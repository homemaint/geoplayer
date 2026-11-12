//! Port of ExifTool's LIGOGPSINFO decoder (lib/Image/ExifTool/LigoGPS.pm)
//! Handles the digit-cipher enciphered variant, the self-describing XOR variant,
//! and the plaintext (Redtiger F9 4K) variant.
//!
//! Verified against real Novatek `freeGPS` blocks from a Novatek-based 4K dashcam.

use crate::telemetry::{Accelerometer, GpsFix};
use chrono::{DateTime, NaiveDateTime, Utc};
use std::collections::{HashMap, HashSet};

const RECORD_LEN: usize = 0x84; // 132 bytes per GPS record

fn is_class_byte(b: u8) -> bool {
    (0x30..=0x5f).contains(&b)
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// `####`-record structure match for the enciphered (digit-cipher) variant.
/// Returns (millennium, colon, seconds_ones).
fn match_enciphered(rec: &[u8]) -> Option<(u8, u8, u8)> {
    if rec.len() < RECORD_LEN || &rec[0..4] != b"####" {
        return None;
    }
    let millennium = rec[8];
    if !is_class_byte(millennium)
        || !is_class_byte(rec[9])
        || !is_class_byte(rec[10])
        || !is_class_byte(rec[11])
        || rec[12] != b'/'
    {
        return None;
    }
    if !is_class_byte(rec[13]) || !is_class_byte(rec[14]) || rec[15] != b'/' {
        return None;
    }
    if !is_class_byte(rec[16]) || !is_class_byte(rec[17]) || rec[18] != b' ' {
        return None;
    }
    let colon = rec[21];
    if !is_class_byte(colon) || rec[24] != colon {
        return None;
    }
    let ones = rec[26];
    if !is_class_byte(ones) || rec[27] != b' ' {
        return None;
    }
    Some((millennium, colon, ones))
}

/// Self-describing XOR decrypt for records in the self-steering variant.
fn decrypt_record(rec: &[u8]) -> Option<Vec<u8>> {
    if rec.len() < 8 {
        return None;
    }
    let mut num = u32::from_le_bytes([rec[4], rec[5], rec[6], rec[7]]) as usize;
    if num < 4 {
        return None;
    }
    if num > 0x84 {
        num = 0x84;
    }
    let data = &rec[8..(8 + num).min(rec.len())];
    let mut out = Vec::with_capacity(num);
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        i += 1;
        let steer = b & 0xe0;
        match steer {
            0xc0 | 0xe0 => {
                if data.len() - i < 4 {
                    return None;
                }
                out.push((data[i] | (b & 0x01)) ^ 0x20);
                out.push((data[i + 1] | (b & 0x02)) ^ 0x20);
                out.push((data[i + 2] | (b & 0x0c)) ^ 0x20);
                out.push((data[i + 3] ^ 0x20) | (b & 0x30));
                i += 4;
            }
            0x40 => {
                if data.len() - i < 3 {
                    return None;
                }
                out.push(0x20);
                out.push((data[i] | (b & 0x01)) ^ 0x20);
                out.push((data[i + 1] | (b & 0x06)) ^ 0x20);
                out.push((data[i + 2] | (b & 0x18)) ^ 0x20);
                i += 3;
            }
            0x60 => {
                if data.len() - i < 3 {
                    return None;
                }
                out.push((data[i] | (b & 0x03)) ^ 0x20);
                out.push(0x20);
                out.push((data[i + 1] | (b & 0x04)) ^ 0x20);
                out.push((data[i + 2] | (b & 0x18)) ^ 0x20);
                i += 3;
            }
            0x80 => {
                if data.len() - i < 3 {
                    return None;
                }
                out.push((data[i] | (b & 0x03)) ^ 0x20);
                out.push((data[i + 1] | (b & 0x0c)) ^ 0x20);
                out.push(0x20);
                out.push((data[i + 2] | (b & 0x10)) ^ 0x20);
                i += 3;
            }
            0xa0 => {
                if data.len() - i < 3 {
                    return None;
                }
                out.push((data[i] | (b & 0x01)) ^ 0x20);
                out.push((data[i + 1] | (b & 0x06)) ^ 0x20);
                out.push((data[i + 2] | (b & 0x18)) ^ 0x20);
                out.push(0x20);
                i += 3;
            }
            0x00 => {
                if data.len() - i < 1 {
                    return None;
                }
                out.push(data[i] | (b & 0x13));
                i += 1;
            }
            _ => return None,
        }
    }
    Some(out)
}

