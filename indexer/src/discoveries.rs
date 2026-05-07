//! Cross-session in-memory cache of LSP-discovered definitions.
//!
//! When the base index misses a symbol (parser limitation, fresh edit, or a
//! file outside our parser's reach) the extension may resolve it via the
//! language server. Those results land here so subsequent lookups for the
//! same name can short-circuit the LSP path. Entries live for the lifetime
//! of the sidecar process — a rebuild restarts the sidecar, which clears
//! everything; an `update_file` on a path invalidates only that path's
//! entries, since an editor change makes prior LSP locations potentially
//! stale.
//!
//! Distinct from `Overlay`: discoveries APPEND to lookup results without
//! shadowing base hits. They're keyed by name (any path), whereas overlay is
//! keyed by path.
//!
//! Bounded at `MAX_ENTRIES` total to keep memory predictable. When full, the
//! oldest insertion is evicted (FIFO via VecDeque); workloads that overflow
//! this cap will simply re-discover via LSP on the next miss.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use crate::format::{Kind, SourceTag};
use crate::query::Hit;

/// Hard ceiling on total discovery entries across all names.
const MAX_ENTRIES: usize = 10_000;

#[derive(Debug, Clone)]
pub struct DiscoveryEntry {
    pub path: String,
    pub line: u32,
    pub col: u32,
    pub kind: Kind,
    pub source: SourceTag,
}

#[derive(Default)]
pub struct Discoveries {
    /// Symbol name → entries discovered for it.
    by_name: HashMap<String, Vec<DiscoveryEntry>>,
    /// Reverse index: path → names that have at least one entry pointing here.
    /// Used for path-scoped invalidation.
    by_path: HashMap<String, HashSet<String>>,
    /// Insertion order across (name, path, line, col), for FIFO eviction.
    fifo: VecDeque<(String, String, u32, u32)>,
}

impl Discoveries {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a discovered location. Caller passes raw fields; we infer a
    /// `SourceTag` from the index roots. Returns `false` if the path falls
    /// outside every known root (in which case nothing is stored).
    pub fn add(
        &mut self,
        name: &str,
        path: &str,
        line: u32,
        col: u32,
        kind: Kind,
        roots: &[(SourceTag, PathBuf)],
    ) -> bool {
        let Some(source) = infer_source_tag(path, roots) else {
            return false;
        };
        let entries = self.by_name.entry(name.to_string()).or_default();

        // Skip duplicates so repeat hovers on the same symbol don't bloat
        // the cache.
        if entries
            .iter()
            .any(|e| e.path == path && e.line == line && e.col == col)
        {
            return true;
        }

        entries.push(DiscoveryEntry {
            path: path.to_string(),
            line,
            col,
            kind,
            source,
        });
        self.by_path
            .entry(path.to_string())
            .or_default()
            .insert(name.to_string());
        self.fifo
            .push_back((name.to_string(), path.to_string(), line, col));

        while self.fifo.len() > MAX_ENTRIES {
            if let Some((evict_name, evict_path, evict_line, evict_col)) = self.fifo.pop_front() {
                self.evict_one(&evict_name, &evict_path, evict_line, evict_col);
            }
        }
        true
    }

    fn evict_one(&mut self, name: &str, path: &str, line: u32, col: u32) {
        if let Some(entries) = self.by_name.get_mut(name) {
            entries.retain(|e| !(e.path == path && e.line == line && e.col == col));
            let empty = entries.is_empty();
            if empty {
                self.by_name.remove(name);
                if let Some(names) = self.by_path.get_mut(path) {
                    names.remove(name);
                    if names.is_empty() {
                        self.by_path.remove(path);
                    }
                }
            } else if !entries.iter().any(|e| e.path == path) {
                if let Some(names) = self.by_path.get_mut(path) {
                    names.remove(name);
                    if names.is_empty() {
                        self.by_path.remove(path);
                    }
                }
            }
        }
    }

    /// Drop every entry that points at `path` (any name). Called when the
    /// editor reports an edit on `path` so we don't serve a now-stale line.
    pub fn clear_for_path(&mut self, path: &str) -> usize {
        let Some(names) = self.by_path.remove(path) else {
            return 0;
        };
        let mut removed = 0usize;
        for name in &names {
            if let Some(entries) = self.by_name.get_mut(name) {
                let before = entries.len();
                entries.retain(|e| e.path != path);
                removed += before - entries.len();
                if entries.is_empty() {
                    self.by_name.remove(name);
                }
            }
        }
        // Rebuild fifo to drop entries for this path. Cheap relative to
        // typical eviction frequency.
        self.fifo
            .retain(|(_, p, _, _)| p.as_str() != path);
        removed
    }

    /// Append discovery hits for `name` (filtered by language) into `out`.
    /// Caller is responsible for dedup against base/overlay hits.
    pub fn collect_hits(&self, name: &str, language_filter: Option<&str>, out: &mut Vec<Hit>) {
        let Some(entries) = self.by_name.get(name) else {
            return;
        };
        for e in entries {
            if let Some(want) = language_filter {
                if language_of(&e.path) != want {
                    continue;
                }
            }
            out.push(Hit {
                file_id: u32::MAX,
                path: e.path.clone(),
                line: e.line,
                col: e.col,
                kind: e.kind,
                source: e.source,
            });
        }
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.fifo.len()
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
