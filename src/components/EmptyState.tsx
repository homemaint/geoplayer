import { FileVideo, FolderOpen, Satellite, MapPinned, Gauge, Clock3 } from "lucide-react";
import brandIcon from "../assets/geoplayer-icon.png";

interface EmptyStateProps {
  onOpenFile: () => void;
  onOpenFolder: () => void;
}

export default function EmptyState({ onOpenFile, onOpenFolder }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty__glow" />
      <div className="empty__mark" aria-hidden="true">
        <img src={brandIcon} alt="" draggable={false} />
      </div>
      <h1 className="empty__title">Geo<em>Player</em></h1>
      <p className="empty__sub">
        Relive every drive with its telemetry baked in — GPS route on a dark map,
        live speed, compass heading, g-forces and harsh-event detection — straight
        from your dashcam file.
      </p>
      <div className="empty__actions">
        <button className="btn btn--primary" onClick={onOpenFile}>
          <FileVideo size={18} strokeWidth={2.2} /> Open dashcam video
        </button>
        <button className="btn" onClick={onOpenFolder}>
          <FolderOpen size={18} strokeWidth={2.2} /> Open folder
        </button>
      </div>
      <div className="empty__hint">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <Satellite size={12} /> Novatek · NMEA · ISO 6709 <span style={{ opacity: 0.4 }}>·</span>
          <MapPinned size={12} /> Live route replay <span style={{ opacity: 0.4 }}>·</span>
          <Gauge size={12} /> Speed &amp; g-forces <span style={{ opacity: 0.4 }}>·</span>
          <Clock3 size={12} /> GPS-synced clock
        </span>
      </div>
    </div>
  );
}
