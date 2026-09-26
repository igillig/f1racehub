/**
 * Live Polling Mode - Real-time F1 data via REST API
 *
 * Polls OpenF1 REST API for live session data.
 * Free alternative to MQTT, with ~1-2 second latency.
 * Emits OpenF1-native (snake_case) format directly into currentStateRef.
 */

import {
  ensureTimingEntry,
  updateBestLap,
  getPitWindowStatus,
  flagToTrackStatus,
  detectSafetyCar,
  queueLocationFix,
} from "./state-utils.js";

const API_BASE = "https://api.openf1.org/v1";

// Polling configuration
const POLL_INTERVAL_MS = 2000; // Poll every 2 seconds

// State
let isRunning = false;
let pollInterval = null;
let broadcastFn = null;
let currentStateRef = null;
let currentSessionKey = null;
let lastPollTime = null;

// Track pit records we've already processed to avoid double-counting pit_count
const seenPitKeys = new Set();

/**
 * Fetch JSON with error handling
 */
async function fetchJSON(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    return await response.json();
  } catch (error) {
    console.error(`[live-polling] Fetch error: ${error.message}`);
    return [];
  }
}

/**
 * Get the current live session and write to currentStateRef.session
 */
async function getCurrentSession() {
  console.log("[live-polling] Looking for live session...");

  const sessions = await fetchJSON(`${API_BASE}/sessions?session_key=latest`);

  if (!sessions || sessions.length === 0) return null;

  const s = sessions[0];

  // Only start for sessions that are currently active or ended within the last 30 min.
  // Prevents live-polling from showing stale data from a session that ended hours ago.
  if (s.date_end) {
    const endDate = new Date(s.date_end);
    if (endDate < new Date(Date.now() - 30 * 60 * 1000)) {
      console.log(
        `[live-polling] Latest session ended at ${s.date_end} — not active, skipping`,
      );
      return null;
    }
  }

  console.log(
    `[live-polling] Found session: ${s.session_name} at ${s.location}`,
  );
  console.log(`[live-polling] Session key: ${s.session_key}`);

  if (currentStateRef) {
    currentStateRef.session = {
      session_key: s.session_key,
      session_name: s.session_name,
      session_type: s.session_type,
      circuit_key: s.circuit_key,
      circuit_short_name: s.circuit_short_name,
      country_name: s.country_name,
      country_code: s.country_code,
      date_start: s.date_start,
      date_end: s.date_end,
      location: s.location,
      meeting_name: s.meeting_name,
    };

    if (!currentStateRef.lap_count) {
      currentStateRef.lap_count = { current: 0, total: s.total_laps || 0 };
    } else if (s.total_laps) {
      // Always sync — may have been initialised as 0 before session was known
      currentStateRef.lap_count.total = s.total_laps;
    }
  }

  return s;
}

/**
 * Fetch current positions for all drivers in the session (no time filter).
 * Necessary when the proxy starts mid-race: the per-tick 3-second window
 * only captures recent changes, leaving drivers that haven't moved with
 * position = 0 / null.
 */
async function fetchInitialPositions(sessionKey) {
  const positions = await fetchJSON(
    `${API_BASE}/position?session_key=${sessionKey}`,
  );
  if (!positions || positions.length === 0) {
    console.log("[live-polling] No initial position data");
    return;
  }
  const latest = new Map();
  for (const p of positions) {
    const num = String(p.driver_number);
    const ts = new Date(p.date).getTime();
    if (!latest.has(num) || ts > latest.get(num).ts) {
      latest.set(num, { ts, position: p.position });
    }
  }
  for (const [num, data] of latest) {
    ensureTimingEntry(currentStateRef, num).position = data.position;
  }
  console.log(
    `[live-polling] Loaded initial positions for ${latest.size} drivers`,
  );
}

/**
 * Fetch drivers for the session and write to currentStateRef.drivers
 */
async function fetchDrivers(sessionKey) {
  const drivers = await fetchJSON(
    `${API_BASE}/drivers?session_key=${sessionKey}`,
  );

  if (currentStateRef) {
    // Replace entirely so stale drivers from a previous session don't persist
    currentStateRef.drivers = {};
    drivers.forEach((d) => {
      const num = String(d.driver_number);
      currentStateRef.drivers[num] = {
        driver_number: d.driver_number,
        name_acronym: d.name_acronym,
        full_name: d.full_name,
        team_name: d.team_name,
        team_colour: d.team_colour,
      };
    });
  }

  console.log(`[live-polling] Loaded ${drivers.length} drivers`);
  return drivers;
}

/**
 * Poll for latest data and update currentStateRef in OpenF1-native format
 */
