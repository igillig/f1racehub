/**
 * F1 SignalR Client — Live Timing (Segments + Sector Times)
 *
 * Connects to the official F1 live timing SignalR endpoint in parallel with
 * MQTT to get real-time per-segment status updates and live sector times.
 *
 * OpenF1 (MQTT/REST) only delivers segments once a lap is COMPLETE.
 * The official F1 SignalR feed pushes each segment as the car crosses it,
 * which is what makes mini-sectors light up live.
 *
 * This client ONLY writes to:
 *   state.timing[num].segments_1 / _2 / _3
 *   state.timing[num].sector_1   / _2 / _3
 *   state.track_status
 *   state.drivers[num] (team name/colour — null in OpenF1 during live sessions)
 *
 * Everything else (position, gaps, tires, pit stops, etc.) stays with MQTT.
 *
 * Log tag: [signalr]
 */

import WebSocket from "ws";
import zlib from "zlib";
import { ensureTimingEntry, queueLocationFix } from "./state-utils.js";
import { insertSignalREvent } from "./session-store.js";

const SIGNALR_HOST = "livetiming.formula1.com";
// SignalR Core (modern ASP.NET Core SignalR). Since ~2025 F1 migrated here and
// gated it behind auth — the old /signalr/ classic endpoint now returns 401 for
// everyone. Access requires a JWT obtained from a formula1.com login, passed as
// the `authToken` query param (see proxy/.env.example for how to get it).
const NEGOTIATE_URL = `https://${SIGNALR_HOST}/signalrcore/negotiate?negotiateVersion=1`;
const WS_BASE = `wss://${SIGNALR_HOST}/signalrcore`;

// SignalR Core's JSON protocol delimits each message with the 0x1e record separator.
const RS = "\x1e";

// Topics: TimingData for live segments/sector times, TimingStats for personal best sectors,
// TrackStatus and ExtrapolatedClock as fast overrides (OpenF1 MQTT doesn't provide these live).
// DriverList because OpenF1 delivers team_name/team_colour as null during live
// sessions (backfilled only after the session ends).
const SUBSCRIBE_TOPICS = [
  // Already processed live
  "TimingData",
  "TimingStats",
  "TrackStatus",
  "ExtrapolatedClock",
  "LapCount",
  "DriverList",
  "Position.z",          // compressed GPS — gated (Pro entitlement); recorded if delivered
  // New: processed live + recorded
  "RaceControlMessages", // real-time flags with marshal sector — faster than OpenF1 MQTT
  "WeatherData",         // real-time weather
  "TimingAppData",       // tyre compound + stint info in real time
  // New: recorded only (live processing deferred)
  "CarData.z",           // compressed telemetry — gated (Pro); recorded if delivered
  "SessionInfo",         // session metadata
  "SessionData",         // session status series (Started/Ends/etc.)
  "TeamRadio",           // audio URLs
];

const COMMON_HEADERS = {
  "User-Agent": "BestHTTP",
  "Accept-Encoding": "gzip, identity",
};

let ws = null;
let currentStateRef = null;
let broadcastFn = null;
let isRunning = false;
let reconnectTimeout = null;
let pingInterval = null;

// Raw message debug buffer — last 20 messages per topic
const RAW_SIGNALR_BUFFER = {};
const RAW_SIGNALR_MAX = 20;

function recordRawSignalR(topic, data) {
  if (!RAW_SIGNALR_BUFFER[topic]) RAW_SIGNALR_BUFFER[topic] = [];
  // For TimingData, extract only the Retired/InPit fields to keep payloads small
  let stored = data;
  if (topic === "TimingData" && data?.Lines) {
    const lines = {};
    for (const [num, d] of Object.entries(data.Lines)) {
      if (!d) continue;
      const relevant = {};
      if (d.Retired !== undefined) relevant.Retired = d.Retired;
      if (d.ShowPosition !== undefined) relevant.ShowPosition = d.ShowPosition;
      if (d.InPit !== undefined) relevant.InPit = d.InPit;
      if (d.PitOut !== undefined) relevant.PitOut = d.PitOut;
      if (d.Position !== undefined) relevant.Position = d.Position;
      if (d.KnockedOut !== undefined) relevant.KnockedOut = d.KnockedOut;
      if (Object.keys(relevant).length > 0) lines[num] = relevant;
    }
    stored = { Lines: lines, SessionPart: data.SessionPart };
  }
  RAW_SIGNALR_BUFFER[topic].push({ ts: new Date().toISOString(), data: stored });
  if (RAW_SIGNALR_BUFFER[topic].length > RAW_SIGNALR_MAX) {
    RAW_SIGNALR_BUFFER[topic].shift();
  }
}

