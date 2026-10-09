"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Trophy, ChevronUp, ChevronDown } from "lucide-react";
import LanguageToggle from "@/components/LanguageToggle";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  ChampionshipSnapshot,
  DriverStanding,
  TeamStanding,
} from "@/lib/championship";
import { DRIVER_NATIONALITY, TEAM_LOGOS_2026 } from "@/lib/constants";

const f1Font = { fontFamily: "'Formula1 Display', sans-serif" } as const;
const f1Wide = { fontFamily: "'Formula1 Display Wide', sans-serif" } as const;

type View = "drivers" | "teams";

interface Props {
  /** Standings resolved on the server; null when they couldn't be loaded. */
  data: ChampionshipSnapshot | null;
}

function hex(c: string) {
  return c.startsWith("#") ? c : `#${c}`;
}

/** Position change vs the start of the latest meeting. */
function Delta({ start, current }: { start: number; current: number }) {
  const diff = start - current; // positive → gained places
  if (diff === 0) {
    return (
      <span className="text-[10px] text-zinc-600 tabular-nums leading-none">
        —
      </span>
    );
  }
  const up = diff > 0;
  return (
    <span
      className={`flex items-center gap-0.5 text-[10px] tabular-nums leading-none font-semibold ${
        up ? "text-emerald-400" : "text-red-400"
      }`}
    >
      {up ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
      {Math.abs(diff)}
    </span>
  );
}

/** Points bar filled in the team colour, scaled to the leader. */
function PointsBar({
  points,
  max,
  colour,
  delay,
}: {
  points: number;
  max: number;
  colour: string;
  delay: number;
}) {
  const pct = max > 0 ? (points / max) * 100 : 0;
  return (
    <div className="h-1 w-full rounded-full bg-white/5 overflow-hidden">
      <motion.div
        className="h-full rounded-full"
        style={{ background: hex(colour) }}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ delay, duration: 0.7, ease: "easeOut" }}
      />
    </div>
  );
}

function Avatar({ driver }: { driver: DriverStanding }) {
  const [failed, setFailed] = useState(false);
  const ring = hex(driver.teamColour);
  return (
    <div
      className="relative h-11 w-11 sm:h-12 sm:w-12 shrink-0 rounded-full overflow-hidden bg-zinc-800 flex items-center justify-center"
      style={{ boxShadow: `0 0 0 2px ${ring}` }}
    >
      {driver.headshotUrl && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={driver.headshotUrl}
          alt={driver.fullName}
          className="h-full w-full object-cover object-top"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="text-xs font-bold text-zinc-300"
          style={f1Font}
        >
          {driver.acronym}
        </span>
      )}
    </div>
  );
}

