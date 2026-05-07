//! In-memory overlay of edited (possibly unsaved) buffers.
//!
//! Sits in front of the read-only `Index`. The serve loop holds one `Overlay`
//! for the lifetime of the sidecar process. Edits arrive via `update_file`
//! ops and are parsed eagerly; lookup merges overlay hits with base hits and
//! suppresses base hits for any path that has an overlay entry.
//!
//! Overlays are not persisted — when the index is rebuilt and the sidecar is
//! respawned, the new process starts with an empty overlay (and the new base
//! index already reflects whatever was on disk at rebuild time).
//!
//! Single-threaded: `serve` runs a readline loop, so no synchronization.
//! Lookups against an overlay are linear in the number of overlaid files,
//! which is typically a handful.
//!
//! A `set` with no symbols (e.g. transient parse failure) is still recorded
//! so that the file's stale base entries stay shadowed — better to show
//! nothing for a half-edited buffer than a defunct symbol.
//!
//! Source-tag inference: an overlay path is matched against the index's roots
//! by longest-prefix; updates for paths outside any indexed root are rejected.

use anyhow::Result;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::format::SourceTag;
use crate::parse::{LangParser, Symbol};
use crate::query::Hit;

pub struct OverlayEntry {
    pub source_tag: SourceTag,
    pub symbols: Vec<Symbol>,
}

#[derive(Default)]
pub struct Overlay {
    /// Keyed by canonical absolute path string (matches the strings produced
    /// by `Index::resolve_path`, so suppression compares directly).
    entries: HashMap<String, OverlayEntry>,
}

impl Overlay {
    pub fn new() -> Self {
        Self::default()
    }

    /// True iff a base hit at this path should be suppressed.
    pub fn shadows(&self, path: &str) -> bool {
        self.entries.contains_key(path)
    }

    /// Append overlay hits matching `name` (with optional language filter).
    /// `language` matches the same `language_of` mapping `serve.rs` uses on
    /// base hits, so the caller's language filter applies uniformly.
    pub fn collect_hits(
        &self,
        name: &str,
        language_filter: Option<&str>,
        out: &mut Vec<Hit>,
    ) {
        for (path, entry) in &self.entries {
            if let Some(want) = language_filter {
                if language_of(path) != want {
                    continue;
                }
            }
            for sym in &entry.symbols {
                if sym.name == name {
                    out.push(Hit {
                        // Overlay symbols don't have a stable file_id (they
                        // aren't in the FST/postings). u32::MAX flags them as
                        // "not from base" — no consumer of `file_id` past the
                        // serve handler.
                        file_id: u32::MAX,
                        path: path.clone(),
                        line: sym.line,
                        col: sym.col,
                        kind: sym.kind,
                        source: entry.source_tag,
                    });
                }
            }
        }
    }

    /// Replace the overlay for `abs_path`. `roots` is consulted to derive a
    /// `SourceTag` (longest-prefix match). Unknown extension or path outside
    /// all roots → returns Ok(0) without storing.
    pub fn set(
        &mut self,
        abs_path: &str,
        source: &[u8],
        ext: &str,
        roots: &[(SourceTag, PathBuf)],
    ) -> Result<usize> {
        let Some(source_tag) = infer_source_tag(abs_path, roots) else {
            return Ok(0);
        };
        let Some(mut parser) = LangParser::for_extension(ext) else {
            return Ok(0);
        };
        // tree-sitter parses partial trees, so syntactically broken buffers
        // still yield whatever symbols it could recover. An Err here means
        // tree-sitter failed to produce any tree at all (rare).
        let symbols = parser.parse(source).unwrap_or_default();
        let n = symbols.len();
        self.entries.insert(
            abs_path.to_string(),
            OverlayEntry { source_tag, symbols },
        );
        Ok(n)
    }

    pub fn clear(&mut self, abs_path: &str) -> bool {
        self.entries.remove(abs_path).is_some()
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

fn infer_source_tag(abs_path: &str, roots: &[(SourceTag, PathBuf)]) -> Option<SourceTag> {
    let p = Path::new(abs_path);
    let mut best: Option<(usize, SourceTag)> = None;
    for (tag, root) in roots {
        if p.starts_with(root) {
            let depth = root.components().count();
            if best.map_or(true, |(d, _)| depth > d) {
                best = Some((depth, *tag));
            }
        }
    }
    best.map(|(_, t)| t)
}

fn language_of(path: &str) -> &'static str {
    if path.ends_with(".py") || path.ends_with(".pyi") {
        "python"
    } else if path.ends_with(".ts") || path.ends_with(".tsx") {
        "typescript"
    } else {
        "other"
    }
}
