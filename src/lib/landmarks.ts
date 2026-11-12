// Nearby landmarks and road names for the route replay map.
//
// Combines two free, keyless sources:
// 1. OpenFreeMap vector tiles (z11 overview `place`, `mountain_peak`, `water_name` + z14 `poi`)
// 2. Overture Maps Foundation Places PMTiles (`places.pmtiles` on AWS S3 via HTTP range requests)
// Plus optional TomTom Nearby POIs when a TomTom key is configured.
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { PMTiles } from "pmtiles";
import type { GpsFix } from "./telemetry";

export type LandmarkKind = "place" | "poi" | "peak" | "water";

export interface Landmark {
  name: string;
  kind: LandmarkKind;
  /** Human label, e.g. "village", "fuel", "temple", "peak" */
  detail: string;
  lat: number;
  lon: number;
  distanceM: number;
  bearingDeg: number;
}

const TILEJSON_URL = "https://tiles.openfreemap.org/planet";
const OVERTURE_STAC_URL = "https://stac.overturemaps.org/catalog.json";
const OVERVIEW_ZOOM = 11;
const DETAIL_ZOOM = 14;
const DEFAULT_RADIUS_KM = 10;
const MAX_RESULTS = 8;

let templatePromise: Promise<string> | null = null;
let overturePmtilesPromise: Promise<PMTiles | null> | null = null;
const tileBufferCache = new Map<string, Uint8Array>();

function tileTemplate(): Promise<string> {
  if (!templatePromise) {
    templatePromise = fetch(TILEJSON_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`OpenFreeMap tile index ${res.status}`);
        return res.json() as Promise<{ tiles?: string[] }>;
      })
      .then((json) => {
        const url = json.tiles?.[0];
        if (!url) throw new Error("OpenFreeMap tile index has no tile URL");
        return url;
      })
      .catch((err) => {
        templatePromise = null;
        throw err;
      });
  }
  return templatePromise;
}

/** Resolve the latest Overture Maps release from STAC and return a PMTiles reader for `places.pmtiles`. */
function getOverturePlacesPmtiles(): Promise<PMTiles | null> {
  if (!overturePmtilesPromise) {
    overturePmtilesPromise = fetch(OVERTURE_STAC_URL)
      .then((res) => (res.ok ? (res.json() as Promise<{ latest?: string; links?: { rel?: string; href?: string }[] }>) : null))
      .then((cat) => {
        let release = cat?.latest;
        if (!release && Array.isArray(cat?.links)) {
          const child = cat.links.find((l) => l.rel === "child" && l.href);
          const m = child?.href?.match(/(\d{4}-\d{2}-\d{2}\.\d+)/);
          if (m) release = m[1];
        }
        if (!release) return null;
        const url = `https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${release}/places.pmtiles`;
        return new PMTiles(url);
      })
      .catch(() => null);
  }
  return overturePmtilesPromise;
}

