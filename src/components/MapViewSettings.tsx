"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Settings, RotateCcw } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { MAP_VIEW_LIMITS, type MapView } from "@/hooks/useMapView";

interface Props {
  view: MapView;
  update: (patch: Partial<MapView>) => void;
  reset: () => void;
}

/**
 * The gear on the track map. Closed it is a single small button in the corner;
 * open it drops the view controls over the map.
 */
export default function MapViewSettings({ view, update, reset }: Props) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click anywhere else, or press Escape, and the panel goes away. Without
  // this it sits on top of the map while someone is trying to watch it.
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

  return (
    // Top left, ahead of the weather gauges — WeatherOverlay starts at left-14
    // to leave this corner free.
    // Opposite corner to the weather gauges, and the wrapper keeps their 58px
    // height so the button lines up with that row rather than hanging from the
    // top edge on its own.
    <div
      ref={rootRef}
      className="absolute top-2 right-2 z-20 flex h-[58px] items-center"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t("map.view")}
        aria-label={t("map.view")}
        aria-expanded={open}
        className={`flex h-12 w-12 items-center justify-center rounded-lg border shadow-lg shadow-black/40 transition-colors ${
          open
            ? "border-zinc-500 bg-zinc-800 text-white"
            : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 hover:text-white"
        }`}
      >
        <Settings size={24} />
      </button>

      {open && (
        <div className="absolute top-full mt-1 right-0 w-56 rounded-lg border border-zinc-800 bg-zinc-950/95 p-3 shadow-xl backdrop-blur-sm">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              {t("map.view")}
            </span>
            <button
              type="button"
              onClick={reset}
              title={t("map.reset")}
              aria-label={t("map.reset")}
              className="text-zinc-500 hover:text-zinc-200 transition-colors"
            >
              <RotateCcw size={12} />
            </button>
          </div>

          <div className="mb-3 flex rounded border border-zinc-800 overflow-hidden text-[11px]">
            {[
              { iso: false, label: t("map.viewTop") },
              { iso: true, label: t("map.viewIso") },
            ].map((option) => (
              <button
                key={String(option.iso)}
                type="button"
                onClick={() => update({ iso: option.iso })}
                className={`flex-1 py-1 transition-colors ${
                  view.iso === option.iso
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2.5">
            {view.iso && (
              <>
                <Slider
                  label={t("map.tilt")}
                  field="tilt"
                  value={view.tilt}
                  unit="°"
                  update={update}
                />
                <Slider
                  label={t("map.spin")}
                  field="spin"
                  value={view.spin}
                  unit="°"
                  update={update}
                />
                <Slider
                  label={t("map.thickness")}
                  field="depthPct"
                  value={view.depthPct}
                  unit="%"
                  update={update}
                />
                <Slider
                  label={t("map.shadow")}
                  field="shadow"
                  value={view.shadow}
                  update={update}
                />
                <Slider
                  label={t("map.backdrop")}
                  field="backdrop"
                  value={view.backdrop}
                  update={update}
                />
              </>
            )}
            <Slider
              label={t("map.trackWidth")}
              field="width"
              value={view.width}
              step={5}
              update={update}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Slider({
  label,
  field,
  value,
  unit = "",
  step = 1,
  update,
}: {
  label: string;
  field: keyof typeof MAP_VIEW_LIMITS;
  value: number;
  unit?: string;
  step?: number;
  update: (patch: Partial<MapView>) => void;
}) {
  const [min, max] = MAP_VIEW_LIMITS[field];

  // A range input fires faster than the browser paints, and every change
  // reprojects the track polyline and re-renders the whole map — measured at
  // ~12ms a step, about a frame's worth. So the thumb and the readout follow
  // the pointer immediately off local state, and the map is told at most once
  // per frame. Same throttle the timing/map divider uses.
  const [local, setLocal] = useState(value);
  const frame = useRef(0);
  const pending = useRef<number | null>(null);

  // Keep in step when the value changes from somewhere else, e.g. Reset.
  useEffect(() => {
    if (!frame.current) setLocal(value);
  }, [value]);

  useEffect(() => () => {
    if (frame.current) cancelAnimationFrame(frame.current);
  }, []);

  const onChange = useCallback(
    (next: number) => {
      setLocal(next);
      pending.current = next;
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        if (pending.current !== null) update({ [field]: pending.current });
      });
    },
    [field, update],
  );

  return (
    <label className="flex flex-col gap-1 text-[11px]">
      <span className="flex justify-between text-zinc-400">
        {label}
        <span className="tabular-nums text-zinc-600">
          {local}
          {unit}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 accent-red-500"
      />
    </label>
  );
}
