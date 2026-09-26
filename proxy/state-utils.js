/**
 * Shared state utilities for proxy data sources.
 * Used by mqtt-client.js, live-polling.js, and replay.js.
 */

/**
 * Ensure a timing entry exists for a driver. Returns the entry.
 */
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

/**
 * Update best lap for a driver. Only counts completed non-pit-out laps.
 * Returns true if this lap set a new personal best.
 */
export function updateBestLap(entry, lapDuration, isPitOutLap) {
  if (!lapDuration || isPitOutLap) return false;
  if (!entry.best_lap || lapDuration < entry.best_lap) {
    entry.best_lap = lapDuration;
    return true;
  }
  return false;
}

/**
 * Check if a driver is currently within a pit lane time window.
 * Returns { in_pit, remaining_ms }.
 */
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

/**
 * Derive track_status flag from a race control flag string.
 * Returns "GREEN", "YELLOW", "RED", "CHEQUERED", or null.
 */
export function flagToTrackStatus(flag) {
  const f = (flag || "").toUpperCase();
  // CLEAR means a localised yellow was lifted — track is back to green
  if (f === "GREEN" || f === "CLEAR") return "GREEN";
  if (f === "YELLOW" || f === "DOUBLE YELLOW") return "YELLOW";
  if (f === "RED") return "RED";
  if (f === "CHEQUERED") return "CHEQUERED";
  return null;
}

/**
 * Detect safety car status from a race control message string.
 * Returns "SC", "VSC", or null.
 */
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
 * Queue a GPS fix for delivery on the next SSE flush.
 *
 * `state.location[num]` is a single slot that keeps only the newest fix, and
 * every source publishes faster than the proxy flushes (OpenF1 is ~3.7 Hz per
 * driver against a 100 ms flush), so roughly 45% of the GPS stream used to be
 * overwritten before it ever left the proxy. The track map was then left with
 * ~800 ms holes to interpolate across and cars moved in stop-and-go.
 *
 * server.js drains these queues after every flush. The cap bounds them for the
 * case where no client is connected and nothing is draining.
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
