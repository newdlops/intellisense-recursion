//! ir-indexer: compact symbol index for the IntelliSense Recursion extension.

mod format;
mod index;
mod parse;
mod query;
mod serve;

use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::time::Instant;

use format::SourceTag;
use index::RootSpec;

#[derive(Parser)]
#[command(name = "ir-indexer", version, about = "IntelliSense Recursion symbol indexer")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Build an index from a workspace root (plus optional extra roots).
    Build {
        /// Main workspace root (files tagged `project`).
        root: PathBuf,
        /// Output path for the .bin index file.
        #[arg(short, long, default_value = "index.bin")]
        out: PathBuf,
        /// Additional root. Repeat per root. Format: `TAG:PATH` where TAG is
        /// one of `venv | stdlib | typeshed | other`.
        #[arg(long = "extra-root", value_name = "TAG:PATH", value_parser = parse_extra_root)]
        extra_roots: Vec<(SourceTag, PathBuf)>,
    },
    /// Look up a symbol by exact name.
    Query {
        index: PathBuf,
        name: String,
        #[arg(short, long, default_value_t = 50)]
        limit: usize,
        #[arg(long, default_value_t = 1)]
        bench: u32,
    },
    /// Print stats about an index file.
    Stats { index: PathBuf },
    /// Serve lookup requests via stdio JSON protocol.
    Serve { index: PathBuf },
}

fn parse_extra_root(s: &str) -> Result<(SourceTag, PathBuf), String> {
    let (tag_s, path_s) = s
        .split_once(':')
        .ok_or_else(|| format!("expected TAG:PATH, got `{}`", s))?;
    let tag = SourceTag::parse(tag_s)
        .ok_or_else(|| format!("unknown tag `{}` (use venv/stdlib/typeshed/other)", tag_s))?;
    if path_s.is_empty() {
        return Err(format!("empty path in `{}`", s));
    }
    Ok((tag, PathBuf::from(path_s)))
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Build { root, out, extra_roots } => cmd_build(&root, &out, extra_roots),
        Cmd::Query { index, name, limit, bench } => cmd_query(&index, &name, limit, bench),
        Cmd::Stats { index } => cmd_stats(&index),
        Cmd::Serve { index } => serve::run(&index),
    }
}

fn cmd_build(
    root: &std::path::Path,
    out: &std::path::Path,
    extras: Vec<(SourceTag, PathBuf)>,
) -> Result<()> {
    let mut roots = vec![RootSpec {
        tag: SourceTag::Project,
        path: root.to_path_buf(),
    }];
    for (tag, p) in extras {
        if tag == SourceTag::Project {
            return Err(anyhow!("--extra-root cannot use tag=project"));
        }
        roots.push(RootSpec { tag, path: p });
    }

    let t = Instant::now();
    let s = index::build_index(&roots, out)?;
    let elapsed = t.elapsed();
    eprintln!("─── build complete ───");
    eprintln!("out           : {}", out.display());
    eprintln!("files scanned : {}", s.num_files_scanned);
    eprintln!("files indexed : {}", s.num_files_indexed);
    eprintln!("unique names  : {}", s.num_symbols_unique);
    eprintln!("total postings: {}", s.num_postings);
    eprintln!();
    eprintln!("per-root indexed:");
    for (tag, count) in &s.per_root {
        eprintln!("  {:<10}: {:>8}", tag.as_str(), count);
    }
    eprintln!();
    eprintln!("sizes:");
    eprintln!("  paths       : {:>12}  ({})", human(s.paths_size), s.paths_size);
    eprintln!("  fst         : {:>12}  ({})", human(s.fst_size), s.fst_size);
    eprintln!("  postings    : {:>12}  ({})", human(s.postings_size), s.postings_size);
    eprintln!("  roots       : {:>12}  ({})", human(s.roots_size), s.roots_size);
    eprintln!("  TOTAL       : {:>12}  ({})", human(s.total_size), s.total_size);
    eprintln!();
    eprintln!("timings:");
    eprintln!("  walk        : {:>6} ms", s.walk_ms);
    eprintln!("  parse       : {:>6} ms", s.parse_ms);
    eprintln!("  build+write : {:>6} ms", s.build_ms);
    eprintln!("  wall        : {:>6} ms", elapsed.as_millis());
    Ok(())
}

fn cmd_query(index: &std::path::Path, name: &str, limit: usize, bench: u32) -> Result<()> {
    let idx = query::Index::open(index)?;
    let hits = idx.lookup(name)?;

    if bench > 1 {
        let mut times_ns: Vec<u128> = Vec::with_capacity(bench as usize);
        for _ in 0..bench {
            let t = Instant::now();
            let _ = idx.lookup(name)?;
            times_ns.push(t.elapsed().as_nanos());
        }
        times_ns.sort_unstable();
        let p = |pct: f64| -> u128 {
            let i = ((pct / 100.0) * (times_ns.len() as f64 - 1.0)).round() as usize;
            times_ns[i.min(times_ns.len() - 1)]
        };
        eprintln!(
            "bench n={}: p50={:.3}µs p95={:.3}µs p99={:.3}µs max={:.3}µs",
            bench,
            p(50.0) as f64 / 1000.0,
            p(95.0) as f64 / 1000.0,
            p(99.0) as f64 / 1000.0,
            p(100.0) as f64 / 1000.0,
        );
    }

    println!("{}: {} hit(s)", name, hits.len());
    for hit in hits.iter().take(limit) {
        println!(
            "  [{:9}|{:8}] {}:{}:{}",
            hit.kind.as_str(),
            hit.source.as_str(),
            hit.path,
            hit.line,
            hit.col
        );
    }
    if hits.len() > limit {
        println!("  ... ({} more)", hits.len() - limit);
    }
    Ok(())
}

fn cmd_stats(index: &std::path::Path) -> Result<()> {
    let idx = query::Index::open(index)?;
    let h = idx.header();
    println!("file        : {}", index.display());
    println!("total size  : {}  ({})", human(idx.total_size() as u64), idx.total_size());
    println!("files       : {}", h.num_files);
    println!("unique names: {}", h.num_symbols);
    println!("postings    : {}", h.num_postings);
    println!();
    println!("roots:");
    for (tag, path) in idx.roots() {
        println!("  [{:<8}] {}", tag.as_str(), path.display());
    }
    println!();
    println!("section sizes:");
    println!("  paths     : {:>12}  ({})", human(h.paths_len), h.paths_len);
    println!("  fst       : {:>12}  ({})", human(h.fst_len), h.fst_len);
    println!("  postings  : {:>12}  ({})", human(h.postings_len), h.postings_len);
    println!("  roots     : {:>12}  ({})", human(h.roots_len), h.roots_len);
    println!();
    if h.num_files > 0 {
        println!("avg postings/file  : {:.1}", h.num_postings as f64 / h.num_files as f64);
    }
    if h.num_symbols > 0 {
        println!("avg postings/symbol: {:.2}", h.num_postings as f64 / h.num_symbols as f64);
        println!("bytes per symbol   : {:.2}", idx.total_size() as f64 / h.num_symbols as f64);
    }
    Ok(())
}

fn human(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KiB", "MiB", "GiB"];
    let mut v = bytes as f64;
    let mut u = 0;
    while v >= 1024.0 && u + 1 < UNITS.len() {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{} B", bytes)
    } else {
        format!("{:.2} {}", v, UNITS[u])
    }
}
