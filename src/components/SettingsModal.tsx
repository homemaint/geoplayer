import { useEffect } from "react";
import {
  X, Gauge, Clock3, Navigation, Map as MapIcon, Palette, Play, RotateCcw, Check,
} from "lucide-react";
import {
  useSettings, TIMEZONES, type Hemisphere, type Accent, type SpeedUnit, type DistanceUnit, type MapStyle,
} from "../lib/settings";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onShowToast: (msg: string) => void;
}

function Segment<T extends string>({
  options, value, onChange, ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={`seg__btn${value === o.value ? " on" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="switch-row">
      <span className="switch-row__text">
        <span className="switch-row__label">{label}</span>
        {hint && <span className="switch-row__hint">{hint}</span>}
      </span>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch${checked ? " on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__thumb" />
      </button>
    </label>
  );
}

const ACCENTS: { id: Accent; name: string; swatch: string }[] = [
  { id: "cyan", name: "Cyan", swatch: "linear-gradient(135deg,#22d3ee,#34d399)" },
  { id: "emerald", name: "Emerald", swatch: "linear-gradient(135deg,#34d399,#10b981)" },
  { id: "amber", name: "Amber", swatch: "linear-gradient(135deg,#f5b44a,#fb923c)" },
  { id: "rose", name: "Rose", swatch: "linear-gradient(135deg,#fb7185,#f472b6)" },
  { id: "violet", name: "Violet", swatch: "linear-gradient(135deg,#a78bfa,#818cf8)" },
];

export default function SettingsModal({ open, onClose, onShowToast }: SettingsModalProps) {
  const { settings, update, reset } = useSettings();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-scrim" onMouseDown={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal__header">
          <div className="modal__title">Settings</div>
          <button className="btn btn--icon" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </header>

        <div className="modal__body">
          {/* ---- Units ---- */}
          <section className="set-section">
            <div className="set-section__title"><Gauge size={13} /> Units</div>
            <div className="set-row">
              <div className="set-row__label">Speed display</div>
              <Segment<SpeedUnit>
                ariaLabel="Speed unit"
                value={settings.speedUnit}
                onChange={(v) => update({ speedUnit: v })}
                options={[
                  { value: "kmh", label: "km/h" },
                  { value: "mph", label: "mph" },
                  { value: "ms", label: "m/s" },
                ]}
              />
            </div>
            <div className="set-row">
              <div className="set-row__label">Distance</div>
              <Segment<DistanceUnit>
                ariaLabel="Distance unit"
                value={settings.distanceUnit}
                onChange={(v) => update({ distanceUnit: v })}
                options={[
                  { value: "km", label: "Kilometres" },
                  { value: "mi", label: "Miles" },
                ]}
              />
            </div>
          </section>

          {/* ---- Time ---- */}
          <section className="set-section">
            <div className="set-section__title"><Clock3 size={13} /> Clock &amp; time zone</div>
            <Switch
              label="Match the video timestamp"
              hint="Shows the same UTC date/time as the dashcam's burned-in overlay"
              checked={settings.clockSync}
              onChange={(v) => update({ clockSync: v })}
            />
            {!settings.clockSync && (
              <div className="set-row set-row--stack">
                <div className="set-row__label">Clock display</div>
                <select
                  className="set-select"
                  value={settings.timezone}
                  onChange={(e) => update({ timezone: e.target.value })}
                  aria-label="Time zone"
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz.id} value={tz.id}>{tz.label}</option>
                  ))}
                </select>
              </div>
            )}
            <p className="set-hint">Dashcam GPS timestamps are recorded in UTC. “Match the video timestamp” keeps the HUD clock in sync with the time burned into the footage; turn it off to display another time zone.</p>
          </section>

          {/* ---- GPS ---- */}
          <section className="set-section">
            <div className="set-section__title"><Navigation size={13} /> GPS</div>
            <div className="set-row">
              <div className="set-row__label">
                Hemisphere<br /><span className="set-row__sub">files with unsigned coordinates</span>
              </div>
              <Segment<Hemisphere>
                ariaLabel="Assumed hemisphere"
                value={settings.assumedHemisphere}
                onChange={(v) => update({ assumedHemisphere: v })}
                options={[
                  { value: "NE", label: "N · E" },
                  { value: "NW", label: "N · W" },
                  { value: "SE", label: "S · E" },
                  { value: "SW", label: "S · W" },
                ]}
              />
            </div>
            <p className="set-hint">This camera writes coordinates without a hemisphere flag. Pick the region you drive in (e.g. India = N · E). The route map and markers flip accordingly.</p>
          </section>

          {/* ---- Map ---- */}
          <section className="set-section">
            <div className="set-section__title"><MapIcon size={13} /> Map &amp; Road Data</div>
            <div className="set-row">
              <div className="set-row__label">Base map</div>
              <Segment<MapStyle>
                ariaLabel="Base map style"
                value={settings.mapStyle}
                onChange={(v) => update({ mapStyle: v })}
                options={[
                  { value: "openfreemap", label: "OpenFreeMap + Overture" },
                  { value: "tomtom", label: "TomTom" },
                  { value: "satellite", label: "Satellite" },
                  { value: "schematic", label: "Offline" },
                ]}
              />
            </div>
            <div className="set-row set-row--stack">
              <div className="set-row__label">
                TomTom API key <span className="set-row__sub">(optional · free tier at developer.tomtom.com)</span>
              </div>
              <input
                className="set-input"
                type="password"
                value={settings.tomtomKey}
                onChange={(e) => update({ tomtomKey: e.target.value.trim() })}
                placeholder="your TomTom developer API key"
                spellCheck={false}
                autoComplete="off"
                aria-label="TomTom API key"
              />
              <p className="set-hint">
                Enables TomTom Night tiles, Snap-to-Roads (posted road speed limits, highway numbers, and overspeed alerts),
                fresh nearby POIs, and street addresses for harsh events. Responses are cached on disk so replaying a clip
                never uses extra quota.
              </p>
            </div>
            <Switch
              label="Follow the car"
              hint="Camera keeps the car centered while the video plays"
              checked={settings.followByDefault}
              onChange={(v) => update({ followByDefault: v })}
            />
            <Switch
              label="Nearby landmarks card"
              hint="Lists the closest POIs, villages, peaks and rivers to the car's position"
              checked={settings.showLandmarks}
              onChange={(v) => update({ showLandmarks: v })}
            />
            <Switch
              label="Tourist & history guide (HUD)"
              hint="Displays live Wikipedia historical facts and landmark insights for the area the vehicle is passing through"
              checked={settings.showPlaceGuide}
              onChange={(v) => update({ showPlaceGuide: v })}
            />
          </section>

          {/* ---- Playback ---- */}
          <section className="set-section">
            <div className="set-section__title"><Play size={13} /> Playback</div>
            <Switch
              label="Autoplay next clip"
              hint="When a clip ends, the next file in the playlist starts automatically"
              checked={settings.autoAdvance}
              onChange={(v) => update({ autoAdvance: v })}
            />
          </section>

          {/* ---- Appearance ---- */}
          <section className="set-section">
            <div className="set-section__title"><Palette size={13} /> Accent</div>
            <div className="swatches" role="radiogroup" aria-label="Accent color">
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  role="radio"
                  aria-checked={settings.accent === a.id}
                  className={`swatch${settings.accent === a.id ? " on" : ""}`}
                  style={{ background: a.swatch }}
                  title={a.name}
                  aria-label={`Accent ${a.name}`}
                  onClick={() => update({ accent: a.id })}
                >
                  {settings.accent === a.id && <Check size={16} strokeWidth={3} />}
                </button>
              ))}
            </div>
          </section>
        </div>

        <footer className="modal__footer">
          <button className="btn" onClick={() => { reset(); onShowToast("Settings restored to defaults"); }}>
            <RotateCcw size={14} /> Restore defaults
          </button>
          <button className="btn btn--primary" onClick={onClose} style={{ padding: "9px 22px" }}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
