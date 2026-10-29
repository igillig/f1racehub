"use client";

import { useCallback, useEffect, useState } from "react";
import { Joyride, STATUS } from "react-joyride";
import type { EventData, Locale, Step } from "react-joyride";
import { useLanguage } from "@/contexts/LanguageContext";

/**
 * One shared key holds every tour a viewer has seen, so a new feature never
 * adds another key to localStorage.
 *
 * Each tour is only offered during its rollout window. The broadcast-delay
 * hint goes out with the Mexico GP weekend and retires 30 days later — after
 * that it is old news and never shows again, seen or not.
 */
const STORAGE_KEY = "f1-dashboard-tours-seen";

const TOUR_ID = "broadcast-delay";
// Friday of the Mexico GP weekend, the day the feature ships for testing.
const TOUR_SHIPPED_AT = Date.UTC(2026, 9, 30);
const TOUR_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const TOUR_EXPIRES_AT = TOUR_SHIPPED_AT + TOUR_LIFETIME_MS;

type SeenTour = { id: string; seenAt: number };

function readSeen(): SeenTour[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSeen(seen: SeenTour[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seen));
  } catch {
    // Private mode or blocked storage — the tour just shows again next visit.
  }
}

export default function FeatureTour() {
  const { t } = useLanguage();
  const [run, setRun] = useState(false);

  // Offer the tour once, and only while it is still inside its rollout window.
  useEffect(() => {
    if (Date.now() >= TOUR_EXPIRES_AT) return;
    if (!readSeen().some((s) => s.id === TOUR_ID)) setRun(true);
  }, []);

  const steps: Step[] = [
    {
      target: '[data-tour="broadcast-delay"]',
      title: t("tour.delay.title"),
      content: t("tour.delay.content"),
      placement: "bottom",
    },
  ];

  const handleEvent = useCallback((data: EventData) => {
    if (data.status !== STATUS.FINISHED && data.status !== STATUS.SKIPPED) {
      return;
    }
    setRun(false);
    const seen = readSeen().filter((s) => s.id !== TOUR_ID);
    seen.push({ id: TOUR_ID, seenAt: Date.now() });
    writeSeen(seen);
  }, []);

  const locale: Locale = {
    back: t("tour.back"),
    next: t("tour.next"),
    last: t("tour.last"),
    skip: t("tour.skip"),
    close: t("tour.skip"),
  };

  return (
    <Joyride
      steps={steps}
      run={run}
      continuous
      onEvent={handleEvent}
      scrollToFirstStep
      locale={locale}
      options={{
        buttons: ["skip", "primary"],
        closeButtonAction: "skip",
        overlayClickAction: false,
        skipBeacon: true,
        arrowColor: "#18181b",
        backgroundColor: "#18181b",
        primaryColor: "#e10600",
        textColor: "#e4e4e7",
        overlayColor: "rgba(0, 0, 0, 0.6)",
        width: 340,
        zIndex: 10000,
        spotlightRadius: 6,
      }}
      styles={{
        buttonSkip: { color: "#a1a1aa" },
      }}
    />
  );
}
