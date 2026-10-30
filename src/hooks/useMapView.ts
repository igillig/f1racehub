"use client";

import { useCallback, useEffect, useState } from "react";

/** How the track map is drawn. Persisted per browser. */
export interface MapView {
  /** Isometric projection on, or the plain top-down map. */
  iso: boolean;
  /** How far the ground is laid away from the viewer, in degrees. */
  tilt: number;
  /** Extra rotation on top of the circuit's own (mapData.rotation +
   *  ROTATION_FIX), which already matches what people see on TV. */
  spin: number;
  /** Slab thickness as a percentage of track width, so widening the ribbon
   *  cannot silently flatten the relief. */
  depthPct: number;
  /** How far the cast shadow falls, and how soft it is. */
  shadow: number;
  /** Outer width of the track ribbon. Everything else scales from it. */
  width: number;
  /** 0–100: how far the panel behind the map is lifted off near-black, so the
   *  slab flank and cast shadow have something to darken against. */
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

/** Stored views are untrusted (older shape, or hand-edited) and a NaN reaching
 *  the viewBox blanks the map, so every field is checked rather than spread. */
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
  // Default on the first render so server and client agree.
  const [view, setView] = useState<MapView>(DEFAULT_MAP_VIEW);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      setView((current) => ({ ...current, ...sanitise(JSON.parse(raw)) }));
    } catch {
      // Private mode, blocked site data, or unparseable.
    }
  }, []);

  const update = useCallback((patch: Partial<MapView>) => {
    setView((current) => {
      const next = { ...current, ...patch };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // The view still works for this session.
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