async function pollData() {
  if (!currentSessionKey || !currentStateRef) return;

  const now = new Date();
  // Look back 3 seconds to catch any delayed data
  const since = new Date(now.getTime() - 3000);
  const sinceISO = since.toISOString();

  const urls = [
    `${API_BASE}/position?session_key=${currentSessionKey}&date>=${sinceISO}`,
    `${API_BASE}/intervals?session_key=${currentSessionKey}&date>=${sinceISO}`,
    `${API_BASE}/laps?session_key=${currentSessionKey}&date_start>=${sinceISO}`,
    `${API_BASE}/location?session_key=${currentSessionKey}&date>=${sinceISO}`,
    `${API_BASE}/race_control?session_key=${currentSessionKey}&date>=${sinceISO}`,
    `${API_BASE}/team_radio?session_key=${currentSessionKey}&date>=${sinceISO}`,
    `${API_BASE}/stints?session_key=${currentSessionKey}`,
    `${API_BASE}/pit?session_key=${currentSessionKey}&date>=${sinceISO}`,
  ];

  try {
    const [
      positions,
      intervals,
      laps,
      locations,
      raceControl,
      teamRadio,
      stints,
      pits,
    ] = await Promise.all(urls.map(fetchJSON));

    // --- Positions ---
    if (positions && positions.length > 0) {
      // Latest per driver by date
      const latest = new Map();
      for (const p of positions) {
        const num = String(p.driver_number);
        const t = new Date(p.date).getTime();
        if (!latest.has(num) || t > latest.get(num).t) {
          latest.set(num, { t, position: p.position });
        }
      }
      for (const [num, data] of latest) {
        ensureTimingEntry(currentStateRef, num).position = data.position;
      }
    }

    // --- Intervals ---
    if (intervals && intervals.length > 0) {
      const latest = new Map();
      for (const i of intervals) {
        const num = String(i.driver_number);
        const t = new Date(i.date).getTime();
        if (!latest.has(num) || t > latest.get(num).t) {
          latest.set(num, {
            t,
            gap_to_leader: i.gap_to_leader,
            interval: i.interval,
          });
        }
      }
      for (const [num, data] of latest) {
        const entry = ensureTimingEntry(currentStateRef, num);
        // Leader has gap_to_leader = 0 or null — normalize to null
        entry.gap_to_leader =
          data.gap_to_leader === 0 || data.gap_to_leader == null
            ? null
            : data.gap_to_leader;
        entry.interval = data.interval ?? null;
      }
    }

    // --- Laps ---
    if (laps && laps.length > 0) {
      // Latest per driver by lap_number
      const latest = new Map();
      for (const l of laps) {
        const num = String(l.driver_number);
        if (!latest.has(num) || l.lap_number > latest.get(num).lap_number) {
          latest.set(num, l);
        }
      }
      for (const [num, l] of latest) {
        const entry = ensureTimingEntry(currentStateRef, num);
        const isTimed = !l.is_pit_out_lap && l.lap_duration != null && l.lap_duration < 600;
        entry.last_lap = isTimed ? l.lap_duration : null;
        entry.last_lap_is_pb = isTimed
          ? updateBestLap(entry, l.lap_duration, l.is_pit_out_lap)
          : false;
        entry.lap_number = l.lap_number;
        entry.sector_1 = l.duration_sector_1 ?? null;
        entry.sector_2 = l.duration_sector_2 ?? null;
        entry.sector_3 = l.duration_sector_3 ?? null;
        entry.segments_1 = Array.isArray(l.segments_sector_1)
          ? l.segments_sector_1
          : [];
        entry.segments_2 = Array.isArray(l.segments_sector_2)
          ? l.segments_sector_2
          : [];
        entry.segments_3 = Array.isArray(l.segments_sector_3)
          ? l.segments_sector_3
          : [];
        entry.is_pit_out_lap = l.is_pit_out_lap || false;

        // Update global lap counter
        if (!currentStateRef.lap_count)
          currentStateRef.lap_count = { current: 0, total: 0 };
        if (l.lap_number > currentStateRef.lap_count.current) {
          currentStateRef.lap_count.current = l.lap_number;
        }
      }
    }

    // --- Locations ---
    if (locations && locations.length > 0) {
      if (!currentStateRef.location) currentStateRef.location = {};
      const latest = new Map();
      for (const l of locations) {
        const num = String(l.driver_number);
        const t = new Date(l.date).getTime();
        if (!latest.has(num) || t > latest.get(num).t) {
          latest.set(num, { t, x: l.x, y: l.y });
        }
      }
      for (const [num, data] of latest) {
        // Carry the fix's own timestamp — the track map plays GPS back on it.
        currentStateRef.location[num] = { x: data.x, y: data.y, t: data.t };
        queueLocationFix(currentStateRef, num, data.x, data.y, data.t);
      }
    }

    // --- Race Control ---
    if (raceControl && raceControl.length > 0) {
      if (!currentStateRef.race_control_messages) {
        currentStateRef.race_control_messages = [];
      }
      for (const msg of raceControl) {
        const exists = currentStateRef.race_control_messages.some(
          (m) => m.date === msg.date && m.message === msg.message,
        );
        if (!exists) {
          currentStateRef.race_control_messages.push({
            date: msg.date,
            message: msg.message,
            flag: msg.flag || null,
            category: msg.category || null,
            scope: msg.scope || null,
            sector: msg.sector || null,
            driver_number: msg.driver_number || null,
            lap_number: msg.lap_number || null,
          });

          if (currentStateRef.race_control_messages.length > 50) {
            currentStateRef.race_control_messages =
              currentStateRef.race_control_messages.slice(-50);
          }

          // Update track status from flag
          if (msg.flag && msg.scope === "Track") {
            const statusFromFlag = flagToTrackStatus(msg.flag);
            if (statusFromFlag) {
              currentStateRef.track_status = { flag: statusFromFlag };
            }
          }

          // Detect safety car from message text
          if (msg.category === "SafetyCar") {
            const sc = detectSafetyCar(msg.message);
            if (sc) {
              currentStateRef.track_status = { flag: sc };
            }
          }
        }
      }
    }

    // --- Team Radio ---
    if (teamRadio && teamRadio.length > 0) {
      if (!currentStateRef.team_radio) currentStateRef.team_radio = [];
      for (const radio of teamRadio) {
        const exists = currentStateRef.team_radio.some(
          (r) => r.recording_url === radio.recording_url,
        );
        if (!exists) {
          currentStateRef.team_radio.push({
            date: radio.date,
            driver_number: radio.driver_number,
            recording_url: radio.recording_url,
          });

          if (currentStateRef.team_radio.length > 30) {
            currentStateRef.team_radio = currentStateRef.team_radio.slice(-30);
          }

          const driverAcronym =
            currentStateRef.drivers?.[String(radio.driver_number)]
              ?.name_acronym;
          console.log(
            `[live-polling] Team Radio: ${driverAcronym || radio.driver_number}`,
          );
        }
      }
    }

    // --- Stints ---
    if (stints && stints.length > 0) {
      // Latest stint per driver by stint_number
      const latest = new Map();
      for (const s of stints) {
        const num = String(s.driver_number);
        if (!latest.has(num) || s.stint_number > latest.get(num).stint_number) {
          latest.set(num, s);
        }
      }
      for (const [num, s] of latest) {
        const entry = ensureTimingEntry(currentStateRef, num);
        entry.compound = s.compound || "UNKNOWN";
        entry.tyre_age_at_start = s.tyre_age_at_start || 0;
        entry.stint_lap_start = s.lap_start ?? entry.stint_lap_start;
        entry.stint_number = s.stint_number || 0;
        // Compute current tyre age: base age + laps done in this stint
        const currentLap = entry.lap_number || 0;
        const lapStart = entry.stint_lap_start;
        entry.tyre_age = (lapStart != null && currentLap >= lapStart)
          ? Math.max(0, currentLap - lapStart) + entry.tyre_age_at_start
          : entry.tyre_age_at_start;
      }
    }

    // --- Pits ---
    if (pits && pits.length > 0) {
      for (const p of pits) {
        if (!p.date || !p.lane_duration) continue;
        const num = String(p.driver_number);
        const pitKey = `${num}_${p.date}`;

        const entry = ensureTimingEntry(currentStateRef, num);

        // Count each unique pit record once
        if (!seenPitKeys.has(pitKey)) {
          seenPitKeys.add(pitKey);
          entry.pit_count = (entry.pit_count || 0) + 1;
        }

        // Pit windows only mark in_pit in race-like sessions: in
        // Practice/Quali, lane_duration windows routinely cover on-track
        // laps and would flag drivers in-pit while they're setting times.
        const sessionType = currentStateRef.session?.session_type;
        if (sessionType !== "Race" && sessionType !== "Sprint") continue;

        const { in_pit, remaining_ms } = getPitWindowStatus(
          p.date,
          p.lane_duration,
        );
        if (in_pit) {
          entry.in_pit = true;
          setTimeout(() => {
            const e = currentStateRef?.timing?.[num];
            if (e) {
              e.in_pit = false;
              if (broadcastFn) broadcastFn("update", currentStateRef);
            }
          }, remaining_ms + 1000);
        }
      }
    }

    // Broadcast update
    if (broadcastFn) {
      broadcastFn("update", currentStateRef);
    }

    lastPollTime = now;
  } catch (error) {
    console.error("[live-polling] Error polling data:", error.message);
  }
}

