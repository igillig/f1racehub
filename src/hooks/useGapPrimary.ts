"use client";

import { useEffect, useRef, useState } from "react";

export type GapPrimary = "gap" | "interval";

/**
 * Which gap figure the timing table leads with. Races lead with the interval
 * to the car ahead; practice and qualifying with the gap to P1. Shared by the
 * desktop and mobile boards.
 */
export function useGapPrimary(sessionName?: string) {
  const isRace = /^(Race|Sprint)$/i.test(sessionName || "");

  const [gapPrimary, setGapPrimary] = useState<GapPrimary>(
    isRace ? "interval" : "gap",
  );

  // Once per session type, not per render: the name can arrive a frame after
  // mount, and after that the user's pick stands until the session changes.
  const appliedForRef = useRef<boolean | null>(sessionName ? isRace : null);

  useEffect(() => {
    if (!sessionName || appliedForRef.current === isRace) return;
    appliedForRef.current = isRace;
    setGapPrimary(isRace ? "interval" : "gap");
  }, [isRace, sessionName]);

  const toggle = () =>
    setGapPrimary((current) => (current === "gap" ? "interval" : "gap"));

  return { gapPrimary, toggle };
}
