"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { History, Minus, Plus } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  BROADCAST_DELAY_MAX_S,
  BROADCAST_DELAY_PRESETS,
} from "@/hooks/useBroadcastDelay";

interface Props {
  seconds: number;
  onChange: (seconds: number) => void;
  /** The delay is set but the stream doesn't reach that far back yet. */
  syncing: boolean;
}

/**
 * How long to let a figure settle before applying it. Each change costs a
 * reconnect — the proxy has to pick a new starting point — and dragging the
 * slider across the range would otherwise ask for sixty of them.
 */
const COMMIT_AFTER_MS = 400;

/**
 * Sets how far behind live the dashboard runs. Closed it is a pill in the top
 * bar that always says which it is — someone who set a delay and forgot should
 * not be left thinking the data is late.
 */
export default function BroadcastDelayControl({
  seconds,
  onChange,
  syncing,
}: Props) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // The figure under the pointer, which the panel and the pill follow
  // immediately; the stream is only told once it stops moving.
  const [draft, setDraft] = useState(seconds);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setDraft(seconds), [seconds]);
  useEffect(
    () => () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
    },
    [],
  );

  const choose = useCallback(
    (next: number) => {
      setDraft(next);
      if (commitTimer.current) clearTimeout(commitTimer.current);
      commitTimer.current = setTimeout(() => onChange(next), COMMIT_AFTER_MS);
    },
    [onChange],
  );

  // Click elsewhere or press Escape and the panel closes, like the map's.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const delayed = draft > 0;

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t("delay.tooltip")}
        aria-label={t("delay.tooltip")}
        aria-expanded={open}
        data-tour="broadcast-delay"
        className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 transition-colors ${
          delayed
            ? "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:border-amber-400/70"
            : "border-zinc-700 bg-zinc-800/50 text-zinc-300 hover:border-zinc-500 hover:text-white"
        }`}
      >
        {delayed ? (
          <History size={16} className="shrink-0" />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
        )}
        <span className="text-sm font-medium tabular-nums">
          {delayed ? `−${draft}s` : t("delay.live")}
        </span>
      </button>

      {open && (
        <div className="absolute top-full right-0 z-30 mt-1 w-60 rounded-lg border border-zinc-800 bg-zinc-950/95 p-3 shadow-xl backdrop-blur-sm">
          <span className="mb-2.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            {t("delay.title")}
          </span>

          <div className="mb-3 flex overflow-hidden rounded border border-zinc-800 text-[11px]">
            {BROADCAST_DELAY_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => choose(preset)}
                className={`flex-1 py-1 tabular-nums transition-colors ${
                  draft === preset
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {preset === 0 ? t("delay.live") : `${preset}s`}
              </button>
            ))}
          </div>

          {/* Nudges either side of the slider: lining the dashboard up with a
              broadcast is done by eye, a second at a time. */}
          <div className="flex items-center gap-2">
            <Nudge
              label={t("delay.less")}
              disabled={draft <= 0}
              onClick={() => choose(draft - 1)}
              icon={<Minus size={12} />}
            />
            <input
              type="range"
              min={0}
              max={BROADCAST_DELAY_MAX_S}
              step={1}
              value={draft}
              onChange={(event) => choose(Number(event.target.value))}
              className="h-1 flex-1 accent-amber-400"
              aria-label={t("delay.title")}
            />
            <Nudge
              label={t("delay.more")}
              disabled={draft >= BROADCAST_DELAY_MAX_S}
              onClick={() => choose(draft + 1)}
              icon={<Plus size={12} />}
            />
          </div>

          <p className="mt-2.5 text-[11px] leading-snug text-zinc-500">
            {t("delay.hint")}
          </p>

          {syncing && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-amber-400/90">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />
              {t("delay.syncing")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Nudge({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-800 text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-100 disabled:opacity-30 disabled:hover:border-zinc-800 disabled:hover:text-zinc-400"
    >
      {icon}
    </button>
  );
}
