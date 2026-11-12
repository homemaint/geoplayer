import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type SpeedUnit = "kmh" | "mph" | "ms";
export type DistanceUnit = "km" | "mi";
export type Hemisphere = "NE" | "NW" | "SE" | "SW";
/** "openfreemap" = keyless online vector map, "tomtom" = TomTom night vector/raster + road matching, "satellite" = Esri World Imagery + road labels, "schematic" = offline canvas */
export type MapStyle = "openfreemap" | "tomtom" | "satellite" | "schematic";
export type Accent = "cyan" | "emerald" | "amber" | "rose" | "violet";

export interface Settings {
  speedUnit: SpeedUnit;
  distanceUnit: DistanceUnit;
  /** 'UTC' | 'local' | IANA zone id, e.g. 'Asia/Kolkata' */
  timezone: string;
  /** Show the camera's UTC timestamp so the HUD matches the burned-in OSD */
  clockSync: boolean;
  assumedHemisphere: Hemisphere;
  mapStyle: MapStyle;
  /** TomTom developer API key (Map Display, Snap to Roads, Search, Reverse Geocode) */
  tomtomKey: string;
  /** Show the "nearby landmarks" card on the route map */
  showLandmarks: boolean;
  /** Show the Wikipedia tourist & historical guide card in the bottom HUD */
  showPlaceGuide: boolean;
  followByDefault: boolean;
  autoAdvance: boolean;
  accent: Accent;
}

export const DEFAULT_SETTINGS: Settings = {
  speedUnit: "kmh",
  distanceUnit: "km",
  timezone: "UTC",
  clockSync: true,
  assumedHemisphere: "NE",
  mapStyle: "openfreemap",
  tomtomKey: "",
  showLandmarks: false,
  showPlaceGuide: true,
  followByDefault: true,
  autoAdvance: true,
  accent: "cyan",
};

const STORAGE_KEY = "geoplayer.settings.v1";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings> & { mapmyindiaKey?: string; landmarksDefaultMigrated?: boolean };
    // migrate legacy "esri" or "mapmyindia" mapStyle values
    if (
      parsed.mapStyle === ("esri" as MapStyle) ||
      parsed.mapStyle === ("mapmyindia" as MapStyle)
    ) {
      parsed.mapStyle = "openfreemap";
    }
    // One-time migration so existing sessions also default to nearby places OFF
    if (!parsed.landmarksDefaultMigrated) {
      parsed.showLandmarks = false;
      parsed.landmarksDefaultMigrated = true;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, ...parsed }));
    }
    delete parsed.mapmyindiaKey;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...s, landmarksDefaultMigrated: true }));
  } catch {
    /* storage unavailable — keep in-memory only */
  }
}

interface SettingsContextValue {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  reset: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    saveSettings({ ...DEFAULT_SETTINGS });
    setSettings({ ...DEFAULT_SETTINGS });
  }, []);

  // apply accent preset to :root
  useEffect(() => {
    document.documentElement.setAttribute("data-accent", settings.accent);
  }, [settings.accent]);

  const value = useMemo(() => ({ settings, update, reset }), [settings, update, reset]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within <SettingsProvider>");
  return ctx;
}

/* ---------------- units ---------------- */

export const SPEED_UNIT_LABEL: Record<SpeedUnit, string> = {
  kmh: "km/h",
  mph: "mph",
  ms: "m/s",
};

export function speedValue(kmh: number, unit: SpeedUnit): number {
  switch (unit) {
    case "kmh": return kmh;
    case "mph": return kmh * 0.621371;
    case "ms": return kmh / 3.6;
  }
}

export function formatSpeed(kmh: number, unit: SpeedUnit): string {
  const v = speedValue(kmh, unit);
  return unit === "ms" ? v.toFixed(1) : String(Math.round(v));
}

export const DISTANCE_UNIT_LABEL: Record<DistanceUnit, string> = { km: "km", mi: "mi" };
const M_PER_MILE = 1609.344;

export function formatDistance(meters: number, unit: DistanceUnit): string {
  if (unit === "km") {
    return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
  }
  const miles = meters / M_PER_MILE;
  return miles >= 0.1 ? `${miles.toFixed(2)} mi` : `${Math.round(miles * 1760)} yd`;
}

export function distanceValue(meters: number, unit: DistanceUnit): string {
  return unit === "km" ? (meters / 1000).toFixed(3) : (meters / M_PER_MILE).toFixed(3);
}

export interface SpeedBucket {
  label: string;
  min: number;
  max: number; // Infinity for top bucket
  color: string;
}

export function speedBuckets(unit: SpeedUnit): SpeedBucket[] {
  if (unit === "mph") {
    return [
      { label: "0–12", min: 0, max: 12, color: "#38bdf8" },
      { label: "12–25", min: 12, max: 25, color: "#22d3ee" },
      { label: "25–37", min: 25, max: 37, color: "#34d399" },
      { label: "37–50", min: 37, max: 50, color: "#a3e635" },
      { label: "50–62", min: 50, max: 62, color: "#f5b44a" },
      { label: "62+", min: 62, max: Infinity, color: "#fb7185" },
    ];
  }
  if (unit === "ms") {
    return [
      { label: "0–5", min: 0, max: 5, color: "#38bdf8" },
      { label: "5–11", min: 5, max: 11, color: "#22d3ee" },
      { label: "11–16", min: 11, max: 16, color: "#34d399" },
      { label: "16–22", min: 16, max: 22, color: "#a3e635" },
      { label: "22–28", min: 22, max: 28, color: "#f5b44a" },
      { label: "28+", min: 28, max: Infinity, color: "#fb7185" },
    ];
  }
  return [
    { label: "0–20", min: 0, max: 20, color: "#38bdf8" },
    { label: "20–40", min: 20, max: 40, color: "#22d3ee" },
    { label: "40–60", min: 40, max: 60, color: "#34d399" },
    { label: "60–80", min: 60, max: 80, color: "#a3e635" },
    { label: "80–100", min: 80, max: 100, color: "#f5b44a" },
    { label: "100+", min: 100, max: Infinity, color: "#fb7185" },
  ];
}