/// Find a cycle through all 10 cipher characters, following the "seconds ones
/// digit" succession graph. `next` maps a node to its candidate successors
/// (in order of appearance, deduplicated).
fn find_cycle(next: &HashMap<u8, Vec<u8>>) -> Option<Vec<u8>> {
    fn dfs(
        ch: u8,
        next: &HashMap<u8, Vec<u8>>,
        order: &mut Vec<u8>,
        used: &mut HashSet<u8>,
        start: u8,
    ) -> bool {
        if used.contains(&ch) {
            return false;
        }
        let Some(cands) = next.get(&ch) else { return false };
        order.push(ch);
        used.insert(ch);
        if order.len() == 10 {
            // success if the cycle closes back to the starting node
            let ok = next.get(&ch).is_some_and(|s| s.contains(&start));
            if ok {
                return true;
            }
            order.pop();
            used.remove(&ch);
            return false;
        }
        for &cand in cands {
            if dfs(cand, next, order, used, start) {
                return true;
            }
        }
        order.pop();
        used.remove(&ch);
        false
    }

    let start = next.keys().copied().min()?;
    let mut order = Vec::with_capacity(10);
    let mut used = HashSet::with_capacity(10);
    if dfs(start, next, &mut order, &mut used, start) {
        Some(order)
    } else {
        None
    }
}

struct Cipher {
    map: HashMap<u8, char>,
}

impl Cipher {
    fn build(records: &[&[u8]]) -> Option<Cipher> {
        let parsed: Vec<(u8, u8, u8)> = records.iter().filter_map(|r| match_enciphered(r)).collect();
        if parsed.len() < 10 {
            return None;
        }
        let mut next: HashMap<u8, Vec<u8>> = HashMap::new();
        let mut prev: Option<u8> = None;
        for &(_, _, ones) in &parsed {
            if let Some(p) = prev {
                if p != ones {
                    let entry = next.entry(p).or_default();
                    if !entry.contains(&ones) {
                        entry.push(ones);
                    }
                }
            }
            prev = Some(ones);
        }
        if next.len() != 10 {
            return None; // all 10 characters must appear
        }
        let order = find_cycle(&next)?;
        let colon = parsed[0].1;
        let millennium = parsed[0].0;
        let two = order.iter().position(|&c| c == millennium)?;

        let mut map: HashMap<u8, char> = HashMap::with_capacity(48);
        map.insert(colon, ':');
        for d in 0..10usize {
            let ch = order[(d + two + 8) % 10];
            map.insert(ch, char::from(b'0' + d as u8));
        }
        // latitude/longitude hemisphere letters from the coordinate signs
        let rec0 = records[0];
        let mut found: Vec<(u8, bool)> = Vec::new();
        for i in 2..rec0.len() {
            if rec0[i] == b':' && is_class_byte(rec0[i - 1]) && rec0[i - 2] == b' ' {
                let neg = i + 1 < rec0.len() && rec0[i + 1] == b'-';
                found.push((rec0[i - 1], neg));
            }
        }
        if found.len() >= 2 {
            map.insert(found[0].0, if found[0].1 { 'S' } else { 'N' });
            map.insert(found[1].0, if found[1].1 { 'W' } else { 'E' });
        }
        // unknown entries inside the ciphered range become '?'
        for code in 0x30u8..=0x5f {
            map.entry(code).or_insert('?');
        }
        Some(Cipher { map })
    }

