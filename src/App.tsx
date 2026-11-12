import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Maximize, Minimize,
  Download, ChevronLeft, AlertOctagon, CheckCircle2, Camera, ZoomIn, RotateCcw,
} from "lucide-react";
import ErrorBoundary from "./components/ErrorBoundary";
import Sidebar from "./components/Sidebar";
import MapView from "./components/MapView";
import RightPanel from "./components/RightPanel";
import Hud from "./components/Hud";
import EmptyState from "./components/EmptyState";
import type { VideoTelemetry, HarshEvent } from "./lib/telemetry";
import { buildGpx, formatDuration, haversineM, positionAtTime, fixAtTime } from "./lib/telemetry";
import type { RawLandmark } from "./lib/landmarks";
import {
  useSettings, hemisphereSigns, formatDistance, formatSpeed, SPEED_UNIT_LABEL,
} from "./lib/settings";
import SettingsModal from "./components/SettingsModal";

const VIDEO_EXTS = ["mp4", "mov", "m4v", "avi", "ts", "mts", "mkv"];

interface TomTomEnrichment {
  snapped: {
    fixIndex: number;
    lat: number;
    lon: number;
    roadName?: string;
    roadRef?: string;
    place?: string;
    speedLimitKmh?: number;
  }[];
  pois: {
    name: string;
    category: string;
    kind: "poi";
    lat: number;
    lon: number;
  }[];
  eventAddresses: [number, string][];
}

