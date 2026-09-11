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

const PORT = process.env.PORT || 4000;

// Mode: "live-polling" | "mqtt" | "openf1" (alias for mqtt) | "replay" | "auto"
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

// Broadcast to all SSE clients
function broadcastSSE(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((connections, clientId) => {
    for (const client of connections) {
      try {
        client.write(message);
      } catch (err) {
        connections.delete(client);
      }
    }
    if (connections.size === 0) sseClients.delete(clientId);
  });
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
      const sessionLive = await checkActiveSession();
      if (!sessionLive) return;

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
        startReplay(broadcastSSE, currentState);
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
        startReplay(broadcastSSE, currentState);
      },
    });
  } catch (err) {
    console.error("[proxy] Archive maintenance error:", err.message);
  }
}

// First check is delayed so it doesn't compete with the startup flow
// (startReplay may already be downloading the same session).
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
    startReplay(broadcastSSE, currentState);
    startSessionWatchdog();
  }
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
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
      archive: {
        downloading: isArchiveDownloading(),
        replayFromDB: isReplayUsingDB(),
        sessions: listSessions().map((s) => ({
          key: s.session_key,
          name: `${s.payload.session_name} ${s.payload.location}`,
          date: s.date_start?.slice(0, 10),
          complete: s.complete === 1,
        })),
      },
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

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.write(`event: initial\ndata: ${JSON.stringify(currentState)}\n\n`);

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
    startReplay(broadcastSSE, currentState);
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
