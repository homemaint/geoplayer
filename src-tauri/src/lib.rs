mod ligogps;
mod mp4;
mod nmea;
#[cfg(windows)]
mod screenshot;
mod telemetry;
mod tomtom;

use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};
use telemetry::{compute_stats, Accelerometer, GpsFix, VideoTelemetry};

/// Sidecar log files dashcams often write next to the video.
const SIDECAR_EXTENSIONS: [&str; 5] = ["nmea", "gps", "log", "txt", "csv"];

/// Build a `GpsFix` list out of decoded positions.
fn fixes_from_times(
    samples: Vec<(chrono::DateTime<Utc>, f64, f64, f64, Option<f64>, Option<u32>)>,
) -> Vec<GpsFix> {
    if samples.is_empty() {
        return Vec::new();
    }
    let t0 = samples[0].0;
    samples
        .into_iter()
        .map(|(time, lat, lon, speed_kmh, altitude_m, sats)| GpsFix {
            t_utc: time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            t_ms: time.timestamp_millis(),
            rel_ms: (time - t0).num_milliseconds(),
            lat,
            lon,
            speed_kmh: speed_kmh as f32,
            accel: None::<Accelerometer>,
            coords_assumed: false,
            altitude_m,
            sats,
        })
        .collect()
}

/// Convert the NMEA samples into UTC timestamps.
fn nmea_to_fixes(
    fixes: &[nmea::NmeaFix],
    fallback_date: Option<NaiveDate>,
) -> Vec<GpsFix> {
    let mut samples: Vec<(chrono::DateTime<Utc>, f64, f64, f64, Option<f64>, Option<u32>)> =
        Vec::new();
    for f in fixes {
        let Some(date) = f.date.or(fallback_date) else { continue };
        let naive = NaiveDateTime::new(date, f.time);
        let time = Utc.from_utc_datetime(&naive);
        samples.push((time, f.lat, f.lon, f.speed_kmh, f.altitude_m, f.sats));
    }
    samples.sort_by_key(|s| s.0);
    samples.dedup_by_key(|s| s.0.timestamp());
    fixes_from_times(samples)
}

/// Look for a sidecar GPS log next to the video.
fn read_sidecar(video: &std::path::Path) -> Option<(String, Vec<u8>)> {
    let stem = video.file_stem()?.to_string_lossy().into_owned();
    let dir = video.parent()?;
    for ext in SIDECAR_EXTENSIONS {
        let candidate = dir.join(format!("{stem}.{ext}"));
        if let Ok(data) = std::fs::read(&candidate) {
            if !data.is_empty() {
                return Some((candidate.to_string_lossy().into_owned(), data));
            }
        }
    }
    None
}

/// Scan the whole file for NMEA sentences (some cameras mux the raw GPS
/// stream into the media data instead of a dedicated atom).
///
/// The file is streamed in chunks so a 4 GB clip does not have to be held in
/// memory; sentences that straddle a chunk border are kept in a small carry
/// buffer.
fn scan_file_for_nmea(video: &std::path::Path) -> Vec<nmea::NmeaFix> {
    use std::io::Read;
    /// Upper bound for the raw scan — long clips would otherwise block the UI.
    const MAX_SCAN_BYTES: u64 = 1024 * 1024 * 1024;
    let Ok(mut f) = std::fs::File::open(video) else { return Vec::new() };
    let mut buf = vec![0u8; 8 * 1024 * 1024];
    let mut carry: Vec<u8> = Vec::new();
    let mut text = String::new();
    let mut scanned: u64 = 0;
    loop {
        let n = match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        scanned += n as u64;
        let mut chunk = std::mem::take(&mut carry);
        chunk.extend_from_slice(&buf[..n]);
        text.push_str(&nmea::extract_sentence_text(&chunk));
        // keep the tail so a sentence split across chunks is still found
        let keep = chunk.len().saturating_sub(1024);
        carry = chunk[keep..].to_vec();
        if scanned >= MAX_SCAN_BYTES {
            break;
        }
    }
    if text.is_empty() {
        return Vec::new();
    }
    nmea::parse_nmea(&text, None)
}

