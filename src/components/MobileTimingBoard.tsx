"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Driver, SectorStatus } from "@/types/f1";
import { TEAM_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { Pin, Expand, Shrink } from "lucide-react";

interface Props {
  drivers: Driver[];
  sessionName?: string;
  qualifyingPart?: number;
  hoveredDriverNumber?: string | null;
  onDriverHover?: (n: string | null) => void;
  pinnedDriverNumber?: string | null;
  onDriverPin?: (n: string | null) => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
}

const SECTOR_COLORS: Record<SectorStatus, string> = {
  purple: "bg-[oklch(.541_.281_293.009)]",
  green:  "bg-[oklch(.696_.17_162.48)]",
  yellow: "bg-[oklch(.795_.184_86.047)]",
  blue:   "bg-[#2b7fff]",
  none:   "bg-zinc-700",
};

const SECTOR_TEXT: Record<SectorStatus, string> = {
  purple: "text-[oklch(.541_.281_293.009)]",
  green:  "text-[oklch(.696_.17_162.48)]",
  yellow: "text-white",
  blue:   "text-[#2b7fff]",
  none:   "text-zinc-400",
};

const TIRE_IMAGES: Record<string, string> = {
  soft:         "/images/tires/soft.svg",
  medium:       "/images/tires/medium.svg",
  hard:         "/images/tires/hard.svg",
  intermediate: "/images/tires/intermediate.svg",
  wet:          "/images/tires/wet.svg",
};

// One sector group: label + dots + time stacked
function SectorGroup({
  label,
  segments,
  time,
  status,
}: {
  label: string;
  segments: SectorStatus[];
  time?: string;
  status: SectorStatus;
}) {
  const labelClass = status !== "none" ? SECTOR_TEXT[status] : "text-zinc-600";
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className={cn("text-[8px] font-bold uppercase", labelClass)}>{label}</span>
      <div className="flex gap-[2px] flex-wrap">
        {segments.map((s, i) => (
          <div key={i} className={cn("w-[10px] h-[4px] rounded-[2px]", SECTOR_COLORS[s])} />
        ))}
      </div>
      <span className={cn("font-mono text-[11px] tabular-nums", SECTOR_TEXT[status])}>
        {time || "--.---"}
      </span>
    </div>
  );
}

