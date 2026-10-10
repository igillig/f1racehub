/**
 * F1 Race Replay Module
 *
 * Replays real session data simulating how a live session would work.
 * Preferred source: the local SQLite archive (session-store.js) — no rate
 * limits, works offline. Falls back to incremental OpenF1 REST polling when
 * the session isn't archived and can't be downloaded.
 *
 * Session priority: latest finished session from OpenF1 > REPLAY_SESSION_KEY
 * env var > newest archived session in SQLite > Baku 2024 (fallback).
 */

import { hasMQTTCredentials } from "./mqtt-client.js";
import { API_BASE, fetchJSON as fetchJSONShared, sleep } from "./openf1-rest.js";
import * as store from "./session-store.js";
import {
  downloadSessionByKey,
  findLatestFinishedSession,
} from "./session-downloader.js";
import {
  ensureTimingEntry,
  updateBestLap,
  flagToTrackStatus,
  detectSafetyCar,
} from "./state-utils.js";

// Session key — resolved at startup: latest race from OpenF1 > env var override > Baku 2024
let SESSION_KEY = 0;
const ENV_SESSION_KEY = parseInt(process.env.REPLAY_SESSION_KEY || "0");
let CIRCUIT_KEY = null; // Loaded from API at startup
// Race distance of the session being replayed. Zero means "unknown": the
// frontend hides the lap counter rather than show a made-up denominator.
// Resolved per session in fetchSessionInfo().
let TOTAL_LAPS = 0;

// Replay speed multiplier (1x = real-time, 10x = 10 seconds per real second)
const REPLAY_SPEED = 1;

// 6 requests per cycle (pos, intervals, laps, location, race_control, team_radio).
// Uses recursive setTimeout (not setInterval) so cycles never overlap.
// Paid limit: 60 req/min = 1 req/s sustained. To avoid burst 429s we space
//   requests at 800ms each: 6×0.8s = 4.8s for requests + 6s gap = ~10.8s/cycle → ~33 req/min
// Free limit: 30 req/min = 0.5 req/s. 6×1.8s = 10.8s + 4s gap = ~15s/cycle → ~24 req/min
const PAID_POLL_INTERVAL_MS = 6000;
const FREE_POLL_INTERVAL_MS = 4000;
const PAID_REQUEST_DELAY_MS = 800;
const FREE_REQUEST_DELAY_MS = 1800;

// DB mode: 1s cadence — no rate limits when serving from SQLite
const DB_POLL_INTERVAL_MS = 1000;

// Set at startReplay() based on source (SQLite vs REST) and credentials
let POLL_INTERVAL_MS = FREE_POLL_INTERVAL_MS;
let REQUEST_DELAY_MS = FREE_REQUEST_DELAY_MS;
let POLL_WINDOW_SECONDS = 8 * REPLAY_SPEED;

// True when the current replay is served from the local SQLite archive
let dbMode = false;

// Epoch ms of the last data point — when the replay clock passes this (plus
// a buffer), the replay restarts from the beginning (continuous loop).
let replayEndMs = 0;
const REPLAY_END_BUFFER_MS = 60_000;

// Bumped on every startReplay so a stale poll chain from a previous run
// (e.g. before a loop restart) stops scheduling itself.
let replayGeneration = 0;

// State
let replayInterval = null;
let broadcastFn = null;
let currentStateRef = null;
let replayStarted = false;
let sessionData = null;
let driversData = [];
let raceStartTime = null; // Actual race start time (UTC)
let replayStartRealTime = null; // When we started the replay (local time)
let lastPollTime = null; // Last race time we polled up to

// Pit stop windows loaded at startup: { "driverNum": [{ entryMs, exitMs }] }
const pitData = {};

// Stint data loaded at startup: { "driverNum": [{ compound, lap_start, lap_end, tyre_age_at_start }] }
const stintsData = {};

// Starting grid data — kept at module level so seekReplay can rebuild state without a re-fetch
let startingGridData = {};

// Fetch with [Replay]-tagged logging (shared auth-aware implementation)
function fetchJSON(url, retries = 4) {
  return fetchJSONShared(url, retries, "[Replay]");
}

