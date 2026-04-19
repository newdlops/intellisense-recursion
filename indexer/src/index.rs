//! Index builder. Walks one or more roots in parallel, parses every Python
//! file found, and writes a compact binary index file.

use anyhow::{Context, Result};
use fst::MapBuilder;
use ignore::WalkBuilder;
use rayon::prelude::*;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::format::{write_varint, Header, Kind, SourceTag, HEADER_SIZE};
use crate::parse::{LangParser, Symbol};

const MAX_FILE_BYTES: usize = 10 * 1024 * 1024; // 10 MB per file

pub struct RootSpec {
    pub tag: SourceTag,
    pub path: PathBuf,
}

pub struct BuildStats {
    pub num_files_scanned: u32,
    pub num_files_indexed: u32,
    pub num_symbols_unique: u32,
    pub num_postings: u64,
    pub total_size: u64,
    pub paths_size: u64,
    pub fst_size: u64,
    pub postings_size: u64,
    pub roots_size: u64,
    pub walk_ms: u128,
    pub parse_ms: u128,
    pub build_ms: u128,
    pub per_root: Vec<(SourceTag, u32)>, // indexed file count per root
}

struct FileSymbols {
    root_id: u8,
    rel_path: String, // path relative to roots[root_id]
    symbols: Vec<Symbol>,
}

pub fn build_index(roots: &[RootSpec], out_path: &Path) -> Result<BuildStats> {
    if roots.is_empty() {
        anyhow::bail!("build_index called with zero roots");
    }
    if roots.len() > 255 {
        anyhow::bail!("too many roots (max 255)");
    }

    // Canonicalize roots once; a missing root fails the build.
    let canonical_roots: Vec<(SourceTag, PathBuf)> = roots
        .iter()
        .map(|r| {
            let canon = r
                .path
                .canonicalize()
                .with_context(|| format!("cannot resolve root: {}", r.path.display()))?;
            Ok((r.tag, canon))
        })
        .collect::<Result<_>>()?;

    // 1. Walk each root; attach its root_id to every file.
    let t_walk = Instant::now();
    let mut all_files: Vec<(u8, PathBuf, PathBuf)> = Vec::new(); // (root_id, root_path, abs_path)
    let mut per_root_counts: Vec<u32> = vec![0; canonical_roots.len()];
    for (idx, (tag, root_path)) in canonical_roots.iter().enumerate() {
        let is_project = matches!(tag, SourceTag::Project);
        let files = collect_python_files(root_path, is_project);
        per_root_counts[idx] = files.len() as u32;
        for abs in files {
            all_files.push((idx as u8, root_path.clone(), abs));
        }
    }
    let walk_ms = t_walk.elapsed().as_millis();
    let num_files_scanned = all_files.len() as u32;

    // 2. Parse in parallel.
    let t_parse = Instant::now();
    let file_symbols: Vec<FileSymbols> = all_files
        .par_iter()
        .filter_map(|(root_id, root_path, abs)| parse_one(abs, root_path, *root_id))
        .collect();
    let parse_ms = t_parse.elapsed().as_millis();
    let num_files_indexed = file_symbols.len() as u32;

    // 3. Group by symbol name (BTreeMap keeps keys sorted for the FST).
    let t_build = Instant::now();
    let mut by_name: BTreeMap<String, Vec<(u32, u32, u32, Kind)>> = BTreeMap::new();
    for (file_id, fs_entry) in file_symbols.iter().enumerate() {
        let fid = file_id as u32;
        for sym in &fs_entry.symbols {
            by_name
                .entry(sym.name.clone())
                .or_default()
                .push((fid, sym.line, sym.col, sym.kind));
        }
    }
    let num_symbols_unique = by_name.len() as u32;

    // 4. Postings blob.
    let mut postings_buf: Vec<u8> = Vec::with_capacity(by_name.len() * 8);
    let mut name_offsets: Vec<(String, u64)> = Vec::with_capacity(by_name.len());
    let mut num_postings: u64 = 0;

    for (name, mut entries) in by_name {
        entries.sort_unstable_by_key(|e| (e.0, e.1, e.2));
        let offset = postings_buf.len() as u64;
        num_postings += entries.len() as u64;
        write_varint(&mut postings_buf, entries.len() as u64);

        let mut last_file_id: u32 = 0;
        let mut first = true;
        for (file_id, line, col, kind) in entries {
            let delta = if first {
                first = false;
                file_id as u64
            } else {
                (file_id - last_file_id) as u64
            };
            last_file_id = file_id;
            write_varint(&mut postings_buf, delta);
            write_varint(&mut postings_buf, line as u64);
            write_varint(&mut postings_buf, col as u64);
            postings_buf.push(kind as u8);
        }
        name_offsets.push((name, offset));
    }

    // 5. FST (keys already sorted).
    let mut fst_buf: Vec<u8> = Vec::new();
    {
        let mut builder = MapBuilder::new(&mut fst_buf).context("fst builder init")?;
        for (name, offset) in &name_offsets {
            builder
                .insert(name.as_bytes(), *offset)
                .with_context(|| format!("fst insert failed: {}", name))?;
        }
        builder.finish().context("fst finish")?;
    }

    // 6. Roots blob.  [u8 count][(u8 tag, u16 len, bytes) ...]
    let mut roots_buf: Vec<u8> = Vec::new();
    roots_buf.push(canonical_roots.len() as u8);
    for (tag, path) in &canonical_roots {
        let bytes = path.to_string_lossy();
        let bytes = bytes.as_bytes();
        if bytes.len() > u16::MAX as usize {
            anyhow::bail!("root path too long: {}", path.display());
        }
        roots_buf.push(*tag as u8);
        roots_buf.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
        roots_buf.extend_from_slice(bytes);
    }

    // 7. Paths blob.  [u32 count][(u8 root_id, u16 len, bytes) ...]
    let mut paths_buf: Vec<u8> = Vec::with_capacity(num_files_indexed as usize * 80);
    paths_buf.extend_from_slice(&num_files_indexed.to_le_bytes());
    for fs_entry in &file_symbols {
        let bytes = fs_entry.rel_path.as_bytes();
        if bytes.len() > u16::MAX as usize {
            anyhow::bail!("path too long: {}", fs_entry.rel_path);
        }
        paths_buf.push(fs_entry.root_id);
        paths_buf.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
        paths_buf.extend_from_slice(bytes);
    }

    // 8. Assemble.
    let paths_offset = HEADER_SIZE as u64;
    let paths_len = paths_buf.len() as u64;
    let fst_offset = paths_offset + paths_len;
    let fst_len = fst_buf.len() as u64;
    let postings_offset = fst_offset + fst_len;
    let postings_len = postings_buf.len() as u64;
    let roots_offset = postings_offset + postings_len;
    let roots_len = roots_buf.len() as u64;

    let header = Header {
        num_files: num_files_indexed,
        num_symbols: num_symbols_unique,
        num_postings,
        paths_offset,
        paths_len,
        fst_offset,
        fst_len,
        postings_offset,
        postings_len,
        roots_offset,
        roots_len,
    };

    let total_size = HEADER_SIZE as u64 + paths_len + fst_len + postings_len + roots_len;
    let mut out_buf: Vec<u8> = Vec::with_capacity(total_size as usize);
    header.write(&mut out_buf);
    out_buf.extend_from_slice(&paths_buf);
    out_buf.extend_from_slice(&fst_buf);
    out_buf.extend_from_slice(&postings_buf);
    out_buf.extend_from_slice(&roots_buf);

    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).ok();
        }
    }
    fs::write(out_path, &out_buf)
        .with_context(|| format!("writing index to {}", out_path.display()))?;

    let build_ms = t_build.elapsed().as_millis();

    // Per-root indexed counts (recompute from file_symbols — some scanned
    // files drop out during parse due to empty/oversize/read errors).
    let mut indexed_per_root: Vec<u32> = vec![0; canonical_roots.len()];
    for fs in &file_symbols {
        indexed_per_root[fs.root_id as usize] += 1;
    }
    let per_root: Vec<(SourceTag, u32)> = canonical_roots
        .iter()
        .zip(indexed_per_root.iter())
        .map(|((tag, _), count)| (*tag, *count))
        .collect();

    Ok(BuildStats {
        num_files_scanned,
        num_files_indexed,
        num_symbols_unique,
        num_postings,
        total_size: out_buf.len() as u64,
        paths_size: paths_len,
        fst_size: fst_len,
        postings_size: postings_len,
        roots_size: roots_len,
        walk_ms,
        parse_ms,
        build_ms,
        per_root,
    })
}

