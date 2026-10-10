"use client";

import { Driver, SectorStatus } from "@/types/f1";
import { TEAM_COLORS, TIRE_COMPOUNDS, TEAM_LOGOS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { Pin } from "lucide-react";
import {
  DENSITY,
  gridColumns,
  maxBarWidth,
  type Density,
} from "@/lib/timingDensity";

interface DriverRowProps {
  driver: Driver;
  qualifyingPart?: number;
  eliminationCutoff?: number | null;
  isHovered?: boolean;
  onHover?: (driverNumber: string | null) => void;
  isPinned?: boolean;
  onPin?: (driverNumber: string | null) => void;
  gapPrimary?: "gap" | "interval";
  /** How much the table has given up to the map. See @/lib/timingDensity. */
  density?: Density;
}

// Empty time format placeholder
const EMPTY_TIME = "--:--.---";
const EMPTY_SECTOR = "--.---";

// Mini sector bars - full width with better spacing and rounded corners
function MiniSectors({
  sectors,
  count = 6,
  bar,
  maxBar,
  t,
}: {
  sectors?: SectorStatus[];
  count?: number;
  bar: number;
  maxBar: number;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  // Use actual sectors length if available, otherwise use count
  const actualCount = sectors?.length || count;
  const items = sectors || Array(actualCount).fill("none");

  const getTooltip = (status: SectorStatus) => {
    if (status === "purple") return t("driver.miniSectorRecord");
    if (status === "green") return t("driver.miniSectorBest");
    if (status === "yellow") return t("driver.miniSectorSlower");
    if (status === "blue") return t("driver.miniSectorPit");
    return t("driver.miniSectorNoData");
  };

  return (
    <div className="flex gap-1 w-full justify-center">
      {items.map((status, i) => (
        <div
          key={i}
          // Grows into the surplus when the table is wider than this density
          // level needs, instead of leaving the column half empty.
          style={{ flex: `1 1 ${bar}px`, minWidth: bar, maxWidth: maxBar }}
          className={cn(
            "h-[5px] rounded-[2px] cursor-default",
            status === "purple" && "bg-[oklch(.541_.281_293.009)]",
            status === "green" && "bg-[oklch(.696_.17_162.48)]",
            status === "yellow" && "bg-[oklch(.795_.184_86.047)]",
            status === "blue" && "bg-[#2b7fff]",
            status === "none" && "bg-zinc-700",
          )}
          title={getTooltip(status)}
        />
      ))}
    </div>
  );
}

// Tire compound icon using SVG images
function TireCompound({
  compound,
  laps,
  pitCount,
  t,
}: {
  compound: string;
  laps: number;
  pitCount: number;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const getCompoundName = (comp: string): string => {
    const key = comp?.toUpperCase();
    if (key === "SOFT") return t("driver.soft");
    if (key === "MEDIUM") return t("driver.medium");
    if (key === "HARD") return t("driver.hard");
    if (key === "INTERMEDIATE") return t("driver.intermediate");
    if (key === "WET") return t("driver.wet");
    return comp;
  };

  const compoundKey = compound?.toLowerCase() || "medium";
  const compoundName = getCompoundName(compound);

  // Map compound to image file
  const imageMap: Record<string, string> = {
    soft: "/images/tires/soft.svg",
    medium: "/images/tires/medium.svg",
    hard: "/images/tires/hard.svg",
    intermediate: "/images/tires/intermediate.svg",
    wet: "/images/tires/wet.svg",
  };

  const imageSrc = imageMap[compoundKey] || imageMap.medium;

  return (
    <div
      className="flex items-center gap-1.5"
      title={`${compoundName} - ${t("driver.lapsOld", { laps })}`}
    >
      <img src={imageSrc} alt={compoundName} className="w-[28px] h-[28px]" />
      <div className="flex flex-col leading-none">
        <span className="text-base text-zinc-300 tabular-nums font-bold font-mono">
          L {laps}
        </span>
        <span className="text-sm text-zinc-500 tabular-nums font-mono">
          PIT {pitCount}
        </span>
      </div>
    </div>
  );
}

// PIT indicator - shows cyan PIT when in pit, yellow OUT on pit-out lap, dim otherwise
function PitIndicator({
  inPit,
  isPitOutLap,
  t,
}: {
  inPit?: boolean;
  isPitOutLap?: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const isOut = !inPit && isPitOutLap;
  return (
    <div
      className={cn(
        "text-base inline-flex h-9 w-full items-center justify-center rounded-md font-mono font-black",
        inPit
          ? "border-[3px] border-cyan-500 text-cyan-500"
          : isOut
            ? "border-[3px] border-yellow-400 text-yellow-400"
            : "border-2 border-zinc-800 text-zinc-800",
      )}
      title={inPit ? t("driver.inPit") : isOut ? t("driver.pitOut") : undefined}
    >
      {isOut ? "OUT" : "PIT"}
    </div>
  );
}

// Sector cell with mini sectors on top, times below side by side
function SectorCell({
  miniSectors,
  time,
  bestTime,
  status,
  isBestOverall,
  isActive,
  bar,
  maxBar,
  t,
}: {
  miniSectors?: SectorStatus[];
  time?: string;
  bestTime?: string;
  status: SectorStatus;
  bar: number;
  maxBar: number;
  isBestOverall?: boolean;
  isActive?: boolean; // true if this sector is current or just completed
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const getTooltip = (s: SectorStatus) => {
    if (s === "purple") return t("driver.sectorBest");
    if (s === "green") return t("driver.sectorPersonalBest");
    if (s === "yellow") return t("driver.sectorSlower");
    return t("driver.sectorCurrent");
  };

  // Use dynamic count based on actual sectors
  const sectorCount = miniSectors?.length || 6;

  // Determine time color based on status and whether sector has time
  const getTimeColor = () => {
    // If sector has a recorded time, color based on status
    if (time) {
      if (status === "purple") return "text-[oklch(.541_.281_293.009)]"; // Purple for overall best
      if (status === "green") return "text-[oklch(.696_.17_162.48)]"; // Green for personal best
      return "text-white"; // Yellow/normal = white (it's a recorded time this lap)
    }
    // No time recorded yet
    if (isActive) return "text-white"; // Currently in this sector
    return "text-zinc-400"; // Past sector without time (shouldn't happen often)
  };

  return (
    <div className="flex flex-col gap-1.5">
      <MiniSectors
        sectors={miniSectors}
        count={sectorCount}
        bar={bar}
        maxBar={maxBar}
        t={t}
      />
      <div className="flex items-center justify-center gap-2">
        <span
          className={cn(
            "text-base font-f1 font-medium leading-none tracking-tight",
            getTimeColor(),
          )}
          title={getTooltip(status)}
        >
          {time || EMPTY_SECTOR}
        </span>
        <span
          className={cn(
            "text-xs font-f1 leading-none tracking-tight",
            isBestOverall
              ? "text-[oklch(.541_.281_293.009)] font-medium"
              : "text-zinc-500",
          )}
          title={t("driver.bestSectorTime")}
        >
          {bestTime || EMPTY_SECTOR}
        </span>
      </div>
    </div>
  );
}

export default function DriverRow({
  driver,
  qualifyingPart,
  eliminationCutoff,
  isHovered,
  onHover,
  isPinned,
  onPin,
  gapPrimary = "gap",
  density = 0,
}: DriverRowProps) {
  const { t } = useLanguage();

  const level = DENSITY[density];
  // The driver column is the second thing to give: the position number and the
  // code badge both tighten rather than either one disappearing.
  const compact = level.driver < DENSITY[0].driver;

  // Use teamColor from API first, then fallback to hardcoded TEAM_COLORS
  const teamColor = driver.teamColor || TEAM_COLORS[driver.team] || "#888";

  // eliminationCutoff is computed in TimingBoard from actual active driver count
  // so it's always correct regardless of grid size or session type.
  const inEliminationZone =
    eliminationCutoff != null && driver.position >= eliminationCutoff;
  // Use knockedOut from API - it's set when driver is eliminated from qualifying
  const eliminated = driver.knockedOut;

  // Calculate total segments and proportional widths for sectors
  const s1Count = driver.sector1SegmentCount || 6;
  const s2Count = driver.sector2SegmentCount || 6;
  const s3Count = driver.sector3SegmentCount || 6;
  const totalSegments = s1Count + s2Count + s3Count;

  // Determine which sector the driver is currently in based on minisectors
  // A sector is "active" if it has segments with status != "none" or has a recorded time
  const getCurrentSector = (): number => {
    if (!driver.miniSectors || driver.miniSectors.length === 0) return 1;

    // Check S3 segments (after s1Count + s2Count)
    const s3Start = s1Count + s2Count;
    const s3Segments = driver.miniSectors.slice(s3Start);
    const hasS3Activity = s3Segments.some((s) => s !== "none");
    if (hasS3Activity) return 3;

    // Check S2 segments
    const s2Segments = driver.miniSectors.slice(s1Count, s1Count + s2Count);
    const hasS2Activity = s2Segments.some((s) => s !== "none");
    if (hasS2Activity) return 2;

    // Default to S1
    return 1;
  };

  const currentSector = getCurrentSector();

  // A sector is active if:
  // - It's the current sector OR
  // - It's the sector just before the current one (just completed)
  const isSectorActive = (sectorNum: number): boolean => {
    // If sector has a time, it was just completed - show as active
    if (sectorNum === 1 && driver.sector1) return true;
    if (sectorNum === 2 && driver.sector2) return true;
    if (sectorNum === 3 && driver.sector3) return true;

    // If it's the current sector being driven
    return sectorNum === currentSector;
  };

  return (
    <div
      onMouseEnter={() => onHover?.(driver.driverNumber)}
      onMouseLeave={() => onHover?.(null)}
      data-pinned-row={isPinned ? "true" : undefined}
      className={cn(
        "grid gap-3 px-3 py-1 items-center cursor-default",
        "border-b border-border/50 transition-colors",
        isHovered || isPinned ? "bg-muted/50" : "hover:bg-muted/30",
        driver.retired && "opacity-40 bg-zinc-900/50",
        eliminated && "opacity-40 bg-zinc-900/50",
        !eliminated && inEliminationZone && "bg-red-950/60",
      )}
      style={{
        gridTemplateColumns: gridColumns(density, {
          s1: s1Count,
          s2: s2Count,
          s3: s3Count,
        }),
        borderLeft: isPinned
          ? `3px solid ${teamColor}`
          : !eliminated && inEliminationZone
            ? "3px solid rgb(239 68 68)"
            : "3px solid transparent",
      }}
    >
      {/* Position + Driver Tag — click to pin/unpin, overlay on hover */}
      <div
        className="relative flex items-center h-[38px] px-1 rounded-md overflow-hidden cursor-pointer"
        style={{ backgroundColor: teamColor }}
        title={isPinned ? "Click to unpin" : driver.name}
        onClick={(e) => {
          e.stopPropagation();
          onPin?.(isPinned ? null : driver.driverNumber);
        }}
      >
        <span
          className={cn(
            "font-black font-mono tabular-nums leading-none text-center text-white",
            compact ? "text-lg mr-1 w-7" : "text-xl mr-2 w-9",
          )}
        >
          {driver.retired ? "RET" : driver.position}
        </span>
        <div
          className={cn(
            "flex items-center justify-center h-[30px] rounded-sm font-black font-mono my-[4px]",
            compact ? "px-1 text-base" : "px-2 text-lg",
          )}
          style={{ backgroundColor: "white", color: teamColor }}
        >
          {driver.code}
        </div>
        {/* Pin overlay — shown on row hover or when pinned */}
        <div
          className={cn(
            "absolute inset-0 flex items-center justify-center rounded-md transition-opacity duration-150",
            "bg-black/50",
            isHovered || isPinned
              ? "opacity-100"
              : "opacity-0 pointer-events-none",
          )}
        >
          <Pin
            size={22}
            className={cn("text-white drop-shadow", isPinned && "fill-current")}
          />
        </div>
      </div>

      {/* Team Logo - HIDDEN FOR NOW
      <div className="flex items-center justify-center">
        {TEAM_LOGOS[driver.team] && (
          <img
            src={TEAM_LOGOS[driver.team]}
            alt={driver.team}
            className="h-7 w-7 object-contain"
            title={driver.team}
          />
        )}
      </div>
      */}

      {/* PIT indicator — the first column dropped when the table runs out of
          room. The pit count stays visible in the tire cell until that goes. */}
      {level.pit && (
        <PitIndicator
          inPit={driver.inPit}
          isPitOutLap={driver.isPitOutLap}
          t={t}
        />
      )}

      {/* Tire with L and PIT */}
      {level.tire && (
        <TireCompound
          compound={driver.tire.compound}
          laps={driver.tire.age}
          pitCount={driver.pitCount}
          t={t}
        />
      )}

      {/* Gap */}
      {driver.retired ? <div /> : (
        <div className="text-right leading-none">
          <div
            className="text-lg text-foreground font-f1 font-medium leading-none tracking-tight"
            title={t(
              gapPrimary === "gap"
                ? "driver.gapToLeader"
                : "driver.intervalToAhead",
            )}
          >
            {gapPrimary === "gap"
              ? driver.position === 1
                ? "—"
                : driver.gap || "—"
              : driver.interval || "—"}
          </div>
          <div
            className="text-xs text-zinc-500 font-f1 mt-0.5 tracking-tight"
            title={t(
              gapPrimary === "gap"
                ? "driver.intervalToAhead"
                : "driver.gapToLeader",
            )}
          >
            {gapPrimary === "gap"
              ? driver.interval || ""
              : driver.position === 1
                ? "—"
                : driver.gap || ""}
          </div>
        </div>
      )}

      {/* Last Lap + Best */}
      <div className="text-right leading-none">
        <div
          className={cn(
            "text-lg font-f1 font-medium leading-none tracking-tight",
            driver.lastLapOverallFastest
              ? "text-f1-purple"
              : driver.lastLapPersonalBest
                ? "text-[oklch(.696_.17_162.48)]"
                : "text-foreground",
          )}
          title={
            driver.lastLapOverallFastest
              ? t("driver.sessionFastest")
              : driver.lastLapPersonalBest
                ? t("driver.lastLapBest")
                : t("driver.bestLap")
          }
        >
          {driver.lastLap || EMPTY_TIME}
        </div>
        <div
          className="text-xs text-zinc-500 font-f1 mt-0.5 tracking-tight"
          title={t("driver.bestLapTime")}
        >
          {driver.bestLap || EMPTY_TIME}
        </div>
      </div>

      {/* S1 */}
      <SectorCell
        miniSectors={driver.miniSectors?.slice(
          0,
          driver.sector1SegmentCount || 6,
        )}
        time={driver.sector1}
        bestTime={driver.bestSector1}
        status={driver.sector1Status}
        isBestOverall={driver.hasSector1Record}
        isActive={isSectorActive(1)}
        bar={level.bar}
        maxBar={maxBarWidth(density)}
        t={t}
      />

      {/* S2 */}
      <SectorCell
        miniSectors={driver.miniSectors?.slice(
          driver.sector1SegmentCount || 6,
          (driver.sector1SegmentCount || 6) + (driver.sector2SegmentCount || 6),
        )}
        time={driver.sector2}
        bestTime={driver.bestSector2}
        status={driver.sector2Status}
        isBestOverall={driver.hasSector2Record}
        isActive={isSectorActive(2)}
        bar={level.bar}
        maxBar={maxBarWidth(density)}
        t={t}
      />

      {/* S3 */}
      <SectorCell
        miniSectors={driver.miniSectors?.slice(
          (driver.sector1SegmentCount || 6) + (driver.sector2SegmentCount || 6),
        )}
        time={driver.sector3}
        bestTime={driver.bestSector3}
        status={driver.sector3Status}
        isBestOverall={driver.hasSector3Record}
        isActive={isSectorActive(3)}
        bar={level.bar}
        maxBar={maxBarWidth(density)}
        t={t}
      />
    </div>
  );
}