async function resolveSessionKey() {
  // 1. Latest finished session (any type) from OpenF1
  try {
    const latest = await findLatestFinishedSession();
    if (latest) {
      SESSION_KEY = latest.session_key;
      console.log(
        `[Replay] Latest finished session: ${latest.session_name} ${latest.location} (session_key ${SESSION_KEY})`,
      );
      return;
    }
    console.warn(`[Replay] No finished sessions found from OpenF1`);
  } catch (err) {
    console.warn(`[Replay] Could not resolve latest session: ${err.message}`);
  }
  // 2. Fall back to env var if set
  if (ENV_SESSION_KEY > 0) {
    SESSION_KEY = ENV_SESSION_KEY;
    console.log(`[Replay] Using session from env var: ${SESSION_KEY}`);
    return;
  }
  // 3. Newest session already archived in SQLite (works fully offline)
  const stored = store.newestCompleteSession();
  if (stored) {
    SESSION_KEY = stored.session_key;
    console.log(
      `[Replay] Using newest archived session: ${stored.payload.session_name} ${stored.payload.location} (${SESSION_KEY})`,
    );
    return;
  }
  // 4. Hardcoded fallback: Baku 2024
  SESSION_KEY = 9598;
  console.log(`[Replay] Falling back to default session ${SESSION_KEY}`);
}

async function fetchSessionInfo() {
  let session;
  let drivers;
  if (dbMode) {
    const meta = store.getSessionMeta(SESSION_KEY);
    if (!meta) throw new Error(`Session ${SESSION_KEY} not in local archive`);
    session = meta.payload;
    drivers = store.getTopicRows(SESSION_KEY, "drivers");
  } else {
    console.log(`[Replay] Fetching session ${SESSION_KEY} from OpenF1...`);
    const sessions = await fetchJSON(
      `${API_BASE}/sessions?session_key=${SESSION_KEY}`,
    );
    if (!sessions || sessions.length === 0)
      throw new Error(`Session ${SESSION_KEY} not found in OpenF1`);
    session = sessions[0];
    await sleep(REQUEST_DELAY_MS);
    drivers = await fetchJSON(`${API_BASE}/drivers?session_key=${SESSION_KEY}`);
  }
  CIRCUIT_KEY = session.circuit_key;
  console.log(
    `[Replay] Session: ${session.location} — ${session.session_name} (circuit_key: ${CIRCUIT_KEY}, source: ${dbMode ? "sqlite" : "rest"})`,
  );
  console.log(`[Replay] Drivers: ${drivers.length}`);

  // Determine when the replay data runs out, to loop back to the start.
  // DB mode: last actual data point across the main topics (more accurate
  // than date_end, which is the scheduled end). REST mode: date_end.
  if (dbMode) {
    let maxTs = 0;
    for (const topic of ["laps", "location", "position", "intervals"]) {
      const bounds = store.getTopicTimeBounds(SESSION_KEY, topic);
      if (bounds?.max && bounds.max > maxTs) maxTs = bounds.max;
    }
    replayEndMs = maxTs || (session.date_end ? Date.parse(session.date_end) : 0);
  } else {
    replayEndMs = session.date_end ? Date.parse(session.date_end) : 0;
  }
  if (replayEndMs) {
    console.log(
      `[Replay] Data ends at ${new Date(replayEndMs).toISOString()} — will loop back to start`,
    );
  }

  TOTAL_LAPS = await resolveTotalLaps(session);
  console.log(
    TOTAL_LAPS
      ? `[Replay] Race distance: ${TOTAL_LAPS} laps`
      : `[Replay] No race distance for a ${session.session_type} session — lap counter hidden`,
  );

  return {
    session: {
      session_key: SESSION_KEY,
      meeting_key: session.meeting_key,
      session_name: session.session_name,
      session_type: session.session_type,
      location: session.location,
      circuit_short_name: session.circuit_short_name || session.location,
      circuit_key: CIRCUIT_KEY,
      country_name: session.country_name,
      country_code: session.country_code,
      date_start: session.date_start,
      date_end: null,
      meeting_name: session.meeting_name || session.location,
    },
    drivers,
  };
}

async function resolveTotalLaps(session) {
  if (session.session_type !== "Race") return 0;

  if (dbMode) {
    const laps = store.getTopicRows(SESSION_KEY, "laps");
    return laps.reduce((max, lap) => Math.max(max, lap.lap_number || 0), 0);
  }

  // REST fallback: the classification already holds the winner's lap count,
  // which is one request instead of the session's whole lap set.
  await sleep(REQUEST_DELAY_MS);
  const result = await fetchJSON(
    `${API_BASE}/session_result?session_key=${SESSION_KEY}`,
  );
  return result.reduce((max, r) => Math.max(max, r.number_of_laps || 0), 0);
}

async function fetchStartingGrid() {
  const grid = dbMode
    ? store.getTopicRows(SESSION_KEY, "starting_grid")
    : await fetchJSON(`${API_BASE}/starting_grid?session_key=${SESSION_KEY}`);
  const result = {};
  grid.forEach((g) => {
    if (g.driver_number && g.position)
      result[String(g.driver_number)] = g.position;
  });
  console.log(`[Replay] Starting grid: ${Object.keys(result).length} drivers`);
  return result;
}

