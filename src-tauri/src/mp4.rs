//! Minimal MP4/ISOBMFF box reader.
//!
//! Besides the usual `moov/mvhd` (creation time, duration) it looks for every
//! place a dashcam can hide its GPS track:
//!
//! * the non-standard `moov/gps ` index that points at `freeGPS ` blocks
//!   (Novatek / LigoGPS),
//! * telemetry atoms named `gps`, `gpsn`, `gnme`, `GPRO`, `nmea`, … used by
//!   Ambarella, Vantrue, Blackvue and friends,
//! * QuickTime metadata values (`moov/udta/meta/ilst/…/data`), which carry a
//!   single ISO 6709 position.
//!
//! Everything is returned as raw blobs; the callers decide how to decode them.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

pub struct ContainerInfo {
    pub created_unix: Option<i64>,
    pub duration_secs: f64,
    /// (offset, size) pairs of the blocks listed in `moov/gps `
    pub indexed_blocks: Vec<(u64, u64)>,
    /// Telemetry-ish boxes and metadata values found by name.
    pub blobs: Vec<(String, Vec<u8>)>,
}

const BOX_HEADER: u64 = 8;
/// Never read more than this from a single box.
const MAX_BLOB: u64 = 32 * 1024 * 1024;

/// Box names that are known to carry GPS data. Compared lower case.
const TELEMETRY_BOXES: [&str; 16] = [
    "freegps",
    "gps",
    "gpsn",
    "gnme",
    "gnss",
    "gpro",
    "gptr",
    "gpr1",
    "gpr2",
    "gdat",
    "gpsdata",
    "nmea",
    "gpsinfo",
    "gpstrack",
    "location",
    "loc",
];

/// Containers we descend into.
const CONTAINER_BOXES: [&str; 8] = [
    "moov", "udta", "trak", "mdia", "minf", "stbl", "wave", "sinf",
];

fn read_exact_at(f: &mut File, buf: &mut [u8], offset: u64) -> io::Result<()> {
    f.seek(SeekFrom::Start(offset))?;
    f.read_exact(buf)
}

fn parse_mvhd(data: &[u8]) -> (Option<i64>, f64) {
    if data.len() < 20 {
        return (None, 0.0);
    }
    let version = data[0];
    // seconds since 1904-01-01
    let epoch_offset: i64 = 2_082_844_800;
    if version == 1 && data.len() >= 32 {
        let creation = u64::from_be_bytes(data[4..12].try_into().unwrap()) as i64;
        let timescale = u32::from_be_bytes(data[20..24].try_into().unwrap()) as f64;
        let duration = u64::from_be_bytes(data[24..32].try_into().unwrap()) as f64;
        let created = if creation > 0 { Some(creation - epoch_offset) } else { None };
        (created, if timescale > 0.0 { duration / timescale } else { 0.0 })
    } else {
        let creation = u32::from_be_bytes(data[4..8].try_into().unwrap()) as i64;
        let timescale = u32::from_be_bytes(data[12..16].try_into().unwrap()) as f64;
        let duration = u32::from_be_bytes(data[16..20].try_into().unwrap()) as f64;
        let created = if creation > 0 { Some(creation - epoch_offset) } else { None };
        (created, if timescale > 0.0 { duration / timescale } else { 0.0 })
    }
}

fn type_name(t: &[u8; 4]) -> String {
    t.iter().map(|&b| b.to_ascii_lowercase() as char).collect()
}

fn read_blob(f: &mut File, offset: u64, len: u64) -> io::Result<Vec<u8>> {
    let len = len.min(MAX_BLOB) as usize;
    let mut buf = vec![0u8; len];
    f.seek(SeekFrom::Start(offset))?;
    match f.read_exact(&mut buf) {
        Ok(()) => Ok(buf),
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => Ok(buf),
        Err(e) => Err(e),
    }
}

/// Read the Novatek style index stored in `moov/gps `.
fn read_gps_index(f: &mut File, content_start: u64, end: u64, out: &mut ContainerInfo) {
    let mut head = [0u8; 8];
    if read_exact_at(f, &mut head, content_start).is_err() {
        return;
    }
    let count = u32::from_be_bytes(head[4..8].try_into().unwrap()) as usize;
    let entries_start = content_start + 8;
    let avail = end.saturating_sub(entries_start);
    let to_read = (count.saturating_mul(8) as u64).min(avail) as usize;
    let mut buf = vec![0u8; to_read];
    if read_exact_at(f, &mut buf, entries_start).is_err() {
        return;
    }
    for chunk in buf.chunks_exact(8) {
        let off = u32::from_be_bytes(chunk[0..4].try_into().unwrap()) as u64;
        let size = u32::from_be_bytes(chunk[4..8].try_into().unwrap()) as u64;
        if std::env::var("GEOPLAYER_DEBUG").is_ok() {
            eprintln!("gps entry: offset={} size={}", off, size);
        }
        out.indexed_blocks.push((off, size));
    }
}

