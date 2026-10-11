"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useLanguage } from "@/contexts/LanguageContext";

export interface AlertData {
  label: string;
  text: string;
  time: string;
  icon: string | null;
  color: string;
  /**
   * Recording URL. Only team radio alerts carry one, and only those get a play
   * button — the strip is the newest thing that happened, so being able to hear
   * it without opening the radio tab is the whole point.
   */
  audio?: string;
  /** Team colour, for the playback progress bar. */
  accent?: string;
}

function PlayIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}

function LoadingIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="animate-spin"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
    </svg>
  );
}

/** How long a new alert stays highlighted. */
const FRESH_MS = 6000;

export default function AlertStrip({ alert }: { alert: AlertData }) {
  const { t } = useLanguage();
  const textRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(0);

  const [playback, setPlayback] = useState<"idle" | "loading" | "playing">("idle");
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayback("idle");
    setProgress(0);
  }, []);

  // A new alert replaces what the strip is showing, so whatever was playing is
  // no longer the thing on screen. Also covers unmount.
  useEffect(() => stop, [alert.audio, stop]);

  // The strip sits still most of the time, so a new message landing in it is
  // easy to miss. Light it up in the event's own colour for a few seconds
  // whenever the content actually changes — not on mount, where the "newest"
  // message is usually something that happened a while ago.
  const alertKey = `${alert.time}|${alert.text}`;
  const seenRef = useRef(alertKey);
  const [fresh, setFresh] = useState(false);

  useEffect(() => {
    if (seenRef.current === alertKey) return;
    seenRef.current = alertKey;
    setFresh(true);
    const timer = setTimeout(() => setFresh(false), FRESH_MS);
    return () => clearTimeout(timer);
  }, [alertKey]);

  const toggle = useCallback(() => {
    if (!alert.audio) return;
    if (playback !== "idle") {
      stop();
      return;
    }

    const audio = new Audio(alert.audio);
    audioRef.current = audio;
    setPlayback("loading");
    setProgress(0);

    audio.onplaying = () => setPlayback("playing");
    audio.ontimeupdate = () => {
      if (audio.duration) setProgress((audio.currentTime / audio.duration) * 100);
    };
    audio.onended = stop;
    audio.onerror = stop;
    audio.play().catch(stop);
  }, [alert.audio, playback, stop]);

  // Re-measured when the play button appears or disappears too: that changes
  // the text's available width without a resize or a text change.
  useEffect(() => {
    setOverflow(0);
    const measure = () => {
      if (textRef.current && containerRef.current) {
        const amount = textRef.current.scrollWidth - containerRef.current.offsetWidth;
        setOverflow(Math.max(0, amount));
      }
    };
    const t = setTimeout(measure, 50);
    window.addEventListener("resize", measure);
    return () => { clearTimeout(t); window.removeEventListener("resize", measure); };
    // `fresh` is in here because the unseen dot takes width off the text.
  }, [alert.text, alert.audio, fresh]);

  const speed = 80; // pixels per second
  const pauseDuration = 1.5;
  const returnDuration = 0.5;
  const scrollDuration = overflow > 0 ? Math.max(overflow / speed, 1.5) : 0;
  const totalDuration = overflow > 0
    ? pauseDuration + scrollDuration + pauseDuration + returnDuration
    : 0;
  const t1 = overflow > 0 ? pauseDuration / totalDuration : 0;
  const t2 = overflow > 0 ? (pauseDuration + scrollDuration) / totalDuration : 0;
  const t3 = overflow > 0 ? (pauseDuration + scrollDuration + pauseDuration) / totalDuration : 0;

  const time = (() => {
    try {
      return new Date(alert.time).toLocaleTimeString([], {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch { return alert.time; }
  })();

  const accent = alert.accent || "#a78bfa";

  return (
    <div
      className="relative shrink-0 flex items-center gap-2 px-3 py-2.5 min-h-[52px] border rounded-lg text-[13px] overflow-hidden transition-[background-color,border-color,box-shadow] duration-700"
      style={
        fresh
          ? {
              borderColor: accent,
              backgroundColor: `${accent}1a`,
              boxShadow: `0 0 14px -4px ${accent}`,
            }
          : { borderColor: "#27272a", backgroundColor: "rgb(24 24 27 / 0.5)" }
      }
    >
      {/* Unseen marker — pulses for as long as the alert counts as new */}
      {fresh && (
        <span className="relative shrink-0 flex h-2 w-2">
          <span
            className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping"
            style={{ backgroundColor: accent }}
          />
          <span
            className="relative inline-flex h-2 w-2 rounded-full"
            style={{ backgroundColor: accent }}
          />
        </span>
      )}

      {/* Source label */}
      <span className={`px-1.5 py-0.5 rounded bg-zinc-800 text-[11px] uppercase tracking-wide font-medium shrink-0 ${alert.color}`}>
        {alert.label}
      </span>

      {/* Play control for radio, flag / type icon for everything else */}
      {alert.audio ? (
        <button
          type="button"
          onClick={toggle}
          title={playback === "idle" ? t("alert.playRadio") : t("alert.stopRadio")}
          aria-label={playback === "idle" ? t("alert.playRadio") : t("alert.stopRadio")}
          className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center border transition-colors ${
            playback === "idle"
              ? "border-zinc-600 bg-zinc-800 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              : "border-white/20 bg-white/10 text-white"
          }`}
        >
          {playback === "loading" ? <LoadingIcon /> : playback === "idle" ? <PlayIcon /> : <StopIcon />}
        </button>
      ) : (
        alert.icon && <span className="shrink-0">{alert.icon}</span>
      )}

      {/* Scrolling text */}
      <div ref={containerRef} className="flex-1 min-w-0 overflow-hidden">
        <motion.span
          key={alert.text}
          ref={textRef}
          className="text-zinc-300 whitespace-nowrap inline-block"
          animate={overflow > 0 ? {
            x: [0, 0, -overflow, -overflow, 0],
          } : { x: 0 }}
          transition={overflow > 0 ? {
            duration: totalDuration,
            times: [0, t1, t2, t3, 1],
            ease: "linear",
            repeat: Infinity,
          } : {}}
        >
          {alert.text}
        </motion.span>
      </div>

      {/* Time */}
      <span className="text-zinc-500 shrink-0">{time}</span>

      {/* Playback progress, along the bottom edge */}
      {playback !== "idle" && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-zinc-800">
          <div
            className="h-full transition-all duration-100"
            style={{ width: `${progress}%`, backgroundColor: accent }}
          />
        </div>
      )}
    </div>
  );
}