function DriverRowMobile({
  driver,
  eliminationCutoff,
  isExpanded,
  isPinned,
  onToggle,
  onPin,
}: {
  driver: Driver;
  eliminationCutoff: number | null;
  isExpanded: boolean;
  isPinned: boolean;
  onToggle: () => void;
  onPin: () => void;
}) {
  const { t } = useLanguage();
  const teamColor = driver.teamColor || TEAM_COLORS[driver.team] || "#888";
  const eliminated = driver.knockedOut;
  const inElimZone = eliminationCutoff != null && !eliminated && driver.position >= eliminationCutoff;
  const tireKey = (driver.tire.compound || "medium").toLowerCase();
  const tireSrc = TIRE_IMAGES[tireKey] || TIRE_IMAGES.medium;

  const lastLapColor =
    driver.lastLapOverallFastest ? SECTOR_TEXT.purple
    : driver.lastLapPersonalBest ? SECTOR_TEXT.green
    : "text-zinc-400";

  const gapText = driver.position === 1 ? "–" : (driver.gap || driver.interval || "–");

  const s1c = driver.sector1SegmentCount || 6;
  const s2c = driver.sector2SegmentCount || 6;
  const allSegs = driver.miniSectors || [];
  const seg1 = allSegs.slice(0, s1c);
  const seg2 = allSegs.slice(s1c, s1c + s2c);
  const seg3 = allSegs.slice(s1c + s2c);
  const hasSegments = allSegs.length > 0;

  return (
    <div
      className={cn(
        "border-b border-zinc-800/60 last:border-0 transition-colors",
        inElimZone && "bg-red-950/20",
        eliminated && "opacity-40",
        isPinned && "border-l-2",
      )}
      style={isPinned ? { borderLeftColor: teamColor } : undefined}
    >
      {/* Collapsed row */}
      <button
        className="w-full flex items-center gap-0 px-2 py-1.5 text-left active:bg-zinc-800/30 transition-colors"
        onClick={onToggle}
      >
        {/* Position */}
        <span className="w-5 text-center text-xs font-bold text-zinc-400 tabular-nums flex-shrink-0">
          {driver.position}
        </span>

        {/* Driver badge */}
        <div className="w-14 flex-shrink-0 flex justify-center mx-1">
          <div
            className="px-1.5 py-0.5 rounded text-xs font-black text-white w-full text-center"
            style={{
              backgroundColor: eliminated ? "#3f3f46" : teamColor,
              fontFamily: "'Formula1 Display', sans-serif",
            }}
          >
            {driver.code}
          </div>
        </div>

        {/* Tire + age */}
        <div className="w-12 flex-shrink-0 flex items-center gap-1 mx-1">
          <img src={tireSrc} alt={tireKey} className="w-5 h-5 flex-shrink-0" />
          <span className="text-[11px] text-zinc-500 font-mono tabular-nums">{driver.tire.age}</span>
        </div>

        {/* Gap */}
        <span className="flex-1 text-xs text-zinc-300 font-mono tabular-nums text-right pr-2 truncate">
          {gapText}
        </span>

        {/* Last lap / PIT / OUT */}
        <span className={cn("w-[68px] flex-shrink-0 text-right text-xs font-mono tabular-nums", lastLapColor)}>
          {driver.inPit ? (
            <span className="text-[10px] font-bold text-cyan-400 border border-cyan-500 px-1 py-0.5 rounded">PIT</span>
          ) : driver.isPitOutLap ? (
            <span className="text-[10px] font-bold text-yellow-400 border border-yellow-400 px-1 py-0.5 rounded">OUT</span>
          ) : (
            driver.lastLap || "–:–-.–––"
          )}
        </span>

        {/* Chevron */}
        <span className={cn("text-zinc-600 text-[10px] flex-shrink-0 ml-1 transition-transform duration-200", isExpanded && "rotate-180")}>
          ▾
        </span>
      </button>

      {/* Expanded panel */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-2.5 pt-1.5 flex flex-col gap-2 bg-zinc-900/50 border-t border-zinc-800/60">
              {/* Sectors: dots + time stacked, side by side, separated by dividers */}
              <div className="flex items-start gap-2">
                {hasSegments ? (
                  <>
                    <SectorGroup label="S1" segments={seg1} time={driver.sector1} status={driver.sector1Status} />
                    <div className="w-px self-stretch bg-zinc-800 flex-shrink-0" />
                    <SectorGroup label="S2" segments={seg2} time={driver.sector2} status={driver.sector2Status} />
                    <div className="w-px self-stretch bg-zinc-800 flex-shrink-0" />
                    <SectorGroup label="S3" segments={seg3} time={driver.sector3} status={driver.sector3Status} />
                  </>
                ) : (
                  <>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[8px] text-zinc-600 uppercase">S1</span>
                      <span className={cn("font-mono text-[10px] tabular-nums", SECTOR_TEXT[driver.sector1Status])}>
                        {driver.sector1 || "--.---"}
                      </span>
                    </div>
                    <div className="w-px self-stretch bg-zinc-800 flex-shrink-0" />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[8px] text-zinc-600 uppercase">S2</span>
                      <span className={cn("font-mono text-[10px] tabular-nums", SECTOR_TEXT[driver.sector2Status])}>
                        {driver.sector2 || "--.---"}
                      </span>
                    </div>
                    <div className="w-px self-stretch bg-zinc-800 flex-shrink-0" />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[8px] text-zinc-600 uppercase">S3</span>
                      <span className={cn("font-mono text-[10px] tabular-nums", SECTOR_TEXT[driver.sector3Status])}>
                        {driver.sector3 || "--.---"}
                      </span>
                    </div>
                  </>
                )}

                {/* Right side: last lap + DRS + PIT count + pin */}
                <div className="ml-auto flex flex-col items-end gap-1">
                  <div className="flex items-center gap-2">
                    {driver.drsEnabled && (
                      <span className="text-[10px] font-bold text-green-400 border border-green-500 px-1 py-0.5 rounded">DRS</span>
                    )}
                    <div className="flex flex-col items-end">
                      <span className="text-[8px] text-zinc-600 uppercase">{t("driver.lastLap")}</span>
                      <span className={cn("font-mono text-xs tabular-nums", lastLapColor)}>
                        {driver.lastLap || "–:–-.–––"}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-zinc-600 font-mono">PIT×{driver.pitCount}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); onPin(); }}
                      className={cn(
                        "p-1 rounded transition-colors",
                        isPinned
                          ? "text-white"
                          : "text-zinc-600 hover:text-zinc-300"
                      )}
                      style={isPinned ? { color: teamColor } : undefined}
                      title={isPinned ? "Desvincular del mapa" : "Vincular al mapa"}
                    >
                      <Pin size={12} className={isPinned ? "fill-current" : ""} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function MobileTimingBoard({
  drivers,
  sessionName,
  qualifyingPart,
  pinnedDriverNumber,
  onDriverPin,
  expanded = false,
  onToggleExpand,
}: Props) {
  const { t } = useLanguage();
  const [expandedDriver, setExpandedDriver] = useState<string | null>(null);

  const eliminationCutoff = (() => {
    if (!qualifyingPart || qualifyingPart === 3) return null;
    const active = drivers.filter((d) => !d.knockedOut).length;
    // Q3 always has exactly 10 cars left (2026 grid). If the driver count is
    // already <=10 we're in Q3 regardless of qualifyingPart (which can go stale
    // when the SessionPart=3 update is missed), so there is never a red zone.
    if (active <= 10) return null;
    return active - 6 + 1;
  })();

  const toggleExpand = (num: string) => {
    setExpandedDriver((prev) => (prev === num ? null : num));
  };

  const togglePin = (num: string) => {
    onDriverPin?.(pinnedDriverNumber === num ? null : num);
  };

  // Pinned driver floats to top
  const sortedDrivers = pinnedDriverNumber
    ? [
        ...drivers.filter((d) => d.driverNumber === pinnedDriverNumber),
        ...drivers.filter((d) => d.driverNumber !== pinnedDriverNumber),
      ]
    : drivers;

  return (
    <div className="h-full flex flex-col bg-zinc-900/30 border border-zinc-800 rounded-lg overflow-hidden">
      {/* Session label + expand toggle */}
      <div className="flex items-center px-2 py-1 border-b border-zinc-800 bg-zinc-950/80 shrink-0 gap-2">
        <span
          className="text-[10px] tracking-widest uppercase text-zinc-500 flex-1"
          style={{ fontFamily: "'Formula1 Display', sans-serif" }}
        >
          {sessionName || t("session.noActive")}
          {qualifyingPart ? ` · Q${qualifyingPart}` : ""}
        </span>
        {onToggleExpand && (
          <button
            onClick={onToggleExpand}
            className="text-zinc-600 hover:text-zinc-300 transition-colors p-0.5"
            title={expanded ? "Vista dividida" : "Tabla a pantalla completa"}
          >
            {expanded ? <Shrink size={13} /> : <Expand size={13} />}
          </button>
        )}
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-0 px-2 py-1 border-b border-zinc-800/80 bg-zinc-950/60 shrink-0">
        <span className="w-5 flex-shrink-0 text-center text-[10px] tracking-widest text-zinc-600 uppercase">#</span>
        <span className="w-14 flex-shrink-0 text-center text-[10px] tracking-widest text-zinc-600 uppercase mx-1">
          {t("timing.driver") || "PILOTO"}
        </span>
        <span className="w-12 flex-shrink-0 text-center text-[10px] tracking-widest text-zinc-600 uppercase mx-1">
          {t("timing.tire") || "NEU"}
        </span>
        <span className="flex-1 text-right pr-2 text-[10px] tracking-widest text-zinc-600 uppercase">GAP</span>
        <span className="w-[68px] flex-shrink-0 text-right text-[10px] tracking-widest text-zinc-600 uppercase">
          {t("timing.lastLap") || "ÚLT. VTA"}
        </span>
        <span className="w-4 flex-shrink-0" />
      </div>

      {/* Driver list */}
      <div className="flex-1 overflow-y-auto">
        {sortedDrivers.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600 text-xs">
            {t("timing.waitingData")}
          </div>
        ) : (
          sortedDrivers.map((d) => (
            <DriverRowMobile
              key={d.driverNumber}
              driver={d}
              eliminationCutoff={eliminationCutoff}
              isExpanded={expandedDriver === d.driverNumber}
              isPinned={pinnedDriverNumber === d.driverNumber}
              onToggle={() => toggleExpand(d.driverNumber)}
              onPin={() => togglePin(d.driverNumber)}
            />
          ))
        )}
      </div>
    </div>
  );
}
