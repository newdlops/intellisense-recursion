//! Stdio JSON-RPC server.
//!
//! Reads newline-delimited JSON requests from stdin and writes one
//! newline-delimited JSON response per request to stdout.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;

use crate::format::{Kind, SourceTag};
use crate::query::{Hit, Index};

const DEFAULT_LIMIT: usize = 50;

#[derive(Deserialize)]
struct Request {
    id: u64,
    op: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    names: Option<Vec<String>>,
    #[serde(default)]
    limit: Option<usize>,
    /// Optional language filter ("python" | "typescript" | "other"). When
    /// set, only hits in files of that language are returned.
    #[serde(default)]
    language: Option<String>,
}

#[derive(Serialize)]
struct HitJson<'a> {
    path: &'a str,
    line: u32,
    col: u32,
    kind: &'static str,
    source: &'static str,
    language: &'static str,
}

/// Derive language from a file's path. `.d.ts` is caught by the `.ts` suffix.
fn language_of(path: &str) -> &'static str {
    if path.ends_with(".py") || path.ends_with(".pyi") {
        "python"
    } else if path.ends_with(".ts") || path.ends_with(".tsx") {
        "typescript"
    } else {
        "other"
    }
}

#[derive(Serialize)]
struct SymbolResult<'a> {
    name: &'a str,
    hits: Vec<HitJson<'a>>,
    total: usize,
}

#[derive(Serialize)]
struct StatsJson {
    files: u32,
    symbols: u32,
    postings: u64,
    size: usize,
    roots: Vec<RootJson>,
}

#[derive(Serialize)]
struct RootJson {
    tag: &'static str,
    path: String,
}

#[derive(Serialize, Default)]
struct Response<'a> {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hits: Option<Vec<HitJson<'a>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    results: Option<Vec<SymbolResult<'a>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stats: Option<StatsJson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pong: Option<bool>,
}

pub fn run(index_path: &Path) -> Result<()> {
    let idx = Index::open(index_path)?;

    let roots_json: Vec<RootJson> = idx
        .roots()
        .iter()
        .map(|(tag, p)| RootJson {
            tag: tag.as_str(),
            path: p.to_string_lossy().into_owned(),
        })
        .collect();

    let ready = serde_json::json!({
        "ok": true,
        "ready": true,
        "files": idx.header().num_files,
        "symbols": idx.header().num_symbols,
        "postings": idx.header().num_postings,
        "size": idx.total_size(),
        "roots": roots_json,
    });
    let mut stdout = BufWriter::new(std::io::stdout().lock());
    writeln!(stdout, "{}", ready)?;
    stdout.flush()?;

    let stdin = std::io::stdin();
    let reader = BufReader::new(stdin.lock());

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                emit_error(&mut stdout, 0, &format!("stdin read: {}", e))?;
                continue;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Request>(trimmed) {
            Ok(req) => handle(&idx, &req, &mut stdout)?,
            Err(e) => emit_error(&mut stdout, 0, &format!("bad json: {}", e))?,
        }
    }
    Ok(())
}

fn handle<W: Write>(idx: &Index, req: &Request, out: &mut W) -> Result<()> {
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).max(1);
    match req.op.as_str() {
        "ping" => {
            let resp = Response {
                id: req.id,
                ok: true,
                pong: Some(true),
                ..Default::default()
            };
            write_response(out, &resp)
        }
        "stats" => {
            let h = idx.header();
            let roots_json: Vec<RootJson> = idx
                .roots()
                .iter()
                .map(|(tag, p)| RootJson {
                    tag: tag.as_str(),
                    path: p.to_string_lossy().into_owned(),
                })
                .collect();
            let resp = Response {
                id: req.id,
                ok: true,
                stats: Some(StatsJson {
                    files: h.num_files,
                    symbols: h.num_symbols,
                    postings: h.num_postings,
                    size: idx.total_size(),
                    roots: roots_json,
                }),
                ..Default::default()
            };
            write_response(out, &resp)
        }
        "lookup" => {
            let Some(name) = req.name.as_deref() else {
                return emit_error(out, req.id, "lookup requires 'name'");
            };
            match idx.lookup(name) {
                Ok(mut hits) => {
                    filter_by_language(&mut hits, req.language.as_deref());
                    rank(&mut hits);
                    let total = hits.len();
                    let taken: Vec<HitJson> = hits
                        .iter()
                        .take(limit)
                        .map(hit_to_json)
                        .collect();
                    let resp = Response {
                        id: req.id,
                        ok: true,
                        hits: Some(taken),
                        total: Some(total),
                        ..Default::default()
                    };
                    write_response(out, &resp)
                }
                Err(e) => emit_error(out, req.id, &format!("{}", e)),
            }
        }
        "lookup_many" => {
            let Some(names) = req.names.as_ref() else {
                return emit_error(out, req.id, "lookup_many requires 'names'");
            };
            let lang = req.language.as_deref();
            let looked: Vec<(String, Vec<Hit>)> = names
                .iter()
                .filter_map(|n| {
                    idx.lookup(n).ok().map(|mut h| {
                        filter_by_language(&mut h, lang);
                        rank(&mut h);
                        (n.clone(), h)
                    })
                })
                .collect();

            let results: Vec<SymbolResult> = looked
                .iter()
                .map(|(n, hits)| SymbolResult {
                    name: n.as_str(),
                    total: hits.len(),
                    hits: hits.iter().take(limit).map(hit_to_json).collect(),
                })
                .collect();

            let resp = Response {
                id: req.id,
                ok: true,
                results: Some(results),
                ..Default::default()
            };
            write_response(out, &resp)
        }
        other => emit_error(out, req.id, &format!("unknown op: {}", other)),
    }
}

