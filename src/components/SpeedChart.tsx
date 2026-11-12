import { useCallback, useMemo, useRef } from "react";
import type { GpsFix, HarshEvent } from "../lib/telemetry";

interface SpeedChartProps {
  fixes: GpsFix[];
  events: HarshEvent[];
  duration: number; // seconds
  currentTime: number; // seconds
  height?: number;
  onSeek: (tSec: number) => void;
  showAxis?: boolean;
}

export default function SpeedChart({ fixes, events, duration, currentTime, height = 132, onSeek, showAxis = true }: SpeedChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const maxSpeed = useMemo(() => Math.max(10, ...fixes.map((f) => f.speedKmh)), [fixes]);

  const { area, line } = useMemo(() => {
    if (fixes.length === 0) return { area: "", line: "" };
    const pts = fixes.map((f) => ({
      x: (f.relMs / 1000 / Math.max(0.001, duration)) * 1000,
      y: 118 - (f.speedKmh / maxSpeed) * 104,
    }));
    const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
    const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(2)},118 L0,118 Z`;
    return { area: areaPath, line: linePath };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixes, duration, maxSpeed]);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      onSeek(frac * duration);
    },
    [duration, onSeek]
  );

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX);
    const move = (ev: PointerEvent) => seekFromClientX(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const cursorX = duration > 0 ? (Math.min(currentTime, duration) / duration) * 1000 : 0;

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 1000 124"
      preserveAspectRatio="none"
      style={{ width: "100%", height, display: "block", cursor: "crosshair", borderRadius: 8 }}
      onPointerDown={onPointerDown}
      role="slider"
      aria-label="Seek video by speed"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(currentTime)}
    >
      <defs>
        <linearGradient id="speedFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.03" />
        </linearGradient>
        <linearGradient id="speedStroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="50%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#34d399" />
        </linearGradient>
      </defs>

      {/* grid lines */}
      {showAxis && [0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1="0" x2="1000" y1={18 + f * 86} y2={18 + f * 86} stroke="#1c2637" strokeWidth="1" strokeDasharray="3 5" />
      ))}

      {fixes.length > 1 && (
        <>
          <path d={area} fill="url(#speedFill)" />
          <path d={line} fill="none" stroke="url(#speedStroke)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
        </>
      )}

      {/* harsh events */}
      {events.map((ev, i) => {
        const x = (ev.tRelMs / 1000 / Math.max(0.001, duration)) * 1000;
        return <circle key={i} cx={x} cy="112" r="4.4" fill="#fb7185" stroke="#2a0a10" strokeWidth="1.4" />;
      })}

      {/* cursor */}
      <line x1={cursorX} x2={cursorX} y1="10" y2="118" stroke="#ecfeff" strokeOpacity="0.85" strokeWidth="1.4" />
      <circle cx={cursorX} cy="12" r="2.6" fill="#ecfeff" />
    </svg>
  );
}
