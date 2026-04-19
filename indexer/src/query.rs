//! Read-only index reader: mmaps a .bin index and serves symbol lookups.

use anyhow::{anyhow, Context, Result};
use fst::Map as FstMap;
use memmap2::Mmap;
use std::fs::File;
use std::path::{Path, PathBuf};

use crate::format::{read_varint, Header, Kind, SourceTag};

pub struct Index {
    mmap: Mmap,
    header: Header,
    /// For each file_id, (root_id, byte_offset_into_mmap, len_of_relative_path).
    files: Vec<(u8, u32, u16)>,
    /// For each root_id, (tag, absolute_path).
    roots: Vec<(SourceTag, PathBuf)>,
}

#[derive(Debug, Clone)]
pub struct Hit {
    pub file_id: u32,
    pub path: String, // absolute
    pub line: u32,
    pub col: u32,
    pub kind: Kind,
    pub source: SourceTag,
}

impl Index {
    pub fn open(path: &Path) -> Result<Self> {
        let file = File::open(path)
            .with_context(|| format!("opening index: {}", path.display()))?;
        let mmap = unsafe { Mmap::map(&file) }
            .with_context(|| format!("mmap failed: {}", path.display()))?;

        let header = Header::read(&mmap)?;

        // Roots section: [u8 count] [(u8 tag, u16 len, bytes) ...]
        let roots_blob = slice_or_empty(&mmap, header.roots_offset, header.roots_len)?;
        let mut roots: Vec<(SourceTag, PathBuf)> = Vec::new();
        if !roots_blob.is_empty() {
            let num_roots = roots_blob[0] as usize;
            let mut c = 1usize;
            for _ in 0..num_roots {
                if c + 3 > roots_blob.len() {
                    return Err(anyhow!("roots blob truncated"));
                }
                let tag = SourceTag::from_u8(roots_blob[c]);
                c += 1;
                let len = u16::from_le_bytes(roots_blob[c..c + 2].try_into().unwrap()) as usize;
                c += 2;
                if c + len > roots_blob.len() {
                    return Err(anyhow!("roots blob truncated payload"));
                }
                let p = PathBuf::from(
                    std::str::from_utf8(&roots_blob[c..c + len])
                        .map_err(|e| anyhow!("root path utf8: {}", e))?,
                );
                c += len;
                roots.push((tag, p));
            }
        }

        // Paths section: [u32 count] [(u8 root_id, u16 len, bytes) ...]
        let paths_blob = slice_or_empty(&mmap, header.paths_offset, header.paths_len)?;
        if paths_blob.len() < 4 {
            return Err(anyhow!("paths blob truncated"));
        }
        let num_paths = u32::from_le_bytes(paths_blob[0..4].try_into().unwrap()) as usize;
        let mut files: Vec<(u8, u32, u16)> = Vec::with_capacity(num_paths);
        let mut cursor: usize = 4;
        let base = header.paths_offset as usize;
        for _ in 0..num_paths {
            if cursor + 3 > paths_blob.len() {
                return Err(anyhow!("paths blob truncated header"));
            }
            let root_id = paths_blob[cursor];
            cursor += 1;
            let len = u16::from_le_bytes(paths_blob[cursor..cursor + 2].try_into().unwrap());
            cursor += 2;
            if cursor + (len as usize) > paths_blob.len() {
                return Err(anyhow!("paths blob truncated payload"));
            }
            files.push((root_id, (base + cursor) as u32, len));
            cursor += len as usize;
        }

        Ok(Self {
            mmap,
            header,
            files,
            roots,
        })
    }

    pub fn header(&self) -> &Header {
        &self.header
    }

    pub fn total_size(&self) -> usize {
        self.mmap.len()
    }

    pub fn roots(&self) -> &[(SourceTag, PathBuf)] {
        &self.roots
    }

    fn fst(&self) -> Result<FstMap<&[u8]>> {
        let slice = &self.mmap[self.header.fst_offset as usize
            ..(self.header.fst_offset + self.header.fst_len) as usize];
        FstMap::new(slice).map_err(|e| anyhow!("fst open: {}", e))
    }

    fn resolve_path(&self, file_id: u32) -> Option<(SourceTag, String)> {
        let &(root_id, off, len) = self.files.get(file_id as usize)?;
        let rel = std::str::from_utf8(&self.mmap[off as usize..off as usize + len as usize])
            .ok()?;
        let (tag, root) = self.roots.get(root_id as usize)?;
        let abs = root.join(rel);
        Some((*tag, abs.to_string_lossy().into_owned()))
    }

    pub fn lookup(&self, name: &str) -> Result<Vec<Hit>> {
        let fst = self.fst()?;
        let Some(offset) = fst.get(name.as_bytes()) else {
            return Ok(Vec::new());
        };
        let postings_start = self.header.postings_offset as usize + offset as usize;
        let postings_end =
            (self.header.postings_offset + self.header.postings_len) as usize;
        let mut buf = &self.mmap[postings_start..postings_end];

        let (count, n) = read_varint(buf).ok_or_else(|| anyhow!("posting count decode"))?;
        buf = &buf[n..];
        let mut hits = Vec::with_capacity(count as usize);
        let mut last_file_id: u32 = 0;
        for i in 0..count {
            let (delta, n) = read_varint(buf).ok_or_else(|| anyhow!("file_id delta decode"))?;
            buf = &buf[n..];
            let file_id = if i == 0 {
                delta as u32
            } else {
                last_file_id + delta as u32
            };
            last_file_id = file_id;
            let (line, n) = read_varint(buf).ok_or_else(|| anyhow!("line decode"))?;
            buf = &buf[n..];
            let (col, n) = read_varint(buf).ok_or_else(|| anyhow!("col decode"))?;
            buf = &buf[n..];
            if buf.is_empty() {
                return Err(anyhow!("kind byte missing"));
            }
            let kind_byte = buf[0];
            buf = &buf[1..];
            let kind = Kind::from_u8(kind_byte)
                .ok_or_else(|| anyhow!("unknown kind byte: {}", kind_byte))?;
            let (source, path) = self
                .resolve_path(file_id)
                .ok_or_else(|| anyhow!("bad file_id: {}", file_id))?;
            hits.push(Hit {
                file_id,
                path,
                line: line as u32,
                col: col as u32,
                kind,
                source,
            });
        }
        Ok(hits)
    }
}

fn slice_or_empty(mmap: &Mmap, offset: u64, len: u64) -> Result<&[u8]> {
    if len == 0 {
        return Ok(&[]);
    }
    let start = offset as usize;
    let end = start.checked_add(len as usize).ok_or_else(|| anyhow!("overflow"))?;
    if end > mmap.len() {
        return Err(anyhow!("section extends past file end"));
    }
    Ok(&mmap[start..end])
}