fn hit_to_json(h: &Hit) -> HitJson<'_> {
    HitJson {
        path: h.path.as_str(),
        line: h.line,
        col: h.col,
        kind: h.kind.as_str(),
        source: h.source.as_str(),
        language: language_of(&h.path),
    }
}

fn filter_by_language(hits: &mut Vec<Hit>, lang: Option<&str>) {
    let Some(lang) = lang else { return; };
    hits.retain(|h| language_of(&h.path) == lang);
}

fn write_response<W: Write>(out: &mut W, resp: &Response) -> Result<()> {
    serde_json::to_writer(&mut *out, resp)?;
    out.write_all(b"\n")?;
    out.flush()?;
    Ok(())
}

fn emit_error<W: Write>(out: &mut W, id: u64, msg: &str) -> Result<()> {
    let resp = Response {
        id,
        ok: false,
        error: Some(msg.to_string()),
        ..Default::default()
    };
    write_response(out, &resp)
}

/// Combined rank: primary = kind (real definitions beat aliases), secondary
/// = source tag (project wins among same-kind hits), tertiary = path-based
/// priority (TS core lib beats jQuery globals; @types beats random deps).
///
/// "Canonical type modules" (`typescript/lib/lib.*`, `/typing.py`,
/// `/typing.pyi`) receive adjusted kind + source ranks so that e.g. TS
/// built-in `type Omit = ...` (a Variable) beats `@sinclair/typebox`'s
/// `static Omit()` (a Method).
fn rank(hits: &mut Vec<Hit>) {
    hits.sort_by_key(|h| {
        (kind_rank_adjusted(h), source_rank_adjusted(h), path_rank(&h.path))
    });
}

fn source_rank(s: SourceTag) -> u8 {
    s as u8
}

fn source_rank_adjusted(h: &Hit) -> u8 {
    if is_canonical_type_module(&h.path) {
        return 0; // promote to project-level
    }
    source_rank(h.source)
}

fn kind_rank(k: Kind) -> u8 {
    match k {
        Kind::Class => 0,
        Kind::Function => 1,
        Kind::Method => 2,
        Kind::Variable => 3,
        Kind::Attribute => 4,
        Kind::Alias => 5,
    }
}

fn kind_rank_adjusted(h: &Hit) -> u8 {
    if is_canonical_type_module(&h.path) && matches!(h.kind, Kind::Variable | Kind::Attribute) {
        return kind_rank(Kind::Class);
    }
    kind_rank(h.kind)
}

/// Paths that define first-class type aliases (TS `type X = ...`,
/// Python `X = _SpecialForm(...)`) — our parser tags these as Variable but
/// they should rank like a real Class definition.
fn is_canonical_type_module(path: &str) -> bool {
    path.contains("/node_modules/typescript/lib/lib.")
        || path.ends_with("/typing.py")
        || path.ends_with("/typing.pyi")
}

/// Tiebreaker for hits that share `(kind, source)`. The driving cases:
///   - `Promise`, `Map`, `Set`, `Omit`, `Partial`, `Array`, `Record`, `Pick`:
///     users want the TS core lib definition, not a random library's
///     re-declaration (jQuery, typebox, etc).
///   - `ReactNode`, `ReactElement`, `Component`: belong in @types/react.
///   - For Python, `typing.py` / `typeshed/stdlib/typing.pyi` should beat
///     site-packages copies of typing stubs (mypyc fixtures, etc.).
/// Lower rank wins.
fn path_rank(path: &str) -> u8 {
    // TypeScript core library — highest external priority.
    if path.contains("/node_modules/typescript/lib/lib.") {
        return 0;
    }
    // DefinitelyTyped — Node and React are very common, then the rest.
    if path.contains("/node_modules/@types/node/") {
        return 1;
    }
    if path.contains("/node_modules/@types/react/") {
        return 2;
    }
    if path.contains("/node_modules/@types/") {
        return 3;
    }
    // Python canonical typing modules — beats site-packages duplicates.
    if path.ends_with("/typing.py") || path.ends_with("/typing.pyi") {
        return 1;
    }
    // Test fixtures / vendored typeshed copies inside libraries ship
    // duplicate definitions that users almost never want to jump to.
    if path.contains("/test-data/") || path.contains("/tests/")
        || path.contains("/jedi/third_party/")
        || path.contains("/mypy/typeshed/")
        || path.contains("/mypyc/test-data/")
    {
        return 9;
    }
    5
}
