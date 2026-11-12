import { useEffect, useRef, useState } from "react";
import { useSettings, speedValue, SPEED_UNIT_LABEL } from "../lib/settings";

interface SpeedGaugeProps {
  speedKmh: number; // telemetry speed, always km/h
  maxRef: number; // reference top of the dial, km/h
  speedLimitKmh?: number; // optional road speed limit
}

function niceCeil(v: number): number {
  for (const c of [40, 60, 80, 100, 120, 160, 200, 240, 300]) {
    if (v <= c) return c;
  }
  return Math.ceil(v / 50) * 50;
}

/** Dynamic colour along the dial (0..1 of full scale) */
function dialColor(frac: number): string {
  const stops: [number, [number, number, number]][] = [
    [0.0, [56, 189, 248]],   // sky blue
    [0.35, [34, 211, 238]],  // cyan
    [0.6, [52, 211, 153]],   // emerald
    [0.8, [245, 180, 74]],   // amber
    [1.0, [251, 113, 133]],  // rose red
  ];
  const t = Math.min(1, Math.max(0, frac));
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1 || i === stops.length - 2) {
      const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * k);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * k);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * k);
      return `rgb(${r},${g},${b})`;
    }
  }
  return "#22d3ee";
}

/**
 * Sports-cockpit SVG speedometer with:
 * - 60fps damped spring needle & arc animation
 * - Fixed `userSpaceOnUse` gradient so partial arcs never squeeze into rainbow tips
 * - Segmented LED outer ring + major/minor precision ticks
 * - Peak-speed hold marker & optional road speed-limit marker
 */