export default function App() {
  const [playlist, setPlaylist] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [telemetry, setTelemetry] = useState<VideoTelemetry | null>(null);
  const [enrichment, setEnrichment] = useState<TomTomEnrichment | null>(null);
  const [detectedRoad, setDetectedRoad] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [fitTrigger, setFitTrigger] = useState(0);
  const [tab, setTab] = useState<"overview" | "graph" | "events">("overview");
  const [toast, setToast] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { settings, update } = useSettings();
  const [follow, setFollow] = useState(() => settings.followByDefault);

  // Digital zoom & pan state for inspecting number plates / road signs
  const [videoZoom, setVideoZoom] = useState(1);
  const [videoPan, setVideoPan] = useState({ x: 0, y: 0 });
  const panDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);

  // Hover preview on the seek bar
  const [seekHover, setSeekHover] = useState<{ xPx: number; timeSec: number } | null>(null);

  useEffect(() => {
    setFollow(settings.followByDefault);
  }, [settings.followByDefault]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const toastTimer = useRef<number | null>(null);
  const restoredRef = useRef(false);

  const SESSION_KEY = "geoplayer.session.v1";

  const currentPath = currentIndex >= 0 ? playlist[currentIndex] : null;
  const hasVideo = playlist.length > 0;

  // Apply hemisphere sign + merge TomTom road/limit/overspeed enrichment
  const viewTelemetry = useMemo(() => {
    if (!telemetry) return null;
    const s = hemisphereSigns(settings.assumedHemisphere);
    const snappedByIdx = new Map(enrichment?.snapped.map((item) => [item.fixIndex, item]));
    const addrByIdx = new Map(enrichment?.eventAddresses ?? []);

    const fixes = telemetry.fixes.map((f, idx) => {
      const snap = snappedByIdx.get(idx);
      return {
        ...f,
        lat: f.lat * s.lat,
        lon: f.lon * s.lon,
        roadName: snap?.roadName ?? f.roadName,
        roadRef: snap?.roadRef ?? f.roadRef,
        place: snap?.place ?? f.place,
        speedLimitKmh: snap?.speedLimitKmh ?? f.speedLimitKmh,
      };
    });

    // Attach reverse-geocoded addresses to harsh events + generate overspeed events
    const baseEvents: HarshEvent[] = telemetry.events.map((ev) => {
      const at = fixAtTime(fixes, ev.tRelMs);
      const addr = at ? addrByIdx.get(at.index) : undefined;
      return addr ? { ...ev, address: addr } : ev;
    });

    const overspeedEvents: HarshEvent[] = [];
    let lastOverspeedMs = -10_000;
    for (const f of fixes) {
      if (f.speedLimitKmh && f.speedKmh > f.speedLimitKmh + 8 && f.relMs - lastOverspeedMs >= 5000) {
        lastOverspeedMs = f.relMs;
        overspeedEvents.push({
          tRelMs: f.relMs,
          kind: `Overspeed (${Math.round(f.speedLimitKmh)} km/h zone)`,
          deltaKmh: f.speedKmh - f.speedLimitKmh,
          address: [f.roadRef, f.roadName, f.place].filter(Boolean).join(" · ") || undefined,
        });
      }
    }

    const events = [...baseEvents, ...overspeedEvents].sort((a, b) => a.tRelMs - b.tRelMs);

    return {
      ...telemetry,
      fixes,
      events,
    };
  }, [telemetry, settings.assumedHemisphere, enrichment]);

  const externalLandmarks = useMemo<RawLandmark[]>(() => {
    if (!enrichment?.pois) return [];
    return enrichment.pois.map((p) => ({
      name: p.name,
      kind: "poi",
      detail: p.category,
      lat: p.lat,
      lon: p.lon,
    }));
  }, [enrichment]);

  // Trigger TomTom route enrichment whenever a clip with GPS is loaded and a TomTom key is present
  useEffect(() => {
    setEnrichment(null);
    setDetectedRoad(null);
    const key = settings.tomtomKey.trim();
    if (!key || !telemetry || telemetry.fixes.length === 0) return;

    const s = hemisphereSigns(settings.assumedHemisphere);
    const fixInputs = telemetry.fixes.map((f) => ({
      lat: f.lat * s.lat,
      lon: f.lon * s.lon,
      tUtc: f.tUtc,
    }));
    const eventIndices = telemetry.events
      .map((ev) => fixAtTime(telemetry.fixes, ev.tRelMs)?.index)
      .filter((idx): idx is number => idx != null);

    let alive = true;
    invoke<TomTomEnrichment>("tomtom_enrich", {
      key,
      fixes: fixInputs,
      eventIndices,
    })
      .then((res) => {
        if (alive) setEnrichment(res);
      })
      .catch(() => {
        /* non-fatal: OpenFreeMap fallback remains active */
      });
    return () => {
      alive = false;
    };
  }, [telemetry, settings.tomtomKey, settings.assumedHemisphere]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const loadIndex = useCallback(async (index: number, paths?: string[]) => {
    const list = paths ?? playlist;
    if (index < 0 || index >= list.length) return;
    setCurrentIndex(index);
    setLoading(true);
    setError(null);
    setTelemetry(null);
    setCurrentTime(0);
    setVideoZoom(1);
    setVideoPan({ x: 0, y: 0 });
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ paths: list, index }));
      const result = await invoke<VideoTelemetry>("load_video", { path: list[index] });
      setTelemetry(result);
      setDuration(result.durationSecs || 0);
    } catch (e) {
      setError(typeof e === "string" ? e : `Could not read video: ${String(e)}`);
      setDuration(0);
    } finally {
      setLoading(false);
    }
  }, [playlist]);

  // Restore last playlist on launch
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { paths?: string[]; index?: number };
      if (!Array.isArray(saved.paths) || saved.paths.length === 0) return;
      const index = Math.min(Math.max(0, saved.index ?? 0), saved.paths.length - 1);
      setPlaylist(saved.paths);
      loadIndex(index, saved.paths);
    } catch {
      /* ignore corrupt session record */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dev helper: ?open=<path>
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const openPath = new URLSearchParams(window.location.search).get("open");
    if (!openPath) return;
    setPlaylist([openPath]);
    loadIndex(0, [openPath]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Native drag-and-drop for video files or folders
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        const dropped = event.payload.paths;
        if (!dropped || dropped.length === 0) return;
        const collected: string[] = [];
        for (const p of dropped) {
          const ext = p.split(".").pop()?.toLowerCase() ?? "";
          if (VIDEO_EXTS.includes(ext)) {
            collected.push(p);
          } else {
            try {
              const inside = await invoke<string[]>("list_videos", { dir: p });
              collected.push(...inside);
            } catch {
              /* not a folder */
            }
          }
        }
        if (collected.length > 0) {
          collected.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
          setPlaylist(collected);
          loadIndex(0, collected);
          showToast(`Loaded ${collected.length} video${collected.length > 1 ? "s" : ""}`);
        } else {
          showToast("No supported video files found in drop");
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, [loadIndex, showToast]);

  const openFileDialog = useCallback(async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "Video files", extensions: VIDEO_EXTS }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;
      paths.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      setPlaylist(paths);
      loadIndex(0, paths);
    } catch (e) {
      setError(`File dialog failed: ${String(e)}`);
    }
  }, [loadIndex]);

  const openFolderDialog = useCallback(async () => {
    try {
      const dir = await open({ directory: true, multiple: false });
      if (!dir || Array.isArray(dir)) return;
      const paths = await invoke<string[]>("list_videos", { dir });
      if (paths.length === 0) {
        showToast("No video files found in that folder");
        return;
      }
      setPlaylist(paths);
      loadIndex(0, paths);
    } catch (e) {
      setError(`Could not open folder: ${String(e)}`);
    }
  }, [loadIndex, showToast]);

  // Playback rate effect
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, currentPath]);

  // Smooth 30fps time sync while playing
  useEffect(() => {
    if (!playing) return;
    let rafId = 0;
    let lastUpdate = 0;
    const tick = (now: number) => {
      if (now - lastUpdate >= 33 && videoRef.current) {
        setCurrentTime(videoRef.current.currentTime);
        lastUpdate = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [playing]);

  // Fullscreen listener
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, []);

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    const d = isFinite(v.duration) ? v.duration : duration;
    v.currentTime = Math.min(Math.max(0, t), d || 0);
    setCurrentTime(v.currentTime);
  }, [duration]);

  const stepFrame = useCallback((dir: 1 | -1) => {
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) v.pause();
    seekTo(v.currentTime + dir * (1 / 30));
  }, [seekTo]);

  const next = useCallback(() => {
    if (playlist.length === 0) return;
    loadIndex(Math.min(currentIndex + 1, playlist.length - 1));
  }, [playlist.length, currentIndex, loadIndex]);

  const prev = useCallback(() => {
    if (playlist.length === 0) return;
    loadIndex(Math.max(currentIndex - 1, 0));
  }, [playlist.length, currentIndex, loadIndex]);

  const toggleFullscreen = useCallback(() => {
    if (!stageRef.current) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else stageRef.current.requestFullscreen().catch(() => {});
  }, []);

  const exportGpx = useCallback(async () => {
    if (!viewTelemetry || viewTelemetry.fixes.length === 0) {
      showToast("No GPS track to export");
      return;
    }
    try {
      const gpx = buildGpx(viewTelemetry);
      const target = await save({
        defaultPath: viewTelemetry.fileName.replace(/\.[^.]+$/, "") + ".gpx",
        filters: [{ name: "GPX track", extensions: ["gpx"] }],
      });
      if (!target) return;
      await invoke("export_gpx", { path: target, gpx });
      showToast("GPX track exported");
    } catch (e) {
      showToast(`Export failed: ${String(e)}`);
    }
  }, [viewTelemetry, showToast]);

  const takeScreenshot = useCallback(async () => {
    try {
      const path = await invoke<string>("capture_screenshot");
      const name = path.split(/[\\/]/).pop() ?? path;
      showToast(`Screenshot saved · ${name}`);
    } catch (e) {
      showToast(`Screenshot failed: ${String(e)}`);
    }
  }, [showToast]);

  // Keyboard shortcuts (case-insensitive, with frame-stepping , / . and zoom reset)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (settingsOpen) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      switch (key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekTo((videoRef.current?.currentTime ?? currentTime) - 5);
          break;
        case "ArrowRight":
          e.preventDefault();
          seekTo((videoRef.current?.currentTime ?? currentTime) + 5);
          break;
        case ",":
          e.preventDefault();
          stepFrame(-1);
          break;
        case ".":
          e.preventDefault();
          stepFrame(1);
          break;
        case "f":
          toggleFullscreen();
          break;
        case "m":
          setMuted((m) => !m);
          break;
        case "n":
          next();
          break;
        case "p":
          prev();
          break;
        case "0":
          setVideoZoom(1);
          setVideoPan({ x: 0, y: 0 });
          break;
        case "1":
          setRate(1);
          break;
        case "2":
          setRate(2);
          break;
        case "5":
          setRate(0.5);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekTo, stepFrame, toggleFullscreen, next, prev, currentTime, settingsOpen]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  const videoSrc = useMemo(() => (currentPath ? convertFileSrc(currentPath) : null), [currentPath]);

  const activeEvent = useMemo(() => {
    if (!viewTelemetry) return null;
    return viewTelemetry.events.find((ev) => Math.abs(ev.tRelMs / 1000 - currentTime) < 0.7) ?? null;
  }, [viewTelemetry, currentTime]);

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  // Precompute cumulative distance array once per clip so distanceSoFar is O(log n)
  const cumulativeDistances = useMemo(() => {
    if (!viewTelemetry || viewTelemetry.fixes.length === 0) return [];
    const out = new Array<number>(viewTelemetry.fixes.length);
    out[0] = 0;
    for (let i = 1; i < viewTelemetry.fixes.length; i++) {
      out[i] =
        out[i - 1] +
        haversineM(
          viewTelemetry.fixes[i - 1].lat,
          viewTelemetry.fixes[i - 1].lon,
          viewTelemetry.fixes[i].lat,
          viewTelemetry.fixes[i].lon
        );
    }
    return out;
  }, [viewTelemetry]);

  const distanceSoFar = useMemo(() => {
    if (!viewTelemetry || cumulativeDistances.length < 2) return 0;
    const at = fixAtTime(viewTelemetry.fixes, currentTime * 1000);
    if (!at) return 0;
    const base = cumulativeDistances[at.index] ?? 0;
    if (at.next && at.index + 1 < cumulativeDistances.length) {
      const seg = cumulativeDistances[at.index + 1] - base;
      return base + seg * at.frac;
    }
    return base;
  }, [viewTelemetry, cumulativeDistances, currentTime]);

  // Seek bar pointer handling
  const seekRef = useRef<HTMLDivElement | null>(null);
  const seekFromClient = useCallback((clientX: number) => {
    const el = seekRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    seekTo(frac * duration);
  }, [duration, seekTo]);

  const onSeekPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromClient(e.clientX);
    const move = (ev: PointerEvent) => seekFromClient(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Digital zoom wheel + drag handlers on video stage
  const onStageWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    setVideoZoom((prevZoom) => {
      const nextZoom = Math.min(5, Math.max(1, +(prevZoom - e.deltaY * 0.0025).toFixed(2)));
      if (nextZoom === 1) setVideoPan({ x: 0, y: 0 });
      return nextZoom;
    });
  };

  const onStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (videoZoom <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    panDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: videoPan.x,
      origY: videoPan.y,
      moved: false,
    };
  };

  const onStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
    setVideoPan({ x: drag.origX + dx, y: drag.origY + dy });
  };

  const onStagePointerUp = () => {
    panDragRef.current = null;
  };

  const onStageClick = () => {
    if (panDragRef.current?.moved) return;
    togglePlay();
  };

  if (!hasVideo) {
    return (
      <div className="app" style={{ gridTemplateColumns: "1fr" }}>
        <EmptyState onOpenFile={openFileDialog} onOpenFolder={openFolderDialog} />
        {toast && (
          <div className="toast toast--show" role="status"><CheckCircle2 size={15} />{toast}</div>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar
        playlist={playlist}
        currentIndex={currentIndex}
        gpsInfo={viewTelemetry ? { fixes: viewTelemetry.fixes.length, source: viewTelemetry.gpsSource } : null}
        onOpenFile={openFileDialog}
        onOpenFolder={openFolderDialog}
        onSelect={(i) => loadIndex(i)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="stage-col">
        <ErrorBoundary label="the player">
          <div
            className="stage"
            ref={stageRef}
            onClick={onStageClick}
            onDoubleClick={toggleFullscreen}
            onWheel={onStageWheel}
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerUp}
            style={{ cursor: videoZoom > 1 ? "grab" : "pointer" }}
          >
            <div className="stage__inner">
              <video
                key={currentPath ?? "none"}
                ref={videoRef}
                src={videoSrc ?? undefined}
                autoPlay
                playsInline
                style={{
                  transform: videoZoom > 1 ? `translate(${videoPan.x}px, ${videoPan.y}px) scale(${videoZoom})` : undefined,
                  transformOrigin: "center center",
                  transition: panDragRef.current ? "none" : "transform 0.12s ease-out",
                }}
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                onLoadedMetadata={(e) => {
                  const d = e.currentTarget.duration;
                  setDuration(isFinite(d) && d > 0 ? d : telemetry?.durationSecs ?? 0);
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => {
                  if (settings.autoAdvance && currentIndex < playlist.length - 1) next();
                  else showToast("End of playlist");
                }}
                onError={() => setError("Video could not be decoded by this system (WebView2 H.264/265 required).")}
              />
              <Hud
                telemetry={viewTelemetry}
                currentTime={currentTime}
                visible={!loading && !error}
                detectedRoad={detectedRoad}
              />
            </div>

            {videoZoom > 1 && (
              <button
                className="zoom-badge"
                onClick={(e) => {
                  e.stopPropagation();
                  setVideoZoom(1);
                  setVideoPan({ x: 0, y: 0 });
                }}
                title="Reset video zoom (0)"
              >
                <ZoomIn size={12} /> {videoZoom.toFixed(1)}× · Reset <RotateCcw size={11} />
              </button>
            )}

            {activeEvent && (
              <div className="event-flash event-flash--show">
                <AlertOctagon size={16} /> {activeEvent.kind} · Δ {formatSpeed(activeEvent.deltaKmh, settings.speedUnit)} {SPEED_UNIT_LABEL[settings.speedUnit]}
              </div>
            )}

            {loading && (
              <div className="empty" style={{ background: "rgba(7,10,18,0.55)", zIndex: 6 }}>
                <div className="spinner" />
                <p className="empty__sub" style={{ marginTop: 16 }}>Decoding GPS telemetry…</p>
              </div>
            )}

            {error && (
              <div className="error-banner">
                <AlertOctagon size={15} /> {error}
              </div>
            )}
          </div>

          <div className="controls" onClick={(e) => e.stopPropagation()}>
            <button className="cbtn" onClick={prev} title="Previous clip (P)" aria-label="Previous">
              <SkipBack size={17} fill="currentColor" />
            </button>
            <button className="cbtn cbtn--play" onClick={togglePlay} title="Play / pause (Space)" aria-label="Play or pause">
              {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" style={{ marginLeft: 2 }} />}
            </button>
            <button className="cbtn" onClick={next} title="Next clip (N)" aria-label="Next">
              <SkipForward size={17} fill="currentColor" />
            </button>

            <div className="timecode" title="Use , and . keys to step frame-by-frame">
              <b>{formatDuration(currentTime)}</b> / {formatDuration(duration)}
            </div>

            <div
              ref={seekRef}
              className="seek"
              role="slider"
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(currentTime)}
              tabIndex={0}
              onPointerDown={onSeekPointerDown}
              onPointerMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const xPx = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
                const timeSec = (xPx / Math.max(1, rect.width)) * duration;
                setSeekHover({ xPx, timeSec });
              }}
              onPointerLeave={() => setSeekHover(null)}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") seekTo(currentTime - 5);
                else if (e.key === "ArrowRight") seekTo(currentTime + 5);
              }}
            >
              <div className="seek__bg">
                <div className="seek__fill" style={{ width: `${progress * 100}%` }} />
              </div>
              {viewTelemetry?.events.map((ev, i) => (
                <div
                  key={i}
                  className="seek__event"
                  style={{ left: `${(ev.tRelMs / 1000 / Math.max(0.001, duration)) * 100}%` }}
                  title={`${ev.kind} at ${formatDuration(ev.tRelMs / 1000)}`}
                />
              ))}
              <div className="seek__knob" style={{ left: `${progress * 100}%` }} />
              {seekHover && duration > 0 && (
                <div className="seek__tooltip" style={{ left: `${seekHover.xPx}px` }}>
                  {formatDuration(seekHover.timeSec)}
                  {viewTelemetry && viewTelemetry.fixes.length > 0 && (() => {
                    const p = positionAtTime(viewTelemetry.fixes, seekHover.timeSec);
                    return p ? ` · ${formatSpeed(p.speedKmh, settings.speedUnit)} ${SPEED_UNIT_LABEL[settings.speedUnit]}` : "";
                  })()}
                </div>
              )}
            </div>

            <div className="speed-toggle" title="Playback speed">
              {[0.25, 0.5, 1, 1.5, 2].map((r) => (
                <button key={r} className={rate === r ? "on" : ""} onClick={() => setRate(r)}>{r}×</button>
              ))}
            </div>

            <div className="divider-v" />

            <button className="cbtn" onClick={() => setMuted((m) => !m)} title="Mute (M)" aria-label="Mute">
              {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
            </button>
            <button className="cbtn" onClick={exportGpx} title="Export GPX track" aria-label="Export GPX">
              <Download size={17} />
            </button>
            <button className="cbtn" onClick={takeScreenshot} title="Capture app screenshot" aria-label="Capture screenshot">
              <Camera size={17} />
            </button>
            <button className="cbtn" onClick={toggleFullscreen} title="Fullscreen (F or Double-click)" aria-label="Fullscreen">
              {isFullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
            </button>
          </div>
        </ErrorBoundary>
      </main>

      <div className="right-panel">
        <ErrorBoundary label="the analytics panel">
          <div className="mapbox">
            <MapView
              fixes={viewTelemetry?.fixes ?? []}
              events={viewTelemetry?.events ?? []}
              currentTime={currentTime}
              follow={follow}
              onToggleFollow={() => setFollow((f) => !f)}
              onFitBounds={() => setFitTrigger((n) => n + 1)}
              followTrigger={fitTrigger}
              mapStyle={settings.mapStyle}
              onMapStyleChange={(v) => update({ mapStyle: v })}
              onOpenSettings={() => setSettingsOpen(true)}
              onSeek={seekTo}
              externalLandmarks={externalLandmarks}
              onRoadDetected={setDetectedRoad}
            />
          </div>

          <RightPanel
            telemetry={viewTelemetry}
            currentTime={currentTime}
            onSeek={seekTo}
            tab={tab}
            onTab={setTab}
            onJumpToEvent={(ms) => seekTo(ms / 1000)}
          />

          <div className="sidebar__footer maps-footer">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ChevronLeft size={11} /> travelled {formatDistance(distanceSoFar, settings.distanceUnit)} of {formatDistance(viewTelemetry ? viewTelemetry.distanceM : 0, settings.distanceUnit)}
            </span>
            <span style={{ fontFamily: "var(--font-mono)" }}>
              {(() => {
                const pos = viewTelemetry ? positionAtTime(viewTelemetry.fixes, currentTime) : null;
                return pos ? `${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}` : "—";
              })()}
            </span>
          </div>
        </ErrorBoundary>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} onShowToast={showToast} />

      {toast && (
        <div className="toast toast--show" role="status"><CheckCircle2 size={15} />{toast}</div>
      )}
    </div>
  );
}
