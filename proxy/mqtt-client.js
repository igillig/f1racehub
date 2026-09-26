/**
 * OpenF1 MQTT Client for Live Data
 *
 * Connects to OpenF1's MQTT broker for real-time F1 telemetry data.
 * Requires authentication via OAuth2 token.
 *
 * Environment variables:
 * - OPENF1_USERNAME: Your OpenF1 username/email
 * - OPENF1_PASSWORD: Your OpenF1 password
 */

import mqtt from "mqtt";
import { isSignalRRunning } from "./signalr-client.js";
import {
  ensureTimingEntry,
  updateBestLap,
  getPitWindowStatus,
  flagToTrackStatus,
  detectSafetyCar,
} from "./state-utils.js";

// MQTT Configuration
const MQTT_BROKER = "mqtt.openf1.org";
const MQTT_PORT = 8883;
const TOKEN_URL = "https://api.openf1.org/token";
const API_BASE = "https://api.openf1.org/v1";

/**
 * fetch() wrapper that retries on HTTP 429 (rate limit), honoring the
 * Retry-After header. OpenF1 enforces a burst/concurrency limit, so firing
 * many requests in parallel at startup non-deterministically 429s some of
 * them — which previously left e.g. the drivers list (and thus team colors)
 * empty. Retrying the failed ones resolves it.
 *
 * Jitter is added so simultaneously-throttled requests don't retry in lockstep
 * and re-trip the limit. Non-429 responses (200, 404, etc.) return immediately.
 */
async function fetchWithRetry(url, options, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429 || attempt >= retries) return res;
    const retryAfter = parseFloat(res.headers.get("retry-after")) || 1;
    const jitterMs = Math.floor(Math.random() * 300);
    await new Promise((r) => setTimeout(r, retryAfter * 1000 + jitterMs));
  }
}

// Topics to subscribe (correspond to REST API endpoints)
const TOPICS = [
  "v1/sessions",
  "v1/drivers",
  "v1/position",
  "v1/intervals",
  "v1/laps",
  "v1/location",
  "v1/car_data",
  "v1/race_control",
  "v1/team_radio",
  "v1/weather",
  "v1/stints",
  "v1/pit",
];

// State
let client = null;
let accessToken = null;
let tokenExpiry = null;
let broadcastFn = null;
let currentStateRef = null;
let isRunning = false;
let reconnectTimeout = null;
let carDataDirty = false;
let carDataTimer = null;
let locationDirty = false;
let locationTimer = null;
let trackedSessionKey = null;
let sessionRefreshInFlight = false;

// Raw message debug buffer — last 20 messages per topic (excluding high-freq location/car_data)
const RAW_MQTT_BUFFER = {};
const RAW_MQTT_MAX = 20;
const HIGH_FREQ_TOPICS = new Set(["location", "car_data"]);

function recordRawMqtt(topicName, data) {
  if (HIGH_FREQ_TOPICS.has(topicName)) return;
  if (!RAW_MQTT_BUFFER[topicName]) RAW_MQTT_BUFFER[topicName] = [];
  RAW_MQTT_BUFFER[topicName].push({ ts: new Date().toISOString(), data });
  if (RAW_MQTT_BUFFER[topicName].length > RAW_MQTT_MAX) {
    RAW_MQTT_BUFFER[topicName].shift();
  }
}

export function getRawMqttDebug() {
  return {
    connected: isRunning,
    buffer: RAW_MQTT_BUFFER,
  };
}

/**
 * Obtain OAuth2 access token from OpenF1
 */