export default function SpeedGauge({ speedKmh, maxRef, speedLimitKmh }: SpeedGaugeProps) {
  const { settings } = useSettings();
  const unit = settings.speedUnit;

  // Smooth spring/lerp animation towards target speedKmh
  const [animKmh, setAnimKmh] = useState(speedKmh);
  const currentRef = useRef(speedKmh);
  const targetRef = useRef(speedKmh);
  targetRef.current = speedKmh;

  useEffect(() => {
    let rafId = 0;
    let lastTime = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.06, (now - lastTime) / 1000);
      lastTime = now;
      const diff = targetRef.current - currentRef.current;
      if (Math.abs(diff) > 0.04) {
        // exponential critically-damped smoothing (~14/s)
        currentRef.current += diff * Math.min(1, dt * 13);
        setAnimKmh(currentRef.current);
        rafId = requestAnimationFrame(step);
      } else if (currentRef.current !== targetRef.current) {
        currentRef.current = targetRef.current;
        setAnimKmh(currentRef.current);
      }
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [speedKmh]);

  const displaySpeed = speedValue(animKmh, unit);
  const displayMax = speedValue(maxRef, unit);
  const displayLimit = speedLimitKmh != null ? speedValue(speedLimitKmh, unit) : null;
  const scale = niceCeil(Math.max(displayMax * 1.15, displayLimit ?? 0, unit === "ms" ? 20 : 60));
  const frac = Math.min(1, Math.max(0, displaySpeed / scale));
  const peakFrac = Math.min(1, Math.max(0, displayMax / scale));
  const limitFrac = displayLimit != null ? Math.min(1, Math.max(0, displayLimit / scale)) : null;

  // Dial geometry: 240° sweep
  const cx = 120;
  const cy = 96;
  const r = 68;
  const START = -120;
  const SWEEP = 240;

  const polar = (deg: number, radius: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
  };

  const arcPath = (fromDeg: number, toDeg: number, radius: number) => {
    const span = Math.max(0.01, toDeg - fromDeg);
    const s = polar(fromDeg, radius);
    const e = polar(fromDeg + span, radius);
    const large = span > 180 ? 1 : 0;
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  };

  const valueAngle = START + SWEEP * frac;
  const fullArcLength = (SWEEP * Math.PI * r) / 180;
  const activeLength = fullArcLength * frac;
  const activeColor = dialColor(frac);

  // Tapered needle polygon points (rotated around cx, cy)
  const needleRad = ((valueAngle - 90) * Math.PI) / 180;
  const cosA = Math.cos(needleRad);
  const sinA = Math.sin(needleRad);
  const rotPt = (lx: number, ly: number) => `${(cx + lx * cosA - ly * sinA).toFixed(2)},${(cy + lx * sinA + ly * cosA).toFixed(2)}`;
  const needlePoly = [
    rotPt(-12, -3.2),
    rotPt(r - 9, -0.9),
    rotPt(r - 4, 0),
    rotPt(r - 9, 0.9),
    rotPt(-12, 3.2),
  ].join(" ");

  // Ticks: major & minor
  const majorStep = scale >= 200 ? 40 : scale >= 100 ? 20 : scale >= 60 ? 10 : 5;
  const minorStep = majorStep / 5;
  const minorTicks: number[] = [];
  for (let v = 0; v <= scale + 0.001; v += minorStep) {
    minorTicks.push(Math.round(v * 10) / 10);
  }

  // Segmented outer LED ring (32 segments)
  const SEGMENTS = 32;
  const segElements = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const sFrac = i / (SEGMENTS - 1);
    const a = START + SWEEP * sFrac;
    const p1 = polar(a, r + 11.5);
    const p2 = polar(a, r + 14.5);
    const lit = sFrac <= frac + 0.005 && frac > 0.005;
    segElements.push(
      <line
        key={i}
        x1={p1.x.toFixed(2)}
        y1={p1.y.toFixed(2)}
        x2={p2.x.toFixed(2)}
        y2={p2.y.toFixed(2)}
        stroke={lit ? dialColor(sFrac) : "#1b2538"}
        strokeWidth={lit ? "2.4" : "1.6"}
        strokeLinecap="round"
        opacity={lit ? 0.95 : 0.55}
      />
    );
  }

  const formattedNumber = unit === "ms" ? displaySpeed.toFixed(1) : String(Math.round(displaySpeed));

  return (
    <svg
      viewBox="0 0 240 176"
      style={{ width: "100%", display: "block" }}
      role="img"
      aria-label={`Speed ${formattedNumber} ${SPEED_UNIT_LABEL[unit]}`}
    >
      <defs>
        {/* Fixed userSpaceOnUse coordinates across the dial so low speeds stay cool blue/cyan */}
        <linearGradient id="gaugeFixedGrad" gradientUnits="userSpaceOnUse" x1="48" y1="130" x2="192" y2="130">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="35%" stopColor="#22d3ee" />
          <stop offset="65%" stopColor="#34d399" />
          <stop offset="84%" stopColor="#f5b44a" />
          <stop offset="100%" stopColor="#fb7185" />
        </linearGradient>

        <radialGradient id="dialFaceGrad" cx="50%" cy="52%" r="50%">
          <stop offset="0%" stopColor="rgba(34, 211, 238, 0.09)" />
          <stop offset="65%" stopColor="rgba(14, 20, 32, 0.45)" />
          <stop offset="100%" stopColor="rgba(7, 10, 18, 0.0)" />
        </radialGradient>
      </defs>

      {/* Subtle inner cockpit dial face */}
      <circle cx={cx} cy={cy} r={r - 6} fill="url(#dialFaceGrad)" />
      <path
        d={arcPath(START, START + SWEEP, r - 18)}
        fill="none"
        stroke="rgba(148, 163, 184, 0.1)"
        strokeWidth="1"
        strokeDasharray="2 4"
      />

      {/* Outer segmented LED ring */}
      {segElements}

      {/* Main arc track */}
      <path
        d={arcPath(START, START + SWEEP, r)}
        fill="none"
        stroke="#151e30"
        strokeWidth="12"
        strokeLinecap="round"
      />

      {/* Redline zone track hint (80%..100%) */}
      <path
        d={arcPath(START + SWEEP * 0.8, START + SWEEP, r)}
        fill="none"
        stroke="rgba(251, 113, 133, 0.18)"
        strokeWidth="12"
        strokeLinecap="round"
      />

      {/* Active value arc — uses strokeDasharray on the full path so gradient never distorts */}
      {frac > 0.003 && (
        <>
          <path
            d={arcPath(START, START + SWEEP, r)}
            fill="none"
            stroke="url(#gaugeFixedGrad)"
            strokeWidth="20"
            strokeLinecap="round"
            strokeDasharray={`${activeLength.toFixed(2)} ${fullArcLength.toFixed(2)}`}
            opacity="0.22"
          />
          <path
            d={arcPath(START, START + SWEEP, r)}
            fill="none"
            stroke="url(#gaugeFixedGrad)"
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={`${activeLength.toFixed(2)} ${fullArcLength.toFixed(2)}`}
          />
        </>
      )}

      {/* Minor & major ticks + numeric labels */}
      {minorTicks.map((v, idx) => {
        const isMajor = Math.abs(v % majorStep) < 0.01 || Math.abs((v % majorStep) - majorStep) < 0.01;
        const tFrac = v / scale;
        const a = START + SWEEP * tFrac;
        const passed = tFrac <= frac + 0.005;
        const p1 = polar(a, r - 8.5);
        const p2 = polar(a, isMajor ? r - 16 : r - 12.5);
        const label = polar(a, r - 25);
        return (
          <g key={idx}>
            <line
              x1={p1.x.toFixed(2)}
              y1={p1.y.toFixed(2)}
              x2={p2.x.toFixed(2)}
              y2={p2.y.toFixed(2)}
              stroke={passed ? activeColor : isMajor ? "#475878" : "#28344b"}
              strokeWidth={isMajor ? "1.8" : "1"}
              strokeLinecap="round"
            />
            {isMajor && (
              <text
                x={label.x.toFixed(2)}
                y={(label.y + 3).toFixed(2)}
                textAnchor="middle"
                fontSize="8"
                fontWeight={passed ? "700" : "500"}
                fill={passed ? "#dbeafe" : "#64748b"}
                fontFamily="'JetBrains Mono', monospace"
              >
                {Math.round(v)}
              </text>
            )}
          </g>
        );
      })}

      {/* Peak speed hold marker on rim */}
      {peakFrac > 0.02 && (
        (() => {
          const a = START + SWEEP * peakFrac;
          const pOuter = polar(a, r + 7);
          const pInner = polar(a, r - 7);
          return (
            <line
              x1={pInner.x.toFixed(2)}
              y1={pInner.y.toFixed(2)}
              x2={pOuter.x.toFixed(2)}
              y2={pOuter.y.toFixed(2)}
              stroke="#38bdf8"
              strokeWidth="2"
              strokeLinecap="round"
              opacity="0.85"
            >
              <title>Max clip speed: {Math.round(displayMax)} {SPEED_UNIT_LABEL[unit]}</title>
            </line>
          );
        })()
      )}

      {/* Optional Speed Limit marker on rim */}
      {limitFrac != null && limitFrac > 0 && (
        (() => {
          const a = START + SWEEP * limitFrac;
          const pOuter = polar(a, r + 9);
          const pInner = polar(a, r - 7);
          return (
            <line
              x1={pInner.x.toFixed(2)}
              y1={pInner.y.toFixed(2)}
              x2={pOuter.x.toFixed(2)}
              y2={pOuter.y.toFixed(2)}
              stroke="#ef4444"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          );
        })()
      )}

      {/* Glowing needle underlay + crisp tapered needle */}
      <polygon points={needlePoly} fill={activeColor} opacity="0.28" transform="scale(1.04)" style={{ transformOrigin: `${cx}px ${cy}px` }} />
      <polygon points={needlePoly} fill="#f8fafc" />

      {/* Center cap */}
      <circle cx={cx} cy={cy} r="9.5" fill="#0b101c" stroke={activeColor} strokeWidth="2.4" />
      <circle cx={cx} cy={cy} r="3.2" fill={activeColor} />

      {/* Digital readout */}
      <text
        x={cx}
        y={cy + 42}
        textAnchor="middle"
        fontSize="31"
        fontWeight="700"
        fill="#f8fafc"
        fontFamily="'JetBrains Mono', monospace"
        letterSpacing="-1.2"
      >
        {formattedNumber}
      </text>
      <text
        x={cx}
        y={cy + 55}
        textAnchor="middle"
        fontSize="8.5"
        fontWeight="600"
        fill={activeColor}
        fontFamily="'Space Grotesk', sans-serif"
        letterSpacing="2.4"
      >
        {SPEED_UNIT_LABEL[unit].toUpperCase()}
      </text>
    </svg>
  );
}
