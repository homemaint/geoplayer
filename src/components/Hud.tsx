import { useEffect, useState } from "react";
import { Navigation, Satellite, Clock3, Calendar, Gauge, Route, Activity, Landmark, ChevronRight } from "lucide-react";
import { useSettings, formatSpeed, SPEED_UNIT_LABEL, speedValue, tzParts, formatDistance } from "../lib/settings";
import type { VideoTelemetry } from "../lib/telemetry";
import { positionAtTime, bearingAtTime, compassPoint, fixAtTime } from "../lib/telemetry";
import { fetchRouteHeritage, selectInsightAt, type HeritageInsight } from "../lib/wiki";

interface HudProps {
  telemetry: VideoTelemetry | null;
  currentTime: number; // seconds
  visible: boolean;
  detectedRoad?: string | null;
}

export default function Hud({ telemetry, currentTime, visible, detectedRoad }: HudProps) {
  const { settings } = useSettings();
  const [heritagePool, setHeritagePool] = useState<HeritageInsight[]>([]);
  const [manualSlotOffset, setManualSlotOffset] = useState(0);

  const pos = telemetry ? positionAtTime(telemetry.fixes, currentTime) : null;
  const roadLabel = [pos?.roadRef, pos?.roadName || detectedRoad, pos?.place]
    .filter(Boolean)
    .join(" · ");

  // Fetch Wikipedia tourist & historical insights for the current route
  useEffect(() => {
    if (!telemetry || telemetry.fixes.length === 0 || !settings.showPlaceGuide) {
      setHeritagePool([]);
      return;
    }
    const controller = new AbortController();
    fetchRouteHeritage(telemetry.fixes, roadLabel, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setHeritagePool(items);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [telemetry?.path, telemetry?.fixes.length, roadLabel, settings.showPlaceGuide]);

  if (!visible) return null;

  const tMs = currentTime * 1000;
  const bearing = telemetry ? bearingAtTime(telemetry.fixes, currentTime) : null;
  const at = telemetry ? fixAtTime(telemetry.fixes, tMs) : null;
  const g = at?.fix.accel ?? null;

  const speed = pos?.speedKmh ?? 0;
  const speedText = formatSpeed(speed, settings.speedUnit);
  const unitLabel = SPEED_UNIT_LABEL[settings.speedUnit];
  const speedLimitKmh = pos?.speedLimitKmh;
  const limitDisplay = speedLimitKmh != null ? formatSpeed(speedLimitKmh, settings.speedUnit) : null;
  const isOverspeed = speedLimitKmh != null && speed > speedLimitKmh + 3;

  // Dynamic cockpit arc & progress fraction (0..1)
  const maxRef = Math.max(telemetry?.maxSpeedKmh ?? 80, speedLimitKmh ?? 0, 60);
  const speedFrac = Math.min(1, Math.max(0, speed / maxRef));
  const BARS = 12;

  // Mini SVG cockpit ring geometry (260° sweep)
  const RING_R = 17;
  const RING_CIRC = 2 * Math.PI * RING_R; // ~106.81
  const ARC_LEN = RING_CIRC * 0.72; // 260° arc
  const arcFill = hasGpsAndSpeed(telemetry, speed) ? ARC_LEN * Math.max(0.06, speedFrac) : 0;

  // Wall-clock at the current position.
  const clockTz = settings.clockSync ? "UTC" : settings.timezone;
  let clockTime = "--:--:--";
  let clockDate = "—";
  let tzAbbr = "UTC";
  if (telemetry && telemetry.fixes.length > 0) {
    const tp = tzParts(telemetry.fixes[0].tMs + tMs, clockTz);
    clockTime = tp.time;
    clockDate = tp.date;
    tzAbbr = tp.abbr;
  } else if (telemetry?.createdUtc) {
    const tp = tzParts(new Date(telemetry.createdUtc).getTime(), clockTz);
    clockTime = tp.time;
    clockDate = tp.date;
    tzAbbr = tp.abbr;
  }

  const hasGps = !!(telemetry && telemetry.fixes.length);
  const [hh = "--", mm = "--", ss = "--"] = clockTime.split(":");

  const activeInsight =
    settings.showPlaceGuide && pos && heritagePool.length > 0
      ? selectInsightAt(heritagePool, pos.lat, pos.lon, currentTime + manualSlotOffset * 12)
      : null;

  return (
    <div className="hud" aria-hidden="true">
      {/* Top Cockpit Instrument Cluster */}
      <div className="hud-row hud-row--top">
        {/* 1. Left: Luxury Automotive Speed Cluster + Radial Dial + Speed Limit */}
        <div className="hud-speed-wrap">
          <div className={`hud-card hud-card--speed${isOverspeed ? " hud-card--overspeed" : ""}`}>
            <span className="hud-card__shine" />

            <div className="hud-speed__cluster">
              {/* Left radial mini-tachometer ring */}
              <div className="hud-speed__dial" aria-hidden="true">
                <svg viewBox="0 0 44 44" className="hud-speed__svg">
                  <defs>
                    <linearGradient id="hudSpeedArcGrad" x1="0%" y1="100%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#38bdf8" />
                      <stop offset="60%" stopColor="#22d3ee" />
                      <stop offset="100%" stopColor={isOverspeed ? "#fb7185" : "#34d399"} />
                    </linearGradient>
                  </defs>
                  {/* Track */}
                  <circle
                    cx="22"
                    cy="22"
                    r={RING_R}
                    fill="none"
                    stroke="rgba(148, 163, 184, 0.2)"
                    strokeWidth="3.6"
                    strokeLinecap="round"
                    strokeDasharray={`${ARC_LEN} ${RING_CIRC}`}
                    transform="rotate(140 22 22)"
                  />
                  {/* Active speed arc */}
                  <circle
                    cx="22"
                    cy="22"
                    r={RING_R}
                    fill="none"
                    stroke="url(#hudSpeedArcGrad)"
                    strokeWidth="3.8"
                    strokeLinecap="round"
                    strokeDasharray={`${arcFill} ${RING_CIRC}`}
                    transform="rotate(140 22 22)"
                    className="hud-speed__arc"
                  />
                </svg>
                <span className="hud-speed__dial-icon">
                  <Gauge size={13} />
                </span>
              </div>

              {/* Right digital readout + header + segmented power bar */}
              <div className="hud-speed__Right">
                <div className="hud-card__head">
                  <span className="hud-card__label">
                    {isOverspeed ? "OVERSPEED" : "SPEED"}
                  </span>
                  {telemetry && telemetry.maxSpeedKmh > 0 && (
                    <span className="hud-card__tag">
                      MAX {Math.round(speedValue(telemetry.maxSpeedKmh, settings.speedUnit))}
                    </span>
                  )}
                </div>

                <div className="hud-speed__main">
                  <span className="hud-speed__value">{hasGps ? speedText : "--"}</span>
                  <span className="hud-speed__unit">{unitLabel}</span>
                </div>

                <div className="hud-rpm" aria-hidden="true">
                  {Array.from({ length: BARS }).map((_, i) => {
                    const f = (i + 1) / BARS;
                    const on = hasGps && speed > 0.5 && f <= speedFrac + 0.05;
                    const zone = f > 0.82 ? "hot" : f > 0.58 ? "mid" : "cool";
                    return <span key={i} className={`hud-rpm__bar hud-rpm__bar--${zone}${on ? " on" : ""}`} />;
                  })}
                </div>
              </div>
            </div>
          </div>

          {limitDisplay && (
            <div className={`hud-limit${isOverspeed ? " hud-limit--alert" : ""}`} title="Posted road speed limit (TomTom)">
              <span className="hud-limit__num">{limitDisplay}</span>
              <span className="hud-limit__sub">LIMIT</span>
            </div>
          )}
        </div>

        {/* 2. Center: Telemetry Chronometer & Date */}
        <div className="hud-clock">
          <div className="hud-card hud-card--time">
            <span className="hud-card__shine" />
            <div className="hud-card__head">
              <span className="hud-card__label">
                <Clock3 size={11} /> {settings.clockSync ? "VIDEO TIME" : "CHRONO"}
              </span>
              <span className="hud-live-dot" />
            </div>
            <div className="hud-clock__time">
              <span>{hh}</span>
              <em className="hud-clock__colon">:</em>
              <span>{mm}</span>
              <em className="hud-clock__colon">:</em>
              <span className="hud-clock__sec">{ss}</span>
            </div>
          </div>

          <div className="hud-card hud-card--date">
            <span className="hud-card__shine" />
            <div className="hud-card__head">
              <span className="hud-card__label">
                <Calendar size={11} /> DATE
              </span>
              <span className="hud-card__badge">{tzAbbr}</span>
            </div>
            <div className="hud-clock__date">{clockDate.toUpperCase()}</div>
          </div>
        </div>

        {/* 3. Right: Satellite Lock & Gyro Compass */}
        <div className="hud-nav">
          <div className={`hud-card hud-card--gps${hasGps ? "" : " off"}`}>
            <span className="hud-card__shine" />
            <div className="hud-card__head">
              <span className="hud-card__label">
                <Satellite size={11} /> {hasGps ? "GPS LOCK" : "NO SIGNAL"}
              </span>
              <span className={`hud-sat-ping${hasGps ? " on" : ""}`} />
            </div>
            <div className="hud-gps__row">
              <span className="hud-card__val">
                {hasGps ? `${telemetry!.fixes.length} pts` : "OFFLINE"}
              </span>
              <span className="hud-bars" aria-hidden="true">
                <i className={hasGps ? "on" : ""} />
                <i className={hasGps ? "on" : ""} />
                <i className={hasGps ? "on" : ""} />
                <i className={hasGps ? "on" : ""} />
              </span>
            </div>
          </div>

          {bearing != null && (
            <div className="hud-card hud-card--bearing">
              <span className="hud-card__shine" />
              <div className="hud-card__head">
                <span className="hud-card__label">
                  <Navigation size={11} /> HEADING
                </span>
                <span className="hud-card__tag">{compassPoint(bearing)}</span>
              </div>
              <div className="hud-bearing__row">
                <span className="hud-compass-ring">
                  <i
                    className="hud-compass-ring__needle"
                    style={{ transform: `rotate(${bearing}deg)` }}
                  />
                </span>
                <span className="hud-card__val">
                  {String(Math.round(bearing)).padStart(3, "0")}°
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Cockpit Row: Road Telemetry Pill + Tourist/History Guide + G-Force Vector Meter */}
      <div className="hud-row hud-row--bottom">
        <div className="hud-bottom-left">
          {roadLabel && (
            <div className="hud-road-card">
              <span className="hud-road-card__icon"><Route size={14} /></span>
              <div className="hud-road-card__body">
                <span className="hud-road-card__label">ACTIVE ROUTE</span>
                <span className="hud-road-card__name">{roadLabel}</span>
              </div>
            </div>
          )}
        </div>

        {activeInsight && (
          <div
            className="hud-guide-card"
            onClick={() => setManualSlotOffset((n) => n + 1)}
            title="Click to cycle nearby historical & tourist highlights (Wikipedia)"
          >
            {activeInsight.thumbnailUrl ? (
              <img
                src={activeInsight.thumbnailUrl}
                alt={activeInsight.title}
                className="hud-guide-card__thumb"
              />
            ) : (
              <span className="hud-guide-card__icon">
                <Landmark size={15} />
              </span>
            )}
            <div className="hud-guide-card__body">
              <div className="hud-guide-card__head">
                <span className="hud-guide-card__kicker">
                  <Landmark size={9} /> PLACE &amp; HISTORY GUIDE
                </span>
                <span className="hud-guide-card__dist">
                  {formatDistance(activeInsight.distanceM, settings.distanceUnit)} {activeInsight.compass}
                </span>
              </div>
              <div className="hud-guide-card__title">
                {activeInsight.title}
                {activeInsight.description && (
                  <span className="hud-guide-card__sub"> · {activeInsight.description}</span>
                )}
              </div>
              <div className="hud-guide-card__extract">{activeInsight.extract}</div>
            </div>
            {heritagePool.length > 1 && (
              <span className="hud-guide-card__next" aria-hidden="true">
                <ChevronRight size={13} />
              </span>
            )}
          </div>
        )}

        {g && (
          <div className="hud-g-card">
            <div className="hud-g-ball">
              <span className="hud-g-ball__ring" />
              <span className="hud-g-ball__cross-h" />
              <span className="hud-g-ball__cross-v" />
              <span
                className="hud-g-ball__dot"
                style={{
                  transform: `translate(${Math.max(-11, Math.min(11, g.y * 16)).toFixed(1)}px, ${Math.max(-11, Math.min(11, -g.x * 16)).toFixed(1)}px)`,
                }}
              />
            </div>
            <div className="hud-g">
              <div className="hud-g__head">
                <Activity size={10} /> G-FORCE
              </div>
              <div className="hud-g__axes">
                {[
                  ["X", g.x],
                  ["Y", g.y],
                  ["Z", g.z],
                ].map(([label, v]) => (
                  <div className="hud-g__axis" key={label as string}>
                    <span className="hud-g__l">{label}</span>
                    <span className="hud-g__v">{(v as number).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function hasGpsAndSpeed(telemetry: VideoTelemetry | null, speed: number): boolean {
  return !!(telemetry && telemetry.fixes.length > 0 && speed > 0.3);
}
