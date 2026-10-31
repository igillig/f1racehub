import "dotenv/config";
import http from "http";
import {
  startReplay,
  stopReplay,
  isReplayRunning,
  isReplayUsingDB,
  getReplayStatus,
  seekReplay,
} from "./replay.js";
import {
  ensureLatestSessionArchived,
  isArchiveDownloading,
} from "./session-downloader.js";
import { listSessions } from "./session-store.js";
import { getCircuitMap } from "./circuit-map.js";
import {
  startMQTT,
  stopMQTT,
  isMQTTRunning,
  hasMQTTCredentials,
  checkActiveSession,
  ensureValidToken,
  getRawMqttDebug,
} from "./mqtt-client.js";
import {
  startLivePolling,
  stopLivePolling,
  isLivePollingRunning,
} from "./live-polling.js";
import {
  startSignalR,
  stopSignalR,
  isSignalRRunning,
  getRawSignalRDebug,
} from "./signalr-client.js";
import { createStreamBuffer, MAX_DELAY_MS } from "./stream-buffer.js";

const PORT = process.env.PORT || 4000;

// Mode: "live-polling" | "mqtt" | "openf1" (alias for mqtt) | "replay" | "signalr" | "auto"
// "signalr" runs the official F1 live timing feed as the sole source — no
// OpenF1 MQTT/REST. Used to validate a full F1-native data path.
const PROXY_MODE = process.env.PROXY_MODE || "auto";

// Store current state (OpenF1-native format)
let currentState = {};
// Map<clientId, Set<res>> — clientId identifies a browser (localStorage), so
// multiple tabs share one id. Each tab gets its own connection in the Set;
// unique viewers = number of clientIds. Never kill an existing connection on
// reconnect: two tabs with the same id would terminate each other in a loop.
let sseClients = new Map();
// Map<clientId, lastSeenMs> — landing page viewers tracked via /health ping
const LANDING_TTL_MS = 35000; // 15s poll + buffer
const landingViewers = new Map();
function pruneLandingViewers() {
  const cutoff = Date.now() - LANDING_TTL_MS;
  for (const [id, ts] of landingViewers) {
    if (ts < cutoff) landingViewers.delete(id);
  }
}

// Deep merge objects
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] instanceof Object &&
      !Array.isArray(source[key]) &&
      key in target &&
      target[key] instanceof Object &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ── SSE delivery ──────────────────────────────────────────────────────────────
// Every data source used to call broadcastSSE() once per incoming message, and
// each call re-serialised the ENTIRE state (~45 KB measured on a quali session).
// At the ~18 msg/s a qualifying session produces that is ~810 KB/s per viewer,
// and client.write() was called without ever checking its return value, so a
// socket that could not keep up grew an unbounded backlog inside Node. The
// dashboard then rendered data that was a minute old while the session clock —
// which self-corrects against Date.now() in useF1DataSSE.ts — stayed accurate.
// That is exactly the "clock live, table behind, fixed by F5" symptom.
//
// Two fixes here:
//   1. Coalesce. "update" only marks the state dirty; one timer flushes at
//      10 Hz. Nothing in the UI changes faster than that anyway.
//   2. Skip, don't queue. A client whose socket already holds MAX_PENDING_BYTES
//      loses the frame instead of growing a backlog, and receives the full
//      state on the next frame it can accept — it resyncs with a jump instead
//      of drifting further behind for the rest of the session.

const BROADCAST_INTERVAL_MS = 100; // 10 Hz

// A frame carries only what actually changed since the last one. Measured on a
// live race, the full state was 112 KB/s per viewer, of which `timing` alone was
// 73.6% — and only 1.1 of 22 drivers changed per frame, so ~95% of those bytes
// were re-sending drivers that had not moved. `car_data` and `location` were
// identical in 70% of frames, and session/clock/lap_count/track_status in
// 385 of 386.
//
// This is safe without sequence numbers because SSE runs over TCP: a client
// cannot silently miss a frame. The only two ways to fall out of sync are a
// frame this proxy deliberately skipped (tracked per client by `_needsFull`,
// which resends the whole state) and a dropped connection (EventSource
// reconnects into a fresh `initial`).
//
// The client cooperates: processData() guards every section with
// `if (data.<key>)` and merges timing into a ref, so an omitted key keeps its
// previous value.
let lastSent = {}; // key -> last serialised value
let lastSentTiming = {}; // driver number -> last serialised timing entry