async function findRaceStart(sessionDateStart) {
  // Use the earliest lap 1 date_start across all drivers — that's when lights went out.
  // Falls back to session date_start if no lap data yet.
  const laps = dbMode
    ? store
        .getTopicRows(SESSION_KEY, "laps")
        .filter((l) => l.lap_number === 1)
    : await fetchJSON(
        `${API_BASE}/laps?session_key=${SESSION_KEY}&lap_number=1`,
      );
  if (laps && laps.length > 0) {
    const dates = laps
      .map((l) => l.date_start && new Date(l.date_start).getTime())
      .filter(Boolean);
    if (dates.length > 0) {
      const start = new Date(Math.min(...dates));
      console.log(
        `[Replay] Race start (from lap 1 data): ${start.toISOString()}`,
      );
      return start;
    }
  }
  console.log(
    `[Replay] Race start (fallback to session date_start): ${sessionDateStart}`,
  );
  return new Date(sessionDateStart);
}

async function fetchPitData() {
  console.log(`[Replay] Loading pit stop data...`);
  const pits = dbMode
    ? store.getTopicRows(SESSION_KEY, "pit")
    : await fetchJSON(`${API_BASE}/pit?session_key=${SESSION_KEY}`);
  // Clear before populating (in case of restart)
  Object.keys(pitData).forEach((k) => delete pitData[k]);
  pits.forEach((p) => {
    if (!p.date || !p.lane_duration) return;
    const num = String(p.driver_number);
    if (!pitData[num]) pitData[num] = [];
    pitData[num].push({
      entryMs: new Date(p.date).getTime(),
      exitMs: new Date(p.date).getTime() + p.lane_duration * 1000,
    });
  });
  console.log(
    `[Replay] Loaded ${pits.length} pit stops across ${Object.keys(pitData).length} drivers`,
  );
}

function isDriverInPit(driverNum, currentTime) {
  const stops = pitData[driverNum] || [];
  const now = currentTime.getTime();
  return stops.some((s) => now >= s.entryMs && now <= s.exitMs);
}

// ── Practice/Qualifying in-pit detection ─────────────────────────────────────
// /v1/pit windows are only reliable for races (short stops). In practice the
// data is inconsistent: lane_duration is often null and timed laps fall inside
// supposed pit windows. Instead: a driver is on track iff the replay clock is
// inside one of their laps (laps without a duration — e.g. in-laps that end in
// the pits — count as in-progress for at most MAX_LAP_MS).
const LAP_GRACE_MS = 20_000;
const MAX_LAP_MS = 3 * 60_000;

// { [driverNum]: { lastStartMs, lastEndMs } } — fed by processData's laps loop
const lapActivity = {};

function isDriverOnTrackByLaps(driverNum, nowMs) {
  const act = lapActivity[driverNum];
  if (!act) return false; // no laps yet — still in the garage
  // Inside (or just past) a completed lap
  if (act.lastEndMs && nowMs <= act.lastEndMs + LAP_GRACE_MS) return true;
  // Lap in progress without a recorded duration
  if (act.lastStartMs > act.lastEndMs && nowMs >= act.lastStartMs) {
    return nowMs - act.lastStartMs <= MAX_LAP_MS;
  }
  return false;
}

async function fetchStintData() {
  console.log(`[Replay] Loading stint/tire data...`);
  const stints = dbMode
    ? store.getTopicRows(SESSION_KEY, "stints")
    : await fetchJSON(`${API_BASE}/stints?session_key=${SESSION_KEY}`);
  Object.keys(stintsData).forEach((k) => delete stintsData[k]);
  stints.forEach((s) => {
    const num = String(s.driver_number);
    if (!stintsData[num]) stintsData[num] = [];
    stintsData[num].push({
      compound: s.compound ? s.compound.toUpperCase() : "UNKNOWN",
      lap_start: s.lap_start || 1,
      lap_end: s.lap_end || null,
      tyre_age_at_start: s.tyre_age_at_start || 0,
      stint_number: s.stint_number || 1,
    });
  });
  console.log(
    `[Replay] Loaded stints for ${Object.keys(stintsData).length} drivers`,
  );
}

// All weather records for the session, sorted by date ascending
let weatherRecords = [];

