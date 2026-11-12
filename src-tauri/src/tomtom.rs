//! TomTom REST proxy & disk cache for GeoPlayer.
//!
//! Endpoints used (all optional, requiring a free TomTom developer key):
//! 1. **Snap to Roads v1** (`POST /snap-to-roads/1/snap-to-roads`)
//!    Matches the GPS track to the road network and returns road names, highway
//!    route numbers, municipality, and posted speed limits per segment.
//! 2. **Search v2 Nearby** (`GET /search/2/nearbySearch/.json`)
//!    Fetches fresh POIs (fuel, tolls, hospitals, temples, restaurants, towns)
//!    around sampled route points.
//! 3. **Reverse Geocode v2** (`GET /search/2/reverseGeocode/{lat},{lon}.json`)
//!    Resolves a human-readable street address for harsh-braking / incident events.
//!
//! Every response is cached on disk (`%LOCALAPPDATA%/GeoPlayer/tomtom_cache`) so
//! replaying a clip never consumes another API transaction.

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnappedFix {
    pub fix_index: usize,
    pub lat: f64,
    pub lon: f64,
    pub road_name: Option<String>,
    pub road_ref: Option<String>,
    pub place: Option<String>,
    pub speed_limit_kmh: Option<f32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TomTomPoi {
    pub name: String,
    pub category: String,
    pub kind: String, // "poi" | "place" | "peak" | "water"
    pub lat: f64,
    pub lon: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RouteEnrichment {
    pub snapped: Vec<SnappedFix>,
    pub pois: Vec<TomTomPoi>,
    pub event_addresses: Vec<(usize, String)>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FixInput {
    pub lat: f64,
    pub lon: f64,
    pub t_utc: String,
}

fn cache_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("GeoPlayer").join("tomtom_cache");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn cache_path(namespace: &str, key_data: &str) -> Option<PathBuf> {
    let mut hasher = DefaultHasher::new();
    namespace.hash(&mut hasher);
    key_data.hash(&mut hasher);
    let hash = hasher.finish();
    Some(cache_dir()?.join(format!("{namespace}_{hash:016x}.json")))
}

fn read_cache<T: for<'de> Deserialize<'de>>(namespace: &str, key_data: &str) -> Option<T> {
    let path = cache_path(namespace, key_data)?;
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_cache<T: Serialize>(namespace: &str, key_data: &str, val: &T) {
    if let Some(path) = cache_path(namespace, key_data) {
        if let Ok(bytes) = serde_json::to_vec(val) {
            let _ = std::fs::write(path, bytes);
        }
    }
}

fn build_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(8))
        .user_agent("GeoPlayer/0.2 (dashcam telemetry)")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

/// Enrich a GPS track using TomTom Snap-to-Roads, Nearby Search, and Reverse Geocode.
pub fn enrich_route(
    api_key: &str,
    fixes: &[FixInput],
    event_fix_indices: &[usize],
) -> Result<RouteEnrichment, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("No TomTom API key configured.".into());
    }
    if fixes.is_empty() {
        return Ok(RouteEnrichment {
            snapped: Vec::new(),
            pois: Vec::new(),
            event_addresses: Vec::new(),
        });
    }

    let first = &fixes[0];
    let last = &fixes[fixes.len() - 1];
    let sig = format!(
        "v1:{}:{:.4},{:.4}:{:.4},{:.4}:{:?}",
        fixes.len(),
        first.lat,
        first.lon,
        last.lat,
        last.lon,
        event_fix_indices
    );
    if let Some(cached) = read_cache::<RouteEnrichment>("enrich", &sig) {
        return Ok(cached);
    }

    let client = build_client()?;

    // 1. Snap to roads (subsample to <= 120 points to keep payload small and fast)
    let snapped = snap_to_roads(&client, key, fixes).unwrap_or_default();

    // 2. Nearby POIs along the route (up to 3 sample points)
    let pois = fetch_route_pois(&client, key, fixes).unwrap_or_default();

    // 3. Reverse geocode harsh events (up to 5 events)
    let mut event_addresses = Vec::new();
    for &idx in event_fix_indices.iter().take(5) {
        if let Some(f) = fixes.get(idx) {
            if let Ok(addr) = reverse_geocode(&client, key, f.lat, f.lon) {
                if !addr.is_empty() {
                    event_addresses.push((idx, addr));
                }
            }
        }
    }

    let result = RouteEnrichment {
        snapped,
        pois,
        event_addresses,
    };
    if !result.snapped.is_empty() || !result.pois.is_empty() {
        write_cache("enrich", &sig, &result);
    }
    Ok(result)
}

fn snap_to_roads(
    client: &reqwest::blocking::Client,
    key: &str,
    fixes: &[FixInput],
) -> Result<Vec<SnappedFix>, String> {
    if fixes.len() < 2 {
        return Ok(Vec::new());
    }
    let step = ((fixes.len() as f64) / 100.0).ceil().max(1.0) as usize;
    let sampled: Vec<(usize, &FixInput)> = fixes
        .iter()
        .enumerate()
        .step_by(step)
        .collect();

    let points: Vec<serde_json::Value> = sampled
        .iter()
        .map(|(_, f)| {
            serde_json::json!({
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [f.lon, f.lat]
                },
                "properties": {
                    "timestamp": f.t_utc
                }
            })
        })
        .collect();

    let fields = "{projectedPoints{type,geometry{type,coordinates},properties{routeIndex}},route{type,geometry{type,coordinates},properties{address{roadName,roadNumbers,municipality},speedRestrictions{maximumSpeed{value,unit}}}}}";
    let url = format!(
        "https://api.tomtom.com/snap-to-roads/1/snap-to-roads?key={key}&fields={fields}&vehicleType=PassengerCar&measurementSystem=metric"
    );

    let body_bytes = serde_json::to_vec(&serde_json::json!({ "points": points }))
        .map_err(|e| format!("Failed to serialize points: {e}"))?;
    let res = client
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body_bytes)
        .send()
        .map_err(|e| format!("TomTom Snap-to-Roads failed: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("TomTom Snap-to-Roads status {}", res.status()));
    }

    let bytes = res
        .bytes()
        .map_err(|e| format!("Cannot read Snap-to-Roads response: {e}"))?;
    let json: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Invalid Snap-to-Roads JSON: {e}"))?;

    let routes = json
        .get("route")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let projected = json
        .get("projectedPoints")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    for (sample_pos, (orig_idx, orig_fix)) in sampled.iter().enumerate() {
        let proj = projected.get(sample_pos);
        let coords = proj
            .and_then(|p| p.pointer("/geometry/coordinates"))
            .and_then(|c| c.as_array());
        let (lon, lat) = match coords {
            Some(c) if c.len() >= 2 => (
                c[0].as_f64().unwrap_or(orig_fix.lon),
                c[1].as_f64().unwrap_or(orig_fix.lat),
            ),
            _ => (orig_fix.lon, orig_fix.lat),
        };
        let route_idx = proj
            .and_then(|p| p.pointer("/properties/routeIndex"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;

        let seg = routes.get(route_idx);
        let road_name = seg
            .and_then(|s| s.pointer("/properties/address/roadName"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let road_ref = seg
            .and_then(|s| s.pointer("/properties/address/roadNumbers/0"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let place = seg
            .and_then(|s| s.pointer("/properties/address/municipality"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let speed_limit_kmh = seg
            .and_then(|s| s.pointer("/properties/speedRestrictions/maximumSpeed/value"))
            .and_then(|v| v.as_f64())
            .filter(|&v| v > 0.0)
            .map(|v| v as f32);

        out.push(SnappedFix {
            fix_index: *orig_idx,
            lat,
            lon,
            road_name,
            road_ref,
            place,
            speed_limit_kmh,
        });
    }

    // Fill intermediate indices so every fix has road metadata
    if out.len() >= 2 && step > 1 {
        let mut expanded = Vec::with_capacity(fixes.len());
        for w in out.windows(2) {
            let a = &w[0];
            let b = &w[1];
            expanded.push(a.clone());
            let span = b.fix_index.saturating_sub(a.fix_index);
            for k in 1..span {
                let idx = a.fix_index + k;
                if let Some(f) = fixes.get(idx) {
                    expanded.push(SnappedFix {
                        fix_index: idx,
                        lat: f.lat,
                        lon: f.lon,
                        road_name: a.road_name.clone(),
                        road_ref: a.road_ref.clone(),
                        place: a.place.clone(),
                        speed_limit_kmh: a.speed_limit_kmh,
                    });
                }
            }
        }
        if let Some(last_s) = out.last() {
            expanded.push(last_s.clone());
        }
        return Ok(expanded);
    }

    Ok(out)
}

fn fetch_route_pois(
    client: &reqwest::blocking::Client,
    key: &str,
    fixes: &[FixInput],
) -> Result<Vec<TomTomPoi>, String> {
    let indices = if fixes.len() <= 3 {
        vec![0]
    } else {
        vec![0, fixes.len() / 2, fixes.len() - 1]
    };

    let mut seen = std::collections::HashSet::new();
    let mut pois = Vec::new();

    for idx in indices {
        let f = &fixes[idx];
        let url = format!(
            "https://api.tomtom.com/search/2/nearbySearch/.json?key={key}&lat={:.5}&lon={:.5}&radius=5000&limit=15",
            f.lat, f.lon
        );
        let Ok(res) = client.get(&url).send() else { continue };
        if !res.status().is_success() {
            continue;
        }
        let Ok(bytes) = res.bytes() else { continue };
        let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) else { continue };
        let Some(results) = json.get("results").and_then(|v| v.as_array()) else { continue };

        for item in results {
            let name = item
                .pointer("/poi/name")
                .and_then(|v| v.as_str())
                .or_else(|| item.pointer("/address/municipalitySubdivision").and_then(|v| v.as_str()))
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let dedup_key = name.to_lowercase();
            if !seen.insert(dedup_key) {
                continue;
            }
            let category = item
                .pointer("/poi/categories/0")
                .and_then(|v| v.as_str())
                .unwrap_or("landmark")
                .to_string();
            let lat = item.pointer("/position/lat").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let lon = item.pointer("/position/lon").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if lat == 0.0 && lon == 0.0 {
                continue;
            }
            pois.push(TomTomPoi {
                name,
                category,
                kind: "poi".to_string(),
                lat,
                lon,
            });
        }
    }

    Ok(pois)
}

fn reverse_geocode(
    client: &reqwest::blocking::Client,
    key: &str,
    lat: f64,
    lon: f64,
) -> Result<String, String> {
    let url = format!(
        "https://api.tomtom.com/search/2/reverseGeocode/{lat:.5},{lon:.5}.json?key={key}&radius=250"
    );
    let res = client
        .get(&url)
        .send()
        .map_err(|e| format!("Reverse geocode failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Reverse geocode status {}", res.status()));
    }
    let bytes = res.bytes().map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let addr = json
        .pointer("/addresses/0/address/freeformAddress")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(addr)
}