    fn apply(&self, body: &[u8]) -> String {
        body.iter()
            .map(|&b| *self.map.get(&b).unwrap_or(&(b as char)))
            .collect()
    }
}

struct ParsedRecord {
    time: DateTime<Utc>,
    /// Latitude/longitude exactly as written in the record (still fuzzed when
    /// `fuzzed` is true). The fuzz scale is chosen per file after all records
    /// have been parsed, because different dashcam models use different scales.
    raw_lat: f64,
    raw_lon: f64,
    lat_sign: f64,
    lon_sign: f64,
    fuzzed: bool,
    speed_kmh: f64,
    accel: Option<Accelerometer>,
    coords_assumed: bool,
}

/// Parse the deciphered body: `YYYY/MM/DD HH:MM:SS R:lat R:lon speed km/h ...`
fn parse_ligorecord(body: &str, flags: u8) -> Option<ParsedRecord> {
    let mut it = body.split_whitespace();
    let date = it.next()?;
    let time = it.next()?;
    let lat_part = it.next()?;
    let lon_part = it.next()?;
    let spd_part = it.next()?;

    let parse_coord = |s: &str| -> Option<(char, bool, f64)> {
        let mut parts = s.splitn(2, ':');
        let hemi = parts.next()?;
        let val = parts.next()?;
        let hemi_ch = hemi.chars().next()?;
        let neg = val.starts_with('-');
        let v: f64 = val.parse().ok()?;
        Some((hemi_ch, neg, v))
    };

    let (lat_ref, lat_neg, mut lat) = parse_coord(lat_part)?;
    let (lon_ref, lon_neg, mut lon) = parse_coord(lon_part)?;
    let speed: f64 = spd_part.parse().ok()?;

    let t = NaiveDateTime::parse_from_str(
        &format!("{} {}", date.replace('/', "-"), time),
        "%Y-%m-%d %H:%M:%S",
    )
    .ok()?;
    let time = DateTime::<Utc>::from_naive_utc_and_offset(t, Utc);

    let no_fuzz = flags & 0x01 != 0;
    let fuzzed = !no_fuzz;
    let spd_is_kmh = flags & 0x02 != 0;
    let mut spd_scale: f64 = if no_fuzz {
        if spd_is_kmh {
            1.0
        } else {
            1.852 // knots -> km/h
        }
    } else {
        1.85407333
    };

    // DDMM.MMMM format? (3+ leading digits)
    if lat >= 100.0 {
        lat = convert_lat_lon(lat);
        lon = convert_lat_lon(lon);
        spd_scale = 1.0;
    }
    // (de-fuzzing is deferred until we know the camera's fuzz scale)

    let sgn_lat = if lat_neg || lat_ref == 'S' { -1.0 } else { 1.0 };
    let sgn_lon = if lon_neg || lon_ref == 'W' { -1.0 } else { 1.0 };
    let coords_assumed = lat_ref == '?' || lon_ref == '?';

    let accel = parse_accel(body);

    Some(ParsedRecord {
        time,
        raw_lat: lat,
        raw_lon: lon,
        lat_sign: sgn_lat,
        lon_sign: sgn_lon,
        fuzzed,
        speed_kmh: speed * spd_scale,
        accel,
        coords_assumed,
    })
}

fn parse_accel(s: &str) -> Option<Accelerometer> {
    let xi = s.find("x:")? + 2;
    let rem = &s[xi..];
    let yi = rem.find("y:")?;
    let x: f32 = rem[..yi].trim().parse().ok()?;
    let rem2 = &rem[yi + 2..];
    let zi = rem2.find("z:")?;
    let y: f32 = rem2[..zi].trim().parse().ok()?;
    let zstr: String = rem2[zi + 2..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '.')
        .collect();
    let z: f32 = zstr.parse().ok()?;
    Some(Accelerometer { x, y, z })
}