async function getAccessToken() {
  const username = process.env.OPENF1_USERNAME;
  const password = process.env.OPENF1_PASSWORD;

  if (!username || !password) {
    throw new Error(
      "OPENF1_USERNAME and OPENF1_PASSWORD environment variables required",
    );
  }

  const params = new URLSearchParams();
  params.append("username", username);
  params.append("password", password);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token request failed: ${response.status} - ${text}`);
  }

  const data = await response.json();
  accessToken = data.access_token;
  // Set expiry 5 minutes before actual expiry for safety
  tokenExpiry = Date.now() + (parseInt(data.expires_in) - 300) * 1000;

  console.log(
    `[openf1-mqtt] Auth token obtained (expires in ${data.expires_in}s)`,
  );
  return accessToken;
}

/**
 * Check if token is still valid, refresh if needed
 */
export async function ensureValidToken() {
  if (!accessToken || !tokenExpiry || Date.now() >= tokenExpiry) {
    await getAccessToken();
  }
  return accessToken;
}

/**
 * Process incoming MQTT message and update state
 */
function processMessage(topic, message) {
  try {
    const data = JSON.parse(message.toString());
    const topicName = topic.replace("v1/", "");

    recordRawMqtt(topicName, data);

    // Self-heal a stale session header: if live data arrives for a session other
    // than the one currently tracked, refresh session info from that exact key.
    if (topicName !== "sessions") maybeRefreshSession(data.session_key);

    // Update state based on topic
    switch (topicName) {
      case "sessions":
        handleSession(data);
        break;
      case "drivers":
        handleDriver(data);
        break;
      case "position":
        handlePosition(data);
        break;
      case "intervals":
        handleInterval(data);
        break;
      case "laps":
        handleLap(data);
        break;
      case "location":
        handleLocation(data);
        locationDirty = true;
        return; // skip per-message broadcast — location uses a dedicated 250ms timer
      case "car_data":
        handleCarData(data);
        carDataDirty = true;
        return; // skip per-message broadcast — car_data uses a dedicated 500ms timer
      case "race_control":
        handleRaceControl(data);
        break;
      case "team_radio":
        handleTeamRadio(data);
        break;
      case "weather":
        handleWeather(data);
        break;
      case "stints":
        handleStint(data);
        break;
      case "pit":
        handlePit(data);
        break;
    }

    // Broadcast update to SSE clients
    if (broadcastFn && currentStateRef) {
      broadcastFn("update", currentStateRef);
    }
  } catch (err) {
    console.error(
      `[openf1-mqtt] Error processing message on ${topic}:`,
      err.message,
    );
  }
}

/**
 * Handle session info
 */
function handleSession(data) {
  if (!currentStateRef) return;

  if (trackedSessionKey !== null && data.session_key !== trackedSessionKey) {
    console.log(
      `[openf1-mqtt] Session changed ${trackedSessionKey} → ${data.session_key} — resetting state`,
    );
    for (const key of Object.keys(currentStateRef)) delete currentStateRef[key];
    if (broadcastFn) broadcastFn("reset", {});
    fetchHistoricalData(data.session_key);
  }
  trackedSessionKey = data.session_key;

  currentStateRef.session = {
    session_key: data.session_key,
    session_name: data.session_name || data.session_type,
    session_type: data.session_type,
    circuit_key: data.circuit_key,
    circuit_short_name: data.circuit_short_name || data.location,
    country_name: data.country_name,
    country_code: data.country_code,
    date_start: data.date_start,
    // Only store date_end if it's more than 30 min in the past (session truly over).
    // OpenF1 can set date_end prematurely during red flags or delays — storing it
    // would make isLive=false on the frontend and dump all cars to the pit lane.
    date_end: (() => {
      if (!data.date_end) return null;
      const d = new Date(data.date_end);
      return d < new Date(Date.now() - 30 * 60 * 1000) ? data.date_end : null;
    })(),
    location: data.location,
    meeting_name: data.meeting_name || data.location,
  };
  // Set total laps when available (Race and Sprint sessions provide this)
  if (data.total_laps) {
    if (!currentStateRef.lap_count)
      currentStateRef.lap_count = { current: 0, total: 0 };
    currentStateRef.lap_count.total = data.total_laps;
  }
}

/**
 * Handle driver info
 */
function handleDriver(data) {
  if (!currentStateRef) return;
  const num = String(data.driver_number);
  if (!currentStateRef.drivers) currentStateRef.drivers = {};
  // OpenF1 sends team_name/team_colour as null during live sessions — merge
  // field-by-field so we don't wipe values already filled by SignalR DriverList.
  const existing = currentStateRef.drivers[num] || {};
  currentStateRef.drivers[num] = {
    driver_number: data.driver_number,
    name_acronym: data.name_acronym ?? existing.name_acronym ?? null,
    full_name: data.full_name ?? existing.full_name ?? null,
    team_name: data.team_name ?? existing.team_name ?? null,
    team_colour: data.team_colour ?? existing.team_colour ?? null,
  };
}

/**
 * During a live session neither OpenF1 nor (since 2026) the F1 SignalR
 * DriverList provides team_name/team_colour — OpenF1 backfills them after the
 * session ends. Walk back through previous session_keys and merge the team
 * info of the most recent session that has it, matching by driver_number.
 */
async function backfillTeamInfo(sessionKey, headers) {
  if (!currentStateRef?.drivers) return;
  const stillMissing = () =>
    Object.values(currentStateRef.drivers).filter((d) => !d.team_colour);
  if (stillMissing().length === 0) return;

  // Pass 1: most recent previous session — fills the regular race lineup
  // with a single request.
  for (let sk = sessionKey - 1; sk >= sessionKey - 10; sk--) {
    try {
      const res = await fetchWithRetry(
        `${API_BASE}/drivers?session_key=${sk}`,
        { headers },
      );
      if (!res.ok) continue;
      const prev = await res.json();
      const withTeam = Array.isArray(prev)
        ? prev.filter((d) => d.team_colour)
        : [];
      if (withTeam.length === 0) continue;

      let filled = 0;
      for (const p of withTeam) {
        const entry = currentStateRef.drivers[String(p.driver_number)];
        if (entry && !entry.team_colour) {
          entry.team_name = entry.team_name ?? p.team_name;
          entry.team_colour = p.team_colour;
          filled++;
        }
      }
      console.log(
        `[openf1-mqtt] Backfilled team info for ${filled} drivers from session ${sk}`,
      );
      break;
    } catch {
      /* try next session key */
    }
  }

  // Pass 2: rookie/FP1-only drivers aren't in the previous session's lineup.
  // Query each one's full driver history and take their most recent team.
  for (const entry of stillMissing()) {
    try {
      const res = await fetchWithRetry(
        `${API_BASE}/drivers?driver_number=${entry.driver_number}`,
        { headers },
      );
      if (!res.ok) continue;
      const hist = await res.json();
      const latest = (Array.isArray(hist) ? hist : [])
        .filter((h) => h.team_colour && h.session_key !== sessionKey)
        .sort((a, b) => b.session_key - a.session_key)[0];
      if (latest) {
        entry.team_name = entry.team_name ?? latest.team_name;
        entry.team_colour = latest.team_colour;
        console.log(
          `[openf1-mqtt] Backfilled team info for #${entry.driver_number} (${entry.name_acronym}) from session ${latest.session_key}: ${latest.team_name}`,
        );
      }
    } catch {
      /* leave this driver without team info */
    }
    // Stay well inside the OpenF1 rate budget during startup
    await new Promise((r) => setTimeout(r, 250));
  }

  const remaining = stillMissing();
  if (remaining.length > 0) {
    console.warn(
      `[openf1-mqtt] No team info found for: ${remaining.map((d) => d.name_acronym || d.driver_number).join(", ")} — colors will be missing for these drivers`,
    );
  }
}