async function fetchAllWeather() {
  console.log(`[Replay] Loading weather data...`);
  const records = dbMode
    ? store.getTopicRows(SESSION_KEY, "weather")
    : await fetchJSON(`${API_BASE}/weather?session_key=${SESSION_KEY}`);
  weatherRecords = (records || []).sort(
    (a, b) => new Date(a.date) - new Date(b.date),
  );
  if (weatherRecords.length > 0) {
    const w = weatherRecords[0];
    console.log(
      `[Replay] Weather: ${weatherRecords.length} records. Start: ${w.air_temperature}°C air, ${w.track_temperature}°C track`,
    );
  }
}

function updateWeather(state, currentRaceTime) {
  if (weatherRecords.length === 0) return;
  const now = currentRaceTime.getTime();
  // Find the latest record at or before the current race time
  let latest = weatherRecords[0];
  for (const w of weatherRecords) {
    if (new Date(w.date).getTime() <= now) latest = w;
    else break;
  }
  state.weather = {
    air_temperature: latest.air_temperature,
    track_temperature: latest.track_temperature,
    humidity: latest.humidity,
    pressure: latest.pressure,
    rainfall: latest.rainfall,
    wind_speed: latest.wind_speed,
    wind_direction: latest.wind_direction,
  };
}

function updateActiveStints(state) {
  Object.keys(state.timing).forEach((num) => {
    const driverStints = stintsData[num];
    if (!driverStints || driverStints.length === 0) return;
    const currentLap = state.timing[num].lap_number || 1;
    const active = driverStints.find(
      (s) =>
        currentLap >= s.lap_start && (!s.lap_end || currentLap <= s.lap_end),
    );
    if (active) {
      state.timing[num].compound = active.compound;
      state.timing[num].tyre_age =
        Math.max(0, currentLap - active.lap_start) + active.tyre_age_at_start;
    }
  });
}

// Fetch incremental data for a time window.
// SQLite when archived (no rate limits); sequential REST otherwise.
async function fetchTimeWindow(sessionKey, startTime, endTime) {
  if (dbMode) {
    return {
      positions: store.getTopicWindow(sessionKey, "position", startTime, endTime),
      intervals: store.getTopicWindow(sessionKey, "intervals", startTime, endTime),
      laps: store.getTopicWindow(sessionKey, "laps", startTime, endTime),
      locations: store.getTopicWindow(sessionKey, "location", startTime, endTime),
      raceControl: store.getTopicWindow(sessionKey, "race_control", startTime, endTime),
      teamRadio: store.getTopicWindow(sessionKey, "team_radio", startTime, endTime),
    };
  }

  const s = startTime.toISOString();
  const e = endTime.toISOString();
  const delay = () => sleep(REQUEST_DELAY_MS);

  const positions = await fetchJSON(
    `${API_BASE}/position?session_key=${sessionKey}&date>=${s}&date<${e}`,
  );
  await delay();
  const intervals = await fetchJSON(
    `${API_BASE}/intervals?session_key=${sessionKey}&date>=${s}&date<${e}`,
  );
  await delay();
  const laps = await fetchJSON(
    `${API_BASE}/laps?session_key=${sessionKey}&date_start>=${s}&date_start<${e}`,
  );
  await delay();
  const locations = await fetchJSON(
    `${API_BASE}/location?session_key=${sessionKey}&date>=${s}&date<${e}`,
  );
  await delay();
  const raceControl = await fetchJSON(
    `${API_BASE}/race_control?session_key=${sessionKey}&date>=${s}&date<${e}`,
  );
  await delay();
  const teamRadio = await fetchJSON(
    `${API_BASE}/team_radio?session_key=${sessionKey}&date>=${s}&date<${e}`,
  );

  return { positions, intervals, laps, locations, raceControl, teamRadio };
}

// Build initial state structure
function buildInitialState(session, drivers, startingGrid) {
  const state = {
    session: {
      session_key: SESSION_KEY,
      session_name: session.session_name || session.session_type || "Race",
      session_type: session.session_type || "Race",
      circuit_key: session.circuit_key,
      circuit_short_name: session.circuit_short_name || session.location,
      country_name: session.country_name,
      country_code: session.country_code,
      date_start: session.date_start,
      date_end: null,
      location: session.location,
      meeting_name: session.meeting_name || session.location,
    },
    drivers: {},
    timing: {},
    location: {},
    lap_count: { current: 1, total: TOTAL_LAPS },
    track_status: { flag: "GREEN" },
    weather: null,
    race_control_messages: [],
    team_radio: [],
    clock: { remaining: "0:00:00", utc: new Date().toISOString() },
  };

  drivers.forEach((driver) => {
    const num = String(driver.driver_number);
    state.drivers[num] = {
      driver_number: driver.driver_number,
      name_acronym: driver.name_acronym,
      full_name: driver.full_name,
      team_name: driver.team_name,
      team_colour: driver.team_colour || "FFFFFF",
    };
    const entry = ensureTimingEntry(state, num);
    entry.position = startingGrid[num] || Object.keys(state.drivers).length;
  });

  return state;
}