fn convert_lat_lon(v: f64) -> f64 {
    let minutes = v % 100.0;
    let degrees = (v - minutes) / 100.0;
    degrees + minutes / 60.0
}

fn unfuzz(lat: f64, lon: f64, scl: f64) -> (f64, f64) {
    let lat2 = (lat / 10.0).trunc() * 10.0;
    let lon2 = (lon / 10.0).trunc() * 10.0;
    (lat2 + (lon - lon2) * scl, lon2 + (lat - lat2) * scl)
}

/// ExifTool exposes the LIGO fuzz scale as an option because different camera
/// models use different values. We pick it automatically by comparing the
/// route length at each candidate scale with the distance implied by the GPS
/// speed samples. The scale that makes the two agree is the one the camera
/// used when it wrote the coordinates.
const FUZZ_SCALES: [f64; 4] = [1.0, 1.524855137, 1.456027985, 1.15368];

fn choose_fuzz_scale(records: &[ParsedRecord]) -> f64 {
    let fuzzed: Vec<&ParsedRecord> = records.iter().filter(|r| r.fuzzed).collect();
    if fuzzed.len() < 10 {
        return 1.0;
    }
    let mut speed_dist = 0.0;
    for w in fuzzed.windows(2) {
        let dt = (w[1].time - w[0].time).num_milliseconds() as f64 / 1000.0;
        if dt > 0.0 && dt <= 30.0 {
            speed_dist += (w[0].speed_kmh / 3.6) * dt;
        }
    }
    if speed_dist < 100.0 {
        return 1.0;
    }
    let mut best = (f64::INFINITY, 1.0);
    for &scl in &FUZZ_SCALES {
        let mut dist = 0.0;
        let mut prev: Option<(f64, f64)> = None;
        for r in &fuzzed {
            let (lat, lon) = unfuzz(r.raw_lat, r.raw_lon, scl);
            if let Some((plat, plon)) = prev {
                dist += crate::telemetry::haversine_m(plat, plon, lat, lon);
            }
            prev = Some((lat, lon));
        }
        let rel = (dist - speed_dist).abs() / speed_dist;
        if rel < best.0 {
            best = (rel, scl);
        }
    }
    if std::env::var("GEOPLAYER_DEBUG").is_ok() {
        eprintln!(
            "fuzz scale: {:.9} (speed-derived {:.1} m, best relative error {:.3})",
            best.1, speed_dist, best.0
        );
    }
    // If no scale fits the speed data, leave the coordinates at ExifTool's
    // default rather than inventing a value.
    if best.0 > 0.5 {
        1.0
    } else {
        best.1
    }
}

fn trim_leading_zeros(s: &str) -> &str {
    s.trim_matches(|c: char| c == '\0' || c.is_whitespace())
}