/**
 * Handle position updates
 */
function handlePosition(data) {
  if (!currentStateRef) return;
  const num = String(data.driver_number);
  const entry = ensureTimingEntry(currentStateRef, num);
  entry.position = data.position ?? null;
}

/**
 * Handle interval updates
 */
function handleInterval(data) {
  if (!currentStateRef) return;
  const num = String(data.driver_number);
  const entry = ensureTimingEntry(currentStateRef, num);
  // Only infer leader (position=1) when gap_to_leader is explicitly 0.
  // A null value means data is missing for this driver — treating it as
  // "leader" causes this driver to jump to P1 in the frontend sort.
  const isLeader = data.gap_to_leader === 0;
  entry.gap_to_leader = (data.gap_to_leader === 0 || data.gap_to_leader == null) ? null : data.gap_to_leader;
  if (isLeader) entry.position = 1;
  entry.interval =
    data.interval === 0 || data.interval == null ? null : data.interval;
}

/**
 * Handle lap updates
 */
function handleLap(data, fromHistory = false) {
  if (!currentStateRef) return;
  const num = String(data.driver_number);
  const entry = ensureTimingEntry(currentStateRef, num);

  entry.lap_number = data.lap_number ?? entry.lap_number;
  // Keep tyre age current as laps tick up
  if (entry.stint_lap_start != null) entry.tyre_age = computeTyreAge(entry);

  // Only update sector times if present — avoids clearing live data from SignalR
  if (data.duration_sector_1 != null) entry.sector_1 = data.duration_sector_1;
  if (data.duration_sector_2 != null) entry.sector_2 = data.duration_sector_2;
  if (data.duration_sector_3 != null) entry.sector_3 = data.duration_sector_3;

  // Only overwrite segments if MQTT delivers a non-empty array (completed-lap data)
  if (
    Array.isArray(data.segments_sector_1) &&
    data.segments_sector_1.length > 0
  )
    entry.segments_1 = data.segments_sector_1;
  if (
    Array.isArray(data.segments_sector_2) &&
    data.segments_sector_2.length > 0
  )
    entry.segments_2 = data.segments_sector_2;
  if (
    Array.isArray(data.segments_sector_3) &&
    data.segments_sector_3.length > 0
  )
    entry.segments_3 = data.segments_sector_3;

  entry.is_pit_out_lap = data.is_pit_out_lap || false;

  if (data.lap_duration != null) {
    // Only record timed laps — skip pit-out laps and anything over 10 minutes
    // (red-flag-interrupted laps, in-laps with inter-segment break included, etc.)
    const isTimed = !data.is_pit_out_lap && data.lap_duration < 600;
    // When loading historical laps at startup and SignalR has already set the
    // current qualifying part's timing (BestLapTime/LastLapTime from snapshot),
    // skip overwriting best_lap and last_lap — historical data may be from a
    // prior qualifying part (Q1/Q2) and would show stale times.
    const signalrOwns = fromHistory && entry._signalrTimingInit;
    // Apply isTimed to both last_lap AND best_lap — a >600s in-lap/installation
    // lap must not become the driver's "best" qualifying time.
    if (isTimed && !signalrOwns) {
      entry.last_lap = data.lap_duration;
      const isPb = updateBestLap(entry, data.lap_duration, data.is_pit_out_lap);
      entry.last_lap_is_pb = isPb;
    } else {
      entry.last_lap_is_pb = false;
    }
    // Lap is confirmed complete — clear live *segment* data so the next lap's
    // mini-sectors start clean (SignalR will repopulate them segment-by-segment
    // as the new lap progresses). Do NOT clear the sector times here: S3 is only
    // known at the finish line, so clearing sector_3 here erases it before it's
    // ever shown (bug #9). Sector times are overwritten as the next lap's
    // sectors complete.
    entry.segments_1 = [];
    entry.segments_2 = [];
    entry.segments_3 = [];
  }

  // Advance the global lap counter
  if (
    data.lap_number &&
    data.lap_number > (currentStateRef.lap_count?.current || 0)
  ) {
    if (!currentStateRef.lap_count)
      currentStateRef.lap_count = { current: 0, total: 0 };
    currentStateRef.lap_count.current = data.lap_number;
  }
}

