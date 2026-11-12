//! NMEA 0183 and ISO 6709 decoding.
//!
//! Novatek based dashcams write their track into `freeGPS` blocks (see
//! `ligogps.rs`), but most other vendors (Ambarella, Vantrue, Blackvue,
//! Nextbase, Garmin, DJI, …) simply keep the raw NMEA sentences the GPS
//! module produced. Those sentences end up in an MP4 atom, next to the clip in
//! a sidecar log, or in a plain text blob inside the container.
//!
//! This module turns any of those into the same `GpsFix` list the rest of
//! GeoPlayer works with.

use chrono::{NaiveDate, NaiveTime, Timelike};

/// A single decoded position sample.
#[derive(Debug, Clone)]
pub struct NmeaFix {
    /// `None` when the sentences carried no date (the caller supplies one).
    pub date: Option<NaiveDate>,
    pub time: NaiveTime,
    pub lat: f64,
    pub lon: f64,
    pub speed_kmh: f64,
    pub altitude_m: Option<f64>,
    pub sats: Option<u32>,
}

const KNOTS_TO_KMH: f64 = 1.852;

#[derive(Debug, Clone, Default)]
struct Sample {
    lat: Option<f64>,
    lon: Option<f64>,
    speed_kmh: Option<f64>,
    time: Option<NaiveTime>,
    date: Option<NaiveDate>,
    altitude_m: Option<f64>,
    sats: Option<u32>,
}

/// Parse `ddmm.mmmm` / `dddmm.mmmm` plus a hemisphere into decimal degrees.
fn parse_coord(value: &str, hemi: &str) -> Option<f64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let raw: f64 = value.parse().ok()?;
    let deg = (raw / 100.0).floor();
    let minutes = raw - deg * 100.0;
    if minutes >= 60.0 {
        return None;
    }
    let mut dec = deg + minutes / 60.0;
    match hemi.trim().to_ascii_uppercase().as_str() {
        "S" | "W" => dec = -dec,
        "N" | "E" => {}
        _ => return None,
    }
    Some(dec)
}

fn parse_time(value: &str) -> Option<NaiveTime> {
    let v = value.trim();
    if v.len() < 6 {
        return None;
    }
    let hh: u32 = v.get(0..2)?.parse().ok()?;
    let mm: u32 = v.get(2..4)?.parse().ok()?;
    let ss: f64 = v.get(4..6)?.parse().ok()?;
    let hour = hh.min(23);
    let minute = mm.min(59);
    let second = ss.clamp(0.0, 59.999);
    NaiveTime::from_hms_micro_opt(hour, minute, second as u32, ((second.fract()) * 1_000_000.0) as u32)
        .or_else(|| NaiveTime::from_hms_opt(hour, minute, second as u32))
}

/// `ddmmyy` as written by RMC.
fn parse_ddmmyy(value: &str) -> Option<NaiveDate> {
    let v = value.trim();
    if v.len() < 6 {
        return None;
    }
    let day: u32 = v.get(0..2)?.parse().ok()?;
    let month: u32 = v.get(2..4)?.parse().ok()?;
    let year: i32 = v.get(4..6)?.parse().ok()?;
    let year = if year < 80 { 2000 + year } else { 1900 + year };
    NaiveDate::from_ymd_opt(year, month, day)
}

fn time_key(t: NaiveTime) -> i64 {
    t.hour() as i64 * 3600 + t.minute() as i64 * 60 + t.second() as i64
}

