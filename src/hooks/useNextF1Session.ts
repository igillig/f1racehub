"use client";

import { useState, useEffect, useCallback } from "react";

export interface OpenF1Session {
  session_key: number;
  session_name: string;
  session_type: string;
  date_start: string;
  date_end: string;
  circuit_short_name: string;
  country_name: string;
  location: string;
  meeting_key: number;
  gmt_offset: string;
  year: number;
}

export interface Countdown {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  isPast: boolean;
}

function computeCountdown(dateStr: string): Countdown {
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, isPast: true };
  return {
    days: Math.floor(diff / 86400000),
    hours: Math.floor((diff % 86400000) / 3600000),
    minutes: Math.floor((diff % 3600000) / 60000),
    seconds: Math.floor((diff % 60000) / 1000),
    isPast: false,
  };
}

interface NextSessionState {
  nextSession: OpenF1Session | null;
  weekendSessions: OpenF1Session[];
  loading: boolean;
  isLive: boolean;
  countdown: Countdown;
}

export function useNextF1Session(): NextSessionState {
  const [nextSession, setNextSession] = useState<OpenF1Session | null>(null);
  const [weekendSessions, setWeekendSessions] = useState<OpenF1Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState<Countdown>({
    days: 0, hours: 0, minutes: 0, seconds: 0, isPast: false,
  });

  const fetchSessions = useCallback(() => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    // Fetch directly from OpenF1 — no auth needed for session schedule,
    // and this way the landing works even when the proxy isn't running.
    // Fall back to proxy URL if the direct fetch fails (e.g. CORS in some envs).
    const direct = `https://api.openf1.org/v1/sessions?date_start>=${yesterday}`;
    const fallback = `/api/proxy/api/sessions?date_start>=${yesterday}`;

    const parse = (data: OpenF1Session[]) => {
      const now = Date.now();
      const upcoming = data
        .filter((s) => new Date(s.date_end).getTime() > now)
        .sort((a, b) => new Date(a.date_start).getTime() - new Date(b.date_start).getTime());
      const next = upcoming[0] ?? null;
      setNextSession(next);
      setWeekendSessions(
        next ? upcoming.filter((s) => s.meeting_key === next.meeting_key) : []
      );
      setLoading(false);
      if (next) setCountdown(computeCountdown(next.date_start));
    };

    fetch(direct)
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then(parse)
      .catch(() =>
        // Proxy fallback
        fetch(fallback)
          .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
          .then(parse)
          .catch(() =>
            // Last resort: the proxy's current session (works even if OpenF1's
            // schedule endpoint is down while a session is live).
            fetch("/api/proxy/api/state")
              .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
              .then((state: { session?: OpenF1Session }) => {
                if (state?.session?.date_end) parse([state.session]);
                else setLoading(false);
              })
              .catch(() => setLoading(false))
          )
      );
  }, []);

  useEffect(() => {
    fetchSessions();
    // Re-check every 60s to detect when a session goes live
    const id = setInterval(fetchSessions, 60_000);
    return () => clearInterval(id);
  }, [fetchSessions]);

  useEffect(() => {
    if (!nextSession) return;
    const id = setInterval(
      () => setCountdown(computeCountdown(nextSession.date_start)),
      1000
    );
    return () => clearInterval(id);
  }, [nextSession]);

  // Session is live when its start has passed but end hasn't (upcoming already filters date_end > now)
  const isLive = nextSession !== null && new Date(nextSession.date_start).getTime() <= Date.now();

  return { nextSession, weekendSessions, loading, isLive, countdown };
}