/// Walk a range of boxes, collecting telemetry payloads.
fn walk(
    f: &mut File,
    start: u64,
    end: u64,
    depth: u32,
    parent: [u8; 4],
    out: &mut ContainerInfo,
) -> io::Result<()> {
    if depth > 8 {
        return Ok(());
    }
    let mut o = start;
    while o + 8 <= end {
        let mut hdr = [0u8; 16];
        read_exact_at(f, &mut hdr[..8], o)?;
        let mut box_size = u32::from_be_bytes(hdr[0..4].try_into().unwrap()) as u64;
        let btype: [u8; 4] = hdr[4..8].try_into().unwrap();
        let mut header_size = BOX_HEADER;
        if box_size == 1 {
            read_exact_at(f, &mut hdr[8..16], o + 8)?;
            box_size = u64::from_be_bytes(hdr[8..16].try_into().unwrap());
            header_size = 16;
        } else if box_size == 0 {
            box_size = end - o;
        }
        if box_size < header_size {
            break;
        }
        let box_end = o + box_size;
        let name = type_name(&btype);

        if name == "ilst" {
            // QuickTime metadata: each child is a key holding a `data` box.
            let mut ko = o + header_size;
            while ko + 8 <= box_end {
                let mut khdr = [0u8; 16];
                read_exact_at(f, &mut khdr[..8], ko)?;
                let mut ksize = u32::from_be_bytes(khdr[0..4].try_into().unwrap()) as u64;
                let ktype: [u8; 4] = khdr[4..8].try_into().unwrap();
                let mut kheader = BOX_HEADER;
                if ksize == 1 {
                    read_exact_at(f, &mut khdr[8..16], ko + 8)?;
                    ksize = u64::from_be_bytes(khdr[8..16].try_into().unwrap());
                    kheader = 16;
                } else if ksize == 0 {
                    ksize = box_end - ko;
                }
                if ksize < kheader {
                    break;
                }
                walk(f, ko + kheader, ko + ksize, depth + 1, ktype, out)?;
                ko += ksize;
            }
        } else if name == "meta" {
            // FullBox: 4 bytes of version/flags before the children.
            if box_size >= header_size + 4 {
                walk(f, o + header_size + 4, box_end, depth + 1, btype, out)?;
            }
        } else if CONTAINER_BOXES.contains(&name.as_str()) {
            walk(f, o + header_size, box_end, depth + 1, btype, out)?;
        } else if btype == *b"gps " {
            // Novatek index (the 4CC literally is "gps ").
            read_gps_index(f, o + header_size, box_end, out);
        } else if btype == *b"data" {
            // QuickTime value: 4 bytes type, 4 bytes locale, then the value.
            let value_start = o + header_size + 8;
            if value_start < box_end {
                let len = box_end - value_start;
                if let Ok(data) = read_blob(f, value_start, len) {
                    let key = type_name(&parent);
                    out.blobs.push((format!("qt:{key}"), data));
                }
            }
        } else if TELEMETRY_BOXES.contains(&name.as_str()) {
            if let Ok(data) = read_blob(f, o + header_size, box_size - header_size) {
                out.blobs.push((name, data));
            }
        }

        o = box_end;
    }
    Ok(())
}

pub fn read_container(path: &Path) -> io::Result<ContainerInfo> {
    let mut f = File::open(path)?;
    let file_len = f.metadata()?.len();

    let mut info = ContainerInfo {
        created_unix: None,
        duration_secs: 0.0,
        indexed_blocks: Vec::new(),
        blobs: Vec::new(),
    };
    let mut blob_bytes: u64 = 0;

    // Walk the top level so that standalone `freeGPS` boxes are found too,
    // then descend into `moov` for the index and the metadata atoms.
    let mut off = 0u64;
    while off + 8 <= file_len {
        let mut hdr = [0u8; 16];
        read_exact_at(&mut f, &mut hdr[..8], off)?;
        let mut box_size = u32::from_be_bytes(hdr[0..4].try_into().unwrap()) as u64;
        let btype: [u8; 4] = hdr[4..8].try_into().unwrap();
        let mut header_size = BOX_HEADER;
        if box_size == 1 {
            read_exact_at(&mut f, &mut hdr[8..16], off + 8)?;
            box_size = u64::from_be_bytes(hdr[8..16].try_into().unwrap());
            header_size = 16;
        } else if box_size == 0 {
            box_size = file_len - off;
        }
        if box_size < header_size {
            break;
        }
        let box_end = off + box_size;

        if btype == *b"moov" {
            walk(&mut f, off + header_size, box_end, 1, btype, &mut info)?;
            // `mvhd` lives directly inside `moov`
            let mut o = off + header_size;
            while o + 8 <= box_end {
                let mut mh = [0u8; 16];
                read_exact_at(&mut f, &mut mh[..8], o)?;
                let mut msize = u32::from_be_bytes(mh[0..4].try_into().unwrap()) as u64;
                let mtype: [u8; 4] = mh[4..8].try_into().unwrap();
                let mut mheader = BOX_HEADER;
                if msize == 1 {
                    read_exact_at(&mut f, &mut mh[8..16], o + 8)?;
                    msize = u64::from_be_bytes(mh[8..16].try_into().unwrap());
                    mheader = 16;
                } else if msize == 0 {
                    msize = box_end - o;
                }
                if msize < mheader {
                    break;
                }
                if mtype == *b"mvhd" {
                    let data = read_blob(&mut f, o + mheader, msize - mheader)?;
                    let (created, dur) = parse_mvhd(&data);
                    info.created_unix = created;
                    info.duration_secs = dur;
                    break;
                }
                o += msize;
            }
        } else {
            let name = type_name(&btype);
            if TELEMETRY_BOXES.contains(&name.as_str()) && blob_bytes < 64 * 1024 * 1024 {
                if let Ok(data) = read_blob(&mut f, off + header_size, box_size - header_size) {
                    blob_bytes += data.len() as u64;
                    info.blobs.push((name, data));
                }
            }
        }

        off = box_end;
    }

    Ok(info)
}

/// Read a raw block (used for the `moov/gps ` index entries).
pub fn read_block(path: &Path, offset: u64, size: u64) -> io::Result<Vec<u8>> {
    let mut f = File::open(path)?;
    read_blob(&mut f, offset, size)
}
