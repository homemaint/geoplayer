import { Gauge, Route, Timer, CalendarClock, Satellite, AlertTriangle, Activity, TrendingUp, HardDrive, CircleAlert } from "lucide-react";
import type { VideoTelemetry } from "../lib/telemetry";
import { formatBytes, formatDuration, positionAtTime } from "../lib/telemetry";
import { useSettings, formatSpeed, SPEED_UNIT_LABEL, formatDistance, speedBuckets, speedValue, tzParts } from "../lib/settings";
import SpeedChart from "./SpeedChart";
import SpeedGauge from "./SpeedGauge";

type Tab = "overview" | "graph" | "events";

interface RightPanelProps {
  telemetry: VideoTelemetry | null;
  currentTime: number;
  onSeek: (tSec: number) => void;
  tab: Tab;
  onTab: (t: Tab) => void;
  onJumpToEvent: (tRelMs: number) => void;
}

function Stat({ icon: Icon, label, value, unit, sub }: { icon: typeof Gauge; label: string; value: string; unit?: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat__label"><Icon size={12} />{label}</div>
      <div className="stat__value">{value}{unit && <small>{unit}</small>}</div>
      {sub && <div className="stat__sub">{sub}</div>}
    </div>
  );
}

export default function RightPanel({ telemetry, currentTime, onSeek, tab, onTab, onJumpToEvent }: RightPanelProps) {
  const { settings } = useSettings();
  const fixes = telemetry?.fixes ?? [];
  const duration = telemetry?.durationSecs ?? 0;
  const unit = settings.speedUnit;
  const distUnit = settings.distanceUnit;

  // satellite count / altitude — only some dashcams write them
  const signal = (() => {
    let sats: number | null = null;
    let alt: number | null = null;
    for (const f of fixes) {
      if (f.sats != null) sats = f.sats;
      if (f.altitudeM != null) alt = f.altitudeM;
    }
    if (sats == null && alt == null) return null;
    const parts: string[] = [];
    if (sats != null) parts.push(`${sats} sats`);
    if (alt != null) parts.push(`${Math.round(alt)} m`);
    return parts.join(" · ");
  })();

  const pos = positionAtTime(fixes, currentTime);

  return (
    <>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "overview"} className={`tab${tab === "overview" ? " active" : ""}`} onClick={() => onTab("overview")}>
          <Gauge size={13} /> Overview
        </button>
        <button role="tab" aria-selected={tab === "graph"} className={`tab${tab === "graph" ? " active" : ""}`} onClick={() => onTab("graph")}>
          <TrendingUp size={13} /> Graphs
        </button>
        <button role="tab" aria-selected={tab === "events"} className={`tab${tab === "events" ? " active" : ""}`} onClick={() => onTab("events")}>
          <AlertTriangle size={13} /> Events
          {telemetry && telemetry.events.length > 0 && <span className="tab__badge">{telemetry.events.length}</span>}
        </button>
      </div>

      <div className="tab-content">
        {!telemetry ? (
          <div className="empty-note"><Activity size={20} strokeWidth={1.7} /><span>Load a video to see trip analytics.</span></div>
        ) : tab === "overview" ? (
          <>
            <div className="chart-card gauge-card">
              <div className="chart-card__head">
                <span className="chart-card__title"><Gauge size={12} /> Speedometer</span>
                <span className="chart-card__max">
                  {pos?.speedLimitKmh != null
                    ? `LIMIT ${formatSpeed(pos.speedLimitKmh, unit)} · MAX ${formatSpeed(telemetry.maxSpeedKmh, unit)} ${SPEED_UNIT_LABEL[unit]}`
                    : `MAX ${formatSpeed(telemetry.maxSpeedKmh, unit)} ${SPEED_UNIT_LABEL[unit]}`}
                </span>
              </div>
              <SpeedGauge
                speedKmh={pos?.speedKmh ?? 0}
                maxRef={telemetry.maxSpeedKmh}
                speedLimitKmh={pos?.speedLimitKmh}
              />
            </div>
            <div className="file-card">
              <div className="file-card__row"><span>FILE</span><b title={telemetry.path}>{telemetry.fileName}</b></div>
              <div className="file-card__row"><span>SIZE</span><b>{formatBytes(telemetry.sizeBytes)}</b></div>
              <div className="file-card__row"><span>DURATION</span><b>{formatDuration(duration)}</b></div>
              <div className="file-card__row">
                <span>RECORDED</span>
                <b>
                  {telemetry.createdUtc
                    ? (() => {
                        const tp = tzParts(new Date(telemetry.createdUtc).getTime(), settings.timezone);
                        return `${tp.date} · ${tp.time} ${tp.abbr}`;
                      })()
                    : "—"}
                </b>
              </div>
              <div className="file-card__row">
                <span>GPS</span>
                <b style={{ color: fixes.length ? "var(--success)" : "var(--text-faint)" }}>
                  {fixes.length ? `${fixes.length} fixes · ${telemetry.gpsSource}` : "no embedded telemetry"}
                </b>
              </div>
              {(pos?.roadName || pos?.roadRef) && (
                <div className="file-card__row">
                  <span>ROAD</span>
                  <b style={{ color: "var(--accent-strong)" }}>
                    {[pos.roadRef, pos.roadName, pos.place].filter(Boolean).join(" · ")}
                  </b>
                </div>
              )}
              {signal && (
                <div className="file-card__row">
                  <span>SIGNAL</span>
                  <b>{signal}</b>
                </div>
              )}
              {telemetry.coordsAssumed && (
                <div className="file-card__row"><span>NOTE</span><b style={{ color: "var(--amber)" }}>hemisphere assumed N/E (unsigned in file)</b></div>
              )}
            </div>

            <div className="stats-grid">
              <Stat icon={Route} label="Distance" value={formatDistance(telemetry.distanceM, distUnit)} />
              <Stat icon={Gauge} label="Max speed" value={formatSpeed(telemetry.maxSpeedKmh, unit)} unit={SPEED_UNIT_LABEL[unit]} />
              <Stat icon={Activity} label="Avg speed" value={formatSpeed(telemetry.avgSpeedKmh, unit)} unit={SPEED_UNIT_LABEL[unit]} />
              <Stat icon={Timer} label="Duration" value={formatDuration(duration)} />
              <Stat icon={CalendarClock} label="Recorded" value={telemetry.createdUtc ? (() => { const t = tzParts(new Date(telemetry.createdUtc).getTime(), settings.timezone); return t.date.slice(0, 6); })() : "—"} sub={telemetry.createdUtc ? (() => { const t = tzParts(new Date(telemetry.createdUtc).getTime(), settings.timezone); return `${t.time} ${t.abbr}`; })() : undefined} />
              <Stat icon={AlertTriangle} label="Hard events" value={String(telemetry.events.length)} sub={telemetry.events.length ? "see Events tab" : "clean drive"} />
            </div>
          </>
        ) : tab === "graph" ? (
          <>
            <div className="chart-card">
              <div className="chart-card__head">
                <span className="chart-card__title"><TrendingUp size={12} /> Time at speed</span>
                <span className="chart-card__max">1 fix = 1 s · {SPEED_UNIT_LABEL[unit]}</span>
              </div>
              <SpeedHistogram fixes={fixes} />
            </div>
            <div className="chart-card">
              <div className="chart-card__head">
                <span className="chart-card__title"><TrendingUp size={12} /> Speed profile</span>
                <span className="chart-card__max">MAX {formatSpeed(telemetry.maxSpeedKmh, unit)} {SPEED_UNIT_LABEL[unit]}</span>
              </div>
              <SpeedChart fixes={fixes} events={telemetry.events} duration={duration} currentTime={currentTime} onSeek={onSeek} height={140} />
            </div>

            <div className="chart-card">
              <div className="chart-card__head">
                <span className="chart-card__title"><Activity size={12} /> G-forces</span>
                <span className="chart-card__max">raw axis</span>
              </div>
              <GForceChart telemetry={telemetry} onSeek={onSeek} />
            </div>

            <div className="empty-note" style={{ padding: "12px 14px", alignItems: "flex-start", textAlign: "left" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Satellite size={13} /> Timebase: GPS 1 Hz · clip starts at {telemetry.fixes[0] ? (() => { const t = tzParts(telemetry.fixes[0].tMs, settings.timezone); return `${t.time} ${t.abbr}`; })() : "—"}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <HardDrive size={13} />
                {duration > 0
                  ? `~${((telemetry.sizeBytes * 8) / duration / 1_000_000).toFixed(1)} Mbps · decoded locally, nothing leaves your PC`
                  : "Decoded locally, nothing leaves your PC"}
              </span>
            </div>
          </>
        ) : (
          <>
            {telemetry.events.length === 0 ? (
              <div className="empty-note"><CircleAlert size={18} strokeWidth={1.7} /><span>No harsh braking, cornering, or overspeed events detected. Smooth driving.</span></div>
            ) : (
              telemetry.events.map((ev, i) => (
                <button key={i} className="event-row" onClick={() => onJumpToEvent(ev.tRelMs)}>
                  <span className="event-row__icon"><AlertTriangle size={17} /></span>
                  <span className="event-row__body">
                    <span className="event-row__kind">{ev.kind}</span>
                    <span className="event-row__detail">
                      {ev.kind.startsWith("Overspeed")
                        ? `+${formatSpeed(ev.deltaKmh, unit)} ${SPEED_UNIT_LABEL[unit]} over limit`
                        : `Δ ${formatSpeed(ev.deltaKmh, unit)} ${SPEED_UNIT_LABEL[unit]} in ≤ 2 s`}
                      {ev.address ? ` · ${ev.address}` : ""}
                    </span>
                  </span>
                  <span className="event-row__time">{formatDuration(ev.tRelMs / 1000)}</span>
                </button>
              ))
            )}
          </>
        )}
      </div>
    </>
  );
}

function SpeedHistogram({ fixes }: { fixes: { speedKmh: number }[] }) {
  const { settings } = useSettings();
  const unit = settings.speedUnit;
  const buckets = speedBuckets(unit).map((b) => ({ ...b, count: 0 }));
  for (const f of fixes) {
    const s = speedValue(f.speedKmh, unit);
    const hit = buckets.find((b) => s >= b.min && s < b.max) ?? buckets[buckets.length - 1];
    hit.count += 1;
  }
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="hist">
      {buckets.map((b) => (
        <div className="hist__col" key={b.label} title={`${b.label} ${SPEED_UNIT_LABEL[unit]} — ${b.count}s`}>
          <div className="hist__val">{b.count > 0 ? `${b.count}s` : ""}</div>
          <div className="hist__track">
            <div className="hist__bar" style={{ height: `${(b.count / max) * 100}%`, background: b.color }} />
          </div>
          <div className="hist__label">{b.label}</div>
        </div>
      ))}
    </div>
  );
}

