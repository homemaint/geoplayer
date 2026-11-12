use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Accelerometer {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GpsFix {
    pub t_utc: String,
    pub t_ms: i64,
    pub rel_ms: i64,
    pub lat: f64,
    pub lon: f64,
    pub speed_kmh: f32,
    pub accel: Option<Accelerometer>,
    pub coords_assumed: bool,
    /// Metres above sea level (only some dashcams record it)
    pub altitude_m: Option<f64>,
    /// Satellites in view
    pub sats: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HarshEvent {
    pub t_rel_ms: i64,
    pub kind: String,
    pub delta_kmh: f32,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VideoTelemetry {
    pub path: String,
    pub file_name: String,
    pub duration_secs: f64,
    pub created_utc: Option<String>,
    pub size_bytes: u64,
    pub fixes: Vec<GpsFix>,
    pub gps_source: String,
    pub coords_assumed: bool,
    pub distance_m: f64,
    pub max_speed_kmh: f32,
    pub avg_speed_kmh: f32,
    pub events: Vec<HarshEvent>,
}

pub fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6371000.0;
    let d_lat = (lat2 - lat1).to_radians();
    let d_lon = (lon2 - lon1).to_radians();
    let a = (d_lat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (d_lon / 2.0).sin().powi(2);
    2.0 * R * a.asin().sqrt()
}

/// Compute trip stats from fixes. `window_secs`: window for speed-drop detection.
pub fn compute_stats(fixes: &[GpsFix]) -> (f64, f32, f32, Vec<HarshEvent>) {
    if fixes.is_empty() {
        return (0.0, 0.0, 0.0, Vec::new());
    }
    let mut dist = 0.0;
    let mut max_speed = 0.0f32;
    let mut sum_speed = 0.0f64;
    let mut events = Vec::new();

    for w in fixes.windows(2) {
        dist += haversine_m(w[0].lat, w[0].lon, w[1].lat, w[1].lon);
    }
    for f in fixes {
        max_speed = max_speed.max(f.speed_kmh);
        sum_speed += f.speed_kmh as f64;
    }
    let avg_speed = (sum_speed / fixes.len() as f64) as f32;

    // harsh braking / acceleration / impact detection
    for i in 0..fixes.len() {
        let t = fixes[i].t_ms;
        // check G-force spikes on this fix
        if let Some(acc) = &fixes[i].accel {
            let lat_g = acc.y.abs();
            if lat_g >= 0.55 {
                events.push(HarshEvent {
                    t_rel_ms: fixes[i].rel_ms,
                    kind: "Sharp cornering".into(),
                    delta_kmh: lat_g * 35.0,
                });
            }
        }
        for j in i + 1..fixes.len() {
            let dt = fixes[j].t_ms - t;
            if dt > 2000 {
                break;
            }
            let drop = fixes[i].speed_kmh - fixes[j].speed_kmh;
            let gain = fixes[j].speed_kmh - fixes[i].speed_kmh;
            if drop >= 30.0 {
                events.push(HarshEvent {
                    t_rel_ms: fixes[j].rel_ms,
                    kind: "Emergency braking".into(),
                    delta_kmh: drop,
                });
                break;
            } else if drop >= 18.0 && dt <= 2000 {
                events.push(HarshEvent {
                    t_rel_ms: fixes[j].rel_ms,
                    kind: "Harsh braking".into(),
                    delta_kmh: drop,
                });
                break;
            } else if gain >= 22.0 && dt <= 2000 {
                events.push(HarshEvent {
                    t_rel_ms: fixes[j].rel_ms,
                    kind: "Rapid acceleration".into(),
                    delta_kmh: gain,
                });
                break;
            }
        }
    }
    // dedupe events that are within 2 s of each other (keep the largest drop)
    events.sort_by_key(|e| e.t_rel_ms);
    let mut deduped: Vec<HarshEvent> = Vec::new();
    for e in events {
        if let Some(last) = deduped.last_mut() {
            if e.t_rel_ms - last.t_rel_ms < 2000 {
                if e.delta_kmh > last.delta_kmh {
                    *last = e;
                }
                continue;
            }
        }
        deduped.push(e);
    }
    (dist, max_speed, avg_speed, deduped)
}