fn load_telemetry(path: &str) -> Result<VideoTelemetry, String> {
    let p = std::path::Path::new(path);
    let meta = std::fs::metadata(p).map_err(|e| format!("Cannot read file: {e}"))?;
    let size_bytes = meta.len();

    let container = mp4::read_container(p).map_err(|e| format!("Cannot parse MP4 structure: {e}"))?;

    // read freeGPS blocks (vector of raw block bytes)
    let mut blocks: Vec<Vec<u8>> = Vec::new();
    for (off, size) in &container.indexed_blocks {
        if *size == 0 || *size > 4 * 1024 * 1024 {
            continue;
        }
        if let Ok(buf) = mp4::read_block(p, *off, *size) {
            blocks.push(buf);
        }
    }

    let fallback_date = container
        .created_unix
        .and_then(|s| chrono::DateTime::<Utc>::from_timestamp(s, 0))
        .map(|d| d.date_naive())
        .or_else(|| {
            // some muxers do not write a creation time — fall back to the file
            // timestamp, which dashcams usually keep correct
            meta.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|d| chrono::DateTime::<Utc>::from_timestamp(d.as_secs() as i64, 0))
                .map(|d| d.date_naive())
        });

    let mut fixes: Vec<GpsFix> = Vec::new();
    let mut gps_source = String::new();
    let mut carrier_found = !container.indexed_blocks.is_empty();

    // 1. Novatek / LigoGPS (freeGPS blocks)
    let novatek = ligogps::extract_fixes(&blocks);
    if !novatek.is_empty() {
        fixes = novatek;
        gps_source = "Novatek freeGPS".to_string();
    }

    // 2. NMEA sentences inside a telemetry atom of the container
    if fixes.is_empty() {
        for (name, blob) in &container.blobs {
            carrier_found = true;
            let nmea_fixes = nmea::extract_from_blob(blob);
            if nmea_fixes.len() >= 2 {
                fixes = nmea_to_fixes(&nmea_fixes, fallback_date);
                if !fixes.is_empty() {
                    gps_source = format!("NMEA ({name})");
                    break;
                }
            }
        }
    }

    // 3. NMEA sidecar file next to the video
    if fixes.is_empty() {
        if let Some((sidecar, data)) = read_sidecar(p) {
            carrier_found = true;
            let nmea_fixes = nmea::extract_from_blob(&data);
            if nmea_fixes.len() >= 2 {
                fixes = nmea_to_fixes(&nmea_fixes, fallback_date);
                if !fixes.is_empty() {
                    gps_source = format!("NMEA sidecar ({})", sidecar_name(&sidecar));
                }
            }
        }
    }

    // 4. NMEA muxed into the media data
    if fixes.is_empty() {
        let nmea_fixes = scan_file_for_nmea(p);
        if nmea_fixes.len() >= 2 {
            fixes = nmea_to_fixes(&nmea_fixes, fallback_date);
            if !fixes.is_empty() {
                gps_source = "NMEA (embedded)".to_string();
            }
        }
    }

    // 5. A single ISO 6709 position (QuickTime `©xyz` and friends)
    if fixes.is_empty() {
        for (_name, blob) in &container.blobs {
            let text = String::from_utf8_lossy(blob);
            for part in text.split(['\0', '\n', '\r', ' ']) {
                if let Some((lat, lon, alt)) = nmea::parse_iso6709(part) {
                    let time = container
                        .created_unix
                        .and_then(|s| chrono::DateTime::<Utc>::from_timestamp(s, 0))
                        .unwrap_or_else(|| Utc.timestamp_opt(0, 0).unwrap());
                    fixes = fixes_from_times(vec![(time, lat, lon, 0.0, alt, None)]);
                    gps_source = "ISO 6709 position".to_string();
                    break;
                }
            }
            if !fixes.is_empty() {
                break;
            }
        }
    }

    if fixes.is_empty() {
        gps_source = if carrier_found {
            "undecodable".to_string()
        } else {
            "none".to_string()
        };
    }
    let coords_assumed = fixes.iter().any(|f| f.coords_assumed);

    let (distance_m, max_speed_kmh, avg_speed_kmh, events) = compute_stats(&fixes);

    let created_utc = container.created_unix.and_then(|s| {
        chrono::DateTime::<chrono::Utc>::from_timestamp(s, 0)
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    });

    Ok(VideoTelemetry {
        path: path.to_string(),
        file_name: p
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string()),
        duration_secs: container.duration_secs,
        created_utc,
        size_bytes,
        fixes,
        gps_source,
        coords_assumed,
        distance_m,
        max_speed_kmh,
        avg_speed_kmh,
        events,
    })
}