// Process fetched data and update state
function processData(data, state) {
  const { positions, intervals, laps, locations, raceControl, teamRadio } =
    data;

  positions.forEach((pos) => {
    const num = String(pos.driver_number);
    const entry = ensureTimingEntry(state, num);
    entry.position = pos.position;
  });

  intervals.forEach((int) => {
    const num = String(int.driver_number);
    const entry = ensureTimingEntry(state, num);
    const gap = parseFloat(int.gap_to_leader);
    const isLeader = int.gap_to_leader === 0;
    entry.gap_to_leader = (int.gap_to_leader === 0 || int.gap_to_leader == null) ? null : !isNaN(gap) ? gap : null;
    if (isLeader) entry.position = 1;
    const ivl = parseFloat(int.interval);
    entry.interval = !isNaN(ivl) && int.interval !== 0 ? ivl : null;
  });

  laps.forEach((lap) => {
    const num = String(lap.driver_number);
    const entry = ensureTimingEntry(state, num);

    // Track lap activity windows for practice/quali in-pit detection
    if (lap.date_start) {
      const startMs = Date.parse(lap.date_start);
      if (Number.isFinite(startMs)) {
        const act = (lapActivity[num] ??= { lastStartMs: 0, lastEndMs: 0 });
        if (startMs > act.lastStartMs) act.lastStartMs = startMs;
        if (lap.lap_duration) {
          const endMs = startMs + lap.lap_duration * 1000;
          if (endMs > act.lastEndMs) act.lastEndMs = endMs;
        }
      }
    }

    if (lap.lap_number > entry.lap_number) {
      entry.lap_number = lap.lap_number;
      if (lap.lap_number > state.lap_count.current) {
        state.lap_count.current = lap.lap_number;
      }
    }
    if (lap.lap_duration && lap.lap_duration < 150) {
      entry.last_lap = lap.lap_duration;
      entry.last_lap_is_pb = updateBestLap(
        entry,
        lap.lap_duration,
        lap.is_pit_out_lap,
      );
    }
    if (lap.duration_sector_1) entry.sector_1 = lap.duration_sector_1;
    if (lap.duration_sector_2) entry.sector_2 = lap.duration_sector_2;
    if (lap.duration_sector_3) entry.sector_3 = lap.duration_sector_3;
    if (lap.segments_sector_1) entry.segments_1 = lap.segments_sector_1;
    if (lap.segments_sector_2) entry.segments_2 = lap.segments_sector_2;
    if (lap.segments_sector_3) entry.segments_3 = lap.segments_sector_3;
    entry.is_pit_out_lap = lap.is_pit_out_lap || false;
  });

  // locations
  const latestLocations = {};
  locations.forEach((loc) => {
    const num = String(loc.driver_number);
    const t = new Date(loc.date).getTime();
    if (!latestLocations[num] || t > latestLocations[num].t) {
      latestLocations[num] = { t, x: loc.x, y: loc.y };
    }
  });
  Object.entries(latestLocations).forEach(([num, loc]) => {
    // Carry the fix's own timestamp — the track map plays GPS back on it.
    state.location[num] = { x: loc.x, y: loc.y, t: loc.t };
  });

  // race control
  if (raceControl && raceControl.length > 0) {
    raceControl.forEach((msg) => {
      const msgId = `${msg.date}_${msg.message}`;
      const exists = state.race_control_messages.some(
        (m) => `${m.date}_${m.message}` === msgId,
      );
      if (!exists) {
        state.race_control_messages.push({
          date: msg.date,
          message: msg.message,
          flag: msg.flag || null,
          category: msg.category || "Other",
          scope: msg.scope || null,
          sector: msg.sector || null,
          driver_number: msg.driver_number || null,
          lap_number: msg.lap_number || null,
        });
        if (state.race_control_messages.length > 50) {
          state.race_control_messages = state.race_control_messages.slice(-50);
        }
        console.log(`[Replay] Race Control: ${msg.message}`);
      }
    });

    // Update track status from latest track-scope flag
    const lastFlagMsg = [...raceControl]
      .reverse()
      .find((m) => m.flag && m.scope === "Track");
    if (lastFlagMsg) {
      const flagStatus = flagToTrackStatus(lastFlagMsg.flag);
      if (flagStatus) state.track_status.flag = flagStatus;
    }
    // Safety car
    const lastSCMsg = [...raceControl]
      .reverse()
      .find((m) => m.category === "SafetyCar");
    if (lastSCMsg) {
      const sc = detectSafetyCar(lastSCMsg.message);
      if (sc) state.track_status.flag = sc;
    }
  }

  // team radio
  if (teamRadio && teamRadio.length > 0) {
    teamRadio.forEach((radio) => {
      const exists = state.team_radio.some(
        (r) => r.recording_url === radio.recording_url,
      );
      if (!exists) {
        state.team_radio.push({
          date: radio.date,
          driver_number: radio.driver_number,
          recording_url: radio.recording_url,
        });
        if (state.team_radio.length > 30) {
          state.team_radio = state.team_radio.slice(-30);
        }
        const driver = state.drivers[String(radio.driver_number)];
        console.log(
          `[Replay] Team Radio: ${driver?.name_acronym || radio.driver_number}`,
        );
      }
    });
  }

  return state;
}