/* ---------------- time ---------------- */

export interface TimeZoneOption {
  id: string;
  label: string;
}

export const TIMEZONES: TimeZoneOption[] = [
  { id: "UTC", label: "UTC — as recorded by dashcam GPS" },
  { id: "local", label: "Local device time" },
  { id: "Asia/Kolkata", label: "India (Asia/Kolkata, IST)" },
  { id: "Asia/Dubai", label: "Gulf (Asia/Dubai, GST)" },
  { id: "Asia/Karachi", label: "Pakistan (Asia/Karachi, PKT)" },
  { id: "Asia/Dhaka", label: "Bangladesh (Asia/Dhaka, BST)" },
  { id: "Asia/Singapore", label: "Singapore (Asia/Singapore, SGT)" },
  { id: "Asia/Bangkok", label: "Thailand/Vietnam (Asia/Bangkok, ICT)" },
  { id: "Asia/Jakarta", label: "Indonesia WIB (Asia/Jakarta, WIB)" },
  { id: "Asia/Manila", label: "Philippines (Asia/Manila, PHT)" },
  { id: "Asia/Shanghai", label: "China (Asia/Shanghai, CST)" },
  { id: "Asia/Tokyo", label: "Japan (Asia/Tokyo, JST)" },
  { id: "Asia/Seoul", label: "Korea (Asia/Seoul, KST)" },
  { id: "Asia/Hong_Kong", label: "Hong Kong (Asia/Hong_Kong, HKT)" },
  { id: "Europe/London", label: "London (Europe/London, GMT/BST)" },
  { id: "Europe/Dublin", label: "Dublin (Europe/Dublin, GMT/IST)" },
  { id: "Europe/Paris", label: "Paris/Berlin/Madrid (Europe/Paris, CET)" },
  { id: "Europe/Rome", label: "Rome (Europe/Rome, CET)" },
  { id: "Europe/Amsterdam", label: "Amsterdam (Europe/Amsterdam, CET)" },
  { id: "Europe/Athens", label: "Athens (Europe/Athens, EET)" },
  { id: "Europe/Moscow", label: "Moscow (Europe/Moscow, MSK)" },
  { id: "Africa/Cairo", label: "Cairo (Africa/Cairo, EET)" },
  { id: "Africa/Johannesburg", label: "Johannesburg (Africa/Johannesburg, SAST)" },
  { id: "Australia/Sydney", label: "Sydney (Australia/Sydney, AEDT)" },
  { id: "Australia/Perth", label: "Perth (Australia/Perth, AWST)" },
  { id: "Pacific/Auckland", label: "Auckland (Pacific/Auckland, NZDT)" },
  { id: "America/New_York", label: "New York (America/New_York, ET)" },
  { id: "America/Chicago", label: "Chicago (America/Chicago, CT)" },
  { id: "America/Denver", label: "Denver (America/Denver, MT)" },
  { id: "America/Los_Angeles", label: "Los Angeles (America/Los_Angeles, PT)" },
  { id: "America/Toronto", label: "Toronto (America/Toronto, ET)" },
  { id: "America/Mexico_City", label: "Mexico City (America/Mexico_City, CT)" },
  { id: "America/Sao_Paulo", label: "São Paulo (America/Sao_Paulo, BRT)" },
  { id: "America/Santiago", label: "Santiago (America/Santiago, CLT)" },
  { id: "America/Bogota", label: "Bogotá (America/Bogota, COT)" },
  { id: "America/Argentina/Buenos_Aires", label: "Buenos Aires (America/Argentina/Buenos_Aires, ART)" },
];

export interface TzParts {
  time: string; // HH:MM:SS (24h)
  date: string; // "24 Oct 2025"
  abbr: string; // e.g. "IST", "UTC"
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function tzParts(epochMs: number, tz: string): TzParts {
  try {
    const zone = tz === "local" ? undefined : tz;
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZoneName: "short",
    }).formatToParts(new Date(epochMs));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return {
      time: `${get("hour")}:${get("minute")}:${get("second")}`,
      date: `${get("day")} ${get("month")} ${get("year")}`,
      abbr: get("timeZoneName") || tz,
    };
  } catch {
    // invalid stored timezone — fall back to UTC
    const d = new Date(epochMs);
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
      date: `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
      abbr: "UTC",
    };
  }
}

/* ---------------- hemisphere ---------------- */

export function hemisphereSigns(h: Hemisphere): { lat: 1 | -1; lon: 1 | -1 } {
  switch (h) {
    case "NE": return { lat: 1, lon: 1 };
    case "NW": return { lat: 1, lon: -1 };
    case "SE": return { lat: -1, lon: 1 };
    case "SW": return { lat: -1, lon: -1 };
  }
}
