import { FolderOpen, FileVideo, Film, Satellite, ListVideo, Settings } from "lucide-react";
import brandIcon from "../assets/geoplayer-icon.png";

interface SidebarProps {
  playlist: string[];
  currentIndex: number;
  gpsInfo: { fixes: number; source: string } | null;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onSelect: (index: number) => void;
  onOpenSettings: () => void;
}

function fileBase(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name;
}

function parentDir(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  const dir = parts.join("\\");
  return dir.length > 44 ? "…" + dir.slice(-44) : dir;
}

function ext(path: string): string {
  const m = /\.([^.]+)$/.exec(path);
  return m ? m[1].toUpperCase() : "";
}

export default function Sidebar({ playlist, currentIndex, gpsInfo, onOpenFile, onOpenFolder, onSelect, onOpenSettings }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand__mark" aria-hidden="true">
          <img src={brandIcon} alt="" draggable={false} />
        </div>
        <div>
          <div className="brand__name">Geo<em>Player</em></div>
          <div className="brand__tag">Dashcam · GPS · Speed</div>
        </div>
      </div>

      <div className="open-actions">
        <button className="btn btn--primary" onClick={onOpenFile}>
          <FileVideo size={16} strokeWidth={2.2} /> Open dashcam video
        </button>
        <button className="btn" onClick={onOpenFolder} style={{ justifyContent: "center" }}>
          <FolderOpen size={15} strokeWidth={2.2} /> Open folder of clips
        </button>
        <button className="btn btn--ghost-sm" onClick={onOpenSettings} style={{ justifyContent: "center" }}>
          <Settings size={15} strokeWidth={2.1} /> Settings
        </button>
      </div>

      <div className="playlist" aria-label="Playlist">
        <div className="playlist__head">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><ListVideo size={12} /> Playlist</span>
          <span className="playlist__count">{playlist.length} files</span>
        </div>
        {playlist.length === 0 ? (
          <div className="empty-note" style={{ margin: "4px 2px" }}>
            <Film size={20} strokeWidth={1.7} />
            <span>No videos yet. Open a dashcam clip or a folder — GeoPlayer reads GPS, speed and time straight from the file.</span>
          </div>
        ) : (
          playlist.map((path, i) => {
            const active = i === currentIndex;
            const info = active && gpsInfo ? gpsInfo : null;
            return (
              <button key={`${path}-${i}`} className={`pl-item${active ? " pl-item--active" : ""}`} onClick={() => onSelect(i)} title={path}>
                <span className="pl-item__idx">{String(i + 1).padStart(2, "0")}</span>
                <span className="pl-item__body">
                  <span className="pl-item__name">{fileBase(path)}</span>
                  <span className="pl-item__meta">
                    {ext(path)}
                    {active && info && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className={info.fixes > 0 ? "pl-item__gps" : "pl-item__gps pl-item__gps--none"}></span>
                        {info.fixes > 0 ? `${info.fixes} GPS fixes` : "no GPS"}
                      </>
                    )}
                  </span>
                  <span className="pl-item__meta" style={{ color: "var(--text-faint)" }}>{parentDir(path)}</span>
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="sidebar__footer">
        <span><b>GeoPlayer</b> v0.1.0</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <Satellite size={11} />
          {gpsInfo ? gpsInfo.source : "Novatek · NMEA · ISO 6709"}
        </span>
      </div>
    </aside>
  );
}