// Start the replay
export async function startReplay(broadcast, stateRef) {
  if (replayStarted) {
    console.log("[Replay] Already running");
    return true;
  }

  replayStarted = true;
  broadcastFn = broadcast;
  currentStateRef = stateRef;
  const gen = ++replayGeneration;

  try {
    // Resolve which session to replay (latest from OpenF1 / env / archive)
    await resolveSessionKey();

    // Pick the data source: prefer the local SQLite archive.
    dbMode = store.isComplete(SESSION_KEY);
    if (!dbMode) {
      const stored = store.newestCompleteSession();
      if (stored) {
        // Replay the newest archived session meanwhile — the archive
        // maintenance loop in server.js downloads the latest one in the
        // background and restarts replay onto it when ready.
        console.log(
          `[Replay] Session ${SESSION_KEY} not archived yet — replaying archived ${stored.payload.session_name} ${stored.payload.location} (${stored.session_key}) meanwhile`,
        );
        SESSION_KEY = stored.session_key;
        dbMode = true;
      } else {
        // Nothing archived (first boot): download now, then serve from SQLite.
        console.log(
          `[Replay] No archived sessions — downloading session ${SESSION_KEY} to SQLite...`,
        );
        dbMode = await downloadSessionByKey(SESSION_KEY);
        if (!dbMode) {
          console.warn(
            `[Replay] Download failed — falling back to REST streaming`,
          );
        }
      }
    }
    // The watchdog may have switched to a live source during the download
    if (!replayStarted) return false;

    if (dbMode) {
      POLL_INTERVAL_MS = DB_POLL_INTERVAL_MS;
      REQUEST_DELAY_MS = 0;
      POLL_WINDOW_SECONDS = (DB_POLL_INTERVAL_MS / 1000) * REPLAY_SPEED;
      console.log(
        `[Replay] Serving from SQLite archive — ${POLL_INTERVAL_MS}ms update cadence`,
      );
    } else if (hasMQTTCredentials()) {
      POLL_INTERVAL_MS = PAID_POLL_INTERVAL_MS;
      REQUEST_DELAY_MS = PAID_REQUEST_DELAY_MS;
      POLL_WINDOW_SECONDS = (PAID_POLL_INTERVAL_MS / 1000) * REPLAY_SPEED;
      console.log(
        `[Replay] Paid tier detected — using ${POLL_INTERVAL_MS}ms interval`,
      );
    } else {
      POLL_INTERVAL_MS = FREE_POLL_INTERVAL_MS;
      REQUEST_DELAY_MS = FREE_REQUEST_DELAY_MS;
      POLL_WINDOW_SECONDS = (FREE_POLL_INTERVAL_MS / 1000) * REPLAY_SPEED;
      console.log(`[Replay] Free tier — using ${POLL_INTERVAL_MS}ms interval`);
    }

    const startupDelay = () =>
      dbMode ? Promise.resolve() : sleep(REQUEST_DELAY_MS);
    await startupDelay();

    // Sequential startup fetches with delays to stay within rate limits
    const sessionInfo = await fetchSessionInfo();
    await startupDelay();
    const startingGrid = await fetchStartingGrid();
    await startupDelay();
    await fetchPitData();
    await startupDelay();
    await fetchStintData();
    await startupDelay();
    await fetchAllWeather();
    await startupDelay();

    const { session, drivers } = sessionInfo;
    sessionData = session;
    driversData = drivers;
    startingGridData = startingGrid;

    raceStartTime = await findRaceStart(session.date_start);

    // Build initial state with starting grid
    const initialState = buildInitialState(session, drivers, startingGrid);
    Object.assign(currentStateRef, initialState);

    // Apply initial tire compounds and weather
    updateActiveStints(currentStateRef);
    updateWeather(currentStateRef, raceStartTime);

    // Broadcast initial state
    broadcastFn("initial", currentStateRef);

    // Start polling
    replayStartRealTime = Date.now();
    lastPollTime = raceStartTime;

    console.log(`[Replay] Starting at ${REPLAY_SPEED}x speed`);
    console.log(
      `[Replay] Polling every ${POLL_INTERVAL_MS}ms for ${POLL_WINDOW_SECONDS}s windows`,
    );

    // Do first poll immediately, then schedule subsequent ones
    await pollAndBroadcast();
    scheduleNextPoll(gen);

    console.log("[Replay] Replay started!");
    return true;
  } catch (error) {
    console.error("[Replay] Error starting replay:", error.message);
    replayStarted = false;
    return false;
  }
}