fn sidecar_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

#[tauri::command]
fn load_video(path: String) -> Result<VideoTelemetry, String> {
    load_telemetry(&path)
}

#[tauri::command]
fn list_videos(dir: String) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Cannot read folder: {e}"))?;
    let mut out: Vec<String> = Vec::new();
    let exts = ["mp4", "mov", "m4v", "avi", "ts", "mts", "mkv"];
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if exts.contains(&ext.to_ascii_lowercase().as_str()) {
                    out.push(path.to_string_lossy().into_owned());
                }
            }
        }
    }
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(out)
}

#[tauri::command]
fn export_gpx(path: String, gpx: String) -> Result<(), String> {
    std::fs::write(&path, gpx).map_err(|e| format!("Cannot write GPX: {e}"))
}

/// Capture the whole GeoPlayer window to Pictures\GeoPlayer and return the path.
#[tauri::command]
fn capture_screenshot(window: tauri::WebviewWindow) -> Result<String, String> {
    #[cfg(windows)]
    {
        screenshot::capture(&window)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Err("Screenshots are only supported on Windows".into())
    }
}

/// Enrich a GPS track with TomTom Snap-to-Roads, Nearby POIs, and Reverse Geocoding (cached on disk).
#[tauri::command]
fn tomtom_enrich(
    key: String,
    fixes: Vec<tomtom::FixInput>,
    event_indices: Vec<usize>,
) -> Result<tomtom::RouteEnrichment, String> {
    tomtom::enrich_route(&key, &fixes, &event_indices)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_video,
            list_videos,
            export_gpx,
            capture_screenshot,
            tomtom_enrich
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_sample_if_available() {
        let Ok(path) = std::env::var("GEOPLAYER_SAMPLE") else {
            eprintln!("GEOPLAYER_SAMPLE not set; skipping");
            return;
        };
        let t = load_telemetry(&path).expect("load");
        eprintln!("fixes: {}", t.fixes.len());
        for f in &t.fixes {
            eprintln!("{}  {:.6} {:.6}  {:.2} km/h", f.t_utc, f.lat, f.lon, f.speed_kmh);
        }
        assert!(!t.fixes.is_empty(), "no GPS fixes decoded");
        assert_eq!(t.fixes.len(), 60);
        let first = &t.fixes[0];
        let last = t.fixes.last().unwrap();
        assert!((first.lat - 30.091990).abs() < 0.001, "first lat {}", first.lat);
        assert!((first.lon - 78.545753).abs() < 0.001, "first lon {}", first.lon);
        assert!((last.lat - 30.087225).abs() < 0.001, "last lat {}", last.lat);
        assert!((last.lon - 78.547472).abs() < 0.001, "last lon {}", last.lon);
        assert!(t.max_speed_kmh > 40.0);
        eprintln!("distance: {:.1} m, max {:.1} km/h, avg {:.1} km/h, events: {:?}",
            t.distance_m, t.max_speed_kmh, t.avg_speed_kmh, t.events.len());
    }

    fn box_of(typ: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::with_capacity(payload.len() + 8);
        v.extend_from_slice(&((payload.len() + 8) as u32).to_be_bytes());
        v.extend_from_slice(typ);
        v.extend_from_slice(payload);
        v
    }

    /// A clip from a non-Novatek dashcam: the GPS track is stored as plain
    /// NMEA sentences inside a telemetry atom.
    #[test]
    fn decodes_nmea_track_from_container() {
        let dir = std::env::temp_dir().join("geoplayer-nmea-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("clip.mp4");

        let sentences = concat!(
            "$GPRMC,123519.00,A,3015.3190,N,07832.7450,E,020.0,084.4,241025,003.1,W*6A\r\n",
            "$GPGGA,123519.00,3015.3190,N,07832.7450,E,1,08,0.9,545.4,M,46.9,M,,*47\r\n",
            "$GPRMC,123520.00,A,3015.3200,N,07832.7460,E,030.0,084.4,241025,003.1,W*6B\r\n",
            "$GPRMC,123521.00,A,3015.3210,N,07832.7470,E,030.0,084.4,241025,003.1,W*6C\r\n",
        );

        let mut mvhd = vec![0u8; 20];
        mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes()); // timescale
        mvhd[16..20].copy_from_slice(&60_000u32.to_be_bytes()); // 60 s

        let mut data = Vec::new();
        data.extend_from_slice(&box_of(b"ftyp", b"isom\0\0\x02\0isomiso2"));
        data.extend_from_slice(&box_of(b"nmea", sentences.as_bytes()));
        data.extend_from_slice(&box_of(b"moov", &box_of(b"mvhd", &mvhd)));
        std::fs::write(&path, &data).expect("write clip");

        let t = load_telemetry(path.to_str().unwrap()).expect("load");
        eprintln!("source: {} fixes: {}", t.gps_source, t.fixes.len());
        assert!(t.gps_source.starts_with("NMEA"), "source {}", t.gps_source);
        assert_eq!(t.fixes.len(), 3);
        let first = &t.fixes[0];
        assert!((first.lat - 30.255316).abs() < 1e-4, "lat {}", first.lat);
        assert!((first.lon - 78.54575).abs() < 1e-4, "lon {}", first.lon);
        assert!((first.speed_kmh - 20.0 * 1.852).abs() < 0.1);
        assert_eq!(first.rel_ms, 0);
        assert_eq!(t.fixes[1].rel_ms, 1000);
        assert_eq!(t.fixes[2].rel_ms, 2000);
        assert!(t.distance_m > 0.0);

        std::fs::remove_file(&path).ok();
    }

    /// The same track delivered as a sidecar log next to the video.
    #[test]
    fn decodes_nmea_sidecar() {
        let dir = std::env::temp_dir().join("geoplayer-sidecar-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("clip.mp4");

        let mut mvhd = vec![0u8; 20];
        mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&60_000u32.to_be_bytes());
        let mut data = Vec::new();
        data.extend_from_slice(&box_of(b"moov", &box_of(b"mvhd", &mvhd)));
        std::fs::write(&path, &data).expect("write clip");

        std::fs::write(
            dir.join("clip.nmea"),
            "$GPRMC,123519.00,A,3015.3190,N,07832.7450,E,020.0,084.4,241025,003.1,W*6A\r\n\
             $GPRMC,123520.00,A,3015.3200,N,07832.7460,E,030.0,084.4,241025,003.1,W*6B\r\n",
        )
        .expect("write sidecar");

        let t = load_telemetry(path.to_str().unwrap()).expect("load");
        eprintln!("source: {} fixes: {}", t.gps_source, t.fixes.len());
        assert!(t.gps_source.starts_with("NMEA sidecar"), "source {}", t.gps_source);
        assert_eq!(t.fixes.len(), 2);

        std::fs::remove_file(&path).ok();
        std::fs::remove_file(dir.join("clip.nmea")).ok();
    }
}
