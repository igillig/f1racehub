"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * How far behind live this viewer wants the dashboard. The dashboard runs
 * 30–60s ahead of a TV broadcast and the figure depends on the provider, so it
 * is per-viewer and remembered per browser.
 *
 * The ceiling matches MAX_DELAY_MS in proxy/stream-buffer.js — that is all the
 * stream the proxy keeps.
 */
export const BROADCAST_DELAY_MAX_S = 60;

/** Offered as one-tap choices; anything in between comes off the slider. */
export const BROADCAST_DELAY_PRESETS = [0, 15, 30, 45, 60] as const;

const STORAGE_KEY = "f1-dashboard-broadcast-delay";

/** Stored values are untrusted: hand-edited, or from an older shape. */
function sanitise(raw: string | null): number | null {
  if (raw === null) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return null;
  return Math.min(Math.max(Math.round(seconds), 0), BROADCAST_DELAY_MAX_S);
}

export interface BroadcastDelay {
  seconds: number;
  /** What the stream layer works in. */
  delayMs: number;
  /**
   * False until the stored preference is read. Nothing should open the stream
   * before then: connecting live and correcting a moment later would show the
   * very seconds the viewer set a delay to avoid.
   */
  ready: boolean;
  setSeconds: (seconds: number) => void;
}

export function useBroadcastDelay(): BroadcastDelay {
  // Live on the first render so server and client agree.
  const [seconds, setStored] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const saved = sanitise(window.localStorage.getItem(STORAGE_KEY));
      if (saved !== null) setStored(saved);
    } catch {
      // Private mode or blocked site data; live is a fine default.
    }
    setReady(true);
  }, []);

  const setSeconds = useCallback((next: number) => {
    const clamped = Math.min(
      Math.max(Math.round(next), 0),
      BROADCAST_DELAY_MAX_S,
    );
    setStored(clamped);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      // The delay still applies for this session.
    }
  }, []);

  return { seconds, delayMs: seconds * 1000, ready, setSeconds };
}
