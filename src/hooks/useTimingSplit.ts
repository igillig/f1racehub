"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  densityForWidth,
  fullTableWidth,
  minTableWidth,
  type Density,
  type SectorCounts,
} from "@/lib/timingDensity";

/** The map panel never gets narrower than this, however far the divider goes. */
const MIN_MAP_WIDTH = 280;

/**
 * The table's share of the row before anyone touches the divider.
 *
 * A share rather than the table's own full width: on a wide monitor the full
 * table leaves the map far more room than the table, and on a laptop it leaves
 * it almost none. Sixty per cent keeps the same balance at either size, and the
 * surplus over what the current density level needs goes into the minisector
 * columns rather than sitting empty.
 */
const DEFAULT_TABLE_SHARE = 0.6;

const STORAGE_KEY = "f1-dashboard-timing-width";

interface Split {
  /**
     * Ref for the flex row that holds the table, the divider and the map.
     *
     * A callback ref, not an object ref: the dashboard renders a loading screen
     * before the first SSE frame arrives, so the row does not exist on mount
     * and an effect with an empty dependency list would observe nothing and
     * never run again.
     */
  containerRef: (node: HTMLDivElement | null) => void;
  /** Explicit table width, or null until the container has been measured. */
  width: number | null;
  /** Which columns the table can still afford at that width. */
  density: Density;
  /** Attach to the divider. */
  onPointerDown: (event: React.PointerEvent) => void;
  dragging: boolean;
  /** Back to the default split. */
  reset: () => void;
}

/**
 * The draggable split between the timing table and the map.
 *
 * The width lives here rather than in CSS because it has to be clamped against
 * two moving targets — the table's own minimum, which depends on the circuit's
 * minisector count, and the map's minimum — and because the density level is
 * derived from it. Persisted per browser: someone who set up their split for a
 * 34" monitor should not have to redo it every session.
 *
 * Desktop only. The mobile layout stacks the two and has its own toggle.
 */
export function useTimingSplit(counts: SectorCounts): Split {
  const [width, setWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  // Measured on the client only: reading localStorage or the container during
  // render would not match what the server rendered.
  const [available, setAvailable] = useState<number | null>(null);

  const observerRef = useRef<ResizeObserver | null>(null);

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;

    const observer = new ResizeObserver(([entry]) => {
      setAvailable(entry.contentRect.width);
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  const clamp = useCallback(
    (value: number, containerWidth: number) => {
      const min = minTableWidth(counts);
      // On a narrow window the map's minimum wins, even if that pushes the
      // table below its own floor — the table can scroll, the map cannot.
      const max = Math.max(min, containerWidth - MIN_MAP_WIDTH);
      return Math.min(Math.max(value, min), max);
    },
    [counts],
  );

  // First measurement: the stored width if there is one, otherwise the default
  // share.
  useEffect(() => {
    if (available === null || width !== null) return;

    let stored: number | null = null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) stored = parsed;
      }
    } catch {
      // Private mode, or site data blocked. The default is fine.
    }

    setWidth(clamp(stored ?? available * DEFAULT_TABLE_SHARE, available));
  }, [available, width, counts, clamp]);

  // Keep the split legal when the window is resized.
  useEffect(() => {
    if (available === null || width === null) return;
    const legal = clamp(width, available);
    if (legal !== width) setWidth(legal);
  }, [available, width, clamp]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (width === null || available === null) return;

      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      const container = available;

      setDragging(true);

      // Throttled to one update per frame. A raw pointermove fires faster than
      // the browser paints, and every update re-renders twenty timing rows on
      // top of whatever the SSE stream is already pushing.
      let frame = 0;
      const move = (e: PointerEvent) => {
        const next = clamp(startWidth + (e.clientX - startX), container);
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          setWidth(next);
        });
      };

      const up = (e: PointerEvent) => {
        if (frame) cancelAnimationFrame(frame);
        const final = clamp(startWidth + (e.clientX - startX), container);
        setWidth(final);
        setDragging(false);
        try {
          window.localStorage.setItem(STORAGE_KEY, String(final));
        } catch {
          // Not worth surfacing: the split still works for this session.
        }
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [width, available, clamp],
  );

  const reset = useCallback(() => {
    if (available === null) return;
    const standard = clamp(available * DEFAULT_TABLE_SHARE, available);
    setWidth(standard);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(standard));
    } catch {
      // Ignored, as above.
    }
  }, [available, clamp]);

  return {
    containerRef,
    width,
    density: densityForWidth(width ?? fullTableWidth(counts), counts),
    onPointerDown,
    dragging,
    reset,
  };
}