function resetChangeTracking() {
  lastSent = {};
  lastSentTiming = {};
}

// Skip frames for a client holding more than this much unflushed data. Node's
// default highWaterMark (16 KB) is useless as a signal here — a single frame
// exceeds it, so write() reports congestion even on a healthy connection.
const MAX_PENDING_BYTES = 256 * 1024;
// Past this the socket is not coming back. Drop it and let the browser's
// EventSource reconnect into a fresh snapshot.
const KILL_PENDING_BYTES = 4 * 1024 * 1024;

let updatePending = false;
const delivery = { sent: 0, skipped: 0, dropped: 0, resyncs: 0 };

// When a source last handed us something to send (not keepalives).
let lastBroadcastAt = Date.now();

// Rolling window of everything broadcast, so a viewer can join the stream
// behind live without being shown the present first. See stream-buffer.js.
const streamBuffer = createStreamBuffer();

// Every frame carries the proxy's clock in the SSE `id:` field. A viewer
// running the stream behind live needs it twice: to know when a frame is due,
// and to measure how far their own clock sits from this one.
function sseFrame(event, data, ts = Date.now()) {
  return `id: ${ts}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Write one frame honouring backpressure. Returns false if it was not written.
function writeFrame(client, frame) {
  if (client.writableEnded || client.destroyed) return false;
  const pending = client.writableLength;
  if (pending > KILL_PENDING_BYTES) {
    delivery.dropped++;
    console.warn(
      `[proxy-sse] Dropping client — ${(pending / 1048576).toFixed(1)} MB unflushed`,
    );
    client.destroy();
    return false;
  }
  if (pending > MAX_PENDING_BYTES) {
    client._needsFull = true;
    delivery.skipped++;
    return false;
  }
  try {
    client.write(frame);
  } catch (err) {
    return false;
  }
  delivery.sent++;
  return true;
}

function flushUpdate() {
  updatePending = false;
  // No early return when nobody is connected: the delay buffer is a viewer
  // that never disconnects, and it has to be warm before the first real one
  // arrives or that viewer has nothing to join behind.
  const ts = Date.now();

  // Lean frame: only what differs from what we last put on the wire.
  const lean = {};
  for (const [key, value] of Object.entries(currentState)) {
    // `timing` gets per-driver granularity — it is the bulk of the payload and
    // a single driver crossing a sector used to resend all 22.
    if (key === "timing" && value && typeof value === "object") {
      const changed = {};
      for (const [num, entry] of Object.entries(value)) {
        const serialised = JSON.stringify(entry);
        if (lastSentTiming[num] === serialised) continue;
        lastSentTiming[num] = serialised;
        changed[num] = entry;
      }
      if (Object.keys(changed).length > 0) lean.timing = changed;
      continue;
    }

    const serialised = JSON.stringify(value);
    if (lastSent[key] === serialised) continue;
    lastSent[key] = serialised;
    lean[key] = value;
  }

  // Nothing moved since the last frame — say nothing.
  if (Object.keys(lean).length === 0) {
    drainLocationFixes();
    return;
  }

  const leanFrame = sseFrame("update", lean, ts);
  streamBuffer.record(leanFrame, ts);
  let fullFrame = null; // built only if some client fell behind

  for (const [clientId, connections] of sseClients) {
    for (const client of connections) {
      if (client._needsFull) {
        // This client missed at least one frame, so an occasional key we have
        // already marked as sent may never have reached it. Send everything.
        // Stamped with this frame's time like any other, which is what lets a
        // delayed viewer queue the resync instead of jumping to the present.
        if (fullFrame === null)
          fullFrame = sseFrame("update", currentState, ts);
        if (writeFrame(client, fullFrame)) {
          client._needsFull = false;
          delivery.resyncs++;
        }
      } else {
        writeFrame(client, leanFrame);
      }
      if (client.destroyed || client.writableEnded) connections.delete(client);
    }
    if (connections.size === 0) sseClients.delete(clientId);
  }

  drainLocationFixes();

  // Taken after the frame for this timestamp — and after the GPS queue is
  // drained — so the snapshot and the frames replayed on top of it never carry
  // the same data twice.
  if (streamBuffer.snapshotDue(ts)) {
    streamBuffer.recordSnapshot(sseFrame("initial", currentState, ts), ts);
  }
}

// GPS fixes are a delivery queue, not state: once a frame carries them they are
// gone. `location` still holds each driver's newest fix for everything else.
// Nothing drains while no client is connected, which is why queueLocationFix
// caps each queue.
function drainLocationFixes() {
  if (!currentState.location_fixes) return;
  for (const num of Object.keys(currentState.location_fixes)) {
    delete currentState.location_fixes[num];
  }
}

setInterval(() => {
  if (updatePending) flushUpdate();
}, BROADCAST_INTERVAL_MS).unref();

// Worst per-client backlog right now, in KB — surfaced on /health.
function maxPendingKB() {
  let worst = 0;
  for (const connections of sseClients.values()) {
    for (const client of connections) {
      if (client.writableLength > worst) worst = client.writableLength;
    }
  }
  return Math.round(worst / 1024);
}

// Report congestion, but only when there is something new to say.
let lastReported = { skipped: 0, dropped: 0 };
setInterval(() => {
  if (
    delivery.skipped === lastReported.skipped &&
    delivery.dropped === lastReported.dropped
  )
    return;
  console.warn(
    `[proxy-sse] Congestion: ${delivery.skipped - lastReported.skipped} frames skipped, ` +
      `${delivery.dropped - lastReported.dropped} clients dropped in the last 10s ` +
      `(${sseClients.size} viewers, ${delivery.resyncs} resyncs total)`,
  );
  lastReported = { skipped: delivery.skipped, dropped: delivery.dropped };
}, 10_000).unref();

// Broadcast to all SSE clients. "update" is coalesced; control events go out
// immediately and are never skipped — a client that misses a reset would keep
// showing the previous session.
function broadcastSSE(event, data) {
  // Any call here means a source produced something. The idle supervisor reads
  // it to tell a live source that is working from one that is merely connected.
  lastBroadcastAt = Date.now();

  if (event === "update") {
    // The flush reads currentState directly (every source mutates it in place),
    // so the payload passed here is redundant.
    updatePending = true;
    return;
  }

  updatePending = false; // superseded by the frame below
  resetChangeTracking(); // next update must carry everything again

  const ts = Date.now();
  const frame = sseFrame(event, data, ts);
  // Recorded like any other frame, never cleared: a viewer running a minute
  // behind still has the end of the previous session on screen and has to be
  // told about the reset when it reaches them, not when it happens.
  streamBuffer.record(frame, ts);
  for (const [clientId, connections] of sseClients) {
    for (const client of connections) {
      try {
        client.write(frame);
        client._needsFull = false;
      } catch (err) {
        connections.delete(client);
      }
    }
    if (connections.size === 0) sseClients.delete(clientId);
  }
}

// ── Retirement inference ──────────────────────────────────────────────────────
// SignalR's Retired field is only sent as a live delta event. If the proxy
// restarts mid-race and a driver had already retired, the field won't appear
// in the next snapshot. We infer retirement only when BOTH conditions hold:
//   1. gap_to_leader AND interval are gone from timing
//   2. driver's lap_number is >3 behind the leader (not just a slow lap)
// Pure lap gap alone is NOT enough — incomplete historical data can leave
// drivers stuck on lap 1 while the leader is on lap 20, which triggered
// false retirements for the entire field.
// Runs every 30 s during live sessions. Only applies to Race/Sprint.
function inferRetiredDrivers() {
  if (!currentState.timing) return;
  const sessionType = currentState.session?.session_type;
  if (sessionType !== "Race" && sessionType !== "Sprint") return;

  const entries = Object.values(currentState.timing);
  if (entries.length === 0) return;

  const leaderLap = Math.max(...entries.map((e) => e.lap_number || 0));
  if (leaderLap < 5) return; // too early to infer

  let changed = false;
  for (const entry of entries) {
    if (entry.retired) continue;
    if (!entry.lap_number) continue;
    const lapsBehind = leaderLap - entry.lap_number;
    const gapGone =
      (entry.gap_to_leader === null || entry.gap_to_leader === undefined) &&
      (entry.interval === null || entry.interval === undefined);
    // Require gapGone + lap gap — pure lap gap alone fires on drivers whose
    // historical lap data didn't load (lap_number stuck at 1).
    if (gapGone && lapsBehind > 3 && !entry.in_pit) {
      console.log(
        `[proxy] Inferred retirement: ${entry.driver_number} (lap ${entry.lap_number} vs leader ${leaderLap}, gapGone=${gapGone})`,
      );
      entry.retired = true;
      changed = true;
    }
  }
  if (changed) broadcastSSE("update", currentState);
}

setInterval(inferRetiredDrivers, 30_000);

// ── Session watchdog ──────────────────────────────────────────────────────────
// When the proxy falls back to replay because no live session existed at startup,
// this watchdog polls every 60 s. When a session appears, it stops replay and
// switches to the best available live source.

const WATCHDOG_INTERVAL_MS = 60_000;
let sessionWatchdog = null;

function clearCurrentState() {
  for (const key of Object.keys(currentState)) delete currentState[key];
  broadcastSSE("reset", {});
}

async function tryUpgradeToLive() {
  if (isMQTTRunning() || isLivePollingRunning()) {
    stopSessionWatchdog();
    return;
  }

  try {
    if (hasMQTTCredentials()) {
      // Strictly `true`: an unknown answer (OpenF1 down, 401, rate limited)
      // used to read as "live" and tore down a perfectly good replay, leaving
      // the dashboard empty until someone redeployed.
      const sessionLive = await checkActiveSession();
      if (sessionLive !== true) return;

      console.log(
        "[proxy] Watchdog: live session detected — stopping replay, starting MQTT+SignalR",
      );
      stopReplay();
      clearCurrentState();

      const ok = await startMQTT(broadcastSSE, currentState);
      if (ok) {
        startSignalR(broadcastSSE, currentState);
        stopSessionWatchdog();
      } else {
        // False positive: session just crossed the 30-min grace window between
        // the watchdog check and the MQTT connect attempt. Restart replay so
        // the dashboard isn't left with an empty state.
        console.log(
          "[proxy] Watchdog: MQTT found no active session — restarting replay",
        );
        startReplaySupervised();
      }
    } else {
      // No MQTT credentials — try live-polling (it checks for active session internally)
      const ok = await startLivePolling(broadcastSSE, currentState);
      if (ok) {
        console.log(
          "[proxy] Watchdog: live session detected — stopping replay, starting live-polling",
        );
        stopReplay();
        clearCurrentState();
        stopSessionWatchdog();
      }
    }
  } catch (err) {
    console.error("[proxy] Watchdog check error:", err.message);
  }
}

// ── Keeping the demo alive ───────────────────────────────────────────────────
// startReplay() can fail for reasons that pass: OpenF1 unreachable on a cold
// archive, a locked SQLite file. Nothing else in the proxy notices, and a dead
// replay is a dead dashboard — no frames, no banner, nothing to look at — so
// retry with backoff until it takes.

const REPLAY_RETRY_BASE_MS = 30_000;
const REPLAY_RETRY_MAX_MS = 5 * 60_000;
let replayRetryTimer = null;

async function startReplaySupervised(attempt = 0) {
  if (replayRetryTimer) {
    clearTimeout(replayRetryTimer);
    replayRetryTimer = null;
  }
  const ok = await startReplay(broadcastSSE, currentState);
  if (ok || isMQTTRunning() || isLivePollingRunning()) return;

  const delay = Math.min(
    REPLAY_RETRY_BASE_MS * 2 ** attempt,
    REPLAY_RETRY_MAX_MS,
  );
  console.warn(
    `[proxy] Replay failed to start — retrying in ${delay / 1000}s`,
  );
  replayRetryTimer = setTimeout(
    () => startReplaySupervised(attempt + 1),
    delay,
  );
  replayRetryTimer.unref?.();
}

// ── Live-source idle supervisor ──────────────────────────────────────────────
// A live source can be "running" and still deliver nothing. The session check
// answers `null` when OpenF1 cannot be reached, the startup path connects on
// that maybe, and the watchdog stops itself as soon as MQTT is up — so a wrong
// guess used to park the proxy in mqtt-live forever: no frames, no demo
// banner, and a redeploy the only way out. If nothing has gone out for a while
// and no session is confirmed on air, go back to replay and let the watchdog
// upgrade again when a session really starts.

const LIVE_IDLE_LIMIT_MS = 5 * 60_000;
const LIVE_IDLE_CHECK_MS = 60_000;

async function checkLiveSourceIdle() {
  if (!isMQTTRunning() && !isLivePollingRunning()) return;

  const idleMs = Date.now() - lastBroadcastAt;
  if (idleMs < LIVE_IDLE_LIMIT_MS) return;

  // A confirmed live session means this is a quiet moment (red flag, a gap
  // between runs in Practice), not a dead source. `null` is not a confirmation.
  const sessionLive = await checkActiveSession();
  if (sessionLive === true) return;

  console.warn(
    `[proxy] Live source silent for ${Math.round(idleMs / 1000)}s and no ` +
      `active session confirmed — falling back to replay`,
  );
  stopMQTT();
  stopSignalR();
  stopLivePolling();
  clearCurrentState();
  await startReplaySupervised();
  startSessionWatchdog();
}

setInterval(checkLiveSourceIdle, LIVE_IDLE_CHECK_MS).unref();

// ── Session archive maintenance ──────────────────────────────────────────────
// Keeps the SQLite archive holding the latest finished sessions. Runs in every
// mode: after a live session ends (or while in replay/standby), the latest
// session gets downloaded once and replay switches to it. Also backfills
// topics that were empty on first download (OpenF1 consolidates data late).

const ARCHIVE_CHECK_INTERVAL_MS = 10 * 60_000;
const ARCHIVE_FIRST_CHECK_DELAY_MS = 5 * 60_000;

async function maintainSessionArchive() {
  try {
    await ensureLatestSessionArchived({
      onNewSessionReady: (session) => {
        if (!isReplayRunning()) return;
        const alreadyOnIt =
          currentState.session?.session_key === session.session_key &&
          isReplayUsingDB();
        if (alreadyOnIt) return;
        console.log(
          `[proxy] Session ${session.session_key} archived — restarting replay from SQLite`,
        );
        stopReplay();
        clearCurrentState();
        startReplaySupervised();
      },
    });
  } catch (err) {
    console.error("[proxy] Archive maintenance error:", err.message);
  }
}

// First check is delayed so it doesn't compete with the startup flow
// (startReplay may already be downloading the same session). Runs in every
// mode: the SQLite replay archive is built from OpenF1's FREE REST tier, which
// signalr-only mode keeps (it only drops the paid MQTT live source).
setTimeout(() => {
  maintainSessionArchive();
  setInterval(maintainSessionArchive, ARCHIVE_CHECK_INTERVAL_MS);
}, ARCHIVE_FIRST_CHECK_DELAY_MS);

function startSessionWatchdog() {
  if (sessionWatchdog) return;
  console.log(
    `[proxy] Session watchdog started — checking every ${WATCHDOG_INTERVAL_MS / 1000}s for a live session`,
  );
  sessionWatchdog = setInterval(tryUpgradeToLive, WATCHDOG_INTERVAL_MS);
}

function stopSessionWatchdog() {
  if (sessionWatchdog) {
    clearInterval(sessionWatchdog);
    sessionWatchdog = null;
  }
}

// No live session found — start replay so the dashboard always has data.
// The watchdog will upgrade to a live source the moment a session appears.
async function startFallbackNoLive() {
  console.log("[proxy] No live session — checking live-polling...");
  const success = await startLivePolling(broadcastSSE, currentState);
  if (!success) {
    console.log(
      "[proxy] No active session — starting replay (watchdog will upgrade to live)",
    );
    startReplaySupervised();
    startSessionWatchdog();
  }
}

// Create HTTP server
/**
 * Archive section of /health.
 *
 * Reading the archive opens the SQLite file, which can fail for reasons that
 * have nothing to do with the proxy's ability to stream (corrupt DB, locked
 * file, bad permissions, a native module built for another Node ABI). Health
 * reports that as a degraded archive instead of failing the whole response —
 * this used to take the process down, because the browser polls /health every
 * 15 s and the throw landed in an async handler with nothing to catch it.
 */
function archiveHealth() {
  const base = {
    downloading: isArchiveDownloading(),
    replayFromDB: isReplayUsingDB(),
  };
  try {
    return {
      ...base,
      sessions: listSessions().map((s) => ({
        key: s.session_key,
        name: `${s.payload.session_name} ${s.payload.location}`,
        date: s.date_start?.slice(0, 10),
        complete: s.complete === 1,
      })),
    };
  } catch (err) {
    console.error("[proxy] Archive unreadable for /health:", err.message);
    return { ...base, sessions: [], error: err.message };
  }
}

const handleRequest = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, "http://localhost");

  // Health check
  if (reqUrl.pathname === "/health") {
    const landingClientId = reqUrl.searchParams.get("clientId");
    if (landingClientId) {
      landingViewers.set(landingClientId, Date.now());
      pruneLandingViewers();
    }
    let mode = "unknown";
    if (isLivePollingRunning()) mode = "live-polling";
    else if (isMQTTRunning()) mode = "mqtt-live";
    else if (isSignalRRunning()) mode = "signalr-live";
    else if (isReplayRunning()) mode = "replay";
    else if (sessionWatchdog !== null) mode = "standby";

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    pruneLandingViewers();
    const health = {
      status: "ok",
      mode,
      clients: sseClients.size + landingViewers.size,
      hasState: Object.keys(currentState).length > 0,
      mqttAvailable: hasMQTTCredentials(),
      mqttRunning: isMQTTRunning(),
      signalrRunning: isSignalRRunning(),
      locationSource: currentState.locationSource ?? "none",
      watchdogRunning: sessionWatchdog !== null,
      // Seconds since any source last produced a frame. Climbing past 300 in a
      // live mode is what the idle supervisor acts on.
      lastDataAgeSec: Math.round((Date.now() - lastBroadcastAt) / 1000),
      // SSE delivery health — `skipped` climbing means clients cannot keep up
      // with the stream, `maxPendingKB` is the worst socket's current backlog.
      delivery: { ...delivery, maxPendingKB: maxPendingKB() },
      // How deep a viewer can set their broadcast delay, and how much of that
      // window is actually stored right now.
      streamDelay: streamBuffer.stats(),
      archive: archiveHealth(),
    };
    if (mode === "replay" && currentState.session) {
      health.replaySession = {
        meetingName: currentState.session.meeting_name,
        sessionName: currentState.session.session_name,
        circuitName: currentState.session.circuit_short_name,
        location: currentState.session.location,
      };
    }
    res.end(JSON.stringify(health));
    return;
  }

  // SSE endpoint
  if (reqUrl.pathname === "/api/sse") {
    const clientId =
      reqUrl.searchParams.get("clientId") ||
      `anon-${Date.now()}-${Math.random()}`;

    // How far behind live this viewer wants to be, in ms. The waiting happens
    // in their browser; what the delay changes here is only where they start.
    const requested = Number(reqUrl.searchParams.get("delay"));
    const delayMs = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 0), MAX_DELAY_MS)
      : 0;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Nagle would hold small frames back waiting for more bytes; for a stream
    // whose whole point is latency, send them as they are produced.
    res.socket?.setNoDelay(true);

    // The snapshot carries every key, so the first lean update can legitimately
    // omit the occasional ones.
    //
    // A delayed viewer gets a snapshot from before their delay plus every
    // frame since, and sorts out the timing themselves. Nothing can interleave
    // between the backlog and the registration below — there is no await here,
    // so the flush timer cannot run in between and drop a frame on the floor.
    const backlog =
      delayMs > 0 ? streamBuffer.backlogFor(delayMs) : null;
    if (backlog) {
      res.write(backlog.snapshot);
      for (const frame of backlog.frames) res.write(frame);
      console.log(
        `[proxy-sse] Delayed start (${clientId}): -${Math.round(delayMs / 1000)}s ` +
          `→ snapshot ${(backlog.coverageMs / 1000).toFixed(1)}s old + ${backlog.frames.length} frames`,
      );
    } else {
      res.write(sseFrame("initial", currentState));
    }
    res._needsFull = false;

    let connections = sseClients.get(clientId);
    if (!connections) {
      connections = new Set();
      sseClients.set(clientId, connections);
    }
    connections.add(res);
    console.log(
      `[proxy-sse] Client connected (${clientId}, ${connections.size} conn). Unique viewers: ${sseClients.size}`,
    );

    const keepAlive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch (_) {
        clearInterval(keepAlive);
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(keepAlive);
      connections.delete(res);
      if (connections.size === 0 && sseClients.get(clientId) === connections) {
        sseClients.delete(clientId);
      }
      console.log(
        `[proxy-sse] Client disconnected (${clientId}, ${connections.size} conn). Unique viewers: ${sseClients.size}`,
      );
    });

    return;
  }

  // Circuit outline fallback for circuits api.multiviewer.app doesn't know
  // (built from a real GPS lap — see circuit-map.js). 404 until buildable.
  const circuitMatch = reqUrl.pathname.match(/^\/api\/circuit\/(\d+)$/);
  if (req.method === "GET" && circuitMatch) {
    const data = await getCircuitMap(circuitMatch[1], currentState.session);
    if (data) {
      // Tiny and served from memory; don't let browsers pin a stale
      // rotation/outline after a deploy.
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      });
      res.end(JSON.stringify(data));
    } else {
      res.writeHead(404, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ error: "Circuit outline not available yet" }));
    }
    return;
  }

  // State endpoint (debugging)
  if (req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(currentState));
    return;
  }

  // Dev replay scrubber — only available outside production
  if (
    (reqUrl.pathname === "/replay/status" ||
      reqUrl.pathname === "/replay/seek") &&
    process.env.NODE_ENV === "production"
  ) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not available in production" }));
    return;
  }

  // Dev replay scrubber — current position + total duration
  if (req.method === "GET" && reqUrl.pathname === "/replay/status") {
    const status = getReplayStatus();
    res.writeHead(status ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status || { error: "Replay not running" }));
    return;
  }

  // Dev replay scrubber — seek to a target offset (ms from session start)
  if (req.method === "POST" && reqUrl.pathname === "/replay/seek") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { targetMs } = JSON.parse(body);
        if (typeof targetMs !== "number" || !isFinite(targetMs)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "targetMs must be a finite number" }));
          return;
        }
        const ok = await seekReplay(targetMs);
        res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Raw MQTT debug — last 20 messages per topic
  if (req.url === "/api/debug/mqtt") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getRawMqttDebug(), null, 2));
    return;
  }

  // Raw SignalR debug — last 20 messages per topic (TimingData filtered to key fields)
  if (req.url === "/api/debug/signalr") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getRawSignalRDebug(), null, 2));
    return;
  }

  // Retirement debug — current retired state per driver and its source
  if (req.url === "/api/debug/retired") {
    const retired = {};
    if (currentState.timing) {
      for (const [num, entry] of Object.entries(currentState.timing)) {
        retired[num] = {
          driver_number: entry.driver_number,
          retired: entry.retired,
          in_pit: entry.in_pit,
          lap_number: entry.lap_number,
          gap_to_leader: entry.gap_to_leader,
          interval: entry.interval,
          position: entry.position,
        };
      }
    }
    const leaderLap = currentState.timing
      ? Math.max(...Object.values(currentState.timing).map((e) => e.lap_number || 0))
      : 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ leaderLap, drivers: retired }, null, 2));
    return;
  }

  // Viewers count endpoint
  if (req.url === "/api/viewers") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ viewers: sseClients.size }));
    return;
  }

  // OpenF1 read-through proxy — forwards whitelisted GET endpoints to OpenF1
  // with paid-tier auth when available (higher rate limit, no 429 bursts).
  // Used by the landing (sessions) and the standings page (championship, etc.).
  // OpenF1 REST is FREE — kept in every mode including signalr-only, which only
  // drops the paid MQTT live source, not the free REST endpoints.
  const OPENF1_PASSTHROUGH = [
    "/api/sessions",
    "/api/championship_drivers",
    "/api/championship_teams",
    "/api/drivers",
    "/api/meetings",
  ];
  const passthrough = OPENF1_PASSTHROUGH.find((p) =>
    reqUrl.pathname.startsWith(p),
  );
  if (passthrough) {
    const endpoint = passthrough.slice("/api/".length);
    const queryString = reqUrl.search;
    const upstreamUrl = `https://api.openf1.org/v1/${endpoint}${queryString}`;
    try {
      const headers = { Accept: "application/json" };
      if (hasMQTTCredentials()) {
        const token = await ensureValidToken();
        headers["Authorization"] = `Bearer ${token}`;
      }
      const upstreamRes = await fetch(upstreamUrl, { headers });
      const body = await upstreamRes.text();
      res.writeHead(upstreamRes.status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_error", detail: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
};

// `handleRequest` is async, and a raw http server does nothing with the
// promise it returns — an unhandled rejection in any route would terminate the
// whole proxy and drop every SSE client. Catching here keeps one bad request
// from taking the stream down with it.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(`[proxy] Unhandled error on ${req.method} ${req.url}:`, err);
    if (res.headersSent) {
      // Too late to change the status; just stop the dangling response.
      res.end();
      return;
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  });
});