fn collect_python_files(root: &Path, is_project_root: bool) -> Vec<PathBuf> {
    // Directories we skip in PROJECT roots because they hold user's own build
    // artifacts / caches that duplicate real source. For extra roots
    // (`node_modules`, `.venv`, stdlib, typeshed) we do NOT skip these —
    // `dist/` / `build/` inside a published npm package or Python wheel is
    // exactly where the `.d.ts` / `.pyi` we need lives.
    const PROJECT_VENDOR_DIRS: &[&str] = &[
        "__pycache__",
        "dist",
        "build",
        "target",
        ".mypy_cache",
        ".pytest_cache",
        ".tox",
    ];
    // Always-skip, regardless of root (pure noise / caches).
    const ALWAYS_SKIP: &[&str] = &[
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
    ];

    // A root starting with `.` (e.g. `.venv`) gets no .gitignore / hidden
    // filtering — its contents are what we came for.
    let is_dotdir_root = root
        .file_name()
        .map(|n| n.to_string_lossy().starts_with('.'))
        .unwrap_or(false);

    // Project roots respect .gitignore (and inherit from ancestors). Extra
    // roots are explicitly user-requested; we turn OFF parent-ignore lookup
    // so e.g. the project's top-level `.gitignore` excluding `node_modules/`
    // doesn't swallow everything the user just asked us to index.
    let respect_ignore = is_project_root && !is_dotdir_root;

    WalkBuilder::new(root)
        .standard_filters(respect_ignore)
        .hidden(respect_ignore)
        .git_ignore(respect_ignore)
        .parents(respect_ignore)
        .filter_entry(move |entry| {
            let name = entry.file_name().to_string_lossy();
            let n = name.as_ref();
            if is_project_root && PROJECT_VENDOR_DIRS.contains(&n) {
                return false;
            }
            if ALWAYS_SKIP.contains(&n) {
                return false;
            }
            true
        })
        .build()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map_or(false, |t| t.is_file()))
        .filter(|e| {
            matches!(
                e.path().extension().and_then(|s| s.to_str()),
                Some("py") | Some("pyi") | Some("ts") | Some("tsx")
            )
        })
        .map(|e| e.path().to_path_buf())
        .collect()
}

fn parse_one(abs: &Path, root: &Path, root_id: u8) -> Option<FileSymbols> {
    let ext = abs.extension().and_then(|s| s.to_str())?;
    let source = fs::read(abs).ok()?;
    if source.is_empty() || source.len() > MAX_FILE_BYTES {
        return None;
    }
    let mut parser = LangParser::for_extension(ext)?;
    let symbols = parser.parse(&source).ok()?;
    if symbols.is_empty() {
        return None;
    }
    let rel = abs.strip_prefix(root).ok()?.to_string_lossy().into_owned();
    Some(FileSymbols {
        root_id,
        rel_path: rel,
        symbols,
    })
}
