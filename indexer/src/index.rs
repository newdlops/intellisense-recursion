//! Index builder. Walks roots incrementally, parses small batches of Python
//! and TypeScript files, and writes a compact binary index file.

use anyhow::{Context, Result};
use fst::MapBuilder;
use ignore::WalkBuilder;
use rayon::prelude::*;
use rayon::{ThreadPool, ThreadPoolBuilder};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::format::{write_varint, Header, Kind, SourceTag, HEADER_SIZE};
use crate::parse::{LangParser, Symbol};

const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;
// Tree-sitter trees can be much larger than their source. Keep background
// indexing conservative even on machines with many logical CPUs.
const MAX_PARSE_THREADS: usize = 2;
const MAX_BATCH_FILES: usize = 64;
const MAX_BATCH_SOURCE_BYTES: u64 = 4 * 1024 * 1024;

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
    rel_path: String, // path relative to the current root
    symbols: Vec<Symbol>,
}

#[derive(Default)]
struct ParsedIndex {
    by_name: BTreeMap<String, Vec<(u32, u32, u32, Kind)>>,
    paths: Vec<u8>,
    num_files: u32,
    parse_time: Duration,
    merge_time: Duration,
}

impl ParsedIndex {
    fn add_batch(
        &mut self,
        pool: &ThreadPool,
        files: &mut Vec<PathBuf>,
        root: &Path,
        root_id: u8,
    ) -> Result<()> {
        if files.is_empty() {
            return Ok(());
        }
        let t = Instant::now();
        let parsed: Vec<_> = pool.install(|| {
            files
                .par_iter()
                .filter_map(|abs| parse_one(abs, root))
                .collect()
        });
        self.parse_time += t.elapsed();
        files.clear();

        let t = Instant::now();
        for file in parsed {
            let bytes = file.rel_path.as_bytes();
            if bytes.len() > u16::MAX as usize {
                anyhow::bail!("path too long: {}", file.rel_path);
            }
            self.paths.push(root_id);
            self.paths
                .extend_from_slice(&(bytes.len() as u16).to_le_bytes());
            self.paths.extend_from_slice(bytes);
            let file_id = self.num_files;
            self.num_files += 1;
            // Move names into the index and release each file's symbols now,
            // instead of keeping a second copy for the entire workspace.
            for sym in file.symbols {
                self.by_name
                    .entry(sym.name)
                    // Most names have only one definition; avoid reserving
                    // several postings per unique name on the first push.
                    .or_insert_with(|| Vec::with_capacity(1))
                    .push((file_id, sym.line, sym.col, sym.kind));
            }
        }
        self.merge_time += t.elapsed();
        Ok(())
    }
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

    let threads = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .min(MAX_PARSE_THREADS);
    let pool = ThreadPoolBuilder::new()
        .num_threads(threads)
        .build()
        .context("creating index parser pool")?;

    // 1. Walk and parse bounded batches. Large files get their own batch;
    // small files are bounded by both source bytes and file count. Paths for
    // the whole workspace and per-file copies of the roots are never queued.
    let t_walk = Instant::now();
    let mut parsed = ParsedIndex {
        paths: vec![0; 4], // file count, filled in after parsing
        ..ParsedIndex::default()
    };
    let mut batch = Vec::with_capacity(MAX_BATCH_FILES);
    let mut batch_bytes = 0;
    let mut num_files_scanned = 0;
    let mut per_root = Vec::with_capacity(canonical_roots.len());
    for (idx, (tag, root_path)) in canonical_roots.iter().enumerate() {
        let root_id = idx as u8;
        let files_before = parsed.num_files;
        let is_project = matches!(tag, SourceTag::Project);
        for abs in source_files(root_path, is_project) {
            num_files_scanned += 1;
            let Ok(metadata) = fs::metadata(&abs) else {
                continue;
            };
            let bytes = metadata.len();
            if bytes == 0 || bytes > MAX_FILE_BYTES as u64 {
                continue;
            }
            if batch_bytes + bytes > MAX_BATCH_SOURCE_BYTES {
                parsed.add_batch(&pool, &mut batch, root_path, root_id)?;
                batch_bytes = 0;
            }
            batch.push(abs);
            batch_bytes += bytes;
            if batch.len() >= MAX_BATCH_FILES || batch_bytes >= MAX_BATCH_SOURCE_BYTES {
                parsed.add_batch(&pool, &mut batch, root_path, root_id)?;
                batch_bytes = 0;
            }
        }
        parsed.add_batch(&pool, &mut batch, root_path, root_id)?;
        batch_bytes = 0;
        per_root.push((*tag, parsed.num_files - files_before));
    }
    let walk_ms = t_walk
        .elapsed()
        .saturating_sub(parsed.parse_time + parsed.merge_time)
        .as_millis();
    drop(pool);
    let parse_ms = parsed.parse_time.as_millis();
    let num_files_indexed = parsed.num_files;
    parsed.paths[..4].copy_from_slice(&num_files_indexed.to_le_bytes());
    let num_symbols_unique = parsed.by_name.len() as u32;