// Last line of defence. A stray rejection somewhere in the MQTT/SignalR/replay
// plumbing is not a reason to disconnect every viewer, and the container's
// restart policy would only paper over it — so log loudly and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[proxy] Unhandled rejection:", reason);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[proxy] ${signal} received — shutting down`);
  stopSessionWatchdog();
  stopLivePolling();
  stopMQTT();
  stopSignalR();
  stopReplay();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Start server
server.listen(PORT, async () => {
  const env =
    process.env.NODE_ENV === "production" ? "production" : "development";
  console.log(`[proxy] ─────────────────────────────────────`);
  console.log(`[proxy] F1 Proxy running on port ${PORT}`);
  console.log(`[proxy] Environment: ${env}`);
  console.log(`[proxy] Mode: ${PROXY_MODE}`);
  console.log(`[proxy] ─────────────────────────────────────`);

  if (PROXY_MODE === "live-polling") {
    console.log("[proxy] Override: live-polling...");
    const success = await startLivePolling(broadcastSSE, currentState);
    if (!success) {
      startSessionWatchdog();
    }
  } else if (PROXY_MODE === "mqtt" || PROXY_MODE === "openf1") {
    console.log("[proxy] Override: MQTT + SignalR hybrid...");
    const sessionLive = await startMQTT(broadcastSSE, currentState);
    if (sessionLive) {
      startSignalR(broadcastSSE, currentState);
    } else {
      startFallbackNoLive();
    }
  } else if (PROXY_MODE === "replay") {
    console.log("[proxy] Override: replay...");
    startReplaySupervised();
  } else if (PROXY_MODE === "signalr") {
    console.log("[proxy] Override: signalr live (F1 native, no paid MQTT)...");
    console.log(
      "[proxy] Live = SignalR. OpenF1 REST (free tier) kept for calendar/standings/archive.",
    );
    startSignalR(broadcastSSE, currentState);
  } else {
    // Auto mode
    console.log(`[proxy] Auto mode — checking for live session...`);
    if (hasMQTTCredentials()) {
      const sessionLive = await startMQTT(broadcastSSE, currentState);
      if (sessionLive) {
        // Run SignalR in parallel for live segment/sector-time updates
        startSignalR(broadcastSSE, currentState);
      } else {
        console.log("[proxy] No live session via MQTT — using fallback...");
        startFallbackNoLive();
      }
    } else if (process.env.F1_LIVETIMING_TOKEN) {
      // No MQTT credentials, but an F1 live-timing token → the official SignalR
      // feed is the live source (drops the paid OpenF1 MQTT tier). checkActiveSession
      // can't confirm liveness without OpenF1 creds (returns null), so connect
      // SignalR directly; it reports whatever is on air.
      console.log("[proxy] F1 token present — starting SignalR live source");
      startSignalR(broadcastSSE, currentState);
    } else {
      const sessionLive = await checkActiveSession();
      if (sessionLive) {
        console.log("[proxy] Live session detected — starting live-polling...");
        const success = await startLivePolling(broadcastSSE, currentState);
        if (!success) startFallbackNoLive();
      } else {
        startFallbackNoLive();
      }
    }
  }
});
