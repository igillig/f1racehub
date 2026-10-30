// Shared state helpers for mqtt-client.js, live-polling.js and replay.js.

/** Ensure a timing entry exists for a driver. Returns the entry. */
export function ensureTimingEntry(state, driverNum) {
  if (!state.timing) state.timing = {};
  if (!state.timing[driverNum]) {
    state.timing[driverNum] = {
      driver_number: parseInt(driverNum, 10) || driverNum,
      position: null,
      gap_to_leader: null,
      interval: null,
      last_lap: null,
      best_lap: null,
      last_lap_is_pb: false,
      lap_number: 0,
      sector_1: null,
      sector_2: null,
      sector_3: null,
      best_sector_1: null,
      best_sector_2: null,
      best_sector_3: null,
      segments_1: [],
      segments_2: [],
      segments_3: [],
      compound: "UNKNOWN",
      tyre_age: 0,
      stint_number: 0,
      in_pit: false,
      pit_count: 0,
      retired: false,
      knocked_out: false,
      is_pit_out_lap: false,
    };
  }
  return state.timing[driverNum];
}

/** Completed non-pit-out laps only. True when it set a personal best. */
export function updateBestLap(entry, lapDuration, isPitOutLap) {
  if (!lapDuration || isPitOutLap) return false;
  if (!entry.best_lap || lapDuration < entry.best_lap) {
    entry.best_lap = lapDuration;
    return true;
  }
  return false;
}

/** Whether a driver is inside a pit lane time window. */
export function getPitWindowStatus(pitDate, laneDuration) {
  if (!pitDate || !laneDuration) return { in_pit: false, remaining_ms: 0 };
  const entryMs = new Date(pitDate).getTime();
  const exitMs = entryMs + laneDuration * 1000;
  const now = Date.now();
  if (now >= entryMs && now <= exitMs) {
    return { in_pit: true, remaining_ms: exitMs - now };
  }
  return { in_pit: false, remaining_ms: 0 };
}

/** Race control flag string to track_status, or null if it maps to neither. */
export function flagToTrackStatus(flag) {
  const f = (flag || "").toUpperCase();
  // CLEAR means a localised yellow was lifted — back to green.
  if (f === "GREEN" || f === "CLEAR") return "GREEN";
  if (f === "YELLOW" || f === "DOUBLE YELLOW") return "YELLOW";
  if (f === "RED") return "RED";
  if (f === "CHEQUERED") return "CHEQUERED";
  return null;
}

/** "SC", "VSC" or null, from a race control message. */
export function detectSafetyCar(message) {
  if (!message) return null;
  if (message.includes("VIRTUAL SAFETY CAR")) {
    if (message.includes("ENDING")) return null;
    return "VSC";
  }
  if (message.includes("SAFETY CAR")) {
    if (message.includes("ENDING")) return null;
    return "SC";
  }
  return null;
}

/**
 * Queue a GPS fix for the next SSE flush. `state.location[num]` keeps only the
 * newest fix, and sources publish faster than the proxy flushes (~3.7 Hz vs
 * 100 ms), so ~45% of the stream was overwritten before leaving the proxy and
 * the map interpolated across ~800 ms holes.
 *
 * server.js drains these after every flush; the cap bounds them when no client
 * is connected.
 */
const LOCATION_QUEUE_MAX = 12; // ~3 s at 3.7 Hz

export function queueLocationFix(state, num, x, y, t) {
  if (!state.location_fixes) state.location_fixes = {};
  let queue = state.location_fixes[num];
  if (!queue) {
    queue = [];
    state.location_fixes[num] = queue;
  }
  queue.push({ x, y, t });
  if (queue.length > LOCATION_QUEUE_MAX) {
    queue.splice(0, queue.length - LOCATION_QUEUE_MAX);
  }
}

/**
 * Merge an OpenF1 minisector array into state rather than replacing it.
 *
 * OpenF1 sends `null` for the first minisector of sector 1 (188 of 316 rows in
 * the archived Singapore sprint; never at any other index). Copying wholesale
 * blanked that bar permanently, since the official feed never resets segment 0
 * of sector 1 at the line. A hole means "no news", not "not driven".
 */
export function mergeSegments(existing, incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) return existing;
  const merged = Array.isArray(existing) ? existing.slice() : [];
  merged.length = incoming.length;
  for (let i = 0; i < incoming.length; i++) {
    const value = incoming[i];
    if (value == null) {
      if (merged[i] == null) merged[i] = 0;
    } else {
      merged[i] = value;
    }
  }
  return merged;
}

/**
 * Reset sector 1 for a new lap, keeping segment 0: the car is already inside it
 * at the line, and the feed never sends a Status 0 reset for that one. Same
 * length out, so the bar count does not flicker.
 */
export function keepFirstSegment(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const reset = new Array(segments.length).fill(0);
  if (segments[0] != null) reset[0] = segments[0];
  return reset;
}