/**
 * Handle location updates (car position on track)
 */
function handleLocation(data) {
  if (!currentStateRef) return;
  // If SignalR Position.z is delivering (<5s ago), let it own car positions.
  if (
    currentStateRef.locationSignalRTs &&
    Date.now() - currentStateRef.locationSignalRTs < 5000
  )
    return;
  const num = String(data.driver_number);
  if (!currentStateRef.location) currentStateRef.location = {};
  // `t` is the fix's OWN timestamp, not arrival time. The track map plays GPS
  // back on a delay and derives speed from the gap between samples; timing it
  // by arrival made that speed meaningless, because MQTT delivers ~2 Hz fixes
  // in bursts (two 100 ms apart, then ~900 ms of nothing).
  const t = Date.parse(data.date);
  currentStateRef.location[num] = {
    x: data.x,
    y: data.y,
    t: Number.isFinite(t) ? t : Date.now(),
  };
  currentStateRef.locationSource = "mqtt";
}

/**
 * Handle race control messages
 */
function handleRaceControl(data, opts = {}) {
  if (!currentStateRef) return;
  if (!Array.isArray(currentStateRef.race_control_messages)) {
    currentStateRef.race_control_messages = [];
  }

  const msg = {
    date: data.date,
    message: data.message,
    flag: data.flag || null,
    category: data.category || "Other",
    scope: data.scope || null,
    sector: data.sector || null,
    driver_number: data.driver_number || null,
    lap_number: data.lap_number || null,
  };

  // Deduplicate
  const exists = currentStateRef.race_control_messages.some(
    (m) => m.date === msg.date && m.message === msg.message,
  );

  if (!exists) {
    currentStateRef.race_control_messages.push(msg);
    if (currentStateRef.race_control_messages.length > 50) {
      currentStateRef.race_control_messages =
        currentStateRef.race_control_messages.slice(-50);
    }
  }

  // skipTrackStatus = true when called during historical data loading.
  // Historical messages must not overwrite the real-time status set by SignalR.
  if (!opts.skipTrackStatus) {
    // Update track status from flag — only when SignalR hasn't claimed authority.
    // In live mode SignalR is the authoritative source for track status (~200ms faster).
    if (!currentStateRef._signalrTrackStatusSet && data.flag && data.scope === "Track") {
      const flagStatus = flagToTrackStatus(data.flag);
      if (flagStatus) {
        currentStateRef.track_status = { flag: flagStatus };
      }
    }

    // CHEQUERED can arrive with flag=null — detect from message text as fallback.
    // Also lock _signalrTrackStatusSet so a delayed yellow sector message can't
    // override the checkered flag afterwards.
    if (data.message?.toUpperCase().includes("CHEQUERED")) {
      currentStateRef.track_status = { flag: "CHEQUERED" };
      currentStateRef._signalrTrackStatusSet = true;
    }

    // Safety car overrides flag-based status — but only when SignalR hasn't
    // claimed authoritative control (live mode: SignalR is faster and more reliable).
    if (!currentStateRef._signalrTrackStatusSet) {
      const scStatus = detectSafetyCar(data.message);
      if (scStatus) {
        currentStateRef.track_status = { flag: scStatus };
      }
    }
  }
}

/**
 * Handle team radio
 */
