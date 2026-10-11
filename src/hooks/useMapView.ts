"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * How the track map is drawn. Persisted per browser: someone who set the map
 * up the way they like should not have to redo it every session.
 */
export interface MapView {
  /** Isometric projection on, or the plain top-down map. */
  iso: boolean;
  /** How far the ground is laid away from the viewer, in degrees. */
  tilt: number;
  /**
   * Extra rotation on top of the circuit's own orientation. Zero by default —
   * the layout already arrives rotated (mapData.rotation + ROTATION_FIX) and
   * turning it further stops it matching what people see on TV.
   */
  spin: number;
  /**
   * Thickness of the track slab, as a percentage of the track width. Relative
   * rather than absolute so widening the ribbon cannot silently flatten the
   * relief — the two always move together.
   */
  depthPct: number;
  /** How far the cast shadow falls, and how soft it is. */
  shadow: number;
  /** Outer width of the track ribbon. Everything else scales from it. */
  width: number;
  /**
   * How far the panel behind the map is lifted off the page's near-black,
   * 0 to 100. The slab's flank and the cast shadow both need something to
   * darken against, and how much is taste.
   */
  backdrop: number;
}

export const DEFAULT_MAP_VIEW: MapView = {
  iso: true,
  tilt: 58,
  spin: 34,
  depthPct: 42,
  shadow: 150,
  width: 120,
  backdrop: 35,
};

/** Slider bounds, also used to sanitise whatever comes back from storage. */
export const MAP_VIEW_LIMITS = {
  tilt: [0, 75],
  spin: [-180, 180],
  depthPct: [0, 150],
  shadow: [0, 400],
  width: [40, 320],
  backdrop: [0, 100],
} as const satisfies Record<string, readonly [number, number]>;

const STORAGE_KEY = "f1-dashboard-map-view";

/**
 * A stored view is untrusted input: it can be from an older shape of this
 * object, or hand-edited. A NaN reaching the viewBox blanks the whole map, so
 * every field is checked rather than spread in.
 */
function sanitise(raw: unknown): Partial<MapView> {
  if (!raw || typeof raw !== "object") return {};
  const stored = raw as Record<string, unknown>;
  const clean: Partial<MapView> = {};

  if (typeof stored.iso === "boolean") clean.iso = stored.iso;

  for (const [key, [min, max]] of Object.entries(MAP_VIEW_LIMITS)) {
    const value = stored[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    clean[key as keyof typeof MAP_VIEW_LIMITS] = Math.min(
      Math.max(value, min),
      max,
    );
  }

  return clean;
}

export function useMapView() {
  // Always the default on the first render so the server and the client agree;
  // the stored view is applied right after mount.
  const [view, setView] = useState<MapView>(DEFAULT_MAP_VIEW);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      setView((current) => ({ ...current, ...sanitise(JSON.parse(raw)) }));
    } catch {
      // Private mode, blocked site data, or unparseable. The default is fine.
    }
  }, []);

  const update = useCallback((patch: Partial<MapView>) => {
    setView((current) => {
      const next = { ...current, ...patch };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Not worth surfacing: the view still works for this session.
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setView(DEFAULT_MAP_VIEW);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignored, as above.
    }
  }, []);

  return { view, update, reset };
}