/**
 * Fetch historical race_control and team_radio and write to currentStateRef
 */
async function fetchHistoricalData(sessionKey) {
  console.log(
    `[live-polling] Fetching historical data for session ${sessionKey}...`,
  );

  try {
    const [raceControl, teamRadio] = await Promise.all([
      fetchJSON(`${API_BASE}/race_control?session_key=${sessionKey}`),
      fetchJSON(`${API_BASE}/team_radio?session_key=${sessionKey}`),
    ]);

    if (raceControl.length > 0) {
      console.log(
        `[live-polling] Loaded ${raceControl.length} historical race control messages`,
      );
      if (!currentStateRef.race_control_messages) {
        currentStateRef.race_control_messages = [];
      }
      for (const msg of raceControl) {
        currentStateRef.race_control_messages.push({
          date: msg.date,
          message: msg.message,
          flag: msg.flag || null,
          category: msg.category || null,
          scope: msg.scope || null,
          sector: msg.sector || null,
          driver_number: msg.driver_number || null,
          lap_number: msg.lap_number || null,
        });
      }
      if (currentStateRef.race_control_messages.length > 50) {
        currentStateRef.race_control_messages =
          currentStateRef.race_control_messages.slice(-50);
      }
    }

    if (teamRadio.length > 0) {
      console.log(
        `[live-polling] Loaded ${teamRadio.length} historical team radios`,
      );
      if (!currentStateRef.team_radio) currentStateRef.team_radio = [];
      for (const radio of teamRadio) {
        currentStateRef.team_radio.push({
          date: radio.date,
          driver_number: radio.driver_number,
          recording_url: radio.recording_url,
        });
      }
      if (currentStateRef.team_radio.length > 30) {
        currentStateRef.team_radio = currentStateRef.team_radio.slice(-30);
      }
    }
  } catch (error) {
    console.error(
      "[live-polling] Error fetching historical data:",
      error.message,
    );
  }
}

