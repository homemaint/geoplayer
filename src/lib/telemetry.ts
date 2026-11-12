// Telemetry types mirror the Rust backend (rust telemetry.rs with camelCase rename)

export interface Accelerometer {
  x: number;
  y: number;
  z: number;
}

export interface GpsFix {
  tUtc: string;
  tMs: number;
  relMs: number;
  lat: number;
  lon: number;
  speedKmh: number;
  accel: Accelerometer | null;
  coordsAssumed: boolean;
  /** metres above sea level (only some dashcams record it) */
  altitudeM: number | null;
  /** satellites in view */
  sats: number | null;
  /** Optional road name from TomTom Snap-to-Roads or vector tiles */
  roadName?: string;
  /** Optional highway ref (e.g. NH-7, SH-12A) */
  roadRef?: string;
  /** Optional municipality / town name */
  place?: string;
  /** Optional posted speed limit in km/h from TomTom Snap-to-Roads */
  speedLimitKmh?: number;
}

export interface HarshEvent {
  tRelMs: number;
  kind: string;
  deltaKmh: number;
  /** Optional street address resolved via reverse geocoding */
  address?: string;
}

export interface VideoTelemetry {
  path: string;
  fileName: string;
  durationSecs: number;
  createdUtc: string | null;
  sizeBytes: number;
  fixes: GpsFix[];
  gpsSource: string; // "novatek-ligogps" | "undecodable" | "none"
  coordsAssumed: boolean;
  distanceM: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  events: HarshEvent[];
}

export const KMH_TO_MS = 0.27777778;

export function formatDuration(totalSecs: number): string {
  if (!isFinite(totalSecs) || totalSecs < 0) return "0:00";
  const s = Math.floor(totalSecs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatClock(totalSecs: number): string {
  return formatDuration(totalSecs);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${Math.round(meters)} m`;
}

/** Haversine distance in meters */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Compass bearing in degrees from point A to B */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos((lat2 * Math.PI) / 180);
  const x =
    Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
    Math.sin((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Index and interpolation factor for telemetry position at a given video time (0-based ms from first fix) */
export function fixAtTime(fixes: GpsFix[], tMs: number): { fix: GpsFix; next: GpsFix | null; frac: number; index: number } | null {
  if (fixes.length === 0) return null;
  if (tMs <= fixes[0].relMs) return { fix: fixes[0], next: fixes[1] ?? null, frac: 0, index: 0 };
  const lastIdx = fixes.length - 1;
  const last = fixes[lastIdx];
  if (tMs >= last.relMs) return { fix: last, next: null, frac: 0, index: lastIdx };
  // binary search for the first fix with relMs >= tMs
  let lo = 0;
  let hi = lastIdx;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fixes[mid].relMs < tMs) lo = mid + 1;
    else hi = mid;
  }
  const next = fixes[lo];
  const prevIdx = lo - 1;
  const prev = fixes[prevIdx];
  const span = next.relMs - prev.relMs;
  const frac = span > 0 ? (tMs - prev.relMs) / span : 0;
  return { fix: prev, next, frac, index: prevIdx };
}

/** Interpolated lat/lon at absolute video time in seconds (O(log n)) */
export function positionAtTime(
  fixes: GpsFix[],
  tSec: number
): {
  lat: number;
  lon: number;
  speedKmh: number;
  fixIndex: number;
  roadName?: string;
  roadRef?: string;
  place?: string;
  speedLimitKmh?: number;
} | null {
  const tMs = tSec * 1000;
  const at = fixAtTime(fixes, tMs);
  if (!at) return null;
  const { fix, next, frac, index } = at;
  let lat = fix.lat;
  let lon = fix.lon;
  let speedKmh = fix.speedKmh;
  if (next) {
    lat = fix.lat + (next.lat - fix.lat) * frac;
    lon = fix.lon + (next.lon - fix.lon) * frac;
    speedKmh = fix.speedKmh + (next.speedKmh - fix.speedKmh) * frac;
  } else if (fixes.length >= 2 && tMs > fix.relMs) {
    // Extrapolate deceleration past the last 1 Hz GPS sample (e.g. from 59.0s to 60.0s clip end)
    const prev = fixes[fixes.length - 2];
    const dt = fix.relMs - prev.relMs;
    if (dt > 0) {
      const slope = (fix.speedKmh - prev.speedKmh) / dt;
      if (slope < 0) {
        speedKmh = Math.max(0, fix.speedKmh + slope * (tMs - fix.relMs));
      }
    }
  }
  // Dashcam firmware & automotive speedometers clamp low-speed GPS Doppler noise to 0
  if (speedKmh < 3.0) {
    speedKmh = 0;
  }
  return {
    lat,
    lon,
    speedKmh,
    fixIndex: index,
    roadName: fix.roadName,
    roadRef: fix.roadRef,
    place: fix.place,
    speedLimitKmh: fix.speedLimitKmh,
  };
}

export function bearingAtTime(fixes: GpsFix[], tSec: number): number | null {
  const pos = positionAtTime(fixes, tSec);
  if (!pos) return null;
  const i = Math.min(pos.fixIndex + 1, fixes.length - 1);
  const j = Math.min(i + 1, fixes.length - 1);
  if (i >= fixes.length - 1) return fixes.length > 1 ? bearingDeg(fixes[j - 1].lat, fixes[j - 1].lon, fixes[j].lat, fixes[j].lon) : null;
  return bearingDeg(fixes[i].lat, fixes[i].lon, fixes[j].lat, fixes[j].lon);
}

/** Build a GPX document from telemetry */
export function buildGpx(t: VideoTelemetry): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const name = esc(t.fileName.replace(/\.[^.]+$/, ""));
  const pts = t.fixes
    .map(
      (f) =>
        `    <trkpt lat="${f.lat.toFixed(7)}" lon="${f.lon.toFixed(7)}">\n` +
        `      <time>${f.tUtc}</time>\n` +
        `      <extensions><speed>${(f.speedKmh / 3.6).toFixed(2)}</speed></extensions>\n` +
        `    </trkpt>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GeoPlayer"
  xmlns="http://www.topografix.com/gpx/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/gpx/1/1 http://www.topografix.com/gpx/1/1/gpx.xsd">
  <metadata><name>${name}</name></metadata>
  <trk><name>${name}</name>
  <trkseg>
${pts}
  </trkseg></trk>
</gpx>
`;
}

/** Sport-bar compass directions */
export function compassPoint(deg: number): string {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

/** Colour ramp used for the speed gradient along the route */
export function speedColor(speedKmh: number, maxSpeed: number): string {
  const t = maxSpeed > 0 ? Math.min(1, speedKmh / maxSpeed) : 0;
  const stops: [number, [number, number, number]][] = [
    [0, [56, 189, 248]],
    [0.45, [34, 211, 238]],
    [0.7, [52, 211, 153]],
    [0.85, [245, 180, 74]],
    [1, [251, 113, 133]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1 || i === stops.length - 2) {
      const k = t1 === t0 ? 0 : Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
      const c = [0, 1, 2].map((ch) => Math.round(c0[ch] + (c1[ch] - c0[ch]) * k));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return "#22d3ee";
}
