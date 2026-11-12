import type { GpsFix } from "./telemetry";
import { haversineM, bearingDeg, compassPoint } from "./telemetry";

export interface HeritageInsight {
  title: string;
  description?: string;
  extract: string;
  lat: number;
  lon: number;
  thumbnailUrl?: string;
  pageUrl: string;
}

export interface ActiveInsight extends HeritageInsight {
  distanceM: number;
  bearingDeg: number;
  compass: string;
}

const STORAGE_KEY = "geoplayer.wiki.v1";
const memCache = new Map<string, HeritageInsight[]>();

function loadDiskCache(): Record<string, HeritageInsight[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, HeritageInsight[]>) : {};
  } catch {
    return {};
  }
}

function saveDiskCache(key: string, items: HeritageInsight[]) {
  try {
    const store = loadDiskCache();
    store[key] = items;
    // Keep at most 40 cached regions so localStorage stays tiny
    const keys = Object.keys(store);
    if (keys.length > 40) {
      delete store[keys[0]];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* ignore quota errors */
  }
}

function cleanExtract(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 210) return flat;
  // Prefer ending at the first or second sentence if reasonable
  const sentences = flat.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences[0] && sentences[0].length >= 55 && sentences[0].length <= 210) {
    return sentences[0].trim();
  }
  return flat.slice(0, 200).replace(/\s+\S*$/, "") + "…";
}

interface WikiGeoSearchPage {
  pageid: number;
  title: string;
  description?: string;
  extract?: string;
  coordinates?: { lat: number; lon: number }[];
  thumbnail?: { source: string };
}

/**
 * Fetch geotagged Wikipedia historical & tourist articles along a GPS track,
 * plus fallback summary for the detected city/road name if no geotagged article is within 5 km.
 */
export async function fetchRouteHeritage(
  fixes: GpsFix[],
  fallbackPlaceName?: string | null,
  signal?: AbortSignal
): Promise<HeritageInsight[]> {
  if (fixes.length === 0) return [];

  const mid = fixes[Math.floor(fixes.length / 2)];
  const cacheKey = `${mid.lat.toFixed(2)},${mid.lon.toFixed(2)}:${(fallbackPlaceName ?? "").toLowerCase()}`;
  const cached = memCache.get(cacheKey) ?? loadDiskCache()[cacheKey];
  if (cached && cached.length > 0) {
    memCache.set(cacheKey, cached);
    return cached;
  }

  // Sample up to 3 points along the route (start, middle, end) if the route is long
  const indices =
    fixes.length < 10
      ? [0]
      : [0, Math.floor(fixes.length / 2), fixes.length - 1];

  const byTitle = new Map<string, HeritageInsight>();

  for (const idx of indices) {
    const f = fixes[idx];
    // Skip if very close to an already-queried point
    if (
      idx > 0 &&
      haversineM(fixes[0].lat, fixes[0].lon, f.lat, f.lon) < 1200
    ) {
      continue;
    }

    try {
      const url =
        `https://en.wikipedia.org/w/api.php?action=query` +
        `&generator=geosearch&ggscoord=${f.lat.toFixed(5)}|${f.lon.toFixed(5)}` +
        `&ggsradius=10000&ggslimit=12` +
        `&prop=extracts|coordinates|pageimages|description` +
        `&exintro=1&explaintext=1&exsentences=2&exlimit=max` +
        `&piprop=thumbnail&pithumbsize=160` +
        `&format=json&origin=*`;

      const res = await fetch(url, { signal });
      if (!res.ok) continue;
      const json = (await res.json()) as {
        query?: { pages?: Record<string, WikiGeoSearchPage> };
      };
      const pages = json.query?.pages ? Object.values(json.query.pages) : [];
      for (const p of pages) {
        const coord = p.coordinates?.[0];
        if (!coord || !p.extract) continue;
        const extract = cleanExtract(p.extract);
        if (extract.length < 30) continue;
        byTitle.set(p.title, {
          title: p.title,
          description: p.description,
          extract,
          lat: coord.lat,
          lon: coord.lon,
          thumbnailUrl: p.thumbnail?.source,
          pageUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`,
        });
      }
    } catch {
      if (signal?.aborted) return [];
    }
  }

  // Also query the named city/place (e.g. "Vadodara", "Tehri Garhwal") if available so major city history is included
  const cleanPlace = fallbackPlaceName
    ?.split("·")
    .pop()
    ?.replace(/\b(NH|SH|Road|Highway|Marg|Bridge|Flyover)\b.*$/i, "")
    .trim();

  if (cleanPlace && cleanPlace.length >= 3 && !byTitle.has(cleanPlace)) {
    try {
      const sumUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanPlace)}`;
      const res = await fetch(sumUrl, { signal });
      if (res.ok) {
        const data = (await res.json()) as {
          title?: string;
          description?: string;
          extract?: string;
          coordinates?: { lat: number; lon: number };
          thumbnail?: { source: string };
          content_urls?: { desktop?: { page?: string } };
        };
        if (data.title && data.extract && data.extract.length >= 30) {
          byTitle.set(data.title, {
            title: data.title,
            description: data.description,
            extract: cleanExtract(data.extract),
            lat: data.coordinates?.lat ?? mid.lat,
            lon: data.coordinates?.lon ?? mid.lon,
            thumbnailUrl: data.thumbnail?.source,
            pageUrl:
              data.content_urls?.desktop?.page ??
              `https://en.wikipedia.org/wiki/${encodeURIComponent(data.title.replace(/ /g, "_"))}`,
          });
        }
      }
    } catch {
      /* ignore network errors */
    }
  }

  const results = [...byTitle.values()];
  if (results.length > 0) {
    memCache.set(cacheKey, results);
    saveDiskCache(cacheKey, results);
  }
  return results;
}

/**
 * Pick the most relevant tourist/historical insight for the vehicle's current position,
 * rotating gently if multiple landmarks are nearby so the user discovers more about the area.
 */
export function selectInsightAt(
  pool: HeritageInsight[],
  lat: number,
  lon: number,
  currentTimeSec: number
): ActiveInsight | null {
  if (pool.length === 0) return null;

  const ranked: ActiveInsight[] = pool
    .map((item) => {
      const distanceM = haversineM(lat, lon, item.lat, item.lon);
      const b = bearingDeg(lat, lon, item.lat, item.lon);
      return {
        ...item,
        distanceM,
        bearingDeg: b,
        compass: compassPoint(b),
      };
    })
    .sort((a, b) => a.distanceM - b.distanceM);

  // Cycle among the top 3 closest landmarks every 12 seconds of video playback
  const topCount = Math.min(3, ranked.length);
  const slot = Math.floor(Math.max(0, currentTimeSec) / 12) % topCount;
  return ranked[slot] ?? ranked[0];
}