function handleTeamRadio(data) {
  if (!currentStateRef) return;
  if (!Array.isArray(currentStateRef.team_radio)) {
    currentStateRef.team_radio = [];
  }

  const radio = {
    date: data.date,
    driver_number: data.driver_number,
    recording_url: data.recording_url,
  };

  // Deduplicate by URL
  const exists = currentStateRef.team_radio.some(
    (r) => r.recording_url === radio.recording_url,
  );

  if (!exists) {
    currentStateRef.team_radio.push(radio);
    if (currentStateRef.team_radio.length > 30) {
      currentStateRef.team_radio = currentStateRef.team_radio.slice(-30);
    }
    console.log(`[openf1-mqtt] Team Radio: Driver ${data.driver_number}`);
  }
}

/**
 * Handle weather data
 */
function handleWeather(data) {
  if (!currentStateRef) return;
  currentStateRef.weather = {
    air_temperature: data.air_temperature,
    track_temperature: data.track_temperature,
    humidity: data.humidity,
    pressure: data.pressure,
    rainfall: data.rainfall,
    wind_speed: data.wind_speed,
    wind_direction: data.wind_direction,
  };
}

/**
 * Handle stint data (tire info)
 */
function handleStint(data) {
  if (!currentStateRef) return;
  const num = String(data.driver_number);
  const entry = ensureTimingEntry(currentStateRef, num);
  entry.compound = data.compound ? data.compound.toUpperCase() : entry.compound;
  entry.tyre_age_at_start = data.tyre_age_at_start ?? entry.tyre_age_at_start ?? 0;
  entry.stint_lap_start = data.lap_start ?? entry.stint_lap_start;
  entry.stint_number = data.stint_number ?? entry.stint_number;
  // Compute current tyre age: base age + laps completed in this stint
  entry.tyre_age = computeTyreAge(entry);
}

function computeTyreAge(entry) {
  const base = entry.tyre_age_at_start || 0;
  const lapStart = entry.stint_lap_start;
  const currentLap = entry.lap_number || 0;
  if (lapStart != null && currentLap >= lapStart) {
    return Math.max(0, currentLap - lapStart) + base;
  }
  return base;
}

/**
 * Handle pit stop events.
 * Sets in_pit=true if the car is still within its pit lane window,
 * and schedules a timer to clear it when the window closes.
 */
function handlePit(data) {
  if (!currentStateRef) return;
  const num = String(data.driver_number);
  const entry = ensureTimingEntry(currentStateRef, num);

  entry.pit_count = (entry.pit_count || 0) + 1;

  // SignalR owns in_pit while connected (real-time InPit/PitOut deltas) —
  // OpenF1 pit windows must never override it. As fallback they're only
  // trustworthy in race-like sessions: in Practice/Quali, lane_duration
  // windows routinely cover on-track laps (drivers got flagged in-pit while
  // setting times).
  if (isSignalRRunning()) return;
  const sessionType = currentStateRef.session?.session_type;
  if (sessionType !== "Race" && sessionType !== "Sprint") return;

  const { in_pit, remaining_ms } = getPitWindowStatus(
    data.date,
    data.lane_duration,
  );
  if (in_pit) {
    entry.in_pit = true;
    setTimeout(() => {
      if (currentStateRef?.timing?.[num]) {
        currentStateRef.timing[num].in_pit = false;
        if (broadcastFn && currentStateRef)
          broadcastFn("update", currentStateRef);
      }
    }, remaining_ms + 1000);
  }
}

/**
 * Handle car telemetry data (~3.7 Hz per driver).
 * State is updated immediately; broadcasts are batched via carDataTimer.
 */
function handleCarData(data) {
  if (!currentStateRef) return;
  const num = String(data.driver_number);
  if (!currentStateRef.car_data) currentStateRef.car_data = {};
  currentStateRef.car_data[num] = {
    brake: data.brake ?? 0,
    throttle: data.throttle ?? 0,
    rpm: data.rpm ?? 0,
    speed: data.speed ?? 0,
    n_gear: data.n_gear ?? 0,
    drs: data.drs ?? 0,
    date: data.date,
  };
}

/**
 * Get current session key from latest data or API.
 * Also writes session info to state.
 */
async function getCurrentSessionKey() {
  try {
    const token = await ensureValidToken();
    const headers = {
      accept: "application/json",
      Authorization: `Bearer ${token}`,
    };

    const response = await fetch(`${API_BASE}/sessions?session_key=latest`, {
      headers,
    });

    if (response.ok) {
      const sessions = await response.json();
      if (sessions && sessions.length > 0) {
        const session = sessions[0];
        console.log(
          `[openf1-mqtt] Current session: ${session.session_name} at ${session.location}`,
        );

        // Write session info to state using the new format
        if (currentStateRef) {
          handleSession(session);
        }

        return session.session_key;
      }
    }
  } catch (error) {
    console.error(
      "[openf1-mqtt] Error getting current session:",
      error.message,
    );
  }
  return null;
}