    // 2. Encode postings and build the FST together, consuming the sorted
    // map so names and posting lists can be released immediately.
    let t_build = Instant::now();
    let mut postings_buf = Vec::new();
    let mut fst_buf = Vec::new();
    let mut builder = MapBuilder::new(&mut fst_buf).context("fst builder init")?;
    let mut num_postings: u64 = 0;

    for (name, mut entries) in parsed.by_name {
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
        builder
            .insert(name.as_bytes(), offset)
            .with_context(|| format!("fst insert failed: {}", name))?;
    }
    builder.finish().context("fst finish")?;

    // 3. Roots blob.  [u8 count][(u8 tag, u16 len, bytes) ...]
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

    // 4. Write sections directly; do not allocate a second, index-sized
    // buffer just to concatenate them.
    let paths_offset = HEADER_SIZE as u64;
    let paths_len = parsed.paths.len() as u64;
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
    let mut header_buf = Vec::with_capacity(HEADER_SIZE);
    header.write(&mut header_buf);

    if let Some(parent) = out_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .with_context(|| format!("creating index directory {}", parent.display()))?;
        }
    }
    let write_index = || -> std::io::Result<()> {
        let mut out = BufWriter::new(fs::File::create(out_path)?);
        for section in [
            &header_buf,
            &parsed.paths,
            &fst_buf,
            &postings_buf,
            &roots_buf,
        ] {
            out.write_all(section)?;
        }
        out.flush()
    };
    write_index().with_context(|| format!("writing index to {}", out_path.display()))?;

    let build_ms = (parsed.merge_time + t_build.elapsed()).as_millis();

    Ok(BuildStats {
        num_files_scanned,
        num_files_indexed,
        num_symbols_unique,
        num_postings,
        total_size,
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

fn source_files(root: &Path, is_project_root: bool) -> impl Iterator<Item = PathBuf> {
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
    const ALWAYS_SKIP: &[&str] = &["__pycache__", ".mypy_cache", ".pytest_cache"];

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
}

fn parse_one(abs: &Path, root: &Path) -> Option<FileSymbols> {
    let ext = abs.extension().and_then(|s| s.to_str())?;
    let file = fs::File::open(abs).ok()?;
    let size = file.metadata().ok()?.len();
    if size == 0 || size > MAX_FILE_BYTES as u64 {
        return None;
    }
    // Check before allocation, then cap the read as well in case the file
    // grows after metadata was read. One extra byte detects an oversize file.
    let mut source = Vec::with_capacity(size as usize + 1);
    file.take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut source)
        .ok()?;
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
        rel_path: rel,
        symbols,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::Index;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            static NEXT_ID: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "ir-index-test-{}-{}",
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }

        fn write(&self, relative: &str, contents: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, contents).unwrap();
            path
        }

        fn project(&self) -> RootSpec {
            RootSpec {
                tag: SourceTag::Project,
                path: self.0.clone(),
            }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn round_trip_preserves_postings_across_batches_and_roots() {
        let dir = TestDir::new();
        fs::create_dir(dir.0.join(".git")).unwrap();
        dir.write(".gitignore", "node_modules/\n.venv/\n");
        let file_count = MAX_BATCH_FILES * 2 + 3;
        for i in 0..file_count {
            dir.write(&format!("module_{i}.py"), &format!(
                "class Shared:\n    value: int = 1\n    def resolve(self):\n        return self.value\nshared = 1\nshared = 2\nclass Unique{i}: pass\n"
            ));
        }
        let stub = dir.write(".venv/lib/library.pyi", "class Library: ...\n");
        let declaration = dir.write(
            "node_modules/pkg/dist/library.d.ts",
            "export declare class Library {}\n",
        );
        let component = dir.write(
            "node_modules/pkg/dist/widget.tsx",
            "export function Widget() { return <span />; }\n",
        );
        dir.write("dist/generated.py", "class Excluded: pass\n");
        dir.write(".venv/__pycache__/cached.py", "class Excluded: pass\n");
        dir.write("empty.py", "");
        dir.write("no_symbols.ts", "// nothing to index\n");
        dir.write("unsupported.js", "class Excluded {}\n");

        let roots = [
            dir.project(),
            RootSpec {
                tag: SourceTag::Venv,
                path: dir.0.join(".venv"),
            },
            RootSpec {
                tag: SourceTag::Other,
                path: dir.0.join("node_modules"),
            },
        ];
        let output = dir.0.join("cache/index.bin");
        let stats = build_index(&roots, &output).unwrap();
        assert_eq!(stats.num_files_scanned, file_count as u32 + 5);
        assert_eq!(stats.num_files_indexed, file_count as u32 + 3);
        assert_eq!(stats.num_symbols_unique, file_count as u32 + 6);
        assert_eq!(stats.num_postings, file_count as u64 * 6 + 3);
        assert_eq!(
            stats.per_root,
            vec![
                (SourceTag::Project, file_count as u32),
                (SourceTag::Venv, 1),
                (SourceTag::Other, 2),
            ]
        );
        assert_eq!(stats.total_size, fs::metadata(&output).unwrap().len());
        let index = Index::open(&output).unwrap();
        assert_eq!(index.header().num_files, stats.num_files_indexed);
        assert_eq!(index.header().num_symbols, stats.num_symbols_unique);
        assert_eq!(index.header().num_postings, stats.num_postings);
        assert_eq!(index.lookup("Shared").unwrap().len(), file_count);
        assert_eq!(index.lookup("value").unwrap().len(), file_count);
        assert_eq!(index.lookup("resolve").unwrap().len(), file_count);
        assert!(index.lookup("Excluded").unwrap().is_empty());
        for i in 0..file_count {
            let hits = index.lookup(&format!("Unique{i}")).unwrap();
            assert_eq!(hits.len(), 1);
            assert_eq!(
                hits[0].path,
                dir.0.join(format!("module_{i}.py")).to_string_lossy()
            );
            assert_eq!(
                (hits[0].line, hits[0].col, hits[0].kind),
                (7, 7, Kind::Class)
            );
            assert_eq!(hits[0].source, SourceTag::Project);
        }
        let repeated = index.lookup("shared").unwrap();
        assert_eq!(repeated.len(), file_count * 2);
        for pair in repeated.chunks_exact(2) {
            assert_eq!(pair[0].file_id, pair[1].file_id);
            assert_eq!((pair[0].line, pair[1].line), (5, 6));
            assert_eq!((pair[0].col, pair[1].col), (1, 1));
            assert_eq!(
                (pair[0].kind, pair[1].kind),
                (Kind::Variable, Kind::Variable)
            );
        }
        let libraries = index.lookup("Library").unwrap();
        assert_eq!(libraries.len(), 2);
        assert_eq!(libraries[0].source, SourceTag::Venv);
        assert_eq!(libraries[0].path, stub.to_string_lossy());
        assert_eq!(libraries[1].source, SourceTag::Other);
        assert_eq!(libraries[1].path, declaration.to_string_lossy());
        let widget = index.lookup("Widget").unwrap();
        assert_eq!(widget.len(), 1);
        assert_eq!(widget[0].path, component.to_string_lossy());
        assert_eq!(widget[0].kind, Kind::Function);
    }

    #[test]
    fn empty_workspace_produces_a_readable_index() {
        let dir = TestDir::new();
        let output = dir.0.join("index.bin");
        let stats = build_index(&[dir.project()], &output).unwrap();
        assert_eq!(stats.num_files_scanned, 0);
        assert_eq!(stats.num_files_indexed, 0);
        assert_eq!(stats.num_postings, 0);
        assert_eq!(stats.per_root, vec![(SourceTag::Project, 0)]);
        assert!(Index::open(&output)
            .unwrap()
            .lookup("Missing")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn files_above_batch_budget_are_still_indexed_up_to_the_file_limit() {
        let dir = TestDir::new();
        let mut large_source = b"class Large: pass\n#".to_vec();
        large_source.resize(MAX_FILE_BYTES, b' ');
        fs::write(dir.0.join("large.py"), large_source).unwrap();
        let oversize = fs::File::create(dir.0.join("oversize.py")).unwrap();
        oversize.set_len(MAX_FILE_BYTES as u64 + 1).unwrap();
        drop(oversize);
        dir.write("small.py", "class Small: pass\n");
        let output = dir.0.join("index.bin");
        let stats = build_index(&[dir.project()], &output).unwrap();
        assert_eq!(stats.num_files_scanned, 3);
        assert_eq!(stats.num_files_indexed, 2);
        let index = Index::open(&output).unwrap();
        assert_eq!(index.lookup("Large").unwrap().len(), 1);
        assert_eq!(index.lookup("Small").unwrap().len(), 1);
        // The parser also enforces the limit independently of the walker.
        assert!(parse_one(&dir.0.join("oversize.py"), &dir.0).is_none());
    }

    #[test]
    fn missing_root_does_not_replace_existing_output() {
        let dir = TestDir::new();
        let output = dir.write("index.bin", "existing index");
        let roots = [
            dir.project(),
            RootSpec {
                tag: SourceTag::Other,
                path: dir.0.join("missing"),
            },
        ];
        assert!(build_index(&roots, &output).is_err());
        assert_eq!(fs::read_to_string(output).unwrap(), "existing index");
    }
}