function TeamLogo({ teamName, colour }: { teamName: string; colour: string }) {
  const [failed, setFailed] = useState(false);
  const logo = TEAM_LOGOS_2026[teamName];
  const c = hex(colour);

  if (logo && !failed) {
    return (
      <div
        className="flex h-9 w-9 flex-none items-center justify-center rounded-md bg-white/[0.06] p-1"
        style={{ boxShadow: `inset 0 0 0 1px ${c}55` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logo}
          alt={teamName}
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      </div>
    );
  }

  // Fallback: solid colour chip (teams without a logo asset).
  return (
    <span
      className="h-9 w-9 flex-none rounded-md"
      style={{ background: c, boxShadow: `0 0 18px -6px ${c}` }}
    />
  );
}

function PositionBadge({ position }: { position: number }) {
  return (
    <div className="w-7 sm:w-9 flex-none flex flex-col items-center">
      <span
        className="text-lg sm:text-2xl tabular-nums leading-none text-white"
        style={f1Wide}
      >
        {position}
      </span>
    </div>
  );
}

function DriverRow({
  d,
  max,
  index,
  leaderPoints,
  animateEnter,
}: {
  d: DriverStanding;
  max: number;
  index: number;
  leaderPoints: number;
  animateEnter: boolean;
}) {
  const iso = DRIVER_NATIONALITY[d.acronym];
  const gap = leaderPoints - d.points;
  const colour = hex(d.teamColour);
  const isLeader = d.position === 1;

  return (
    <motion.div
      initial={animateEnter ? { opacity: 0, y: 14 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.04 * index, duration: 0.4, ease: "easeOut" }}
      className="relative flex items-center gap-3 sm:gap-4 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-2.5 sm:px-4 py-2.5 overflow-hidden"
      style={
        isLeader
          ? { boxShadow: `inset 0 0 30px -18px ${colour}` }
          : undefined
      }
    >
      {/* team-colour accent */}
      <span
        className="absolute left-0 top-0 bottom-0 w-1"
        style={{ background: colour }}
      />

      <PositionBadge position={d.position} />

      <div className="flex flex-col items-center gap-1 flex-none">
        <Delta start={d.positionStart} current={d.position} />
      </div>

      <Avatar driver={d} />

      {/* name + team + bar */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {iso && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://flagcdn.com/w20/${iso}.png`}
              alt=""
              className="h-3 w-4 rounded-[2px] object-cover shrink-0"
            />
          )}
          <span
            className="truncate text-sm sm:text-base text-white uppercase leading-tight"
            style={{ ...f1Font, fontWeight: 700 }}
          >
            <span className="text-zinc-400 font-normal normal-case mr-1 hidden sm:inline">
              {d.firstName}
            </span>
            {d.lastName || d.fullName}
          </span>
          {isLeader && (
            <Trophy size={13} className="text-yellow-400 shrink-0" />
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span
            className="text-[10px] sm:text-[11px] uppercase tracking-wide truncate"
            style={{ ...f1Font, color: colour }}
          >
            {d.teamName}
          </span>
        </div>
        <div className="mt-1.5 max-w-[220px]">
          <PointsBar
            points={d.points}
            max={max}
            colour={d.teamColour}
            delay={0.04 * index + 0.1}
          />
        </div>
      </div>

      {/* points */}
      <div className="flex flex-col items-end flex-none pl-1">
        <span
          className="text-lg sm:text-2xl text-white tabular-nums leading-none"
          style={f1Wide}
        >
          {d.points}
        </span>
        <span className="text-[8px] sm:text-[9px] tracking-[0.2em] text-zinc-500 uppercase mt-0.5">
          PTS
        </span>
        {!isLeader && gap > 0 && (
          <span className="text-[10px] text-zinc-500 tabular-nums mt-0.5">
            -{gap}
          </span>
        )}
      </div>
    </motion.div>
  );
}

function TeamRow({
  t,
  max,
  index,
  leaderPoints,
  animateEnter,
}: {
  t: TeamStanding;
  max: number;
  index: number;
  leaderPoints: number;
  animateEnter: boolean;
}) {
  const gap = leaderPoints - t.points;
  const colour = hex(t.teamColour);
  const isLeader = t.position === 1;

  return (
    <motion.div
      initial={animateEnter ? { opacity: 0, y: 14 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 * index, duration: 0.4, ease: "easeOut" }}
      className="relative flex items-center gap-3 sm:gap-4 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-2.5 sm:px-4 py-3 overflow-hidden"
      style={
        isLeader ? { boxShadow: `inset 0 0 30px -18px ${colour}` } : undefined
      }
    >
      <span
        className="absolute left-0 top-0 bottom-0 w-1"
        style={{ background: colour }}
      />

      <PositionBadge position={t.position} />

      <div className="flex flex-col items-center gap-1 flex-none">
        <Delta start={t.positionStart} current={t.position} />
      </div>

      <TeamLogo teamName={t.teamName} colour={t.teamColour} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="truncate text-sm sm:text-base text-white uppercase leading-tight"
            style={{ ...f1Font, fontWeight: 700 }}
          >
            {t.teamName}
          </span>
          {isLeader && <Trophy size={13} className="text-yellow-400 shrink-0" />}
        </div>
        <div className="mt-1.5 max-w-[260px]">
          <PointsBar
            points={t.points}
            max={max}
            colour={t.teamColour}
            delay={0.05 * index + 0.1}
          />
        </div>
      </div>

      <div className="flex flex-col items-end flex-none pl-1">
        <span
          className="text-lg sm:text-2xl text-white tabular-nums leading-none"
          style={f1Wide}
        >
          {t.points}
        </span>
        <span className="text-[8px] sm:text-[9px] tracking-[0.2em] text-zinc-500 uppercase mt-0.5">
          PTS
        </span>
        {!isLeader && gap > 0 && (
          <span className="text-[10px] text-zinc-500 tabular-nums mt-0.5">
            -{gap}
          </span>
        )}
      </div>
    </motion.div>
  );
}

export default function StandingsView({ data }: Props) {
  const { t } = useLanguage();
  const [view, setView] = useState<View>("drivers");

  // Skip the entrance animation on first paint so the server-rendered rows
  // are visible straight away — both for readers and for crawlers that don't
  // run JS. Switching views afterwards animates normally.
  const [animateEnter, setAnimateEnter] = useState(false);
  useEffect(() => setAnimateEnter(true), []);

  const drivers = data?.drivers ?? [];
  const teams = data?.teams ?? [];
  const meetingName = data?.meetingName ?? null;
  const year = data?.year ?? null;
  const error = data === null;

  const driverMax = drivers[0]?.points ?? 0;
  const teamMax = teams[0]?.points ?? 0;

  const tabs: { id: View; label: string }[] = [
    { id: "drivers", label: t("standings.drivers") },
    { id: "teams", label: t("standings.teams") },
  ];

  return (
    <div
      className="h-svh overflow-y-auto bg-background relative"
      style={{
        backgroundImage: `repeating-linear-gradient(-60deg, transparent 0px, transparent 38px, rgba(255,255,255,0.012) 38px, rgba(255,255,255,0.012) 39px)`,
      }}
    >
      {/* red glow */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-64"
        style={{
          background:
            "radial-gradient(ellipse 70% 60% at 50% 0%, rgba(225,6,0,0.10) 0%, transparent 70%)",
        }}
      />

      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-zinc-800/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <ArrowLeft size={16} />
            <span
              className="text-xs uppercase tracking-[0.15em]"
              style={f1Font}
            >
              Dashboard
            </span>
          </Link>
          <LanguageToggle />
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-3xl px-4 pb-16 pt-8">
        {/* Title */}
        <div className="mb-6 text-center">
          <div className="mb-3 flex items-center justify-center gap-3">
            <div className="h-px w-8 bg-primary opacity-70" />
            <span
              className="text-[11px] uppercase tracking-[0.35em] text-primary"
              style={f1Font}
            >
              {t("standings.title")}
            </span>
            <div className="h-px w-8 bg-primary opacity-70" />
          </div>
          <h1
            className="text-[clamp(2rem,10vw,4rem)] uppercase leading-none text-white"
            style={f1Wide}
          >
            {/* The design shows just the year; the full heading is kept in the
                markup so the page has a descriptive h1 for search engines and
                screen readers. */}
            <span className="sr-only">
              {t("standings.heading", { year: year ?? "" })}
            </span>
            <span aria-hidden="true">{year ?? "F1"}</span>
          </h1>
          {meetingName && (
            <p
              className="mt-3 text-xs uppercase tracking-[0.2em] text-zinc-500"
              style={f1Font}
            >
              {t("standings.updatedAfter")} · {meetingName}
            </p>
          )}
        </div>

        {/* Toggle */}
        <div className="mb-6 flex justify-center">
          <div className="inline-flex rounded-full border border-zinc-800 bg-zinc-900/50 p-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setView(tab.id)}
                className={`relative rounded-full px-5 py-1.5 text-xs uppercase tracking-[0.15em] transition-colors ${
                  view === tab.id ? "text-white" : "text-zinc-500 hover:text-zinc-300"
                }`}
                style={f1Font}
              >
                {view === tab.id && (
                  <motion.span
                    layoutId="standings-tab"
                    className="absolute inset-0 rounded-full bg-primary"
                    transition={{ type: "spring", stiffness: 400, damping: 34 }}
                  />
                )}
                <span className="relative z-10">{tab.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        {error ? (
          <div className="py-20 text-center">
            <div className="mb-3 text-4xl opacity-20">🏁</div>
            <p className="text-sm text-zinc-500" style={f1Font}>
              {t("standings.unavailable")}
            </p>
          </div>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={view}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="space-y-2"
            >
              {view === "drivers"
                ? drivers.map((d, i) => (
                    <DriverRow
                      key={d.driverNumber}
                      d={d}
                      max={driverMax}
                      index={i}
                      leaderPoints={driverMax}
                      animateEnter={animateEnter}
                    />
                  ))
                : teams.map((tm, i) => (
                    <TeamRow
                      key={tm.teamName}
                      t={tm}
                      max={teamMax}
                      index={i}
                      leaderPoints={teamMax}
                      animateEnter={animateEnter}
                    />
                  ))}
            </motion.div>
          </AnimatePresence>
        )}

        <p
          className="mt-8 text-center text-[10px] uppercase tracking-[0.2em] text-zinc-700"
          style={f1Font}
        >
          {t("standings.source")}
        </p>
      </main>
    </div>
  );
}
