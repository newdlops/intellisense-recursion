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
//! Lookups inspect only the matching name range in each file's sorted symbol
//! vector, instead of scanning every symbol on every hover.
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
    pub fn collect_hits(&self, name: &str, language_filter: Option<&str>, out: &mut Vec<Hit>) {
        for (path, entry) in &self.entries {
            if let Some(want) = language_filter {
                if language_of(path) != want {
                    continue;
                }
            }
            let start = entry
                .symbols
                .partition_point(|sym| sym.name.as_str() < name);
            for sym in entry.symbols[start..]
                .iter()
                .take_while(|sym| sym.name == name)
            {
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
        let mut symbols = parser.parse(source).unwrap_or_default();
        // Stable sorting preserves source order for repeated definitions of
        // the same name and adds no persistent secondary index allocation.
        symbols.sort_by(|a, b| a.name.cmp(&b.name));
        let n = symbols.len();
        self.entries.insert(
            abs_path.to_string(),
            OverlayEntry {
                source_tag,
                symbols,
            },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_ranges_preserve_duplicates_and_language_filters() {
        let roots = vec![
            (SourceTag::Project, PathBuf::from("/workspace")),
            (SourceTag::Venv, PathBuf::from("/workspace/.venv")),
        ];
        let mut overlay = Overlay::new();
        overlay.set("/workspace/models.py", b"class Zed: pass\nclass Match: pass\nclass Alpha: pass\nclass Match: pass\nclass MatchSuffix: pass\n", "py", &roots).unwrap();
        overlay
            .set(
                "/workspace/.venv/models.pyi",
                b"class Match: ...\n",
                "pyi",
                &roots,
            )
            .unwrap();
        overlay
            .set(
                "/workspace/models.tsx",
                b"export class Match {}\n",
                "tsx",
                &roots,
            )
            .unwrap();

        let mut hits = Vec::new();
        overlay.collect_hits("Match", Some("python"), &mut hits);
        assert_eq!(hits.len(), 3);
        let project: Vec<_> = hits
            .iter()
            .filter(|hit| hit.source == SourceTag::Project)
            .collect();
        assert_eq!(
            project.iter().map(|hit| hit.line).collect::<Vec<_>>(),
            vec![2, 4]
        );
        assert!(hits.iter().any(|hit| hit.source == SourceTag::Venv));
        hits.clear();
        overlay.collect_hits("Match", Some("typescript"), &mut hits);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "/workspace/models.tsx");
        for name in ["", "BeforeAlpha", "MatchMissing", "Zzz"] {
            hits.clear();
            overlay.collect_hits(name, None, &mut hits);
            assert!(hits.is_empty(), "unexpected match for {name}");
        }
        for name in ["Alpha", "Zed", "MatchSuffix"] {
            hits.clear();
            overlay.collect_hits(name, None, &mut hits);
            assert_eq!(hits.len(), 1, "missing exact match for {name}");
        }
    }

    #[test]
    fn replacement_and_empty_buffers_keep_shadowing_until_cleared() {
        let roots = vec![(SourceTag::Project, PathBuf::from("/workspace"))];
        let path = "/workspace/models.py";
        let mut overlay = Overlay::new();
        overlay
            .set(path, b"class Old: pass\n", "py", &roots)
            .unwrap();
        overlay
            .set(path, b"class New: pass\n", "py", &roots)
            .unwrap();
        let mut hits = Vec::new();
        overlay.collect_hits("Old", None, &mut hits);
        assert!(hits.is_empty());
        overlay.collect_hits("New", None, &mut hits);
        assert_eq!(hits.len(), 1);
        assert_eq!(overlay.set(path, b"", "py", &roots).unwrap(), 0);
        assert!(overlay.shadows(path));
        hits.clear();
        overlay.collect_hits("New", None, &mut hits);
        assert!(hits.is_empty());
        assert!(overlay.clear(path));
        assert!(!overlay.shadows(path));
        overlay
            .set("/outside/models.py", b"class Other: pass", "py", &roots)
            .unwrap();
        assert!(!overlay.shadows("/outside/models.py"));
    }
}