/// Decode a run of NMEA sentences into fixes.
///
/// `fallback_date` is used for sentences that carry a time but no date (most
/// dashcams only write the date once, in the RMC sentence).
pub fn parse_nmea(text: &str, fallback_date: Option<NaiveDate>) -> Vec<NmeaFix> {
    let mut samples: std::collections::BTreeMap<i64, Sample> = std::collections::BTreeMap::new();
    let mut last_key: Option<i64> = None;
    let mut last_date: Option<NaiveDate> = None;

    for raw in text.split(|c| c == '\n' || c == '\r') {
        let line = raw.trim();
        if !line.starts_with('$') {
            continue;
        }
        let body = line[1..].split('*').next().unwrap_or(&line[1..]);
        let fields: Vec<&str> = body.split(',').collect();
        if fields.len() < 2 || fields[0].len() < 3 {
            continue;
        }
        let kind = &fields[0][fields[0].len() - 3..];

        match kind {
            "RMC" => {
                if fields.len() < 10 {
                    continue;
                }
                let Some(time) = parse_time(fields[1]) else { continue };
                let Some(lat) = parse_coord(fields[3], fields[4]) else { continue };
                let Some(lon) = parse_coord(fields[5], fields[6]) else { continue };
                let speed = fields[7].trim().parse::<f64>().ok().map(|k| k * KNOTS_TO_KMH);
                let date = parse_ddmmyy(fields[9]).or(last_date);
                if let Some(d) = date {
                    last_date = Some(d);
                }
                let key = time_key(time);
                last_key = Some(key);
                let entry = samples.entry(key).or_default();
                entry.lat = Some(lat);
                entry.lon = Some(lon);
                entry.time = Some(time);
                if let Some(s) = speed {
                    entry.speed_kmh = Some(s);
                }
                if let Some(d) = date {
                    entry.date = Some(d);
                }
            }
            "GGA" => {
                if fields.len() < 10 {
                    continue;
                }
                let Some(time) = parse_time(fields[1]) else { continue };
                let Some(lat) = parse_coord(fields[2], fields[3]) else { continue };
                let Some(lon) = parse_coord(fields[4], fields[5]) else { continue };
                let sats = fields[7].trim().parse::<u32>().ok();
                let alt = fields[9].trim().parse::<f64>().ok();
                let key = time_key(time);
                last_key = Some(key);
                let entry = samples.entry(key).or_default();
                entry.lat = Some(lat);
                entry.lon = Some(lon);
                entry.time = Some(time);
                if let Some(s) = sats {
                    entry.sats = Some(s);
                }
                if let Some(a) = alt {
                    entry.altitude_m = Some(a);
                }
            }
            "GLL" => {
                if fields.len() < 6 {
                    continue;
                }
                let Some(lat) = parse_coord(fields[1], fields[2]) else { continue };
                let Some(lon) = parse_coord(fields[3], fields[4]) else { continue };
                let time = parse_time(fields[5]);
                let key = match time {
                    Some(t) => time_key(t),
                    None => match last_key {
                        Some(k) => k,
                        None => continue,
                    },
                };
                let entry = samples.entry(key).or_default();
                entry.lat = Some(lat);
                entry.lon = Some(lon);
                if let Some(t) = time {
                    entry.time = Some(t);
                }
            }
            "VTG" => {
                if fields.len() < 8 {
                    continue;
                }
                let kph = fields[7].trim().parse::<f64>().ok();
                let knots = fields[5].trim().parse::<f64>().ok().map(|k| k * KNOTS_TO_KMH);
                let speed = kph.or(knots);
                let Some(speed) = speed else { continue };
                let Some(key) = last_key else { continue };
                if let Some(entry) = samples.get_mut(&key) {
                    entry.speed_kmh = Some(speed);
                }
            }
            "ZDA" => {
                if fields.len() < 5 {
                    continue;
                }
                let day = fields[2].trim().parse::<u32>().ok();
                let month = fields[3].trim().parse::<u32>().ok();
                let year = fields[4].trim().parse::<i32>().ok();
                if let (Some(day), Some(month), Some(year)) = (day, month, year) {
                    if let Some(date) = NaiveDate::from_ymd_opt(year, month, day) {
                        last_date = Some(date);
                        if let Some(key) = last_key {
                            if let Some(entry) = samples.get_mut(&key) {
                                entry.date = Some(date);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    samples
        .into_values()
        .filter_map(|s| {
            let lat = s.lat?;
            let lon = s.lon?;
            let time = s.time?;
            Some(NmeaFix {
                date: s.date.or(last_date).or(fallback_date),
                time,
                lat,
                lon,
                speed_kmh: s.speed_kmh.unwrap_or(0.0),
                altitude_m: s.altitude_m,
                sats: s.sats,
            })
        })
        .collect()
}

/// Sentence types we understand, used when hunting for NMEA inside binaries.
const KNOWN: [&str; 8] = ["RMC", "GGA", "GLL", "VTG", "GSA", "GSV", "ZDA", "GST"];

/// Collect the NMEA sentences of an arbitrary byte blob as text.
///
/// Dashcams store the track either as clean text or mixed into a binary
/// structure, so the blob is scanned for `$` markers and every candidate
/// sentence is validated before it is accepted.
pub fn extract_sentence_text(data: &[u8]) -> String {
    let mut text = String::with_capacity(data.len().min(1 << 20));
    let mut start = 0usize;
    while start < data.len() {
        let Some(rel) = memchr::memchr(b'$', &data[start..]) else { break };
        let pos = start + rel;
        let end = data[pos + 1..]
            .iter()
            .position(|&b| b == b'\r' || b == b'\n' || b == 0)
            .map(|p| p + 1)
            .unwrap_or(0)
            .min(512);
        let candidate = &data[pos..pos + end];
        if candidate.len() > 8 {
            let kind = &candidate[3..6];
            let talker_ok = candidate[1] == b'G' || candidate[1] == b'P';
            if talker_ok && KNOWN.iter().any(|k| k.as_bytes() == kind) {
                text.push_str(&String::from_utf8_lossy(candidate));
                text.push('\n');
            }
        }
        start = pos + 1;
    }
    text
}

/// Pull NMEA sentences out of an arbitrary byte blob and decode them.
pub fn extract_from_blob(data: &[u8]) -> Vec<NmeaFix> {
    let text = extract_sentence_text(data);
    if text.is_empty() {
        return Vec::new();
    }
    parse_nmea(&text, None)
}

/// Parse an ISO 6709 position such as `+30.09199+078.54575+1234.5/`.
/// Used by QuickTime's `©xyz` atom and several other muxers.
pub fn parse_iso6709(value: &str) -> Option<(f64, f64, Option<f64>)> {
    let s = value
        .trim()
        .trim_matches(|c: char| c == '\0' || c.is_whitespace());
    if s.is_empty() {
        return None;
    }

    // latitude
    let (lat_raw, lat_len, lat_frac, lat_signed) = parse_iso_number(s)?;
    let mut pos = lat_len;
    let mut lat_sign = 1.0;
    if let Some(c) = s[pos..].chars().next() {
        if c.eq_ignore_ascii_case(&'S') {
            if !lat_signed {
                lat_sign = -1.0;
            }
            pos += 1;
        } else if c.eq_ignore_ascii_case(&'N') {
            pos += 1;
        }
    }
    let lat = lat_sign * iso_to_degrees(lat_raw, lat_frac, 90.0)?;

    // longitude
    let (lon_raw, lon_len, lon_frac, lon_signed) = parse_iso_number(&s[pos..])?;
    pos += lon_len;
    let mut lon_sign = 1.0;
    if let Some(c) = s[pos..].chars().next() {
        if c.eq_ignore_ascii_case(&'W') {
            if !lon_signed {
                lon_sign = -1.0;
            }
            pos += 1;
        } else if c.eq_ignore_ascii_case(&'E') {
            pos += 1;
        }
    }
    let lon = lon_sign * iso_to_degrees(lon_raw, lon_frac, 180.0)?;

    // optional altitude
    let rest = s[pos..].trim_start_matches('/');
    let alt = parse_iso_number(rest)
        .map(|(v, _, _, _)| v)
        .filter(|v| *v != 0.0);

    Some((lat, lon, alt))
}

/// Read one signed number from the front of `s`.
///
/// Returns the value, how many bytes were consumed and the number of digits
/// in front of the decimal point (which tells degrees from degrees+minutes).
fn parse_iso_number(s: &str) -> Option<(f64, usize, usize, bool)> {
    let bytes = s.as_bytes();
    let mut i = 0usize;
    let mut sign = 1.0;
    let mut signed = false;
    match bytes.first() {
        Some(b'+') => {
            i = 1;
            signed = true;
        }
        Some(b'-') => {
            sign = -1.0;
            i = 1;
            signed = true;
        }
        _ => {}
    }
    let start = i;
    while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
        i += 1;
    }
    if i == start {
        return None;
    }
    let digits = &s[start..i];
    let int_len = digits.split('.').next().map(|d| d.len()).unwrap_or(0);
    let raw: f64 = digits.parse().ok()?;
    Some((sign * raw, i, int_len, signed))
}

/// ISO 6709 mixes decimal degrees (`30.09199`) and degrees+minutes
/// (`3015.319`); four or more leading digits mean degrees and minutes.
fn iso_to_degrees(raw: f64, int_len: usize, limit: f64) -> Option<f64> {
    let sign = if raw < 0.0 { -1.0 } else { 1.0 };
    let abs = raw.abs();
    let dec = if int_len >= 4 {
        let deg = (abs / 100.0).floor();
        let minutes = abs - deg * 100.0;
        if minutes >= 60.0 {
            return None;
        }
        deg + minutes / 60.0
    } else {
        abs
    };
    if dec > limit {
        return None;
    }
    Some(sign * dec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rmc_gga_stream() {
        let text = "$GPRMC,123519.00,A,4807.0380,N,01131.0000,E,022.4,084.4,230394,003.1,W*6A\r\n\
                    $GPGGA,123519.00,4807.0380,N,01131.0000,E,1,08,0.9,545.4,M,46.9,M,,*47\r\n\
                    $GPRMC,123520.00,A,4807.0390,N,01131.0010,E,030.0,084.4,230394,003.1,W*6B\r\n";
        let fixes = parse_nmea(text, None);
        assert_eq!(fixes.len(), 2);
        assert!((fixes[0].lat - 48.1173).abs() < 1e-3);
        assert!((fixes[0].lon - 11.51667).abs() < 1e-3);
        assert!((fixes[0].speed_kmh - 22.4 * 1.852).abs() < 1e-3);
        assert_eq!(fixes[0].date, NaiveDate::from_ymd_opt(1994, 3, 23));
        assert!((fixes[0].altitude_m.unwrap() - 545.4).abs() < 1e-6);
    }

    #[test]
    fn parses_southern_and_western_hemisphere() {
        let text = "$GNRMC,101112.00,A,3352.0000,S,15112.0000,W,010.0,000.0,120820,,,A*XX\r\n";
        let fixes = parse_nmea(text, None);
        assert_eq!(fixes.len(), 1);
        assert!(fixes[0].lat < 0.0);
        assert!(fixes[0].lon < 0.0);
        assert!((fixes[0].lat + 33.866667).abs() < 1e-3);
    }

    #[test]
    fn extracts_sentences_from_binary_blob() {
        let mut blob = vec![0u8; 32];
        blob.extend_from_slice(b"$GPRMC,123519.00,A,4807.0380,N,01131.0000,E,022.4,084.4,230394,003.1,W*6A");
        blob.extend_from_slice(&[0u8; 16]);
        blob.extend_from_slice(b"$GPGGA,123519.00,4807.0380,N,01131.0000,E,1,08,0.9,545.4,M,46.9,M,,*47");
        let fixes = extract_from_blob(&blob);
        assert_eq!(fixes.len(), 1);
        assert!(fixes[0].lat > 48.0);
    }

    #[test]
    fn parses_iso6709() {
        let (lat, lon, alt) = parse_iso6709("+30.09199+078.54575+1234.5/").unwrap();
        assert!((lat - 30.09199).abs() < 1e-5);
        assert!((lon - 78.54575).abs() < 1e-5);
        assert_eq!(alt, Some(1234.5));
    }

    #[test]
    fn parses_iso6709_degrees_minutes() {
        let (lat, lon, _) = parse_iso6709("-3015.319N+15112.500E/").unwrap();
        assert!((lat - -30.255316).abs() < 1e-4);
        assert!((lon - 151.208333).abs() < 1e-4);
    }
}