/// Extract all GPS fixes from the `freeGPS` blocks pointed to by the
/// `moov/gps ` box entries.
pub fn extract_fixes(blocks: &[Vec<u8>]) -> Vec<GpsFix> {
    let mut raw_records: Vec<(Vec<u8>, bool)> = Vec::new();
    for (bi, block) in blocks.iter().enumerate() {
        let idx = find_subslice(block, b"LIGOGPSINFO");
        if std::env::var("GEOPLAYER_DEBUG").is_ok() {
            eprintln!("block {}: len={} ligogpsinfo_idx={:?}", bi, block.len(), idx);
        }
        let Some(idx) = idx else {
            continue;
        };
        // ExifTool: substr(dataPt, pos-8, 4) =~ /^\0\0\0[\x01\x14]/ with pos = idx + 0x14
        let no_fuzz = idx + 16 <= block.len()
            && ((block[idx + 12] == 0 && block[idx + 13] == 0 && block[idx + 14] == 0)
                && (block[idx + 15] == 0x01 || block[idx + 15] == 0x14));
        let pos = idx + 0x14;
        if pos >= block.len() {
            continue;
        }
        for rpos in (pos..=block.len().saturating_sub(RECORD_LEN)).step_by(RECORD_LEN) {
            let rec = &block[rpos..rpos + RECORD_LEN];
            if rec.iter().all(|&b| b == 0) {
                continue;
            }
            if rec[..4] == *b"####" {
                if std::env::var("GEOPLAYER_DEBUG").is_ok() {
                    eprintln!("  block {} rpos {}: push #### record", bi, rpos);
                }
                raw_records.push((rec.to_vec(), no_fuzz));
            } else if rec[4..].starts_with(b"/") || {
                match find_subslice(&rec[4..], b"/") {
                    Some(p) => {
                        p > 0 && p < 6 && rec[4..].iter().take(10).all(|b| b.is_ascii_digit() || *b == b'/' || *b == 0)
                    }
                    None => false,
                }
            } {
                // plaintext variant (Redtiger F9 4K)
                raw_records.push((rec.to_vec(), no_fuzz));
            }
        }
    }
    if raw_records.is_empty() {
        return Vec::new();
    }

    let rec_refs: Vec<&[u8]> = raw_records.iter().map(|(r, _)| r.as_slice()).collect();
    let cipher = Cipher::build(&rec_refs);

    let mut parsed: Vec<ParsedRecord> = Vec::with_capacity(raw_records.len());
    let debug = std::env::var("GEOPLAYER_DEBUG").is_ok();
    for (i, (rec, no_fuzz)) in raw_records.iter().enumerate() {
        let flags: u8 = if *no_fuzz { 0x03 } else { 0x00 };
        if debug {
            let end = rec[8..].iter().position(|&b| b == 0).map(|p| 8 + p).unwrap_or(rec.len());
            if i == 0 {
                eprintln!("raw record 0 hex: {}", rec[..40].iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(" "));
            }
            if let Some(c) = &cipher {
                let s = c.apply(&rec[8..end]);
                eprintln!("record {i}: deciphered = {s:?}");
            } else {
                eprintln!("record {i}: cipher not built; rec = {rec:?}");
            }
        }
        let p = if rec[..4] != *b"####" {
            // plaintext variant
            let s = String::from_utf8_lossy(&rec[4..]);
            parse_ligorecord(trim_leading_zeros(&s), 0x03)
        } else {
            // ExifTool: if the digit cipher is known, use it first; otherwise
            // try the self-describing XOR variant.
            let mut result = None;
            if let Some(c) = &cipher {
                let end = rec[8..].iter().position(|&b| b == 0).map(|p| 8 + p).unwrap_or(rec.len());
                let s = c.apply(&rec[8..end]);
                result = parse_ligorecord(s.trim(), flags);
            }
            if result.is_none() {
                if let Some(dec) = decrypt_record(rec) {
                    let s = String::from_utf8_lossy(&dec[4..]);
                    result = parse_ligorecord(trim_leading_zeros(&s), flags);
                }
            }
            result
        };
        if let Some(p) = p {
            parsed.push(p);
        }
    }

    parsed.sort_by_key(|p| p.time);
    if parsed.is_empty() {
        return Vec::new();
    }
    let fuzz_scale = choose_fuzz_scale(&parsed);
    let t0 = parsed[0].time;
    parsed
        .into_iter()
        .filter_map(|p| {
            let (lat, lon) = if p.fuzzed {
                unfuzz(p.raw_lat, p.raw_lon, fuzz_scale)
            } else {
                (p.raw_lat, p.raw_lon)
            };
            let lat = lat * p.lat_sign;
            let lon = lon * p.lon_sign;
            if lat.abs() > 90.0 || lon.abs() > 180.0 {
                return None;
            }
            Some(GpsFix {
                t_utc: p.time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                t_ms: p.time.timestamp_millis(),
                rel_ms: (p.time - t0).num_milliseconds(),
                lat,
                lon,
                speed_kmh: p.speed_kmh as f32,
                accel: p.accel,
                coords_assumed: p.coords_assumed,
                altitude_m: None,
                sats: None,
            })
        })
        .collect()
}
