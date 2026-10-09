"use client";

import { useEffect, useState } from "react";

interface Props {
  /** ISO 8601 instant with offset. */
  iso: string;
  locale?: "es" | "en";
  /** Include the weekday and day/month, not just the clock time. */
  withDate?: boolean;
}

/**
 * The session time in the *reader's* timezone.
 *
 * Pages render track-local time on the server (so the schedule is in the HTML
 * for crawlers and for the first paint); this fills in the visitor's own time
 * after hydration. It renders nothing until mounted — the server has no way to
 * know the reader's zone, and guessing would cause a hydration mismatch.
 */
export default function ViewerTime({ iso, locale = "es", withDate }: Props) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return;
    setText(
      new Intl.DateTimeFormat(locale === "es" ? "es-ES" : "en-GB", {
        ...(withDate ? { weekday: "short", day: "numeric", month: "short" } : {}),
        hour: "2-digit",
        minute: "2-digit",
      }).format(d),
    );
  }, [iso, locale, withDate]);

  if (!text) return null;
  return <>{text}</>;
}