/**
 * Self-heal for stale session header.
 *
 * `getCurrentSessionKey()` runs once at connect via `?session_key=latest`, which
 * lags when a session goes green — it can still return the previous session, so
 * the header shows stale info even though live MQTT data (location/position) is
 * already streaming for the new session. Every OpenF1 record carries the true
 * `session_key`, so when a live message arrives for a session other than the one
 * in the header, we fetch that specific session and hand it to handleSession
 * (which resets state + refetches historical). Fetching by explicit key avoids
 * the `latest` lag entirely.
 */
function maybeRefreshSession(sessionKey) {
  if (
    sessionRefreshInFlight ||
    trackedSessionKey === null ||
    typeof sessionKey !== "number" ||
    sessionKey === trackedSessionKey
  ) {
    return;
  }
  sessionRefreshInFlight = true;
  console.log(
    `[openf1-mqtt] Live data for session ${sessionKey} but header tracks ${trackedSessionKey} — refreshing session info`,
  );
  (async () => {
    try {
      const token = await ensureValidToken();
      const res = await fetch(`${API_BASE}/sessions?session_key=${sessionKey}`, {
        headers: { accept: "application/json", Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const sessions = await res.json();
        if (sessions?.length && currentStateRef) {
          handleSession(sessions[0]);
          if (broadcastFn) broadcastFn("update", currentStateRef);
        }
      }
    } catch (err) {
      console.error("[openf1-mqtt] Session refresh failed:", err.message);
    } finally {
      sessionRefreshInFlight = false;
    }
  })();
}

/**
 * Fetch historical data for the current session.
 * Called once at startup to fill in data that happened before we connected.
 */
async function fetchHistoricalData(sessionKey) {
  if (!sessionKey) return;

  console.log(
    `[openf1-mqtt] Fetching historical data for session ${sessionKey}...`,
  );

  try {
    const token = await ensureValidToken();
    const headers = {
      accept: "application/json",
      Authorization: `Bearer ${token}`,
    };

    const [
      raceControlRes,
      teamRadioRes,
      driversRes,
      lapsRes,
      intervalsRes,
      stintsRes,
      pitRes,
      posRes,
    ] = await Promise.all([
      fetchWithRetry(`${API_BASE}/race_control?session_key=${sessionKey}`, { headers }),
      fetchWithRetry(`${API_BASE}/team_radio?session_key=${sessionKey}`, { headers }),
      fetchWithRetry(`${API_BASE}/drivers?session_key=${sessionKey}`, { headers }),
      fetchWithRetry(`${API_BASE}/laps?session_key=${sessionKey}`, { headers }),
      fetchWithRetry(`${API_BASE}/intervals?session_key=${sessionKey}`, { headers }),
      fetchWithRetry(`${API_BASE}/stints?session_key=${sessionKey}`, { headers }),
      fetchWithRetry(`${API_BASE}/pit?session_key=${sessionKey}`, { headers }),
      fetchWithRetry(`${API_BASE}/position?session_key=${sessionKey}`, { headers }),
    ]);

    if (raceControlRes.ok) {
      const raceControl = await raceControlRes.json();
      console.log(
        `[openf1-mqtt] Loaded ${raceControl.length} historical race control messages`,
      );
      // Skip per-message track_status updates — we'll derive it once at the end
      // from the most recent message, but only if SignalR hasn't already set it.
      raceControl.forEach((msg) =>
        handleRaceControl(msg, { skipTrackStatus: true }),
      );

      // Derive initial track status from the last relevant historical message,
      // but defer to SignalR if it has already set the authoritative live status.
      if (!currentStateRef._signalrTrackStatusSet) {
        const msgs = raceControl;
        // Safety car takes priority
        // Find most recent SC-related message (deployed OR ending), then check if still active
        const lastSC = [...msgs]
          .reverse()
          .find(
            (m) =>
              m.message &&
              (m.message.includes("SAFETY CAR") ||
                m.message.includes("VIRTUAL SAFETY CAR")),
          );
        const lastFlag = [...msgs]
          .reverse()
          .find((m) => m.flag && m.scope === "Track");
        if (lastSC) {
          const sc = detectSafetyCar(lastSC.message);
          if (sc) currentStateRef.track_status = { flag: sc };
        } else if (lastFlag) {
          const fs = flagToTrackStatus(lastFlag.flag);
          if (fs) currentStateRef.track_status = { flag: fs };
        }
      }
    }

    if (teamRadioRes.ok) {
      const teamRadio = await teamRadioRes.json();
      console.log(
        `[openf1-mqtt] Loaded ${teamRadio.length} historical team radios`,
      );
      teamRadio.forEach((radio) => handleTeamRadio(radio));
    }

    if (driversRes.ok) {
      let drivers = await driversRes.json();
      // OpenF1 doesn't populate drivers for a session until it actually starts.
      // Fall back to the previous session's driver list so codes/images are
      // available before the session begins.
      if (drivers.length === 0) {
        console.log(
          `[openf1-mqtt] No drivers for session ${sessionKey} yet — falling back to previous session`,
        );
        try {
          const prevRes = await fetchWithRetry(
            `${API_BASE}/drivers?session_key=${sessionKey - 1}`,
            { headers },
          );
          if (prevRes.ok) {
            const prev = await prevRes.json();
            if (prev.length > 0) {
              drivers = prev;
              console.log(
                `[openf1-mqtt] Loaded ${drivers.length} drivers from previous session`,
              );
            }
          }
        } catch {
          /* ignore, keep empty */
        }
      } else {
        console.log(`[openf1-mqtt] Loaded ${drivers.length} drivers`);
      }
      // Rebuild keyed only by the fetched list so retained MQTT messages for
      // drivers from past sessions (e.g. RIC) don't persist — but carry over
      // each current driver's existing entry first, so team name/colour already
      // filled by SignalR DriverList survives the REST nulls (handleDriver merges).
      const previousDrivers = currentStateRef.drivers || {};
      currentStateRef.drivers = {};
      drivers.forEach((driver) => {
        const num = String(driver.driver_number);
        if (previousDrivers[num])
          currentStateRef.drivers[num] = previousDrivers[num];
        handleDriver(driver);
      });
      await backfillTeamInfo(sessionKey, headers);
    } else {
      // Drivers are critical (team colors, codes, names). If even the retried
      // fetch failed, log it loudly — team colors will be missing until the
      // v1/drivers MQTT topic pushes (which it rarely does mid-session).
      console.warn(
        `[openf1-mqtt] Failed to load drivers (status ${driversRes.status}) — team colors may be missing`,
      );
    }

    // Sort ascending so best/last lap are accumulated correctly
    if (lapsRes.ok) {
      const laps = await lapsRes.json();
      laps.sort((a, b) => a.lap_number - b.lap_number);
      laps.forEach((lap) => handleLap(lap, true));
      console.log(`[openf1-mqtt] Loaded ${laps.length} historical laps`);
    }

    if (intervalsRes.ok) {
      const intervals = await intervalsRes.json();
      // Keep only the last interval per driver
      const lastInterval = {};
      for (const entry of intervals) {
        lastInterval[String(entry.driver_number)] = entry;
      }
      Object.values(lastInterval).forEach((entry) => handleInterval(entry));
    }

    if (stintsRes.ok) {
      const stints = await stintsRes.json();
      stints.forEach((stint) => handleStint(stint));
    }

    if (pitRes.ok) {
      const pits = await pitRes.json();
      pits.forEach((p) => {
        if (!p.date || !p.lane_duration) return;
        const { in_pit } = getPitWindowStatus(p.date, p.lane_duration);
        if (in_pit) {
          // Driver is currently in the pit lane — triggers timer too
          handlePit(p);
        } else {
          // Just accumulate stop count without setting in_pit or timers
          const num = String(p.driver_number);
          const entry = ensureTimingEntry(currentStateRef, num);
          entry.pit_count = (entry.pit_count || 0) + 1;
        }
      });
      console.log(`[openf1-mqtt] Loaded ${pits.length} historical pit stops`);
    }

    if (posRes.ok) {
      const positions = await posRes.json();
      // Keep only the most recent position per driver
      const latestPos = {};
      for (const p of positions) {
        const key = String(p.driver_number);
        if (!latestPos[key] || p.date > latestPos[key].date) {
          latestPos[key] = p;
        }
      }
      Object.values(latestPos).forEach((p) => handlePosition(p));
      console.log(
        `[openf1-mqtt] Loaded positions for ${Object.keys(latestPos).length} drivers`,
      );
    }

    console.log("[openf1-mqtt] Historical data loaded");
  } catch (error) {
    console.error(
      "[openf1-mqtt] Error fetching historical data:",
      error.message,
    );
  }
}

/**
 * Check if there is an active F1 session right now.
 * Returns true if session ended within the last 30 minutes (post-race window).
 */
export async function checkActiveSession() {
  try {
    const token = await ensureValidToken();
    const response = await fetch(`${API_BASE}/sessions?session_key=latest`, {
      headers: { accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return true; // can't check → assume active
    const sessions = await response.json();
    if (!sessions?.length) return false;
    const session = sessions[0];
    if (!session.date_end) return true; // no end date = session in progress
    const endDate = new Date(session.date_end);
    const isActive = endDate > new Date(Date.now() - 30 * 60 * 1000);
    if (!isActive) {
      console.log(
        `[openf1-mqtt] Last session ended at ${session.date_end} — no active session`,
      );
    }
    return isActive;
  } catch {
    return true; // assume active on error
  }
}

/**
 * Connect to OpenF1 MQTT broker
 */
async function connect() {
  try {
    const token = await ensureValidToken();
    const username = process.env.OPENF1_USERNAME;

    console.log(`[openf1-mqtt] Connecting to ${MQTT_BROKER}:${MQTT_PORT}...`);

    client = mqtt.connect(`mqtts://${MQTT_BROKER}:${MQTT_PORT}`, {
      username: username,
      password: token,
      rejectUnauthorized: true,
      reconnectPeriod: 0, // We'll handle reconnection manually
    });

    client.on("connect", () => {
      console.log(
        `[openf1-mqtt] Connected — subscribing to ${TOPICS.length} topics`,
      );

      TOPICS.forEach((topic) => {
        client.subscribe(topic, (err) => {
          if (err)
            console.error(
              `[openf1-mqtt] Subscribe failed for ${topic}:`,
              err.message,
            );
        });
      });

      // Fetch historical data for the current session (runs once at startup).
      // After both calls complete, broadcast the full state so any clients
      // that connected during the loading window get session info + circuit key.
      getCurrentSessionKey().then(async (sessionKey) => {
        if (sessionKey) {
          await fetchHistoricalData(sessionKey);
        }
        if (broadcastFn && currentStateRef) {
          console.log(
            "[openf1-mqtt] Initial state ready — broadcasting to SSE clients",
          );
          broadcastFn("update", currentStateRef);
        }
      });
    });

    client.on("message", processMessage);

    client.on("error", (error) => {
      console.error("[openf1-mqtt] Connection error:", error.message);
    });

    client.on("close", () => {
      if (isRunning) {
        console.log("[openf1-mqtt] Disconnected — reconnecting in 5s...");
        reconnectTimeout = setTimeout(async () => {
          accessToken = null;
          connect();
        }, 5000);
      }
    });
  } catch (error) {
    console.error("[openf1-mqtt] Failed to connect:", error.message);
    if (isRunning) {
      console.log("[openf1-mqtt] Retrying in 10s...");
      reconnectTimeout = setTimeout(connect, 10000);
    }
  }
}

/**
 * Start MQTT live data streaming
 */
export async function startMQTT(broadcast, stateRef) {
  if (isRunning) {
    return true;
  }

  if (!process.env.OPENF1_USERNAME || !process.env.OPENF1_PASSWORD) {
    console.log("[openf1-mqtt] No credentials configured");
    return false;
  }

  // Check if there is an active session before connecting
  const sessionActive = await checkActiveSession();
  if (!sessionActive) {
    return false;
  }

  isRunning = true;
  broadcastFn = broadcast;
  currentStateRef = stateRef;

  // Initialize state structure
  if (!currentStateRef.session) currentStateRef.session = null;
  if (!currentStateRef.drivers) currentStateRef.drivers = {};
  if (!currentStateRef.timing) currentStateRef.timing = {};
  if (!currentStateRef.location) currentStateRef.location = {};
  if (!currentStateRef.lap_count)
    currentStateRef.lap_count = { current: 0, total: 0 };
  if (!currentStateRef.track_status)
    currentStateRef.track_status = { flag: "GREEN" };
  if (!currentStateRef.weather) currentStateRef.weather = null;
  if (!currentStateRef.race_control_messages)
    currentStateRef.race_control_messages = [];
  if (!currentStateRef.team_radio) currentStateRef.team_radio = [];
  if (!currentStateRef.car_data) currentStateRef.car_data = {};

  // Broadcast car telemetry at 500ms — car_data is ~3.7 Hz, too fast to broadcast per-message
  carDataTimer = setInterval(() => {
    if (carDataDirty && broadcastFn && currentStateRef) {
      broadcastFn("update", currentStateRef);
      carDataDirty = false;
    }
  }, 500);

  // Broadcast location at 250ms — location is ~3.7 Hz per driver (74 Hz with 20 drivers)
  locationTimer = setInterval(() => {
    if (locationDirty && broadcastFn && currentStateRef) {
      broadcastFn("update", currentStateRef);
      locationDirty = false;
    }
  }, 250);

  await connect();
  return true;
}

/**
 * Stop MQTT client
 */
export function stopMQTT() {
  console.log("[openf1-mqtt] Stopping...");
  isRunning = false;

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  if (carDataTimer) {
    clearInterval(carDataTimer);
    carDataTimer = null;
  }
  carDataDirty = false;

  if (locationTimer) {
    clearInterval(locationTimer);
    locationTimer = null;
  }
  locationDirty = false;

  if (client) {
    client.end(true);
    client = null;
  }

  accessToken = null;
  tokenExpiry = null;
  trackedSessionKey = null;
  sessionRefreshInFlight = false;
}

/**
 * Check if MQTT is running
 */
export function isMQTTRunning() {
  return isRunning;
}

/**
 * Check if MQTT credentials are configured
 */
export function hasMQTTCredentials() {
  return !!(process.env.OPENF1_USERNAME && process.env.OPENF1_PASSWORD);
}