export function getRawSignalRDebug() {
  return {
    connected: isRunning && ws !== null,
    buffer: RAW_SIGNALR_BUFFER,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse an F1 lap/sector time string ("1:23.456" or "23.456") to seconds.
 * Returns null if the string is empty, zero, or unparseable.
 */
function parseF1Time(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(":");
  if (colon !== -1) {
    const mins = parseInt(trimmed.slice(0, colon), 10);
    const secs = parseFloat(trimmed.slice(colon + 1));
    if (isNaN(mins) || isNaN(secs)) return null;
    const total = mins * 60 + secs;
    return total > 0 ? total : null;
  }
  const v = parseFloat(trimmed);
  return isNaN(v) || v <= 0 ? null : v;
}

/**
 * Parse an F1 gap/interval string ("+1.151", "LAPPED", "+1 LAP", "") into the
 * shape the frontend's formatGap expects: null for the leader (empty diff),
 * a number of seconds for a numeric gap, or the raw string for lapped cars.
 */
function parseTimeDiff(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null; // leader: TimeDiffToFastest is empty
  if (/lap/i.test(s)) return s; // "+1 LAP" / "LAPPED" — keep as string
  const num = parseFloat(s.replace(/^\+/, ""));
  return Number.isFinite(num) && num > 0 ? num : null;
}

// ── Message handlers ─────────────────────────────────────────────────────────

/**
 * Apply a (possibly sparse/incremental) TimingData update.
 *
 * The SignalR feed sends partial objects — only changed fields are present.
 * We deep-merge each segment and sector value into the existing state entry
 * so that a single-segment update doesn't wipe the rest of the array.
 *
 * @param {Object}  data        TimingData payload from SignalR
 * @param {boolean} isSnapshot  true when this is the full initial snapshot (msg.R),
 *                              false for incremental live-feed messages (msg.M).
 *                              Snapshots are treated as authoritative: an absent InPit
 *                              field means the car is NOT in the pit lane.
 */
function processTimingData(data, isSnapshot = false) {
  if (!currentStateRef || !data?.Lines) return;

  let changed = false;

  // SessionPart — 1=Q1/SQ1, 2=Q2/SQ2, 3=Q3/SQ3
  // SignalR sends this at the top level of TimingData when a new part starts.
  if (data.SessionPart != null && currentStateRef.session) {
    const part = parseInt(data.SessionPart, 10);
    if (!isNaN(part)) {
      const prevPart = currentStateRef.session.qualifying_part ?? 0;
      currentStateRef.session.qualifying_part = part;
      // SessionPart only arrives in Qualifying/Sprint Qualifying. If the stored
      // session name is from a prior session (e.g. "Practice 3"), correct it now
      // so the frontend doesn't show "Practice 3 · Q2".
      const storedType = (currentStateRef.session.session_type ?? "").toLowerCase();
      if (!storedType.includes("qualifying")) {
        const oldName = currentStateRef.session.session_name;
        currentStateRef.session.session_type = "Qualifying";
        currentStateRef.session.session_name = "Qualifying";
        console.log(
          `[signalr] SessionPart received but session was "${oldName}" — corrected to Qualifying`,
        );
      }
      // When advancing to a new qualifying segment, wipe all per-lap timing so
      // stale Q1/Q2 times don't bleed into the new segment's leaderboard.
      if (part > prevPart && currentStateRef.timing) {
        for (const entry of Object.values(currentStateRef.timing)) {
          entry.best_lap = null;
          entry.last_lap = null;
          entry.last_lap_is_pb = false;
          entry.sector_1 = null;
          entry.sector_2 = null;
          entry.sector_3 = null;
          entry.best_sector_1 = null;
          entry.best_sector_2 = null;
          entry.best_sector_3 = null;
          entry.segments_1 = [];
          entry.segments_2 = [];
          entry.segments_3 = [];
          entry.gap_to_leader = null;
          entry.interval = null;
        }
        // Also clear the CHEQUERED flag — the end-of-segment flag must not
        // persist into the next segment while waiting for SignalR's GREEN update.
        currentStateRef.track_status = { flag: "GREEN" };
        currentStateRef._signalrTrackStatusSet = true;
        console.log(
          `[signalr] Qualifying part advanced to Q${part} — timing data and track status cleared`,
        );
      }
      changed = true;
    }
  }

  for (const [driverNum, driverData] of Object.entries(data.Lines)) {
    if (!driverData || typeof driverData !== "object") continue;

    const num = String(driverNum);
    const entry = ensureTimingEntry(currentStateRef, num);

    // Race position — present in every TimingData snapshot and incremental update.
    // More reliable than MQTT v1/position which only fires on position changes.
    if (driverData.Position != null) {
      const pos = parseInt(String(driverData.Position), 10);
      if (!isNaN(pos) && pos > 0) {
        entry.position = pos;
        changed = true;
      }
    }

    // Gap to leader (TimeDiffToFastest) and interval to the car ahead
    // (TimeDiffToPositionAhead). SignalR is the authoritative live source for
    // both — OpenF1 MQTT only fires intervals on change and is ~4s behind.
    if (driverData.TimeDiffToFastest !== undefined) {
      entry.gap_to_leader = parseTimeDiff(driverData.TimeDiffToFastest);
      changed = true;
    }
    if (driverData.TimeDiffToPositionAhead !== undefined) {
      entry.interval = parseTimeDiff(driverData.TimeDiffToPositionAhead);
      changed = true;
    }

    // Current lap number and pit-stop count ("Line" is F1's pit counter).
    if (driverData.NumberOfLaps != null) {
      const laps = parseInt(String(driverData.NumberOfLaps), 10);
      if (!isNaN(laps)) {
        entry.lap_number = laps;
        changed = true;
      }
    }
    if (driverData.Line != null) {
      const pits = parseInt(String(driverData.Line), 10);
      if (!isNaN(pits)) {
        entry.pit_count = pits;
        changed = true;
      }
    }

    // InPit / PitOut — real-time pit lane detection.
    // This is the only reliable source: OpenF1 REST/MQTT only provides pit data
    // after the stop is complete (lane_duration present), so cars currently in
    // the pit lane (e.g. during a red flag) would never show in_pit=true there.
    //
    // Snapshot vs incremental distinction matters here:
    // - Incremental (isSnapshot=false): absent InPit means "no change" — only
    //   update when the field is explicitly present.
    // - Snapshot (isSnapshot=true): the payload is the complete current state.
    //   An absent InPit means the car is NOT in the pit — treat it as false.
    //   This prevents stale in_pit=true values from persisting across reconnects
    //   (e.g. after a red flag where all cars pitted, then the race restarted
    //   but some InPit:false updates were missed during a brief disconnect).
    if (driverData.InPit === true) {
      entry.in_pit = true;
      entry.is_pit_out_lap = false; // entering pit again cancels any prior pit-out state
      changed = true;
    } else if (driverData.InPit === false || driverData.PitOut === true) {
      entry.in_pit = false;
      if (driverData.PitOut === true) {
        // Driver just exited the pit — show OUT badge immediately.
        // MQTT v1/laps will eventually overwrite this when the pit-out lap completes.
        entry.is_pit_out_lap = true;
      }
      changed = true;
    } else if (isSnapshot && entry.in_pit) {
      // Snapshot is authoritative: car not shown as InPit:true → must be on track.
      entry.in_pit = false;
      changed = true;
    }

    // BestLapTime / LastLapTime — authoritative source for qualifying best/last laps.
    // SignalR resets these between Q1/Q2/Q3, so the snapshot correctly reflects
    // the current part's state. Setting _signalrTimingInit tells MQTT historical
    // lap loading to skip overwriting these with data from prior qualifying parts.
    if (driverData.BestLapTime !== undefined) {
      const seconds = parseF1Time(driverData.BestLapTime?.Value);
      entry.best_lap = seconds; // null when Value is "" (no time set this part)
      entry._signalrTimingInit = true;
      changed = true;
    }
    if (driverData.LastLapTime !== undefined) {
      const seconds = parseF1Time(driverData.LastLapTime?.Value);
      // Reject values >=150s — SignalR sometimes sends elapsed session time
      // (e.g. "21:56.685" or "9:24.xxx") instead of a real lap time for drivers
      // who haven't completed a lap in the current qualifying part yet. A real
      // F1 lap never exceeds ~2:30 (150s), and replay.js uses the same bound to
      // decide what counts as a timed lap.
      if (seconds != null && seconds < 150) {
        entry.last_lap = seconds;
      } else {
        entry.last_lap = null;
      }
      changed = true;
    }

    // KnockedOut — driver eliminated from qualifying (Q1/Q2 cutoff).
    // SignalR sets this to true once the segment ends and the driver didn't advance.
    if (driverData.KnockedOut === true) {
      entry.knocked_out = true;
      changed = true;
    } else if (driverData.KnockedOut === false) {
      entry.knocked_out = false;
      changed = true;
    }

    // Retired — driver has stopped/retired from the race.
    // NOTE: `Retired` is the authoritative retirement flag. We do NOT infer
    // retirement from `ShowPosition:false` — F1 sets ShowPosition:false for
    // garage-bound cars in the pre-session snapshot, which would mark the whole
    // grid as retired at session start (dimmed table + cars pulled off the map).
    if (driverData.Retired === true) {
      entry.retired = true;
      changed = true;
    } else if (driverData.Retired === false) {
      entry.retired = false;
      changed = true;
    }

    const sectors = driverData.Sectors;
    if (!sectors || typeof sectors !== "object") continue;

    for (const [sectorIdxStr, sectorData] of Object.entries(sectors)) {
      if (!sectorData || typeof sectorData !== "object") continue;

      const sIdx = parseInt(sectorIdxStr, 10); // 0, 1, or 2
      if (isNaN(sIdx) || sIdx < 0 || sIdx > 2) continue;

      const segKey = `segments_${sIdx + 1}`; // segments_1 / _2 / _3
      const sectorKey = `sector_${sIdx + 1}`; // sector_1   / _2 / _3

      // Completed sector time (e.g. "25.123") — present when the sector finishes
      if (sectorData.Value !== undefined) {
        const seconds = parseF1Time(sectorData.Value);
        if (seconds != null) {
          entry[sectorKey] = seconds;
          changed = true;
        }
      }

      // Individual segment status updates — sparse, only changed segments present
      const segs = sectorData.Segments;
      if (segs && typeof segs === "object") {
        if (!Array.isArray(entry[segKey])) entry[segKey] = [];

        for (const [segIdxStr, segData] of Object.entries(segs)) {
          const sj = parseInt(segIdxStr, 10);
          if (isNaN(sj)) continue;

          const status = segData?.Status;
          if (status !== undefined) {
            // Grow the array if needed
            while (entry[segKey].length <= sj) entry[segKey].push(0);
            entry[segKey][sj] = status;
            changed = true;
          }
        }
      }
    }
  }

  if (changed && broadcastFn && currentStateRef) {
    broadcastFn("update", currentStateRef);
  }
}

/**
 * Fast track-status override from the official feed.
 * Status codes: "1"=Green, "2"=Yellow, "4"=SC, "5"=Red, "6"=VSC, "7"=Chequered
 */
const STATUS_TO_FLAG = {
  1: "GREEN",
  2: "YELLOW",
  4: "SC",
  5: "RED",
  6: "VSC",
  // SignalR 7 = VSCEnding (transitional — delta still active until AllClear).
  // The real chequered arrives via OpenF1 race_control flag:"CHEQUERED".
  7: "VSC ENDING",
};

function processTrackStatus(data) {
  if (!currentStateRef || !data) return;
  const flag = STATUS_TO_FLAG[String(data.Status)];
  if (flag) {
    // Mark as set by SignalR so MQTT historical data cannot overwrite it
    currentStateRef._signalrTrackStatusSet = true;
    currentStateRef.track_status = { flag };
    if (broadcastFn) broadcastFn("update", currentStateRef);
  }
}

/**
 * ExtrapolatedClock — provides session remaining time.
 * OpenF1 MQTT has no equivalent; this is the only live source.
 * Format: { Utc: "2026-05-22T14:23:45Z", Remaining: "0:18:32", Extrapolating: true }
 */
function processExtrapolatedClock(data) {
  if (!currentStateRef || !data) return;
  const remaining = data.Remaining ?? data.remaining;
  const utc = data.Utc ?? data.utc;
  const extrapolating = data.Extrapolating ?? data.extrapolating ?? true;
  if (remaining && utc) {
    currentStateRef.clock = { remaining, utc, extrapolating };
    if (broadcastFn) broadcastFn("update", currentStateRef);
  }
}

/**
 * TimingStats — personal best sector times per driver.
 * Lines[num].BestSectors[0/1/2].Value contains the driver's best time for that sector.
 */
function processTimingStats(data) {
  if (!currentStateRef || !data?.Lines) return;

  let changed = false;

  for (const [driverNum, driverData] of Object.entries(data.Lines)) {
    if (!driverData || typeof driverData !== "object") continue;

    const num = String(driverNum);
    const entry = ensureTimingEntry(currentStateRef, num);

    const bestSectors = driverData.BestSectors;
    if (bestSectors && typeof bestSectors === "object") {
      for (const [sectorIdxStr, sectorData] of Object.entries(bestSectors)) {
        if (!sectorData || typeof sectorData !== "object") continue;
        const sIdx = parseInt(sectorIdxStr, 10); // 0, 1, or 2
        if (isNaN(sIdx) || sIdx < 0 || sIdx > 2) continue;
        const key = `best_sector_${sIdx + 1}`; // best_sector_1/2/3
        if (sectorData.Value !== undefined) {
          const seconds = parseF1Time(sectorData.Value);
          if (seconds != null) {
            entry[key] = seconds;
            changed = true;
          }
        }
      }
    }
  }

  if (changed && broadcastFn && currentStateRef) {
    broadcastFn("update", currentStateRef);
  }
}

/**
 * LapCount — current and total laps for Race/Sprint sessions.
 * Format: { CurrentLap: 24, TotalLaps: 68 }
 */
function processLapCount(data) {
  if (!currentStateRef || !data) return;
  const current = data.CurrentLap ?? data.currentLap;
  const total = data.TotalLaps ?? data.totalLaps;
  if (current != null || total != null) {
    if (!currentStateRef.lap_count)
      currentStateRef.lap_count = { current: 0, total: 0 };
    if (current != null) currentStateRef.lap_count.current = current;
    if (total != null) currentStateRef.lap_count.total = total;
    if (broadcastFn) broadcastFn("update", currentStateRef);
  }
}

/**
 * DriverList — driver info keyed by racing number.
 * Format: { "1": { Tla, FullName, TeamName, TeamColour, ... }, "_kf": true }
 * Updates can be sparse (only changed fields present), so merge field-by-field
 * and never overwrite an existing value with an absent one. TeamColour is a
 * hex string without "#", same format as OpenF1's team_colour.
 */
function processDriverList(data) {
  if (!currentStateRef || !data || typeof data !== "object") return;

  if (!currentStateRef.drivers) currentStateRef.drivers = {};
  let changed = false;

  for (const [driverNum, info] of Object.entries(data)) {
    if (!info || typeof info !== "object") continue; // skips "_kf" flag
    const num = String(driverNum);
    const existing = currentStateRef.drivers[num] || {
      driver_number: parseInt(num, 10),
      name_acronym: null,
      full_name: null,
      team_name: null,
      team_colour: null,
    };

    const merged = {
      ...existing,
      name_acronym: info.Tla ?? existing.name_acronym,
      full_name: info.FullName ?? existing.full_name,
      team_name: info.TeamName ?? existing.team_name,
      team_colour: info.TeamColour ?? existing.team_colour,
    };

    if (
      merged.name_acronym !== existing.name_acronym ||
      merged.full_name !== existing.full_name ||
      merged.team_name !== existing.team_name ||
      merged.team_colour !== existing.team_colour ||
      !currentStateRef.drivers[num]
    ) {
      currentStateRef.drivers[num] = merged;
      changed = true;
    }
  }

  if (changed && broadcastFn) broadcastFn("update", currentStateRef);
}

/**
 * SessionInfo — session + meeting metadata. SignalR is the only live source in
 * signalr-only mode (no OpenF1 /sessions). Maps onto the OpenF1Session shape the
 * frontend already consumes, so no frontend change is needed.
 *
 * Format: { Key, Type, Number, Name, StartDate, EndDate, GmtOffset, Path,
 *           Meeting: { Key, Name, Location, Country: {Key, Code, Name},
 *                      Circuit: { Key, ShortName } }, SessionStatus, ... }
 */
let f1SessionPath = "";

function processSessionInfo(data) {
  if (!currentStateRef || !data) return;
  const meeting = data.Meeting || {};
  const circuit = meeting.Circuit || {};
  const country = meeting.Country || {};

  const endDate = data.EndDate ? new Date(data.EndDate) : null;
  // Same guard as OpenF1 handleSession: only expose date_end once the session is
  // truly over (>30 min past), otherwise a premature EndDate would flip isLive
  // to false mid-session and dump every car to the pit lane.
  const endIsPast =
    endDate && endDate < new Date(Date.now() - 30 * 60 * 1000);

  const type = data.Type || "Practice";
  const sessionType =
    type === "SprintShootout" || type === "SprintQualifying"
      ? "Sprint Shootout"
      : type;

  currentStateRef.session = {
    session_key: data.Key,
    session_name: data.Name || sessionType,
    session_type: sessionType,
    circuit_key: circuit.Key,
    circuit_short_name: circuit.ShortName || meeting.Location,
    country_name: country.Name,
    country_code: country.Code,
    date_start: data.StartDate,
    date_end: endIsPast ? data.EndDate : null,
    location: meeting.Location,
    meeting_name: meeting.Name || meeting.Location,
  };

  if (data.Path) f1SessionPath = data.Path;
  if (broadcastFn) broadcastFn("update", currentStateRef);
}

/**
 * WeatherData — live weather. Maps F1 field names onto the OpenF1 weather shape.
 * Values arrive as strings ("24.5", "0"), so coerce to numbers.
 */
function processWeatherData(data) {
  if (!currentStateRef || !data) return;
  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  currentStateRef.weather = {
    air_temperature: num(data.AirTemp),
    track_temperature: num(data.TrackTemp),
    humidity: num(data.Humidity),
    pressure: num(data.Pressure),
    rainfall: data.Rainfall === "1" || data.Rainfall === 1 || data.Rainfall === true,
    wind_speed: num(data.WindSpeed),
    wind_direction: num(data.WindDirection),
  };
  if (broadcastFn) broadcastFn("update", currentStateRef);
}

/**
 * TeamRadio — live team radio clip metadata. Builds the full static media URL
 * from the session Path + clip Path, matching the "full URL" the frontend
 * expects from OpenF1's recording_url.
 */
function processTeamRadio(data) {
  if (!currentStateRef || !data?.Captures) return;
  if (!Array.isArray(currentStateRef.team_radio)) {
    currentStateRef.team_radio = [];
  }
  let added = false;
  for (const capture of Object.values(data.Captures)) {
    if (!capture || !capture.Path) continue;
    const url = `https://livetiming.formula1.com/static/${f1SessionPath}${capture.Path}`;
    if (currentStateRef.team_radio.some((r) => r.recording_url === url)) continue;
    currentStateRef.team_radio.push({
      date: capture.Utc,
      driver_number: parseInt(capture.RacingNumber, 10) || null,
      recording_url: url,
    });
    added = true;
  }
  if (added) {
    if (currentStateRef.team_radio.length > 30) {
      currentStateRef.team_radio = currentStateRef.team_radio.slice(-30);
    }
    if (broadcastFn) broadcastFn("update", currentStateRef);
  }
}

/**
 * TimingAppData — real-time tyre compound + stint info. F1 sends
 * Lines[num].Stints[stintNum] = { Compound, TotalLaps, StartLaps, New }.
 * Same shape as OpenF1 v1/stints: compound, tyre age (TotalLaps), stint number.
 */
let tyreCompoundSeen = false;
function processTimingAppData(data) {
  if (!currentStateRef || !data?.Lines) return;
  let changed = false;
  for (const [driverNum, driverData] of Object.entries(data.Lines)) {
    if (!driverData || typeof driverData !== "object") continue;
    const num = String(driverNum);
    const entry = ensureTimingEntry(currentStateRef, num);

    if (driverData.Line != null) {
      const pits = parseInt(String(driverData.Line), 10);
      if (!isNaN(pits)) {
        entry.pit_count = pits;
        changed = true;
      }
    }

    const stints = driverData.Stints;
    if (stints && typeof stints === "object") {
      for (const [stintIdxStr, stintData] of Object.entries(stints)) {
        if (!stintData || typeof stintData !== "object") continue;
        const stintNum = parseInt(stintIdxStr, 10);
        if (stintData.Compound != null) {
          if (!tyreCompoundSeen) {
            console.log("[signalr] TimingAppData delivering — tyre compounds active");
            tyreCompoundSeen = true;
          }
          entry.compound = String(stintData.Compound).toUpperCase();
          changed = true;
        }
        if (stintData.TotalLaps != null) {
          entry.tyre_age = parseInt(stintData.TotalLaps, 10) || 0;
          changed = true;
        }
        if (!isNaN(stintNum)) {
          entry.stint_number = stintNum;
          changed = true;
        }
      }
    }
  }
  if (changed && broadcastFn) broadcastFn("update", currentStateRef);
}

/**
 * RaceControlMessages — real-time flags/penalties. Maps onto the OpenF1
 * race_control_messages shape (date, message, flag, category, scope, sector,
 * driver_number, lap_number).
 */
function processRaceControlMessages(data) {
  if (!currentStateRef || !data?.Messages) return;
  if (!Array.isArray(currentStateRef.race_control_messages)) {
    currentStateRef.race_control_messages = [];
  }
  let added = false;
  for (const msg of Object.values(data.Messages)) {
    if (!msg || !msg.Message) continue;
    const mapped = {
      date: msg.Utc,
      message: msg.Message,
      flag: msg.Flag || null,
      category: msg.Category || "Other",
      scope: msg.Scope || null,
      sector: msg.Sector != null ? msg.Sector : null,
      driver_number: msg.RacingNumber != null ? parseInt(msg.RacingNumber, 10) : null,
      lap_number: msg.Lap != null ? parseInt(msg.Lap, 10) : null,
    };
    const exists = currentStateRef.race_control_messages.some(
      (m) => m.date === mapped.date && m.message === mapped.message,
    );
    if (exists) continue;
    currentStateRef.race_control_messages.push(mapped);
    added = true;
  }
  if (added) {
    if (currentStateRef.race_control_messages.length > 50) {
      currentStateRef.race_control_messages =
        currentStateRef.race_control_messages.slice(-50);
    }
    if (broadcastFn) broadcastFn("update", currentStateRef);
  }
}

/**
 * CarData.z — compressed car telemetry (~4 Hz per car). Payload is a
 * base64-encoded, raw-deflate-compressed JSON string. Decoded format:
 *   { Entries: [ { Utc, Cars: { "<num>": { Channels: {
 *       "0": rpm, "2": speed, "3": gear, "4": throttle, "5": brake, "45": drs
 *   } } } } ] }
 * 2026 cars publish no channel "45" (DRS was replaced by Active Aero), so drs
 * defaults to 0.
 */
let carDataMsgCount = 0;
function processCarData(data) {
  if (!currentStateRef) return;

  let payload;
  try {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    const buf = Buffer.from(raw, "base64");
    const inflated = zlib.inflateRawSync(buf);
    payload = JSON.parse(inflated.toString("utf8"));
  } catch {
    payload = typeof data === "object" ? data : null;
  }
  if (!payload?.Entries) return;

  if (!currentStateRef.car_data) currentStateRef.car_data = {};
  let changed = false;

  if (carDataMsgCount === 0) {
    console.log("[signalr] CarData.z delivering — telemetry active");
  }
  carDataMsgCount++;
  if (carDataMsgCount % 100 === 0) {
    console.log(`[signalr] CarData.z: ${carDataMsgCount} messages received`);
  }

  for (const frame of payload.Entries) {
    const cars = frame?.Cars;
    if (!cars || typeof cars !== "object") continue;
    const date = frame.Utc;
    for (const [num, car] of Object.entries(cars)) {
      const ch = car?.Channels;
      if (!ch || typeof ch !== "object") continue;
      currentStateRef.car_data[String(num)] = {
        rpm: ch["0"] ?? 0,
        speed: ch["2"] ?? 0,
        n_gear: ch["3"] ?? 0,
        throttle: ch["4"] ?? 0,
        brake: ch["5"] ?? 0,
        drs: ch["45"] ?? 0,
        date,
      };
      changed = true;
    }
  }

  if (changed && broadcastFn) broadcastFn("update", currentStateRef);
}

/**
 * Position.z — compressed car x/y positions (~4 Hz for all cars).
 * Payload is a base64-encoded, raw-deflate-compressed JSON string.
 * Decoded format: { Position: [{ Timestamp: "...", Entries: { "1": { X, Y, Z }, ... } }] }
 * Requires F1 TV Pro entitlement; with Access the server returns completion but 0 messages.
 */
let positionMsgCount = 0;
function processPosition(data) {
  if (!currentStateRef) return;

  let payload;
  try {
    // Data arrives as a base64 string (compressed); objects are also possible in snapshots.
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    const buf = Buffer.from(raw, "base64");
    const inflated = zlib.inflateRawSync(buf);
    payload = JSON.parse(inflated.toString("utf8"));
  } catch {
    // Not all frames are compressed — some are plain JSON objects (snapshot).
    payload = typeof data === "object" ? data : null;
  }

  if (!payload?.Position) return;

  if (positionMsgCount === 0) {
    console.log("[signalr] Position.z delivering — car GPS active");
  }
  positionMsgCount++;
  if (positionMsgCount % 100 === 0) {
    console.log(`[signalr] Position.z: ${positionMsgCount} messages received`);
  }

  // Each message packs ~1s of samples (3-5 frames, ~250ms apart). Applying
  // them all at once collapses to the last frame and the track map only gets
  // one target per second — cars visibly sprint-and-stall. Replay the frames
  // at their own timestamp offsets instead, so the map keeps the ~4 Hz
  // cadence it had with OpenF1 MQTT (costs <1s of extra latency).
  const frames = payload.Position.filter((f) => f?.Entries);
  if (!frames.length) return;
  const firstTs = Date.parse(frames[0].Timestamp);
  for (const frame of frames) {
    const ts = Date.parse(frame.Timestamp);
    const offset =
      Number.isFinite(firstTs) && Number.isFinite(ts)
        ? Math.min(Math.max(ts - firstTs, 0), 1500)
        : 0;
    if (offset === 0) {
      applyPositionFrame(frame);
    } else {
      const timer = setTimeout(() => {
        pendingPositionFrames.delete(timer);
        applyPositionFrame(frame);
      }, offset);
      pendingPositionFrames.add(timer);
    }
  }
}

const pendingPositionFrames = new Set();

function clearPendingPositionFrames() {
  for (const timer of pendingPositionFrames) clearTimeout(timer);
  pendingPositionFrames.clear();
}

function applyPositionFrame(frame) {
  if (!currentStateRef || !isRunning) return;
  if (!currentStateRef.location) currentStateRef.location = {};
  let changed = false;
  // The frame's own timestamp travels with the fix so the client can play it
  // back on the data's clock instead of guessing from arrival time.
  const frameTs = Date.parse(frame.Timestamp);
  const t = Number.isFinite(frameTs) ? frameTs : Date.now();
  for (const [num, coords] of Object.entries(frame.Entries)) {
    if (coords?.X != null && coords?.Y != null) {
      currentStateRef.location[String(num)] = { x: coords.X, y: coords.Y, t };
      queueLocationFix(currentStateRef, String(num), coords.X, coords.Y, t);
      // Seal timestamp so MQTT handleLocation won't override SignalR GPS
      currentStateRef.locationSignalRTs = Date.now();
      currentStateRef.locationSource = "signalr";
      changed = true;
    }
  }
  if (changed && broadcastFn) broadcastFn("update", currentStateRef);
}

// ── SQLite recorder ──────────────────────────────────────────────────────────
// Non-blocking: wrapped in try/catch so any DB error is silently discarded and
// the live feed is never interrupted. Snapshots (isSnapshot=true) are skipped —
// we only need the incremental stream for replay.

function persistMessage(topic, data) {
  const sessionKey = currentStateRef?.session?.session_key;
  if (!sessionKey) return;
  try {
    insertSignalREvent(sessionKey, topic, Date.now(), JSON.stringify(data));
  } catch (err) {
    console.warn(`[signalr] Failed to archive message (topic=${topic}):`, err.message);
  }
}

// ── New topic handlers ───────────────────────────────────────────────────────

function handleFeedMessage(topic, data, isSnapshot = false) {
  recordRawSignalR(topic, data);
  // Archive every incremental message to SQLite (non-blocking, best-effort)
  if (!isSnapshot) persistMessage(topic, data);

  if (topic === "TimingData")           processTimingData(data, isSnapshot);
  else if (topic === "TimingStats")     processTimingStats(data);
  else if (topic === "TrackStatus")     processTrackStatus(data);
  else if (topic === "ExtrapolatedClock") processExtrapolatedClock(data);
  else if (topic === "LapCount")        processLapCount(data);
  else if (topic === "DriverList")      processDriverList(data);
  else if (topic === "SessionInfo")     processSessionInfo(data);
  else if (topic === "WeatherData")     processWeatherData(data);
  else if (topic === "TeamRadio")       processTeamRadio(data);
  else if (topic === "TimingAppData")   processTimingAppData(data);
  else if (topic === "RaceControlMessages") processRaceControlMessages(data);
  else if (topic === "Position.z")      processPosition(data);
  else if (topic === "CarData.z")       processCarData(data);
  // SessionData (status series Started/Ends) remains recorded-only: the
  // frontend derives liveness from session.date_end, which SessionInfo covers.
}

// ── Connection ───────────────────────────────────────────────────────────────

async function connect() {
  if (!isRunning) return;

  const token = process.env.F1_LIVETIMING_TOKEN;
  if (!token) {
    // No token → nothing to connect to (the classic endpoint is dead). Don't
    // reconnect-spam; the dashboard falls back to MQTT and shows the degraded
    // banner until a token is provided.
    console.warn(
      "[signalr] F1_LIVETIMING_TOKEN not set — F1 live timing unavailable (feed gated by F1 since 2025). Skipping SignalR.",
    );
    return;
  }

  try {
    const authQS = `authToken=${encodeURIComponent(token)}`;

    // Step 1: Negotiate (POST). Returns a connectionToken AND sets AWSALB sticky
    // cookies. The WebSocket MUST send those cookies back, or the load balancer
    // routes it to a different backend that doesn't know our connectionToken → 404.
    const negRes = await fetch(`${NEGOTIATE_URL}&${authQS}`, {
      method: "POST",
      headers: COMMON_HEADERS,
    });
    if (negRes.status === 401) {
      // Token missing/expired. Manual refresh required — back off long instead
      // of hammering every 5s.
      console.error(
        "[signalr] Negotiate 401 — F1_LIVETIMING_TOKEN expired or invalid. Refresh it from your browser (see proxy/.env.example). Backing off 5 min.",
      );
      if (isRunning) scheduleReconnect(300000);
      return;
    }
    if (!negRes.ok) throw new Error(`Negotiate failed: ${negRes.status}`);

    const neg = await negRes.json();
    const connToken = neg.connectionToken;
    if (!connToken) throw new Error("No connectionToken in negotiate response");

    const setCookies = negRes.headers.getSetCookie
      ? negRes.headers.getSetCookie()
      : [negRes.headers.get("set-cookie")].filter(Boolean);
    const stickyCookie = setCookies.map((c) => c.split(";")[0]).join("; ");

    // Step 2: Open WebSocket with the sticky cookie + auth token.
    const wsUrl = `${WS_BASE}?id=${encodeURIComponent(connToken)}&${authQS}`;
    ws = new WebSocket(wsUrl, {
      headers: { ...COMMON_HEADERS, Cookie: stickyCookie },
    });

    ws.on("open", () => {
      // SignalR Core handshake must be the very first frame.
      ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);

      // Subscribe to the streaming topics (hub method "Subscribe").
      ws.send(
        JSON.stringify({
          type: 1,
          invocationId: "0",
          target: "Subscribe",
          arguments: [SUBSCRIBE_TOPICS],
        }) + RS,
      );

      console.log("[signalr] Connected to F1 live timing (SignalR Core)");

      // Application-level keepalive: SignalR Core drops the connection if the
      // server receives nothing within its client-timeout window (~30s).
      clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 6 }) + RS);
        }
      }, 15000);
    });

    ws.on("message", (raw) => {
      // A single frame may pack multiple RS-delimited messages.
      for (const part of raw.toString().split(RS)) {
        if (!part) continue;
        let msg;
        try {
          msg = JSON.parse(part);
        } catch {
          continue;
        }

        if (msg.type === 1 && Array.isArray(msg.arguments)) {
          // Invocation = live feed. arguments = [topic, data, timestamp].
          handleFeedMessage(msg.arguments[0], msg.arguments[1]);
        } else if (
          msg.type === 3 &&
          msg.result &&
          typeof msg.result === "object"
        ) {
          // Completion of our Subscribe: result is the full initial snapshot,
          // keyed by topic. Treat as authoritative (isSnapshot=true) so absent
          // InPit clears stale state from a previous connection cycle.
          for (const [topic, data] of Object.entries(msg.result)) {
            // Position.z comes as a compressed base64 string, not an object
            if (data && (typeof data === "object" || typeof data === "string")) {
              console.log(`[signalr] Snapshot: ${topic}`);
              handleFeedMessage(topic, data, true);
            }
          }
        } else if (msg.type === 7) {
          // Server-initiated close.
          console.log(`[signalr] Server close: ${msg.error || "(no reason)"}`);
        } else if (msg.error && msg.type === undefined) {
          // Handshake response is `{}` on success or `{error}` on failure.
          console.error(`[signalr] Handshake error: ${msg.error}`);
        }
        // type 6 (ping) and the empty handshake ack are ignored.
      }
    });

    ws.on("close", (code) => {
      console.log(`[signalr] Disconnected (${code})`);
      clearInterval(pingInterval);
      ws = null;
      if (isRunning) scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error("[signalr] WebSocket error:", err.message);
      ws?.close();
    });
  } catch (err) {
    console.error("[signalr] Connection failed:", err.message);
    if (isRunning) scheduleReconnect();
  }
}