// Recursive setTimeout scheduling — extracted so seekReplay can reuse the same loop.
// Each cycle starts only after the previous completes, preventing overlapping requests.
function scheduleNextPoll(gen) {
  if (!replayStarted || gen !== replayGeneration) return;
  replayInterval = setTimeout(async () => {
    if (!replayStarted || gen !== replayGeneration) return;
    await pollAndBroadcast();
    scheduleNextPoll(gen);
  }, POLL_INTERVAL_MS);
}

// Poll for new data and broadcast
async function pollAndBroadcast() {
  if (!replayStarted) return;

  // Calculate current race time based on real elapsed time
  const realElapsedMs = Date.now() - replayStartRealTime;
  const raceElapsedMs = realElapsedMs * REPLAY_SPEED;
  const currentRaceTime = new Date(raceStartTime.getTime() + raceElapsedMs);

  // Session data exhausted — loop: restart the replay from the beginning
  if (
    replayEndMs &&
    currentRaceTime.getTime() > replayEndMs + REPLAY_END_BUFFER_MS
  ) {
    console.log(
      "[Replay] Reached end of session data — restarting replay from the beginning",
    );
    const broadcast = broadcastFn;
    const stateRef = currentStateRef;
    stopReplay();
    for (const key of Object.keys(stateRef)) delete stateRef[key];
    broadcast("reset", {});
    await startReplay(broadcast, stateRef);
    return;
  }

  // Time window to fetch (from last poll to current)
  const windowStart = lastPollTime;
  const windowEnd = currentRaceTime;

  // Only fetch if we have a meaningful window
  if (windowEnd <= windowStart) return;

  // Fetch data for this time window
  const data = await fetchTimeWindow(SESSION_KEY, windowStart, windowEnd);

  // Log progress
  const raceSeconds = Math.floor(raceElapsedMs / 1000);
  const mins = Math.floor(raceSeconds / 60);
  const secs = raceSeconds % 60;
  const dataCount =
    data.positions.length +
    data.intervals.length +
    data.laps.length +
    data.locations.length +
    (data.raceControl?.length || 0) +
    (data.teamRadio?.length || 0);

  if (dataCount > 0) {
    console.log(
      `[Replay] ${mins}:${String(secs).padStart(2, "0")} - Fetched: ${
        data.positions.length
      } pos, ${data.intervals.length} int, ${data.laps.length} laps, ${
        data.locations.length
      } loc, ${data.raceControl?.length || 0} rc, ${
        data.teamRadio?.length || 0
      } radio`,
    );
  }

  // Process and update state
  processData(data, currentStateRef);

  // Update InPit per driver. Races: /v1/pit time windows (reliable, short
  // stops). Practice/Quali: lap-activity heuristic — pit data is inconsistent
  // there (see isDriverOnTrackByLaps).
  const sessionType = currentStateRef.session?.session_type;
  const raceLike = sessionType === "Race" || sessionType === "Sprint";
  Object.keys(currentStateRef.timing).forEach((num) => {
    currentStateRef.timing[num].in_pit = raceLike
      ? isDriverInPit(num, currentRaceTime)
      : !isDriverOnTrackByLaps(num, currentRaceTime.getTime());
  });

  // Update active tire compound per driver based on current lap
  updateActiveStints(currentStateRef);

  // Update weather based on current race time
  updateWeather(currentStateRef, currentRaceTime);

  // Update clock
  const hours = Math.floor(raceSeconds / 3600);
  const minutes = Math.floor((raceSeconds % 3600) / 60);
  const seconds = raceSeconds % 60;
  currentStateRef.clock = {
    remaining: `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
    utc: new Date().toISOString(),
  };

  // Broadcast update
  broadcastFn("update", {
    session: currentStateRef.session,
    drivers: currentStateRef.drivers,
    timing: currentStateRef.timing,
    location: currentStateRef.location,
    lap_count: currentStateRef.lap_count,
    track_status: currentStateRef.track_status,
    race_control_messages: currentStateRef.race_control_messages,
    team_radio: currentStateRef.team_radio,
    clock: currentStateRef.clock,
  });

  // Update last poll time
  lastPollTime = windowEnd;
}

// Stop replay
export function stopReplay() {
  if (replayInterval) {
    clearTimeout(replayInterval);
    replayInterval = null;
  }
  replayStarted = false;
  dbMode = false;
  replayEndMs = 0;
  TOTAL_LAPS = 0;
  sessionData = null;
  driversData = [];
  startingGridData = {};
  raceStartTime = null;
  replayStartRealTime = null;
  lastPollTime = null;
  Object.keys(pitData).forEach((k) => delete pitData[k]);
  Object.keys(stintsData).forEach((k) => delete stintsData[k]);
  Object.keys(lapActivity).forEach((k) => delete lapActivity[k]);
  weatherRecords = [];
  console.log("[Replay] Replay stopped");
}

// Check if replay is running
export function isReplayRunning() {
  return replayStarted;
}

// True when the running replay serves from the local SQLite archive
export function isReplayUsingDB() {
  return replayStarted && dbMode;
}

// Returns current replay position info for the dev scrubber UI
export function getReplayStatus() {
  if (!replayStarted || !raceStartTime || !replayStartRealTime) return null;
  const realElapsedMs = Date.now() - replayStartRealTime;
  const currentOffsetMs = Math.max(0, Math.floor(realElapsedMs * REPLAY_SPEED));
  const totalMs = replayEndMs > 0 ? replayEndMs - raceStartTime.getTime() : 0;
  return {
    sessionKey: SESSION_KEY,
    currentOffsetMs,
    totalMs,
    dbMode,
    speed: REPLAY_SPEED,
  };
}

// Seek the replay to a target offset from session start (ms). Only works in DB
// mode — rebuilds state from SQLite up to the target time, then resumes polling.
export async function seekReplay(targetOffsetMs) {
  if (!replayStarted || !raceStartTime || !dbMode) return false;

  const totalMs = replayEndMs > 0 ? replayEndMs - raceStartTime.getTime() : 0;
  const clampedMs = Math.max(
    0,
    totalMs > 0 ? Math.min(targetOffsetMs, totalMs) : targetOffsetMs,
  );
  const targetTime = new Date(raceStartTime.getTime() + clampedMs);

  if (replayInterval) {
    clearTimeout(replayInterval);
    replayInterval = null;
  }
  const gen = ++replayGeneration;

  try {
    // Clear lap-activity cache so in-pit detection starts fresh
    Object.keys(lapActivity).forEach((k) => delete lapActivity[k]);

    // Rebuild state from session start to target time in one pass
    const freshState = buildInitialState(sessionData, driversData, startingGridData);
    for (const k of Object.keys(currentStateRef)) delete currentStateRef[k];
    Object.assign(currentStateRef, freshState);

    if (clampedMs > 0) {
      const allData = await fetchTimeWindow(SESSION_KEY, raceStartTime, targetTime);
      processData(allData, currentStateRef);
    }

    updateActiveStints(currentStateRef);
    updateWeather(currentStateRef, targetTime);

    const sessionType = currentStateRef.session?.session_type;
    const raceLike = sessionType === "Race" || sessionType === "Sprint";
    Object.keys(currentStateRef.timing).forEach((num) => {
      currentStateRef.timing[num].in_pit = raceLike
        ? isDriverInPit(num, targetTime)
        : !isDriverOnTrackByLaps(num, targetTime.getTime());
    });

    // Adjust the virtual clock so polling continues from targetTime
    replayStartRealTime = Date.now() - clampedMs / REPLAY_SPEED;
    lastPollTime = targetTime;

    // Tell clients to reset then receive the rebuilt snapshot
    broadcastFn("reset", {});
    broadcastFn("initial", currentStateRef);

    scheduleNextPoll(gen);

    const mins = Math.floor(clampedMs / 60000);
    const secs = String(Math.floor((clampedMs % 60000) / 1000)).padStart(2, "0");
    console.log(`[Replay] Seeked to ${mins}:${secs} (${targetTime.toISOString()})`);
    return true;
  } catch (err) {
    console.error("[Replay] Seek error:", err.message);
    scheduleNextPoll(gen); // resume even on error
    return false;
  }
}
