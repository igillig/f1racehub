import "dotenv/config";
import http from "http";
import { startReplay, stopReplay, isReplayRunning } from "./replay.js";
import {
  startMQTT,
  stopMQTT,
  isMQTTRunning,
  hasMQTTCredentials,
  checkActiveSession,
  ensureValidToken,
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
} from "./signalr-client.js";

const PORT = process.env.PORT || 4000;

// Mode: "live-polling" | "mqtt" | "openf1" (alias for mqtt) | "replay" | "auto"
const PROXY_MODE = process.env.PROXY_MODE || "auto";

// Store current state (OpenF1-native format)
let currentState = {};
// Map<clientId, res> — deduplicates reconnects and StrictMode double-mounts
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

// Cache of OpenF1 /sessions responses keyed by query string (schedule fallback)
const sessionsCache = new Map();
const SESSIONS_FRESH_MS = 30_000; // absorbs landing-page polling from many viewers

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
  sseClients.forEach((client, clientId) => {
    try {
      client.write(message);
    } catch (err) {
      sseClients.delete(clientId);
    }
  });
}

// ── Retirement inference ──────────────────────────────────────────────────────
// SignalR's Retired field is only sent as a live delta event. If the proxy
// restarts mid-race and a driver had already retired, the field won't appear
// in the next snapshot. We infer retirement from two signals:
//   1. gap_to_leader === null && interval === null (timing drops off)
//   2. driver's lap_number is >5 behind the leader (stuck on an old lap)
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
    if (lapsBehind > 5 || (gapGone && lapsBehind > 2 && !entry.in_pit)) {
      console.log(
        `[proxy] Inferred retirement: ${entry.code || entry.driver_number} (lap ${entry.lap_number} vs leader ${leaderLap}, gapGone=${gapGone})`,
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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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
      watchdogRunning: sessionWatchdog !== null,
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

    // Close any existing connection for this clientId
    const existing = sseClients.get(clientId);
    if (existing) {
      try {
        existing.end();
      } catch (_) {}
      sseClients.delete(clientId);
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.write(`event: initial\ndata: ${JSON.stringify(currentState)}\n\n`);

    sseClients.set(clientId, res);
    console.log(
      `[proxy-sse] Client connected (${clientId}). Unique viewers: ${sseClients.size}`,
    );

    const keepAlive = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(keepAlive);
      if (sseClients.get(clientId) === res) sseClients.delete(clientId);
      console.log(
        `[proxy-sse] Client disconnected (${clientId}). Unique viewers: ${sseClients.size}`,
      );
    });

    return;
  }

  // State endpoint (debugging)
  if (req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(currentState));
    return;
  }

  // Viewers count endpoint
  if (req.url === "/api/viewers") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ viewers: sseClients.size }));
    return;
  }

  // Sessions proxy — forwards to OpenF1 with auth credentials when available.
  // Successful responses are cached; if OpenF1 is down (503/502/timeout) we serve
  // the last good response so the landing schedule keeps working.
  if (reqUrl.pathname.startsWith("/api/sessions")) {
    const queryString = reqUrl.search;
    const upstreamUrl = `https://api.openf1.org/v1/sessions${queryString}`;
    const sendJSON = (status, body, extra = {}) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        ...extra,
      });
      res.end(body);
    };
    const cached = sessionsCache.get(queryString);
    if (cached && Date.now() - cached.ts < SESSIONS_FRESH_MS) {
      sendJSON(200, cached.body, { "X-Cache": "HIT" });
      return;
    }
    try {
      const headers = { Accept: "application/json" };
      if (hasMQTTCredentials()) {
        const token = await ensureValidToken();
        headers["Authorization"] = `Bearer ${token}`;
      }
      const upstreamRes = await fetch(upstreamUrl, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      const body = await upstreamRes.text();
      if (upstreamRes.ok) {
        sessionsCache.set(queryString, { body, ts: Date.now() });
        sendJSON(200, body, { "X-Cache": "MISS" });
        return;
      }
      console.warn(`[proxy] OpenF1 sessions responded ${upstreamRes.status}`);
      if (cached) {
        sendJSON(200, cached.body, { "X-Cache": "STALE" });
        return;
      }
      sendJSON(
        upstreamRes.status,
        JSON.stringify({ error: "upstream_error", status: upstreamRes.status }),
      );
    } catch (err) {
      console.warn(`[proxy] OpenF1 sessions failed: ${err.message}`);
      if (cached) {
        sendJSON(200, cached.body, { "X-Cache": "STALE" });
        return;
      }
      sendJSON(502, JSON.stringify({ error: "upstream_error", detail: err.message }));
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
