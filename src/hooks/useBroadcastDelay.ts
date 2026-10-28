"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * How far behind live this viewer wants the dashboard, in seconds.
 *
 * The data arrives as fast as the sources produce it, which puts the dashboard
 * 30 to 60 seconds ahead of a TV broadcast. Anyone watching both at once needs
 * to be able to hold it back by their own amount — the figure depends on their
 * provider, so it is theirs to set, and it is remembered per browser.
 *
 * The ceiling matches MAX_DELAY_MS in proxy/stream-buffer.js: the proxy only
 * keeps that much of the stream, and past a minute the dashboard would be
 * behind the broadcast rather than with it.
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
   * False until the stored preference has been read, which happens right
   * after mount. Nothing should open the stream before then: connecting live
   * and correcting a moment later would show this viewer the very seconds
   * they set a delay to avoid.
   */
  ready: boolean;
  setSeconds: (seconds: number) => void;
}

export function useBroadcastDelay(): BroadcastDelay {
  // Live on the first render so the server and the client agree; the stored
  // preference is applied right after mount.
  const [seconds, setStored] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const saved = sanitise(window.localStorage.getItem(STORAGE_KEY));
      if (saved !== null) setStored(saved);
    } catch {
      // Private mode, or blocked site data. Live is a fine default.
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
      // Not worth surfacing: the delay still applies for this session.
    }
  }, []);

  return { seconds, delayMs: seconds * 1000, ready, setSeconds };
}
