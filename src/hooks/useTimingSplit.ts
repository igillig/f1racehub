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

/** A share, not the table's full width: that balance holds on a laptop and a
 *  wide monitor alike, and the surplus goes into the minisector columns. */
const DEFAULT_TABLE_SHARE = 0.6;

const STORAGE_KEY = "f1-dashboard-timing-width";

interface Split {
  /**
   * Callback ref, not an object ref: the dashboard shows a loading screen until
   * the first SSE frame, so the row does not exist on mount and a one-shot
   * effect would observe nothing.
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
 * The draggable split between the timing table and the map. Not CSS: the width
 * is clamped against two moving targets (the table's minimum, which follows the
 * circuit's minisector count, and the map's) and the density level derives from
 * it. Persisted per browser. Desktop only — mobile stacks the two.
 */
export function useTimingSplit(counts: SectorCounts): Split {
  const [width, setWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  // Client-only: reading storage or the container during render would not
  // match what the server rendered.
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
      // The map's minimum wins on a narrow window: the table can scroll, the
      // map cannot.
      const max = Math.max(min, containerWidth - MIN_MAP_WIDTH);
      return Math.min(Math.max(value, min), max);
    },
    [counts],
  );

  // First measurement: the stored width, else the default share.
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
      // Private mode, or site data blocked.
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

      // One update per frame: pointermove outruns paint, and each update
      // re-renders twenty rows on top of what the SSE stream is pushing.
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
          // The split still works for this session.
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