/**
 * Start live polling
 */
export async function startLivePolling(broadcast, stateRef) {
  if (isRunning) {
    console.log("[live-polling] Already running");
    return true;
  }

  broadcastFn = broadcast;
  currentStateRef = stateRef;

  // Initialize top-level state keys if absent
  if (!currentStateRef.session) currentStateRef.session = {};
  if (!currentStateRef.drivers) currentStateRef.drivers = {};
  if (!currentStateRef.timing) currentStateRef.timing = {};
  if (!currentStateRef.location) currentStateRef.location = {};
  if (!currentStateRef.lap_count)
    currentStateRef.lap_count = { current: 0, total: 0 };
  if (!currentStateRef.track_status)
    currentStateRef.track_status = { flag: "GREEN" };
  if (!currentStateRef.race_control_messages)
    currentStateRef.race_control_messages = [];
  if (!currentStateRef.team_radio) currentStateRef.team_radio = [];

  // Get current session
  const session = await getCurrentSession();
  if (!session) {
    console.log("[live-polling] No active session found");
    return false;
  }

  // If a different session was already loaded (e.g. replay or previous session),
  // clear all session-scoped state so stale drivers/timing don't bleed in.
  const prevSessionKey = currentStateRef.session?.session_key;
  if (
    prevSessionKey &&
    String(prevSessionKey) !== String(session.session_key)
  ) {
    console.log(
      `[live-polling] Session changed (${prevSessionKey} → ${session.session_key}) — clearing stale state`,
    );
    currentStateRef.timing = {};
    currentStateRef.drivers = {};
    currentStateRef.location = {};
    currentStateRef.race_control_messages = [];
    currentStateRef.team_radio = [];
    currentStateRef.lap_count = { current: 0, total: 0 };
    seenPitKeys.clear();
    // Notify connected clients so they can reset their local driver state
    if (broadcastFn) broadcastFn("reset", { session_key: session.session_key });
  }

  currentSessionKey = session.session_key;

  // Fetch drivers
  await fetchDrivers(currentSessionKey);

  // Fetch initial positions for all drivers (handles proxy starting mid-race)
  await fetchInitialPositions(currentSessionKey);

  // Fetch historical data
  await fetchHistoricalData(currentSessionKey);

  // Start polling
  isRunning = true;
  console.log(`[live-polling] Starting polling every ${POLL_INTERVAL_MS}ms...`);

  // Initial poll
  await pollData();

  // Start interval
  pollInterval = setInterval(pollData, POLL_INTERVAL_MS);

  return true;
}

/**
 * Stop live polling
 */
export function stopLivePolling() {
  console.log("[live-polling] Stopping...");
  isRunning = false;

  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }

  currentSessionKey = null;
  lastPollTime = null;
  seenPitKeys.clear();
}

/**
 * Check if live polling is running
 */
export function isLivePollingRunning() {
  return isRunning;
}