function tileFraction(lon: number, lat: number, z: number): { x: number; y: number } {
  const x = ((lon + 180) / 360) * 2 ** z;
  const rad = (lat * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
  return { x, y };
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function pickName(props: Record<string, unknown>): string | null {
  // OpenMapTiles / Overture name properties
  const direct =
    (props["name:latin"] as string | undefined) ||
    (props.name as string | undefined) ||
    (props["name:en"] as string | undefined) ||
    (props[" primary_name"] as string | undefined);
  if (direct && typeof direct === "string") return direct.trim();

  // Overture PMTiles stores `names` as JSON string `{"primary":"..."}`
  if (typeof props.names === "string") {
    try {
      const parsed = JSON.parse(props.names) as { primary?: string };
      if (parsed.primary) return parsed.primary.trim();
    } catch {
      /* ignore */
    }
  }
  return null;
}

export interface RawLandmark extends Omit<Landmark, "distanceM" | "bearingDeg"> {}

async function fetchTileBytes(template: string, z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null> {
  const key = `ofm:${z}/${x}/${y}`;
  const hit = tileBufferCache.get(key);
  if (hit) return hit;
  const url = template
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (tileBufferCache.size > 80) {
    const firstKey = tileBufferCache.keys().next().value;
    if (firstKey) tileBufferCache.delete(firstKey);
  }
  tileBufferCache.set(key, buf);
  return buf;
}

function collectTile(
  buf: Uint8Array,
  x: number,
  y: number,
  z: number,
  out: RawLandmark[]
) {
  const tile = new VectorTile(new Pbf(buf));
  const layers: { name: string; kind: LandmarkKind }[] = [
    { name: "poi", kind: "poi" },
    { name: "place", kind: "place" },
    { name: "mountain_peak", kind: "peak" },
    { name: "water_name", kind: "water" },
  ];

  for (const { name: layerName, kind } of layers) {
    const layer = tile.layers[layerName];
    if (!layer) continue;
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const props = feature.properties as Record<string, unknown>;
      const name = pickName(props);
      if (!name) continue;

      const geom = feature.toGeoJSON(x, y, z).geometry;
      let lon = 0;
      let lat = 0;
      if (geom.type === "Point") {
        [lon, lat] = geom.coordinates as [number, number];
      } else if (geom.type === "Polygon" && geom.coordinates[0]?.[0]) {
        [lon, lat] = geom.coordinates[0][0] as [number, number];
      } else {
        continue;
      }

      const subclass = String(props.subclass ?? props.class ?? kind).replace(/_/g, " ");
      const detail =
        kind === "peak"
          ? "peak"
          : kind === "water"
            ? "water"
            : subclass;
      out.push({ name, kind, detail, lat, lon });
    }
  }
}

function collectOvertureTile(
  buf: Uint8Array,
  x: number,
  y: number,
  z: number,
  out: RawLandmark[]
) {
  const tile = new VectorTile(new Pbf(buf));
  for (const layerName of Object.keys(tile.layers)) {
    const layer = tile.layers[layerName];
    if (!layer) continue;
    const count = Math.min(layer.length, 150);
    for (let i = 0; i < count; i++) {
      const feature = layer.feature(i);
      const props = feature.properties as Record<string, unknown>;
      const name = pickName(props);
      if (!name) continue;
      const geom = feature.toGeoJSON(x, y, z).geometry;
      if (geom.type !== "Point") continue;
      const [lon, lat] = geom.coordinates as [number, number];

      let detail = "place";
      if (typeof props.categories === "string") {
        try {
          const cat = JSON.parse(props.categories) as { primary?: string };
          if (cat.primary) detail = cat.primary.replace(/_/g, " ");
        } catch {
          detail = props.categories.replace(/_/g, " ");
        }
      }
      out.push({ name, kind: "poi", detail, lat, lon });
    }
  }
}

/** Fetch landmarks along the entire route from OpenFreeMap (z11 + z14) AND Overture Places PMTiles. */
export async function fetchRouteLandmarks(
  fixes: GpsFix[],
  opts: { signal?: AbortSignal } = {}
): Promise<RawLandmark[]> {
  if (fixes.length === 0) return [];
  const template = await tileTemplate();

  const sampleIndices = new Set<number>([
    0,
    Math.floor(fixes.length * 0.25),
    Math.floor(fixes.length * 0.5),
    Math.floor(fixes.length * 0.75),
    fixes.length - 1,
  ]);
  const samples = [...sampleIndices].map((i) => fixes[i]);

  const tileCoords = new Map<string, { z: number; x: number; y: number }>();
  const detailCoords: { z: number; x: number; y: number }[] = [];

  for (const pt of samples) {
    const { x: fx11, y: fy11 } = tileFraction(pt.lon, pt.lat, OVERVIEW_ZOOM);
    const bx11 = Math.floor(fx11);
    const by11 = Math.floor(fy11);
    const xs11 = fx11 - bx11 < 0.5 ? [bx11 - 1, bx11] : [bx11, bx11 + 1];
    const ys11 = fy11 - by11 < 0.5 ? [by11 - 1, by11] : [by11, by11 + 1];
    for (const x of xs11) {
      for (const y of ys11) {
        tileCoords.set(`${OVERVIEW_ZOOM}/${x}/${y}`, { z: OVERVIEW_ZOOM, x, y });
      }
    }
    const { x: fx14, y: fy14 } = tileFraction(pt.lon, pt.lat, DETAIL_ZOOM);
    const bx14 = Math.floor(fx14);
    const by14 = Math.floor(fy14);
    const key14 = `${DETAIL_ZOOM}/${bx14}/${by14}`;
    if (!tileCoords.has(key14)) {
      const c = { z: DETAIL_ZOOM, x: bx14, y: by14 };
      tileCoords.set(key14, c);
      detailCoords.push(c);
    }
  }

  const raw: RawLandmark[] = [];

  // 1. OpenFreeMap tiles
  await Promise.all(
    [...tileCoords.values()].map(async ({ z, x, y }) => {
      const buf = await fetchTileBytes(template, z, x, y, opts.signal);
      if (buf) collectTile(buf, x, y, z, raw);
    })
  );

  // 2. Overture Places PMTiles (HTTP range requests for the route's z14 tiles)
  try {
    const pmtiles = await getOverturePlacesPmtiles();
    if (pmtiles && !opts.signal?.aborted) {
      await Promise.all(
        detailCoords.slice(0, 3).map(async ({ z, x, y }) => {
          const tileRes = await pmtiles.getZxy(z, x, y, opts.signal);
          if (tileRes?.data) {
            collectOvertureTile(new Uint8Array(tileRes.data), x, y, z, raw);
          }
        })
      );
    }
  } catch {
    /* Overture PMTiles is additive; ignore network/CORS errors */
  }

  const unique = new Map<string, RawLandmark>();
  for (const l of raw) {
    const k = `${l.kind}:${l.name.toLowerCase()}`;
    if (!unique.has(k)) unique.set(k, l);
  }
  return [...unique.values()];
}

/** Rank landmarks relative to the car's current position. */
export function rankLandmarksAt(
  pool: RawLandmark[],
  lat: number,
  lon: number,
  opts: { radiusKm?: number; limit?: number } = {}
): Landmark[] {
  const radiusM = (opts.radiusKm ?? DEFAULT_RADIUS_KM) * 1000;
  const limit = opts.limit ?? MAX_RESULTS;

  const withDistance = pool
    .map((l) => ({
      ...l,
      distanceM: haversineM(lat, lon, l.lat, l.lon),
      bearingDeg: bearingDeg(lat, lon, l.lat, l.lon),
    }))
    .filter((l) => l.distanceM <= radiusM);

  withDistance.sort((a, b) => a.distanceM - b.distanceM);

  const result: Landmark[] = [];
  for (const kind of ["poi", "place", "peak", "water"] as LandmarkKind[]) {
    const nearest = withDistance.find((l) => l.kind === kind);
    if (nearest) result.push(nearest);
  }
  for (const l of withDistance) {
    if (result.length >= limit) break;
    if (!result.some((r) => r.kind === l.kind && r.name === l.name)) result.push(l);
  }
  result.sort((a, b) => a.distanceM - b.distanceM);
  return result.slice(0, limit);
}
