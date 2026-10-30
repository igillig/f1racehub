"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Driver, SectorStatus } from "@/types/f1";
import { TEAM_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useGapPrimary, type GapPrimary } from "@/hooks/useGapPrimary";
import { Pin, Expand, Shrink, ArrowUpDown } from "lucide-react";

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

/** Session label row plus the column header row, both sticky at the card top. */
const HEADER_BLOCK_H = 52;

/**
 * Best-lap column. Hidden under 390px, where the gap column needs every pixel
 * it can get — those phones read the best lap in the expanded panel instead.
 */
const BEST_LAP_COL = "hidden min-[390px]:block w-[56px] flex-shrink-0 text-right pr-1.5";

/** "1:23.456" → ms. Infinity when the driver has no time yet. */
function lapTimeToMs(lapTime?: string): number {
  if (!lapTime || lapTime === "---") return Infinity;
  const parts = lapTime.split(/[:.]/).map(Number);
  if (parts.some(Number.isNaN)) return Infinity;
  if (parts.length === 3) return parts[0] * 60000 + parts[1] * 1000 + parts[2];
  if (parts.length === 2) return parts[0] * 1000 + parts[1];
  return Infinity;
}

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
  hasFastestLap,
  gapPrimary,
  docked = false,
  onToggle,
  onPin,
}: {
  driver: Driver;
  eliminationCutoff: number | null;
  isExpanded: boolean;
  isPinned: boolean;
  /** True when this driver holds the session's fastest lap. */
  hasFastestLap: boolean;
  gapPrimary: GapPrimary;
  /** True for the copy docked to an edge, so it does not claim to be the row. */
  docked?: boolean;
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

  const bestLapColor = hasFastestLap ? SECTOR_TEXT.purple : "text-zinc-500";

  // Interval = gap to the car ahead, gap = gap to P1. Same as desktop.
  const gapText =
    gapPrimary === "interval"
      ? driver.interval || "–"
      : driver.position === 1
        ? "–"
        : driver.gap || "–";
  const inPit = driver.inPit;
  const pitOut = !inPit && driver.isPitOutLap;

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
      data-pinned-row={isPinned && !docked ? "true" : undefined}
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
        <div className="w-12 flex-shrink-0 flex justify-center mx-1">
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
        <div className="w-11 flex-shrink-0 flex items-center gap-1 mx-1">
          <img src={tireSrc} alt={tireKey} className="w-5 h-5 flex-shrink-0" />
          <span className="text-[11px] text-zinc-500 font-mono tabular-nums">{driver.tire.age}</span>
        </div>

        {/* Pit status */}
        <span className="w-8 flex-shrink-0 flex justify-center">
          <span
            className={cn(
              "text-[9px] font-bold leading-none px-1 py-0.5 rounded border",
              inPit
                ? "text-cyan-400 border-cyan-500"
                : pitOut
                  ? "text-yellow-400 border-yellow-400"
                  : "text-zinc-800 border-zinc-800",
            )}
            title={inPit ? t("driver.inPit") : pitOut ? t("driver.pitOut") : undefined}
          >
            {pitOut ? "OUT" : "PIT"}
          </span>
        </span>

        {/* Gap */}
        <span className="flex-1 text-xs text-zinc-300 font-mono tabular-nums text-right pr-2 truncate">
          {gapText}
        </span>

        {/* Best lap */}
        <span className={cn(BEST_LAP_COL, "text-[10px] font-mono tabular-nums", bestLapColor)}>
          {driver.bestLap || "–:–-.–––"}
        </span>

        {/* Last lap */}
        <span className={cn("w-[64px] flex-shrink-0 text-right text-xs font-mono tabular-nums", lastLapColor)}>
          {driver.lastLap || "–:–-.–––"}
        </span>

        {/* Chevron */}
        <span className={cn("w-4 flex-shrink-0 text-center text-zinc-600 text-[10px] transition-transform duration-200", isExpanded && "rotate-180")}>
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

                {/* Right side: last lap + PIT count + pin */}
                <div className="ml-auto flex flex-col items-end gap-1">
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col items-end min-[390px]:hidden">
                      <span className="text-[8px] text-zinc-600 uppercase">{t("timing.bestLap")}</span>
                      <span className={cn("font-mono text-xs tabular-nums", bestLapColor)}>
                        {driver.bestLap || "–:–-.–––"}
                      </span>
                    </div>
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
  const { gapPrimary, toggle: toggleGapPrimary } = useGapPrimary(sessionName);
  const [expandedDriver, setExpandedDriver] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pinnedPos, setPinnedPos] = useState<"visible" | "above" | "below">("visible");
  const [cardBounds, setCardBounds] = useState<{
    top: number;
    bottom: number;
    left: number;
    width: number;
  } | null>(null);

  const eliminationCutoff = (() => {
    if (!qualifyingPart || qualifyingPart === 3) return null;
    const active = drivers.filter((d) => !d.knockedOut).length;
    // Q3 always has exactly 10 cars left (2026 grid). If the driver count is
    // already <=10 we're in Q3 regardless of qualifyingPart (which can go stale
    // when the SessionPart=3 update is missed), so there is never a red zone.
    if (active <= 10) return null;
    return active - 6 + 1;
  })();

  // Purple on whoever holds the session's fastest lap, as on the broadcast.
  const fastestLapMs = drivers.reduce(
    (best, d) => Math.min(best, lapTimeToMs(d.bestLap)),
    Infinity,
  );
  const hasFastestLap = (d: Driver) =>
    fastestLapMs !== Infinity && lapTimeToMs(d.bestLap) === fastestLapMs;

  const toggleExpand = (num: string) => {
    setExpandedDriver((prev) => (prev === num ? null : num));
  };

  const togglePin = (num: string) => {
    onDriverPin?.(pinnedDriverNumber === num ? null : num);
  };

  // The pinned driver keeps its real position; a copy docks to whichever edge
  // it went out of view past, as on desktop. Reordering it to the top made a
  // pinned P20 show up above the leader.
  const sortedDrivers = drivers;

  const pinnedDriver = pinnedDriverNumber
    ? drivers.find((d) => d.driverNumber === pinnedDriverNumber)
    : undefined;

  useEffect(() => {
    if (!pinnedDriverNumber) {
      setPinnedPos("visible");
      return;
    }

    let frame: number | null = null;

    const update = () => {
      const card = cardRef.current;
      if (!card) return;
      const r = card.getBoundingClientRect();
      setCardBounds({ top: r.top, bottom: r.bottom, left: r.left, width: r.width });

      const row = card.querySelector<HTMLElement>('[data-pinned-row="true"]');
      if (!row) return;
      const rect = row.getBoundingClientRect();
      // Clamped to the viewport: expanded, the card is taller than the screen.
      const top = Math.max(r.top + HEADER_BLOCK_H, 0);
      const bottom = Math.min(r.bottom, window.innerHeight);
      if (rect.bottom < top) setPinnedPos("above");
      else if (rect.top > bottom) setPinnedPos("below");
      else setPinnedPos("visible");
    };

    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        update();
      });
    };

    // Capture: scroll does not bubble, and the scroller is the list when
    // collapsed and the page column when expanded.
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule, { passive: true });
    const observer = cardRef.current ? new ResizeObserver(schedule) : null;
    if (cardRef.current && observer) observer.observe(cardRef.current);
    update();

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [pinnedDriverNumber, expanded]);

  const dockedStyle = (): CSSProperties | null => {
    if (pinnedPos === "visible" || !pinnedDriver || !cardBounds) return null;
    const base: CSSProperties = {
      position: "fixed",
      left: cardBounds.left,
      width: cardBounds.width,
      zIndex: 30,
    };
    if (pinnedPos === "above") {
      return { ...base, top: Math.max(0, cardBounds.top + HEADER_BLOCK_H) };
    }
    return {
      ...base,
      bottom: Math.max(0, window.innerHeight - Math.min(cardBounds.bottom, window.innerHeight)),
    };
  };

  return (
    <div
      ref={cardRef}
      className={`${
        expanded ? "h-auto" : "h-full"
      } flex flex-col bg-zinc-900/30 border border-zinc-800 rounded-lg overflow-hidden`}
    >
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
        <span className="w-12 flex-shrink-0 text-center text-[10px] tracking-widest text-zinc-600 uppercase mx-1">
          {t("timing.driver") || "PILOTO"}
        </span>
        <span className="w-11 flex-shrink-0 text-center text-[10px] tracking-widest text-zinc-600 uppercase mx-1 truncate">
          {t("timing.tireShort")}
        </span>
        <span className="w-8 flex-shrink-0 text-center text-[10px] tracking-widest text-zinc-600 uppercase">
          {t("timing.pit")}
        </span>
        <button
          type="button"
          onClick={toggleGapPrimary}
          title={t(
            gapPrimary === "gap"
              ? "timing.gapToggleTooltip"
              : "timing.intervalToggleTooltip",
          )}
          className="flex-1 min-w-0 flex items-center justify-end gap-1 pr-2 text-[10px] tracking-widest text-zinc-600 uppercase active:text-zinc-300 transition-colors"
        >
          <span className="truncate">
            {t(gapPrimary === "gap" ? "timing.gapShort" : "timing.intervalShort")}
          </span>
          <ArrowUpDown size={8} className="opacity-60 shrink-0" />
        </button>
        <span className={cn(BEST_LAP_COL, "text-[10px] tracking-widest text-zinc-600 uppercase whitespace-nowrap overflow-hidden")}>
          {t("timing.bestLap")}
        </span>
        <span className="w-[64px] flex-shrink-0 text-right text-[10px] tracking-widest text-zinc-600 uppercase whitespace-nowrap overflow-hidden">
          {t("timing.lastLapShort")}
        </span>
        <span className="w-4 flex-shrink-0" />
      </div>

      {/* Driver list */}
      <div className={expanded ? "" : "flex-1 overflow-y-auto"}>
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
              hasFastestLap={hasFastestLap(d)}
              gapPrimary={gapPrimary}
              onToggle={() => toggleExpand(d.driverNumber)}
              onPin={() => togglePin(d.driverNumber)}
            />
          ))
        )}
      </div>

      {/* The pinned row, docked to whichever edge it went out of view past.
          Fixed to the viewport and matched to the card's width, so it lands on
          the visible edge whether the list or the page column is scrolling. */}
      {pinnedDriver && dockedStyle() && (
        <div
          style={dockedStyle() as CSSProperties}
          className="bg-zinc-900 border-y border-zinc-700 shadow-lg shadow-black/50"
        >
          <DriverRowMobile
            driver={pinnedDriver}
            eliminationCutoff={eliminationCutoff}
            isExpanded={false}
            isPinned
            hasFastestLap={hasFastestLap(pinnedDriver)}
            gapPrimary={gapPrimary}
            docked
            onToggle={() => {
              const row = cardRef.current?.querySelector<HTMLElement>(
                '[data-pinned-row="true"]',
              );
              row?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            onPin={() => togglePin(pinnedDriver.driverNumber)}
          />
        </div>
      )}
    </div>
  );
}
