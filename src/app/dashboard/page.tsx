"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Map, Flag, AlertTriangle, Radio } from "lucide-react";
import AlertStrip from "@/components/AlertStrip";
import Image from "next/image";
import TopBar from "@/components/TopBar";
import TimingBoard from "@/components/TimingBoard";
import MobileTimingBoard from "@/components/MobileTimingBoard";
import TrackMap from "@/components/TrackMap";
import TeamRadios from "@/components/TeamRadios";
import RaceControl from "@/components/RaceControl";
import TrackViolations from "@/components/TrackViolations";
import CarTelemetry from "@/components/CarTelemetry";
import Footer from "@/components/Footer";
import StatusBanner, { BannerConfig } from "@/components/StatusBanner";
import ReplayBar from "@/components/ReplayBar";
import AppDrawer from "@/components/AppDrawer";
import { useF1DataSSE } from "@/hooks/useF1DataSSE";
import { useLanguage } from "@/contexts/LanguageContext";

export default function DashboardPage() {
  const { t } = useLanguage();
  const {
    drivers,
    sessionInfo,
    trackStatus,
    weather,
    teamRadios,
    raceControlMessages,
    carData,
    error,
    proxyMode,
    signalrDegraded,
  } = useF1DataSSE();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "map" | "control" | "violations" | "radio"
  >("map");
  const [tableExpanded, setTableExpanded] = useState(false);
  const [hoveredDriverNumber, setHoveredDriverNumber] = useState<string | null>(
    null,
  );
  const [pinnedDriverNumber, setPinnedDriverNumber] = useState<string | null>(
    null,
  );
  const [latestRaceControlMessage, setLatestRaceControlMessage] = useState<
    { category?: string; message: string } | undefined
  >();
  const lastShownMessageRef = useRef<string | null>(null);

  useEffect(() => {
    if (raceControlMessages.length > 0) {
      const newestMessage = raceControlMessages[0];
      if (
        newestMessage &&
        newestMessage.message !== lastShownMessageRef.current
      ) {
        const isRace = /^(Race|Sprint)$/i.test(sessionInfo.sessionName);
        const isInterestingMessage =
          !newestMessage.message.includes("CLEAR IN TRACK SECTOR") &&
          !newestMessage.message.includes("TRACK SURFACE SLIPPERY") &&
          !newestMessage.message.includes("WAVED BLUE FLAG") &&
          !newestMessage.message.includes("BLUE FLAG") &&
          // In race/sprint, "time deleted" notices are not actionable for viewers
          !(isRace && newestMessage.message.includes("DELETED")) &&
          !(isRace && newestMessage.message.includes("WILL BE REINSTATED"));
        if (isInterestingMessage) {
          lastShownMessageRef.current = newestMessage.message;
          setLatestRaceControlMessage({
            category: newestMessage.category,
            message: newestMessage.message,
          });
        }
      }
    }
  }, [raceControlMessages, sessionInfo.sessionName]);

  const hideBanner = useCallback(
    () => setLatestRaceControlMessage(undefined),
    [],
  );

  const latestAlert = (() => {
    const isRace = /^(Race|Sprint)$/i.test(sessionInfo.sessionName);
    const allMsgs = raceControlMessages.filter(
      (m) =>
        !m.message.includes("CLEAR IN TRACK SECTOR") &&
        !m.message.includes("WAVED BLUE FLAG") &&
        !m.message.includes("BLUE FLAG") &&
        !(isRace && m.message.includes("DELETED")) &&
        !(isRace && m.message.includes("WILL BE REINSTATED")),
    );
    const msg = allMsgs[0];
    const radio = teamRadios[0];
    const msgTime = msg ? new Date(msg.utc).getTime() : 0;
    const radioTime = radio ? new Date(radio.utc).getTime() : 0;

    if (!msg && !radio) return null;

    if (radio && radioTime > msgTime) {
      const driver = drivers.find((d) => d.driverNumber === radio.racingNumber);
      return {
        label: t("alert.radio"),
        text: driver ? driver.code : `#${radio.racingNumber}`,
        time: radio.utc,
        icon: "📻" as string | null,
        color: "text-purple-400",
      };
    }

    if (!msg) return null;
    const m = msg.message;
    const isViolation = m.toUpperCase().includes("TRACK LIMITS");
    return {
      label: isViolation ? t("alert.violations") : t("alert.raceControl"),
      color: isViolation ? "text-orange-400" : "text-zinc-400",
      text: msg.message,
      time: msg.utc,
      icon: m.includes("CHEQUERED")
        ? "🏁"
        : m.includes("BLACK AND WHITE")
          ? "⚑"
          : m.includes("DOUBLE YELLOW")
            ? "🟡"
            : m.includes("YELLOW")
              ? "🟡"
              : m.includes("RED FLAG")
                ? "🔴"
                : m.includes("GREEN")
                  ? "🟢"
                  : m.includes("BLUE FLAG")
                    ? "🔵"
                    : m.includes("SAFETY CAR")
                      ? "🚗"
                      : m.includes("VSC")
                        ? "🟡"
                        : null,
    };
  })();

  // Priority order: signalrDegraded > replay > standby > reconnecting
  // Only one banner is shown at a time; standby/replay suppress the generic reconnecting message.
  const activeBanner: BannerConfig | null = (() => {
    if (signalrDegraded)
      return {
        id: "signalr",
        bg: "bg-yellow-500/10",
        border: "border-yellow-500/30",
        text: "text-yellow-200",
        dot: "bg-yellow-400",
        label: t("mode.signalrDegradedLabel"),
        desc: t("mode.signalrDegradedDesc"),
      };
    if (proxyMode === "replay")
      return {
        id: "replay",
        bg: "bg-yellow-500/10",
        border: "border-yellow-500/30",
        text: "text-yellow-200",
        dot: "bg-yellow-400",
        label: t("mode.replayLabel"),
        desc: t("mode.replayDesc"),
      };
    if (proxyMode === "standby")
      return {
        id: "standby",
        bg: "bg-blue-500/10",
        border: "border-blue-500/30",
        text: "text-blue-200",
        dot: "bg-blue-400",
        label: t("mode.standbyLabel"),
        desc: t("mode.standbyDesc"),
      };
    if (error === "RECONNECTING")
      return {
        id: "reconnecting",
        bg: "bg-yellow-500/10",
        border: "border-yellow-500/30",
        text: "text-yellow-200",
        dot: "bg-yellow-400",
        label: t("error.reconnecting"),
      };
    return null;
  })();

  if (error === "OFFLINE") {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-10">
        <Image
          src="/images/logo.png"
          alt="F1 Dashboard"
          width={180}
          height={60}
          className="opacity-90"
          priority
        />
        <div className="w-20 h-0.5 bg-primary" />
        <div className="text-center space-y-3">
          <p
            className="text-foreground text-2xl tracking-widest uppercase"
            style={{
              fontFamily: "'Formula1 Display', sans-serif",
              fontWeight: 700,
            }}
          >
            {t("error.offline")}
          </p>
          <p className="text-muted-foreground text-sm tracking-wide">
            {t("error.retrying")}
          </p>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground/50 text-xs tracking-widest uppercase">
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          {t("error.offlineBadge")}
        </div>
      </div>
    );
  }

  return (
    <div
      translate="no"
      className="h-dvh overflow-hidden bg-background flex flex-col"
    >
      <TopBar
        session={sessionInfo}
        trackStatus={trackStatus}
        latestRaceControlMessage={latestRaceControlMessage}
        onBannerComplete={hideBanner}
        onMenuOpen={() => setDrawerOpen((v) => !v)}
      />

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

        <main
          className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
          onClick={drawerOpen ? () => setDrawerOpen(false) : undefined}
        >
          <StatusBanner banner={activeBanner} />

          <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-2 p-2">
          {/* Mobile timing board */}
          <div className={`lg:hidden min-h-0 ${tableExpanded ? "flex-1" : "flex-[60]"}`}>
            <MobileTimingBoard
              drivers={drivers}
              sessionName={sessionInfo.sessionName}
              qualifyingPart={sessionInfo.qualifyingPart}
              hoveredDriverNumber={hoveredDriverNumber}
              onDriverHover={setHoveredDriverNumber}
              pinnedDriverNumber={pinnedDriverNumber}
              onDriverPin={setPinnedDriverNumber}
              expanded={tableExpanded}
              onToggleExpand={() => setTableExpanded((v) => !v)}
            />
          </div>

          {/* Desktop timing board */}
          <div className="hidden lg:block lg:flex-none min-h-0 overflow-x-auto">
            <TimingBoard
              drivers={drivers}
              sessionName={sessionInfo.sessionName}
              qualifyingPart={sessionInfo.qualifyingPart}
              hoveredDriverNumber={hoveredDriverNumber}
              onDriverHover={setHoveredDriverNumber}
              pinnedDriverNumber={pinnedDriverNumber}
              onDriverPin={setPinnedDriverNumber}
            />
          </div>

          {/* Tab panel — full when split, icon-only strip when tableExpanded */}
          {(() => {
            const tabs = [
              { id: "map"        as const, label: t("tab.map"),     icon: Map,           color: "#38bdf8" },
              { id: "control"    as const, label: t("tab.control"), icon: Flag,          color: "#facc15" },
              { id: "violations" as const, label: t("tab.limits"),  icon: AlertTriangle, color: "#f97316" },
              { id: "radio"      as const, label: t("tab.radio"),   icon: Radio,         color: "#a78bfa" },
            ];

            return (
              <div
                className={`${tableExpanded ? "flex-none lg:flex-1" : "flex-[40] lg:flex-1"} min-h-0 flex flex-col gap-1`}
                style={{ minWidth: tableExpanded ? undefined : 220 }}
              >
                <div className={`border border-zinc-800 rounded-lg bg-zinc-900/50 overflow-hidden flex flex-col ${tableExpanded ? "flex-none" : "flex-1 min-h-0"}`}>
                  {/* Tab bar */}
                  <div className="flex shrink-0 border-b border-zinc-800 bg-zinc-950/40">
                    {tabs.map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => {
                          setActiveTab(tab.id);
                          if (tableExpanded) setTableExpanded(false);
                        }}
                        className={`relative flex items-center gap-1.5 px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors flex-1 justify-center lg:flex-none lg:justify-start ${
                          activeTab === tab.id ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                        }`}
                      >
                        <tab.icon size={13} style={{ color: tab.color }} />
                        <span className={tableExpanded ? "hidden" : "inline"}>{tab.label}</span>
                        {activeTab === tab.id && (
                          <motion.div
                            layoutId="tab-indicator"
                            className="absolute bottom-0 left-0 right-0 h-0.5"
                            style={{ backgroundColor: tab.color }}
                            transition={{ type: "spring", stiffness: 400, damping: 35 }}
                          />
                        )}
                      </button>
                    ))}
                  </div>

                  {/* Tab content — hidden when table is expanded */}
                  {!tableExpanded && (
                    <div className="flex-1 min-h-0 overflow-hidden">
                      {activeTab === "map" &&
                        (() => {
                          const activeNum = hoveredDriverNumber ?? pinnedDriverNumber;
                          const activeDriver = activeNum ? drivers.find((d) => d.driverNumber === activeNum) : null;
                          const activeTelemetry = activeNum ? carData[activeNum] : null;
                          return (
                            <div className="h-full flex flex-col">
                              <div className="flex-1 min-h-0">
                                <TrackMap
                                  drivers={drivers}
                                  circuitKey={sessionInfo.circuitKey}
                                  trackStatus={trackStatus}
                                  raceControlMessages={raceControlMessages}
                                  isSessionActive={sessionInfo.isLive}
                                  qualifyingPart={sessionInfo.qualifyingPart}
                                  hoveredDriverNumber={activeNum}
                                  weather={weather}
                                />
                              </div>
                              <AnimatePresence>
                                {activeDriver && activeTelemetry && (
                                  <motion.div
                                    key="car-telemetry"
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 80, opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.15 }}
                                    className="shrink-0 overflow-hidden"
                                  >
                                    <CarTelemetry driver={activeDriver} data={activeTelemetry} />
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>
                          );
                        })()}
                      {activeTab === "control" && <RaceControl messages={raceControlMessages} />}
                      {activeTab === "violations" && (
                        <TrackViolations
                          messages={raceControlMessages}
                          drivers={drivers}
                          sessionName={sessionInfo.sessionName}
                        />
                      )}
                      {activeTab === "radio" && <TeamRadios radios={teamRadios} drivers={drivers} />}
                    </div>
                  )}
                </div>

                {latestAlert && !tableExpanded && <AlertStrip alert={latestAlert} />}
              </div>
            );
          })()}
          </div>
        </main>
      </div>

      <Footer />
      <ReplayBar
        proxyMode={proxyMode}
        sessionName={
          sessionInfo
            ? `${sessionInfo.sessionName} · ${sessionInfo.track}`
            : undefined
        }
      />
    </div>
  );
}
