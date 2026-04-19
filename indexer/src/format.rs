//! Binary index file format.
//!
//! v2 layout:
//!   [header 128 B] [paths] [fst] [postings] [roots]
//!
//! - Symbol name → postings lookup via FST.
//! - Postings are varint-encoded (file_id delta, line, col) triples followed
//!   by a kind byte.
//! - Paths section lists files as (root_id, relative_path).
//! - Roots section lists indexed roots as (source_tag, absolute_path). File
//!   absolute paths are reconstructed at query time by joining root path and
//!   the per-file relative path.

use anyhow::{anyhow, Result};

pub const MAGIC: &[u8; 8] = b"IRIDX001";
pub const VERSION: u32 = 2;
pub const HEADER_SIZE: usize = 128;

#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    Class = 1,
    Function = 2,
    Method = 3,
    Variable = 4,
    Attribute = 5,
    Alias = 6,
}

impl Kind {
    pub fn from_u8(b: u8) -> Option<Kind> {
        match b {
            1 => Some(Kind::Class),
            2 => Some(Kind::Function),
            3 => Some(Kind::Method),
            4 => Some(Kind::Variable),
            5 => Some(Kind::Attribute),
            6 => Some(Kind::Alias),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Kind::Class => "class",
            Kind::Function => "function",
            Kind::Method => "method",
            Kind::Variable => "variable",
            Kind::Attribute => "attribute",
            Kind::Alias => "alias",
        }
    }
}

/// Where a file came from. Drives ranking: project > venv > stdlib > typeshed.
#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum SourceTag {
    Project = 0,
    Venv = 1,
    Stdlib = 2,
    Typeshed = 3,
    Other = 4,
}

impl SourceTag {
    pub fn from_u8(b: u8) -> SourceTag {
        match b {
            0 => SourceTag::Project,
            1 => SourceTag::Venv,
            2 => SourceTag::Stdlib,
            3 => SourceTag::Typeshed,
            _ => SourceTag::Other,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            SourceTag::Project => "project",
            SourceTag::Venv => "venv",
            SourceTag::Stdlib => "stdlib",
            SourceTag::Typeshed => "typeshed",
            SourceTag::Other => "other",
        }
    }

    pub fn parse(s: &str) -> Option<SourceTag> {
        match s {
            "project" => Some(SourceTag::Project),
            "venv" => Some(SourceTag::Venv),
            "stdlib" => Some(SourceTag::Stdlib),
            "typeshed" => Some(SourceTag::Typeshed),
            "other" => Some(SourceTag::Other),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Header {
    pub num_files: u32,
    pub num_symbols: u32,
    pub num_postings: u64,
    pub paths_offset: u64,
    pub paths_len: u64,
    pub fst_offset: u64,
    pub fst_len: u64,
    pub postings_offset: u64,
    pub postings_len: u64,
    pub roots_offset: u64,
    pub roots_len: u64,
}

impl Header {
    pub fn write(&self, out: &mut Vec<u8>) {
        let start = out.len();
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // flags
        out.extend_from_slice(&self.num_files.to_le_bytes());
        out.extend_from_slice(&self.num_symbols.to_le_bytes());
        out.extend_from_slice(&self.num_postings.to_le_bytes());
        out.extend_from_slice(&self.paths_offset.to_le_bytes());
        out.extend_from_slice(&self.paths_len.to_le_bytes());
        out.extend_from_slice(&self.fst_offset.to_le_bytes());
        out.extend_from_slice(&self.fst_len.to_le_bytes());
        out.extend_from_slice(&self.postings_offset.to_le_bytes());
        out.extend_from_slice(&self.postings_len.to_le_bytes());
        out.extend_from_slice(&self.roots_offset.to_le_bytes());
        out.extend_from_slice(&self.roots_len.to_le_bytes());
        while out.len() - start < HEADER_SIZE {
            out.push(0);
        }
    }

    pub fn read(buf: &[u8]) -> Result<Self> {
        if buf.len() < HEADER_SIZE {
            return Err(anyhow!("buffer too small for header"));
        }
        if &buf[0..8] != MAGIC {
            return Err(anyhow!("bad magic: not an ir-indexer file"));
        }
        let version = u32::from_le_bytes(buf[8..12].try_into().unwrap());
        if version != VERSION {
            return Err(anyhow!(
                "unsupported version: {} (expected {})",
                version,
                VERSION
            ));
        }
        Ok(Header {
            num_files: u32::from_le_bytes(buf[16..20].try_into().unwrap()),
            num_symbols: u32::from_le_bytes(buf[20..24].try_into().unwrap()),
            num_postings: u64::from_le_bytes(buf[24..32].try_into().unwrap()),
            paths_offset: u64::from_le_bytes(buf[32..40].try_into().unwrap()),
            paths_len: u64::from_le_bytes(buf[40..48].try_into().unwrap()),
            fst_offset: u64::from_le_bytes(buf[48..56].try_into().unwrap()),
            fst_len: u64::from_le_bytes(buf[56..64].try_into().unwrap()),
            postings_offset: u64::from_le_bytes(buf[64..72].try_into().unwrap()),
            postings_len: u64::from_le_bytes(buf[72..80].try_into().unwrap()),
            roots_offset: u64::from_le_bytes(buf[80..88].try_into().unwrap()),
            roots_len: u64::from_le_bytes(buf[88..96].try_into().unwrap()),
        })
    }
}

/// LEB128 unsigned varint.
pub fn write_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// Returns (value, bytes_consumed) or None on truncation / overflow.
pub fn read_varint(buf: &[u8]) -> Option<(u64, usize)> {
    let mut v: u64 = 0;
    let mut shift: u32 = 0;
    for (i, &b) in buf.iter().enumerate() {
        if i >= 10 {
            return None;
        }
        v |= ((b & 0x7F) as u64) << shift;
        if b & 0x80 == 0 {
            return Some((v, i + 1));
        }
        shift += 7;
    }
    None
}