function scheduleReconnect(delayMs = 5000) {
  clearTimeout(reconnectTimeout);
  reconnectTimeout = setTimeout(() => {
    if (isRunning) connect();
  }, delayMs);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the SignalR client.
 * Safe to call multiple times — does nothing if already running.
 * @param {Function} broadcast  broadcastSSE(event, data) from server.js
 * @param {Object}   stateRef   the shared currentState object (mutated in place)
 */
export function startSignalR(broadcast, stateRef) {
  if (isRunning) return;
  isRunning = true;
  broadcastFn = broadcast;
  currentStateRef = stateRef;

  // In signalr-only mode there is no startMQTT() to seed these structures, so
  // do it here (no-ops if a mode already initialised them).
  if (!stateRef.session) stateRef.session = null;
  if (!stateRef.drivers) stateRef.drivers = {};
  if (!stateRef.timing) stateRef.timing = {};
  if (!stateRef.location) stateRef.location = {};
  if (!stateRef.car_data) stateRef.car_data = {};
  if (!stateRef.lap_count) stateRef.lap_count = { current: 0, total: 0 };
  if (!stateRef.track_status) stateRef.track_status = { flag: "GREEN" };
  if (!stateRef.weather) stateRef.weather = null;
  if (!stateRef.race_control_messages) stateRef.race_control_messages = [];
  if (!stateRef.team_radio) stateRef.team_radio = [];

  console.log(
    "[signalr] Starting F1 live timing client (segments + sector times)...",
  );
  connect();
}

/**
 * Stop the SignalR client and cancel any pending reconnect.
 */
export function stopSignalR() {
  isRunning = false;
  clearTimeout(reconnectTimeout);
  clearInterval(pingInterval);
  ws?.close();
  ws = null;
  positionMsgCount = 0;
  carDataMsgCount = 0;
  tyreCompoundSeen = false;
  clearPendingPositionFrames();
  f1SessionPath = "";
  if (currentStateRef) currentStateRef.locationSignalRTs = null;
  broadcastFn = null;
  currentStateRef = null;
}

/**
 * Returns true if the WebSocket is currently open.
 */
export function isSignalRRunning() {
  return isRunning && ws !== null && ws.readyState === WebSocket.OPEN;
}