function GForceChart({ telemetry, onSeek }: { telemetry: VideoTelemetry; onSeek: (tSec: number) => void }) {
  const fixes = telemetry.fixes;
  const duration = telemetry.durationSecs;
  if (fixes.length === 0) {
    return <div className="empty-note">No accelerometer data</div>;
  }
  const maxAbs = Math.max(0.5, ...fixes.flatMap((f) => (f.accel ? [Math.abs(f.accel.x), Math.abs(f.accel.y), Math.abs(f.accel.z)] : [0])));
  const line = fixes
    .map((f) => ({
      x: (f.relMs / 1000 / Math.max(0.001, duration)) * 1000,
      y: f.accel ? 60 - (f.accel.x / maxAbs) * 52 : 60,
    }))
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
  const lineY = fixes
    .map((f) => ({
      x: (f.relMs / 1000 / Math.max(0.001, duration)) * 1000,
      y: f.accel ? 60 - (f.accel.y / maxAbs) * 52 : 60,
    }))
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
  return (
    <svg
      viewBox="0 0 1000 124"
      preserveAspectRatio="none"
      style={{ width: "100%", height: 110, display: "block", cursor: "crosshair", borderRadius: 8 }}
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        onSeek(frac * duration);
      }}
    >
      <line x1="0" x2="1000" y1="60" y2="60" stroke="#1c2637" strokeWidth="1" strokeDasharray="3 5" />
      <path d={line} fill="none" stroke="#f5b44a" strokeWidth="2" strokeLinejoin="round" />
      <path d={lineY} fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinejoin="round" strokeOpacity="0.85" />
      <text x="8" y="14" fill="#f5b44a" fontSize="11" fontFamily="JetBrains Mono, monospace">X (long)</text>
      <text x="8" y="118" fill="#22d3ee" fontSize="11" fontFamily="JetBrains Mono, monospace">Y (lat)</text>
    </svg>
  );
}
