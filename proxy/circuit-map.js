/**
 * Circuit outline fallback — builds a track map from real car GPS when the
 * frontend's outline provider (api.multiviewer.app) doesn't know the circuit
 * (new venues: Madring/circuit_key 153 in 2026).
 *
 * Source: one clean, completed lap of the fastest driver so far. Location
 * samples come from the SQLite archive when the session is archived, else from
 * OpenF1 REST (auth-aware — during a live session the REST API is only open to
 * paid accounts). The result is shaped like multiviewer's response so
 * TrackMap.tsx consumes it unchanged (x[], y[], rotation, corners), and is
 * cached on disk next to the SQLite DB so it survives restarts.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchJSON, API_BASE } from "./openf1-rest.js";
import { getTopicRows, getTopicWindow, isComplete } from "./session-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.dirname(
  process.env.DB_PATH || path.join(__dirname, "data", "f1-sessions.db"),
);
const CIRCUITS_DIR = path.join(DATA_DIR, "circuits");

// Minimum GPS samples for a usable outline (a lap at ~3.7 Hz is 250-400)
const MIN_POINTS = 150;
// A lap must close on itself: start/end distance as fraction of bbox diagonal
const MAX_CLOSURE_RATIO = 0.08;
// After a failed build (no completed laps yet, REST locked) retry after this
const NEGATIVE_CACHE_MS = 60 * 1000;

// Raw GPS comes out roughly north-up; multiviewer picks a per-circuit rotation
// so the map matches the official layout. Degrees, applied on top of
// TrackMap's ROTATION_FIX: 270 = quarter turn clockwise on screen.
const ROTATION_BY_CIRCUIT = {
  153: 270, // Madring (Madrid)
};

const memCache = new Map(); // circuitKey -> map data
const inFlight = new Map(); // circuitKey -> Promise
const lastFailure = new Map(); // circuitKey -> epoch ms

function cachePath(circuitKey) {
  return path.join(CIRCUITS_DIR, `${circuitKey}.json`);
}

function loadFromDisk(circuitKey) {
  try {
    const raw = fs.readFileSync(cachePath(circuitKey), "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data.x) && data.x.length >= MIN_POINTS) return data;
  } catch {
    // no cache
  }
  return null;
}

function saveToDisk(circuitKey, data) {
  try {
    fs.mkdirSync(CIRCUITS_DIR, { recursive: true });
    fs.writeFileSync(cachePath(circuitKey), JSON.stringify(data));
  } catch (err) {
    console.warn(`[circuit-map] Could not cache circuit ${circuitKey}:`, err.message);
  }
}

// Candidate laps: completed, timed, not an out-lap; fastest first. Fast laps
// are the cleanest racing line and never wander through the pit lane.
function pickCandidateLaps(laps) {
  const now = Date.now();
  return laps
    .filter(
      (l) =>
        l.lap_duration > 0 &&
        !l.is_pit_out_lap &&
        l.date_start &&
        new Date(l.date_start).getTime() + l.lap_duration * 1000 + 5000 < now,
    )
    .sort((a, b) => a.lap_duration - b.lap_duration)
    .slice(0, 6);
}

// Turn raw location rows into an ordered outline, or null if they don't
// describe a closed loop (partial coverage, pit lane, GPS dropout).
function buildOutline(rows) {
  const pts = rows
    .filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && (r.x !== 0 || r.y !== 0))
    .map((r) => ({ t: new Date(r.date).getTime(), x: r.x, y: r.y }))
    .sort((a, b) => a.t - b.t);

  const x = [];
  const y = [];
  for (const p of pts) {
    const n = x.length;
    if (n > 0 && x[n - 1] === p.x && y[n - 1] === p.y) continue; // stationary
    x.push(p.x);
    y.push(p.y);
  }
  if (x.length < MIN_POINTS) return null;

  const diag = Math.hypot(
    Math.max(...x) - Math.min(...x),
    Math.max(...y) - Math.min(...y),
  );
  if (diag <= 0) return null;
  const closure = Math.hypot(x[0] - x[x.length - 1], y[0] - y[y.length - 1]);
  if (closure / diag > MAX_CLOSURE_RATIO) return null;

  return { x, y };
}

async function loadLaps(sessionKey) {
  if (isComplete(sessionKey)) {
    const rows = getTopicRows(sessionKey, "laps");
    if (rows.length) return rows;
  }
  const data = await fetchJSON(
    `${API_BASE}/laps?session_key=${sessionKey}`,
    2,
    "[circuit-map]",
    null,
  );
  return Array.isArray(data) ? data : [];
}

async function loadLocation(sessionKey, driverNumber, start, end) {
  if (isComplete(sessionKey)) {
    const rows = getTopicWindow(sessionKey, "location", start, end).filter(
      (r) => String(r.driver_number) === String(driverNumber),
    );
    if (rows.length >= MIN_POINTS) return rows;
  }
  const data = await fetchJSON(
    `${API_BASE}/location?session_key=${sessionKey}&driver_number=${driverNumber}&date>=${start.toISOString()}&date<=${end.toISOString()}`,
    2,
    "[circuit-map]",
    null,
  );
  return Array.isArray(data) ? data : [];
}

async function build(circuitKey, session) {
  const sessionKey = session.session_key;
  const laps = await loadLaps(sessionKey);
  const candidates = pickCandidateLaps(laps);
  if (!candidates.length) {
    console.log(
      `[circuit-map] Circuit ${circuitKey}: no completed timed laps yet in session ${sessionKey} (${laps.length} laps)`,
    );
    return null;
  }

  for (const lap of candidates) {
    const start = new Date(lap.date_start);
    const end = new Date(start.getTime() + lap.lap_duration * 1000);
    const rows = await loadLocation(sessionKey, lap.driver_number, start, end);
    const outline = buildOutline(rows);
    if (!outline) {
      console.log(
        `[circuit-map] Circuit ${circuitKey}: lap ${lap.lap_number} of #${lap.driver_number} unusable (${rows.length} samples)`,
      );
      continue;
    }
    console.log(
      `[circuit-map] Circuit ${circuitKey} (${session.circuit_short_name}) built from lap ${lap.lap_number} of #${lap.driver_number}, ${outline.x.length} points`,
    );
    // rotation 0 + TrackMap's ROTATION_FIX flips y so north stays up, like
    // the multiviewer maps (same coordinate system as the F1 position feed).
    return {
      ...outline,
      rotation: 0,
      corners: [],
      source: "openf1-gps",
      circuitKey: Number(circuitKey),
      circuitName: session.circuit_short_name,
      sessionKey,
      driverNumber: lap.driver_number,
      lapNumber: lap.lap_number,
      generatedAt: new Date().toISOString(),
    };
  }
  return null;
}

// Rotation overrides are applied at serve time so tweaking the table doesn't
// require regenerating cached outlines.
function withRotation(key, data) {
  const rotation = ROTATION_BY_CIRCUIT[key];
  return rotation === undefined ? data : { ...data, rotation };
}

/**
 * Outline for a circuit, or null if it can't be built yet (no completed lap,
 * REST unavailable). `session` is the current proxy state's session object.
 */
export async function getCircuitMap(circuitKey, session) {
  const key = String(circuitKey);
  if (memCache.has(key)) return withRotation(key, memCache.get(key));

  const cached = loadFromDisk(key);
  if (cached) {
    memCache.set(key, cached);
    return withRotation(key, cached);
  }

  if (!session?.session_key) return null;
  if (String(session.circuit_key) !== key) return null;

  const failedAt = lastFailure.get(key) || 0;
  if (Date.now() - failedAt < NEGATIVE_CACHE_MS) return null;

  if (inFlight.has(key)) return inFlight.get(key);

  const p = build(key, session)
    .then((data) => {
      if (data) {
        memCache.set(key, data);
        saveToDisk(key, data);
        lastFailure.delete(key);
        return withRotation(key, data);
      }
      lastFailure.set(key, Date.now());
      return null;
    })
    .catch((err) => {
      console.warn(`[circuit-map] Build failed for circuit ${key}:`, err.message);
      lastFailure.set(key, Date.now());
      return null;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
