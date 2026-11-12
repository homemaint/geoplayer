import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { GpsFix, HarshEvent } from "../lib/telemetry";
import { positionAtTime, bearingAtTime, speedColor, compassPoint, haversineM } from "../lib/telemetry";
import { formatDistance, useSettings, type MapStyle } from "../lib/settings";
import { rankLandmarksAt, type Landmark, type RawLandmark } from "../lib/landmarks";
import { DARK_STYLE, SATELLITE_STYLE, buildTomTomStyle } from "./dark-style";
import {
  Crosshair, Maximize2, Navigation, CircleAlert, MapPin, Mountain, Waves,
  Landmark as LandmarkIcon, Compass, KeyRound,
} from "lucide-react";

interface MapViewProps {
  fixes: GpsFix[];
  events: HarshEvent[];
  currentTime: number; // seconds
  follow: boolean;
  onToggleFollow: () => void;
  onFitBounds: () => void;
  followTrigger: number;
  mapStyle: MapStyle;
  onMapStyleChange: (s: MapStyle) => void;
  onOpenSettings: () => void;
  onSeek: (tSec: number) => void;
  externalLandmarks?: RawLandmark[];
  onRoadDetected?: (road: string | null) => void;
}

export default function MapView({
  fixes,
  events,
  currentTime,
  follow,
  onToggleFollow,
  onFitBounds,
  followTrigger,
  mapStyle,
  onMapStyleChange,
  onOpenSettings,
  onSeek,
  externalLandmarks = [],
  onRoadDetected,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const schematicRef = useRef<HTMLCanvasElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapLoadedRef = useRef(false);
  const fittingRef = useRef(false);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const carDotRef = useRef<HTMLDivElement | null>(null);
  const carArrowRef = useRef<HTMLDivElement | null>(null);
  const endMarkerRef = useRef<maplibregl.Marker | null>(null);
  const eventMarkersRef = useRef<maplibregl.Marker[]>([]);
  const appliedStyleKeyRef = useRef<string>("");
  const [tileError, setTileError] = useState(false);
  const [tilePool, setTilePool] = useState<RawLandmark[]>([]);
  const { settings } = useSettings();
  const schematic = mapStyle === "schematic";
  const needsTomTomKey = mapStyle === "tomtom" && !settings.tomtomKey.trim();
  const maxSpeed = useMemo(() => fixes.reduce((m, f) => Math.max(m, f.speedKmh), 0), [fixes]);

  const routeCoords = useMemo(() => fixes.map((f) => [f.lon, f.lat] as number[]), [fixes]);
  const gradientStops = useMemo(() => {
    const stops: (number | string)[] = [];
    const n = fixes.length;
    for (let i = 0; i < n; i++) {
      stops.push(n > 1 ? i / (n - 1) : 0, speedColor(fixes[i].speedKmh, maxSpeed));
    }
    return stops;
  }, [fixes, maxSpeed]);

  // Combine OpenFreeMap tile landmarks + TomTom POIs
  const combinedPool = useMemo(() => {
    const map = new Map<string, RawLandmark>();
    for (const l of externalLandmarks) {
      map.set(`${l.kind}:${l.name.toLowerCase()}`, l);
    }
    for (const l of tilePool) {
      const k = `${l.kind}:${l.name.toLowerCase()}`;
      if (!map.has(k)) map.set(k, l);
    }
    return [...map.values()];
  }, [externalLandmarks, tilePool]);

  // Dynamically rank landmarks relative to current car position (quantised to ~2s steps to avoid jitter)
  const timeBucket = Math.floor(currentTime / 2);
  const landmarks = useMemo(() => {
    if (fixes.length === 0 || combinedPool.length === 0) return [];
    const pos = positionAtTime(fixes, timeBucket * 2) ?? fixes[0];
    return rankLandmarksAt(combinedPool, pos.lat, pos.lon, { limit: 6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combinedPool, fixes, timeBucket]);

  const landmarksRef = useRef<Landmark[]>(landmarks);
  landmarksRef.current = landmarks;

  const routeCoordsRef = useRef<number[][]>(routeCoords);
  const fixesRef = useRef<GpsFix[]>(fixes);
  const eventsRef = useRef<HarshEvent[]>(events);
  const gradientStopsRef = useRef<(number | string)[]>(gradientStops);
  const currentTimeRef = useRef(currentTime);
  const followRef = useRef(follow);
  const onSeekRef = useRef(onSeek);
  routeCoordsRef.current = routeCoords;
  fixesRef.current = fixes;
  eventsRef.current = events;
  gradientStopsRef.current = gradientStops;
  currentTimeRef.current = currentTime;
  followRef.current = follow;
  onSeekRef.current = onSeek;

  // Fetch multi-point route landmarks (z11 + z14 POIs) once per clip
  const fixesKey = fixes.length
    ? (() => {
        const mid = fixes[Math.floor(fixes.length / 2)];
        return `${fixes[0].tUtc}|${fixes[fixes.length - 1].tUtc}|${fixes.length}|${mid.lat.toFixed(4)},${mid.lon.toFixed(4)}`;
      })()
    : "";
  useEffect(() => {
    const list = fixesRef.current;
    if (list.length === 0) {
      setTilePool([]);
      return;
    }
    setTilePool([]);
    const controller = new AbortController();
    let alive = true;
    import("../lib/landmarks")
      .then((mod) => mod.fetchRouteLandmarks(list, { signal: controller.signal }))
      .then((items) => {
        if (alive) setTilePool(items);
      })
      .catch(() => {
        if (alive) setTilePool([]);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [fixesKey]);

  function getActiveStyle(): { key: string; spec: maplibregl.StyleSpecification } {
    if (mapStyle === "satellite") {
      return { key: "satellite", spec: SATELLITE_STYLE };
    }
    if (mapStyle === "tomtom" && settings.tomtomKey.trim()) {
      return { key: `tomtom:${settings.tomtomKey.trim()}`, spec: buildTomTomStyle(settings.tomtomKey) };
    }
    return { key: "openfreemap", spec: DARK_STYLE };
  }

  // Create the map once the container is mounted
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;
    const initial = routeCoordsRef.current;
    const first: [number, number] = initial.length
      ? [initial[0][0], initial[0][1]]
      : [78.9629, 20.5937];
    const initialStyle = getActiveStyle();
    appliedStyleKeyRef.current = initialStyle.key;
    const map = new maplibregl.Map({
      container,
      style: initialStyle.spec,
      center: first,
      zoom: initial.length ? 13 : 4,
      pitch: 48,
      maxPitch: 70,
      attributionControl: false,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) {
      (window as unknown as { __geoMap?: maplibregl.Map }).__geoMap = map;
    }
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

    const onStyleReady = () => {
      mapLoadedRef.current = true;
      applyRoute();
      applyLandmarks();
      if (routeCoordsRef.current.length > 1) fitBoundsNow();
    };

    map.on("load", onStyleReady);
    map.on("style.load", onStyleReady);

    // Click anywhere near the route to seek the video to that exact point
    map.on("click", (e) => {
      const track = fixesRef.current;
      if (track.length < 2) return;
      const { lng, lat } = e.lngLat;
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < track.length; i++) {
        const d = haversineM(lat, lng, track[i].lat, track[i].lon);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      // Seek if click was reasonably close to the route (within ~500m depending on zoom)
      const maxMeters = Math.max(80, 25000 / Math.pow(2, map.getZoom() - 8));
      if (bestDist <= maxMeters) {
        onSeekRef.current(track[bestIdx].relMs / 1000);
      }
    });

    let tileErrors = 0;
    map.on("error", (e: maplibregl.ErrorEvent) => {
      const msg = e?.error?.message ?? String(e?.error ?? "");
      if (msg.includes("tile") || msg.includes("network") || msg.includes("Failed to fetch")) {
        tileErrors += 1;
        if (tileErrors >= 3) setTileError(true);
      }
    });

    let lastW = -1;
    let lastH = -1;
    let rafId = 0;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => map.resize());
    });
    ro.observe(container);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      mapLoadedRef.current = false;
      eventMarkersRef.current.forEach((m) => m.remove());
      eventMarkersRef.current = [];
      markerRef.current?.remove();
      markerRef.current = null;
      endMarkerRef.current?.remove();
      endMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch MapLibre style only when the active style key actually changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || schematic) return;
    const next = getActiveStyle();
    if (appliedStyleKeyRef.current === next.key) return;
    appliedStyleKeyRef.current = next.key;
    setTileError(false);
    mapLoadedRef.current = false;
    map.setStyle(next.spec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapStyle, settings.tomtomKey, schematic]);

  useEffect(() => {
    if (schematic) return;
    const id = requestAnimationFrame(() => mapRef.current?.resize());
    return () => cancelAnimationFrame(id);
  }, [schematic]);

  function fitBoundsNow() {
    const map = mapRef.current;
    const coords = routeCoordsRef.current;
    if (!map || coords.length < 2) return;
    const bounds = coords.reduce(
      (b, c) => b.extend(c as [number, number]),
      new maplibregl.LngLatBounds(coords[0] as [number, number], coords[0] as [number, number])
    );
    fittingRef.current = true;
    map.once("moveend", () => { fittingRef.current = false; });
    map.fitBounds(bounds, { padding: 46, duration: 700, maxZoom: 15 });
  }

  function applyRoute() {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;
    const coords = routeCoordsRef.current;
    const evs = eventsRef.current;
    const track = fixesRef.current;

    const data = coords.length >= 2
      ? {
          type: "Feature" as const,
          properties: {},
          geometry: { type: "LineString" as const, coordinates: coords },
        }
      : { type: "FeatureCollection" as const, features: [] };
    if (map.getSource("route")) {
      (map.getSource("route") as maplibregl.GeoJSONSource).setData(data as never);
      if (map.getLayer("route-line") && gradientStopsRef.current.length >= 4) {
        map.setPaintProperty("route-line", "line-gradient", [
          "interpolate", ["linear"], ["line-progress"], ...gradientStopsRef.current,
        ]);
      }
    } else {
      map.addSource("route", { type: "geojson", data: data as never, lineMetrics: true });
      map.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#02252e", "line-width": 9, "line-opacity": 0.95 },
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-width": 5,
          "line-opacity": 0.98,
          ...(gradientStopsRef.current.length >= 4
            ? { "line-gradient": ["interpolate", ["linear"], ["line-progress"], ...gradientStopsRef.current] }
            : { "line-color": "#22d3ee" }),
        },
      });
    }

    if (coords.length) {
      if (!markerRef.current) {
        const el = document.createElement("div");
        el.className = "car-marker";
        const arrow = document.createElement("div");
        arrow.className = "car-marker__arrow";
        const dot = document.createElement("div");
        dot.className = "car-marker__dot";
        el.appendChild(arrow);
        el.appendChild(dot);
        carDotRef.current = dot;
        carArrowRef.current = arrow;
        markerRef.current = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat(coords[0] as [number, number])
          .addTo(map);
      }
      const pos = positionAtTime(track, currentTimeRef.current);
      if (pos) markerRef.current.setLngLat([pos.lon, pos.lat]);
    } else if (markerRef.current) {
      markerRef.current.remove();
      markerRef.current = null;
      carDotRef.current = null;
      carArrowRef.current = null;
    }

    endMarkerRef.current?.remove();
    endMarkerRef.current = null;
    if (coords.length > 1) {
      const el = document.createElement("div");
      el.className = "end-marker";
      endMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat(coords[coords.length - 1] as [number, number])
        .addTo(map);
    }

    eventMarkersRef.current.forEach((m) => m.remove());
    eventMarkersRef.current = [];
    for (const ev of evs) {
      const pos = positionAtTime(track, ev.tRelMs / 1000);
      if (!pos) continue;
      const el = document.createElement("div");
      el.className = "event-marker";
      el.textContent = "!";
      el.title = ev.address ? `${ev.kind} · ${ev.address}` : ev.kind;
      el.style.cursor = "pointer";
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onSeekRef.current(ev.tRelMs / 1000);
      });
      const marker = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([pos.lon, pos.lat])
        .addTo(map);
      eventMarkersRef.current.push(marker);
    }
  }

  function applyLandmarks() {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;
    const data = {
      type: "FeatureCollection" as const,
      features: landmarksRef.current.map((l) => ({
        type: "Feature" as const,
        properties: { name: l.name, kind: l.kind, detail: l.detail },
        geometry: { type: "Point" as const, coordinates: [l.lon, l.lat] },
      })),
    };
    const source = map.getSource("landmarks") as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(data);
      return;
    }
    map.addSource("landmarks", { type: "geojson", data });
    map.addLayer({
      id: "landmark-dot",
      type: "circle",
      source: "landmarks",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 14, 4.5],
        "circle-color": [
          "match", ["get", "kind"],
          "peak", "#a78bfa",
          "water", "#38bdf8",
          "poi", "#f5b44a",
          "#22d3ee",
        ],
        "circle-stroke-color": "#05131a",
        "circle-stroke-width": 1.2,
        "circle-opacity": 0.92,
      },
    });
    map.addLayer({
      id: "landmark-label",
      type: "symbol",
      source: "landmarks",
      minzoom: 9,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 9.5, 14, 11.5],
        "text-offset": [0, 0.7],
        "text-anchor": "top",
        "text-max-width": 8,
        "text-optional": true,
        "text-padding": 2,
      },
      paint: {
        "text-color": "#e2f1ff",
        "text-halo-color": "#050a12",
        "text-halo-width": 1.4,
      },
    });
  }

  useEffect(() => {
    if (!mapLoadedRef.current) return;
    applyRoute();
    if (routeCoordsRef.current.length > 1) fitBoundsNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixes, events]);

  useEffect(() => {
    if (!mapLoadedRef.current) return;
    applyLandmarks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landmarks]);

  // Move car along route + camera follow + query rendered road name when TomTom isn't providing it
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker || fixes.length === 0) return;
    const pos = positionAtTime(fixes, currentTime);
    if (!pos) return;
    marker.setLngLat([pos.lon, pos.lat]);
    const bearing = bearingAtTime(fixes, currentTime);
    if (carArrowRef.current && bearing != null) {
      carArrowRef.current.style.transform = `translateX(-50%) rotate(${bearing}deg)`;
      carArrowRef.current.style.transformOrigin = "50% 9px";
    }
    if (follow && !fittingRef.current) {
      map.easeTo({ center: [pos.lon, pos.lat], duration: 250, easing: (t) => t });
    }
    // If fix doesn't already have a TomTom road name, query MapLibre's rendered road layer
    if (onRoadDetected && !pos.roadName && !pos.roadRef && mapLoadedRef.current && !schematic) {
      try {
        const pt = map.project([pos.lon, pos.lat]);
        const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
          [pt.x - 18, pt.y - 18],
          [pt.x + 18, pt.y + 18],
        ];
        const layers = ["road_name", "road_ref"].filter((id) => map.getLayer(id));
        if (layers.length > 0) {
          const feats = map.queryRenderedFeatures(bbox, { layers });
          const firstFeat = feats[0]?.properties as Record<string, unknown> | undefined;
          const name =
            (firstFeat?.["name:latin"] as string) ||
            (firstFeat?.name as string) ||
            (firstFeat?.ref as string) ||
            null;
          onRoadDetected(name ? String(name) : null);
        }
      } catch {
        /* ignore query errors while style is loading */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, follow, followTrigger]);

  useEffect(() => {
    if (followTrigger > 0) fitBoundsNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followTrigger]);

  // Schematic (offline canvas) rendering + click-to-seek
  useEffect(() => {
    if (!schematic) return;
    const canvas = schematicRef.current;
    if (!canvas) return;
    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.max(1, Math.min(8192, Math.round(rect.width * dpr)));
      const bh = Math.max(1, Math.min(8192, Math.round(rect.height * dpr)));
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = rect.width;
      const H = rect.height;

      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#0d1220");
      bg.addColorStop(1, "#080c16");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      if (fixes.length < 2) {
        ctx.fillStyle = "#8d99ae";
        ctx.font = "12px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillText("No GPS fixes to plot", W / 2, H / 2);
        return;
      }

      const lats = fixes.map((f) => f.lat);
      const lons = fixes.map((f) => f.lon);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const minLon = Math.min(...lons);
      const maxLon = Math.max(...lons);
      const pad = Math.max(maxLat - minLat, maxLon - minLon) * 0.18 || 0.0005;
      const latSpan = (maxLat - minLat) + pad * 2;
      const lonSpan = (maxLon - minLon) + pad * 2;
      const scale = Math.min((W - 56) / lonSpan, (H - 56) / latSpan);
      const ox = (W - lonSpan * scale) / 2;
      const oy = (H - latSpan * scale) / 2;
      const px = (lon: number) => ox + (lon - (minLon - pad)) * scale;
      const py = (lat: number) => H - (oy + (lat - (minLat - pad)) * scale);

      ctx.strokeStyle = "rgba(56, 189, 248, 0.09)";
      ctx.lineWidth = 1;
      for (const f of [0.25, 0.5, 0.75]) {
        ctx.beginPath();
        ctx.moveTo(f * W, 0);
        ctx.lineTo(f * W, H);
        ctx.moveTo(0, f * H);
        ctx.lineTo(W, f * H);
        ctx.stroke();
      }

      ctx.fillStyle = "#5c6779";
      ctx.font = "9px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      ctx.fillText(`${maxLat.toFixed(4)}° N`, 8, 14);
      ctx.fillText(`${minLat.toFixed(4)}° N`, 8, H - 6);
      ctx.textAlign = "right";
      ctx.fillText(`${minLon.toFixed(4)}° E`, W - 8, H - 6);
      ctx.fillText(`${maxLon.toFixed(4)}° E`, W - 8, 14);

      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = "#02252e";
      ctx.lineWidth = 7;
      ctx.beginPath();
      fixes.forEach((f, i) => {
        if (i === 0) ctx.moveTo(px(f.lon), py(f.lat));
        else ctx.lineTo(px(f.lon), py(f.lat));
      });
      ctx.stroke();

      for (let i = 0; i < fixes.length - 1; i++) {
        ctx.strokeStyle = speedColor(fixes[i].speedKmh, maxSpeed);
        ctx.lineWidth = 3.6;
        ctx.beginPath();
        ctx.moveTo(px(fixes[i].lon), py(fixes[i].lat));
        ctx.lineTo(px(fixes[i + 1].lon), py(fixes[i + 1].lat));
        ctx.stroke();
      }

      const dot = (lon: number, lat: number, color: string) => {
        ctx.beginPath();
        ctx.arc(px(lon), py(lat), 5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = "#05070d";
        ctx.stroke();
      };
      dot(fixes[0].lon, fixes[0].lat, "#34d399");
      dot(fixes[fixes.length - 1].lon, fixes[fixes.length - 1].lat, "#fb7185");

      for (const ev of events) {
        const pos = positionAtTime(fixes, ev.tRelMs / 1000);
        if (!pos) continue;
        ctx.beginPath();
        ctx.arc(px(pos.lon), py(pos.lat), 6, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(251,113,133,0.9)";
        ctx.fill();
        ctx.fillStyle = "#2a0a10";
        ctx.font = "bold 9px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("!", px(pos.lon), py(pos.lat));
        ctx.textBaseline = "alphabetic";
      }

      const pos = positionAtTime(fixes, currentTime);
      if (pos) {
        ctx.beginPath();
        ctx.arc(px(pos.lon), py(pos.lat), 9, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(34,211,238,0.25)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px(pos.lon), py(pos.lat), 4.6, 0, Math.PI * 2);
        ctx.fillStyle = "#22d3ee";
        ctx.shadowColor = "rgba(34,211,238,0.9)";
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      const kmPerDegLon = 111.32 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
      const metersPerPx = (1000 / kmPerDegLon / scale) * 1;
      const barMeters = metersPerPx > 0 ? niceScaleMeters(100 * metersPerPx) : 100;
      const barPx = barMeters / metersPerPx;
      ctx.strokeStyle = "#8d99ae";
      ctx.lineWidth = 2;
      const y = H - 24;
      ctx.beginPath();
      ctx.moveTo(W / 2 - barPx / 2, y);
      ctx.lineTo(W / 2 + barPx / 2, y);
      ctx.stroke();
      ctx.fillStyle = "#a7b3c8";
      ctx.font = "9px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(barMeters >= 1000 ? `${(barMeters / 1000).toFixed(barMeters % 1000 === 0 ? 0 : 1)} km` : `${barMeters} m`, W / 2, y - 4);

      ctx.fillStyle = "#a7b3c8";
      ctx.font = "bold 11px 'Space Grotesk', sans-serif";
      ctx.textAlign = "right";
      ctx.fillText("N↑", W - 10, 24);
    };
    draw();
    let rafId = 0;
    const schedule = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(draw);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [schematic, fixes, events, currentTime, maxSpeed]);

  function flyToLandmark(landmark: Landmark) {
    const map = mapRef.current;
    if (!map) return;
    map.flyTo({
      center: [landmark.lon, landmark.lat],
      zoom: Math.max(map.getZoom(), 14),
      pitch: 45,
      duration: 900,
    });
  }

  const kindIcon = (kind: Landmark["kind"]) => {
    if (kind === "peak") return <Mountain size={11} />;
    if (kind === "water") return <Waves size={11} />;
    if (kind === "poi") return <Compass size={11} />;
    return <MapPin size={11} />;
  };

  const hasFixes = fixes.length > 0;

  return (
    <>
      <div ref={containerRef} className="mapbox__map" style={{ display: schematic ? "none" : "block" }} />
      <canvas
        ref={schematicRef}
        className="mapbox__map mapbox__map--schematic"
        style={{ display: schematic ? "block" : "none", width: "100%", height: "100%" }}
      />
      {needsTomTomKey && (
        <div className="mapmy__status mapmy__status--card" style={{ zIndex: 4 }}>
          <KeyRound size={18} />
          <b>TomTom API key needed</b>
          <span>
            Add your free TomTom developer key in Settings to unlock TomTom Night tiles,
            Snap-to-Roads speed limits, and fresh POIs.
          </span>
          <button className="btn btn--primary" onClick={onOpenSettings}>Open Settings</button>
        </div>
      )}
      <div className="mapbox__overlay">
        <div className="mapbox__actions">
          <button className={`mapbox__btn${follow ? " active" : ""}`} onClick={onToggleFollow} title="Follow the car">
            <Crosshair size={11} /> Follow
          </button>
          <button className="mapbox__btn" onClick={onFitBounds} title="Fit the whole route">
            <Maximize2 size={11} /> Fit
          </button>
        </div>
        <div className="mapbox__styles" role="radiogroup" aria-label="Map layer">
          {([
            ["openfreemap", "OpenFreeMap"],
            ["tomtom", "TomTom"],
            ["satellite", "Satellite"],
            ["schematic", "Offline"],
          ] as [MapStyle, string][]).map(([id, label]) => (
            <button
              key={id}
              role="radio"
              aria-checked={mapStyle === id}
              className={`mapbox__style-btn${mapStyle === id ? " active" : ""}`}
              onClick={() => onMapStyleChange(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {!schematic && settings.showLandmarks && landmarks.length > 0 && (
        <div className="mapbox__landmarks" aria-label="Nearby landmarks">
          <div className="mapbox__landmarks-title"><LandmarkIcon size={11} /> Nearby places &amp; POIs</div>
          {landmarks.map((landmark) => (
            <button
              key={`${landmark.kind}:${landmark.name}`}
              className="mapbox__landmark"
              onClick={() => flyToLandmark(landmark)}
              title={`${landmark.detail} · ${formatDistance(landmark.distanceM, settings.distanceUnit)} ${compassPoint(landmark.bearingDeg)}`}
            >
              <span className={`mapbox__landmark-icon mapbox__landmark-icon--${landmark.kind}`}>
                {kindIcon(landmark.kind)}
              </span>
              <span className="mapbox__landmark-name">{landmark.name}</span>
              <span className="mapbox__landmark-meta">
                {formatDistance(landmark.distanceM, settings.distanceUnit)} · {compassPoint(landmark.bearingDeg)}
              </span>
            </button>
          ))}
        </div>
      )}
      {tileError && !schematic && (
        <div className="mapbox__tilefail">
          <CircleAlert size={12} /> Tiles failed to load — <button onClick={() => onMapStyleChange("schematic")}>switch to offline</button>
        </div>
      )}
      {!hasFixes && (
        <div className="no-gps">
          <Navigation size={30} strokeWidth={1.6} />
          <b>No GPS telemetry</b>
          <span>This file has no embedded location data GeoPlayer understands yet. Video playback works normally.</span>
        </div>
      )}
      <div className="mapbox__attribution">
        {mapStyle === "tomtom"
          ? "© TomTom · OpenStreetMap"
          : mapStyle === "satellite"
            ? "Imagery © Esri · Labels © OpenFreeMap"
            : schematic
              ? "Offline schematic · GPS telemetry"
              : "© OpenFreeMap · Overture Maps · OpenStreetMap"}
      </div>
    </>
  );
}

function niceScaleMeters(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= raw) return m * pow;
  }
  return 10 * pow;
}
