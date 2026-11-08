# F1 Dashboard — CLAUDE.md

Real-time F1 telemetry dashboard. Frontend in Next.js 14, backend proxy in Node.js that bridges F1 data sources to the frontend via SSE.

## Architecture

```
Browser (Next.js 14)
  └─ useF1DataSSE.ts (EventSource → /api/sse)
       └─ Next.js rewrite → proxy:4000
            └─ proxy/server.js (Node.js)
                 ├─ stream-buffer.js  (rolling window of broadcast frames — delayed starts)
                 ├─ signalr-client.js (F1 oficial SignalR — ÚNICA fuente live)
                 ├─ mqtt-client.js    (OpenF1 MQTT paid — código dormido, ver abajo)
                 ├─ live-polling.js   (OpenF1 REST polling — free, fallback)
                 ├─ radio-transcriber.js (team radio → texto, OpenAI STT + cache SQLite)
                 └─ replay.js         (session replay — SQLite archive first, REST fallback)
                      ├─ session-store.js      (SQLite archive, better-sqlite3)
                      ├─ session-downloader.js (archives finished sessions, retention=3)
                      └─ openf1-rest.js        (shared auth-aware fetch)
```

`openf1-client.js` and `f1dash-client.js` were deleted. `mqtt-client.js` is the correct OpenF1 paid client, but it is **no longer the live path** — see below.

The proxy normalizes all sources into a single SSE stream. The frontend never talks directly to F1 APIs.

## Fuente de datos en vivo: SignalR, y nada más

**Estado actual (rama `release/production`, post-merge de `feature/signalr-only`): el vivo es 100% SignalR.** El tier pago de OpenF1 MQTT se dejó de usar.

`signalr-client.js` cubre los 15 topics que antes se repartían entre dos fuentes:

| Topic | Qué aporta | Procesado en vivo |
|---|---|---|
| `TimingData` | mini-sectores, tiempos de sector, in_pit, KnockedOut | sí |
| `TimingStats` | mejores personales por sector | sí |
| `TimingAppData` | compuesto + stint de neumáticos | sí |
| `TrackStatus` | banderas, SC, VSC, roja | sí |
| `ExtrapolatedClock` | tiempo restante de sesión | sí |
| `LapCount` | vuelta actual / total de vueltas | sí |
| `DriverList` | nombres, equipos, colores | sí |
| `RaceControlMessages` | mensajes FIA con marshal sector | sí |
| `WeatherData` | clima (mapeado a la forma de OpenF1 weather) | sí |
| `TeamRadio` | URLs de audio | sí |
| `Position.z` | x/y/z de cada auto → track map | sí (`locationSource = "signalr"`) |
| `CarData.z` | rpm, speed, gear, throttle, brake, drs | sí (`currentState.car_data`) |
| `SessionInfo` / `SessionData` | metadata y estado de sesión | sí |

**El feed está cerrado desde 2025.** Es `/signalrcore` (SignalR Core, no el viejo `/signalr`) y requiere un JWT de login de formula1.com en `F1_LIVETIMING_TOKEN` (expira ~4 días; se renueva a mano). Detalles del protocolo que importan:

- Mensajes delimitados por el record separator `0x1e`.
- El `negotiate` devuelve una cookie de sticky session que el WebSocket **tiene** que devolver, o el load balancer rutea a otro nodo y no llega nada.
- `User-Agent: BestHTTP` (el del cliente oficial).
- `Position.z` y `CarData.z` están **gated por entitlement**: necesitan el subscription token interno del JWT enviado como `Authorization: Bearer`, y una cuenta **F1 TV Pro** (Access no alcanza). Sin eso el feed conecta igual y esos dos topics entregan 0 mensajes.
- `negotiate` 401 = token vencido → backoff de 5 min.
- **Los timestamps vienen sin zona** (`2026-11-08T17:27:34`, sin `Z`) y tanto
  Node como el browser los leen como hora **local**: en UTC-3 cada mensaje de
  race control quedaba 3 h en el futuro, siempre más nuevo que la última radio
  (el strip bajo el mapa nunca mostraba una) y con la hora mal impresa. Todo
  `.Utc` del feed pasa por `toUtcISO()` (state-utils.js) antes de entrar al
  estado.

**Qué sigue usando OpenF1 (solo tier gratuito, nada en vivo):**

- El archivo SQLite de sesiones para el modo replay/demo (`session-downloader.js`).
- Calendario y próxima sesión (`src/lib/calendar.ts`, `src/hooks/useNextF1Session.ts`).
- Standings del campeonato (`src/lib/championship.ts`).
- `checkActiveSession()` en `mqtt-client.js`, que el watchdog sigue llamando.

**`mqtt-client.js` y `live-polling.js` son código dormido**, no borrado: siguen alcanzables por `PROXY_MODE=mqtt` / `live-polling`, y `auto` los elige solo si hay credenciales de OpenF1. Sin `OPENF1_USERNAME`/`PASSWORD`, `auto` arranca SignalR directo.

**⚠️ Hueco conocido en modo signalr-only:** ni el watchdog (`tryUpgradeToLive`) ni el supervisor de idle (`checkLiveSourceIdle`) contemplan SignalR — ambos chequean solo `isMQTTRunning()` / `isLivePollingRunning()`. Y `startSignalR()` reconecta con backoff pero nunca cae a replay. Consecuencia: entre sesiones el proxy puede quedar en `mode: "signalr-live"` sin datos y **sin banner de demo**. Si se toca esta zona, es lo primero a arreglar.

## Dev Setup

```bash
# Frontend (port 3000)
npm run dev

# Proxy (port 4000) — run from proxy/ — nodemon watches for file changes
npm run dev

# Both via Docker
docker-compose up
```

Copy `.env.example` → `.env` (frontend) and `proxy/.env.example` → `proxy/.env` (backend) before first run.

## Key Files

| File | Role |
|---|---|
| `src/hooks/useF1DataSSE.ts` | Main data hook — SSE connection, state, reconnect logic |
| `proxy/server.js` | Proxy entry point — picks mode, starts SSE server |
| `proxy/signalr-client.js` | **Fuente live única** — F1 oficial `/signalrcore`, JWT + sticky cookie, 15 topics |
| `proxy/mqtt-client.js` | OpenF1 paid tier (dormido) — OAuth2 + MQTT `mqtt.openf1.org:8883`; aún provee `checkActiveSession()` |
| `proxy/replay.js` | Historical replay — polls OpenF1 REST, auth-aware rate limits |
| `proxy/radio-transcriber.js` | Transcribe cada clip de team radio (OpenAI STT) y cachea el texto en SQLite |
| `proxy/stream-buffer.js` | Rolling window of broadcast frames + snapshots — serves delayed viewers their starting point |
| `src/hooks/useBroadcastDelay.ts` | Per-browser "how far behind live" preference (0–60s) |
| `src/lib/frameQueue.ts` | Frames received but not due yet |
| `src/lib/serverClock.ts` | Estimate of the proxy's clock from frame timestamps |
| `src/lib/constants.ts` | Team colors, tire types, track status mappings |
| `src/types/f1.ts` | All TypeScript interfaces for F1 data |
| `src/app/page.tsx` | Dashboard root — assembles all components |
| `next.config.js` | SSE rewrite rule (`/api/proxy/*` → proxy) |

## Proxy Modes

Set `PROXY_MODE` in `proxy/.env`:

| Mode | Source | Needs credentials? |
|---|---|---|
| `signalr` | **F1 oficial SignalR — el modo en producción** | Yes (`F1_LIVETIMING_TOKEN`) |
| `mqtt` / `openf1` | OpenF1 MQTT (paid, dormido) + SignalR en paralelo | Yes (`OPENF1_USERNAME/PASSWORD`) |
| `live-polling` | OpenF1 REST API | No |
| `replay` | OpenF1 historical data (Baku 2024) | No |
| `auto` | MQTT (si hay creds) → SignalR (si hay token F1) → live-polling → replay | Depends |

**Auto mode fallback chain**: `hasMQTTCredentials()` → MQTT + SignalR en paralelo. Si no hay credenciales pero sí `F1_LIVETIMING_TOKEN` → **SignalR directo, sin chequear sesión** (`checkActiveSession()` devuelve `null` sin credenciales de OpenF1, así que se conecta y se deja que el feed reporte lo que haya en el aire). Sin token ni credenciales → `checkActiveSession()` y live-polling, o replay.

**No active session**: when `date_end` of the latest session is >30 min in the past, `checkActiveSession()` returns false and the proxy falls back to replay automatically.

**Radios de la sesión anterior**: `session_key=latest` de OpenF1 laguea al
empezar una sesión, así que la carga histórica puede traer las radios de la
sesión previa, y `currentState.team_radio` sobrevive al cambio de sesión.
`pruneStaleRadios(state)` (state-utils.js) descarta todo clip anterior a
`session.date_start - 10 min` y corre en cada push de radio; el hook del
frontend filtra igual, porque una pestaña abierta cruza el cambio de sesión.

**Session watchdog**: when the proxy falls back to replay, a watchdog timer fires every 60s and calls `checkActiveSession()`. As soon as a live session appears in the OpenF1 API (typically at session start), the watchdog stops replay, clears state, and starts MQTT+SignalR automatically. This prevents the common failure where the proxy starts during a break between sessions and stays in replay for the entire next session.

`checkActiveSession()` is **tri-state**: `true`, `false`, or `null` when it could not tell (OpenF1 answers 401 for its whole REST API during a live session, and rate limits look the same). The watchdog only leaves replay on a literal `true` — an unknown used to count as "live", so a single failed check tore down a working replay.

**Live-source idle supervisor**: `startMQTT()` still connects on an unknown session check, so a wrong guess could park the proxy in `mqtt-live` with no data, no demo banner and the watchdog already stopped — only a redeploy got it out. Every 60s, if a live source is running, nothing has been broadcast for 5 min (`lastDataAgeSec` in `/health`) and no session is confirmed on air, the proxy stops the live source, falls back to replay and restarts the watchdog. A confirmed live session means a quiet moment (red flag, a gap between practice runs), never a fallback.

**Replay is supervised**: every `startReplay()` call in `server.js` goes through `startReplaySupervised()`, which retries with backoff (30s → 5 min) — a failed start used to leave the dashboard with nothing and no retry. In `replay.js`, each poll cycle is wrapped in try/catch: one throw used to kill the recursive `setTimeout` chain for good, freezing the demo mid-session and never reaching the end-of-data check that loops it back.

## OpenF1 MQTT (paid tier)

- Auth: `POST https://api.openf1.org/token` with `username`/`password` → Bearer token
- Broker: `mqtt.openf1.org:8883` (TLS)
- Topics mirror REST paths: `v1/laps`, `v1/intervals`, `v1/position`, `v1/location`, etc.
- `ensureValidToken()` is exported and used by `replay.js` for authenticated REST calls
- Historical data (laps, intervals, stints, race control, team radio) loaded at startup via REST before MQTT connects
- Rate limits: free = 30 req/min, paid = 60 req/min

## Replay & SQLite session archive

- Session priority: latest finished session from OpenF1 (any type) > `REPLAY_SESSION_KEY` env > newest archived in SQLite > Baku 2024 (9598).
- **Preferred source: SQLite archive** (`proxy/data/f1-sessions.db`, override with `DB_PATH`; Docker volume `proxy-data:/app/data`). 1s update cadence, no rate limits, works offline.
- `server.js` runs `maintainSessionArchive()` every 10 min (first check at +5 min) in every mode: downloads the latest finished session (>30 min past `date_end`, any type) and restarts replay onto it. Retention: 3 sessions, pruned only after a successful download.
- Per-topic completeness in `session_topics` (row_count/attempts, max 4 attempts): the verify pass re-fetches topics that are empty or whose time coverage is <60% of the session span (OpenF1 often has partial `location` even historically — Monaco 2026 race only has fragments). `car_data` is not archived (heavy, replay doesn't use it).
- `openf1-rest.js` holds the shared auth-aware `fetchJSON`; the downloader passes `errorValue=null` to distinguish "no data" (404 → `[]`) from "request failed" — failed windows abort the topic instead of archiving silent gaps. Interrupted downloads resume (topics with rows are skipped).
- REST streaming fallback (only if the archive download fails): paid 6s cycle / 800ms delays, free 4s / 1800ms.
- **Replay loops**: when the replay clock passes the last data point (+60s buffer), it broadcasts `reset` and restarts from the beginning. End is data-driven in DB mode (max ts across laps/location/position/intervals), `date_end` in REST mode. A generation counter (`replayGeneration`) kills stale poll chains across restarts.
- Archived `drivers` get team info backfilled (OpenF1 returns null colours right after a session): pass 1 from the newest archived session, pass 2 from `/v1/drivers?driver_number=N` history (rookies). Drivers topic has `maxAttempts: 12` in the verify pass since colours can take hours to consolidate upstream.

## Transcripción de team radio

Cada clip de radio se transcribe una sola vez y el texto viaja en el mismo
estado SSE, así que se muestra al lado del audio en la lista de radios y en el
`AlertStrip`. Tres campos por clip:

| Campo | Qué es |
|---|---|
| `transcript` | Verbatim: una radio en español queda en español |
| `transcript_en` | El mensaje en inglés |
| `transcript_es` | El mensaje en español latino |

En el `AlertStrip` una radio nueva **retiene el strip 20 s** aunque llegue un
mensaje de race control después (salvo bandera roja, SC, bandera a cuadros y
compañía): por recencia estricta quedaba tapada al instante, porque race
control habla todo el tiempo.

El cliente elige con `radioCaption(radio, language)` (`src/lib/radioText.ts`),
que cae al verbatim si falta la traducción. La traducción es **por sentido, no
literal** ("slow grip" → "poco agarre", no "agarré lento"), con el piloto, la
sesión y la vuelta como contexto en el prompt, tuteo neutro y pretérito simple
(nada de voseo ni de "ha ido empeorando").

- **Dónde**: `proxy/radio-transcriber.js`. Cada fuente que empuja un clip
  (`signalr-client`, `mqtt-client`, `live-polling`, `replay`) llama a
  `enrichRadios(state, broadcastFn)`. Lo cacheado se adjunta en el acto; lo que
  falta se encola (concurrencia 2, 3 intentos) y aterriza en un frame posterior.
  Nunca bloquea el camino del dato en vivo.
- **Cache**: tabla `radio_transcripts` en el mismo SQLite del archivo de
  sesiones, **keyeada por la URL del clip** y no podada por la retención de 3
  sesiones. Un replay en loop paga la transcripción una vez; después es gratis.
  `status`: `ok` | `empty` (sin voz / ruido filtrado) | `failed` (con `attempts`
  para no reintentar para siempre entre reinicios).
- **Config** (`proxy/.env`): `OPENAI_API_KEY` (sin key la feature queda
  apagada y la UI muestra el clip sin texto), `OPENAI_TRANSCRIBE_MODEL`
  (default `gpt-4o-mini-transcribe`), `OPENAI_TRANSCRIBE_LANGUAGE` (vacío =
  autodetect, que es lo que mantiene las radios en español/italiano en su
  idioma), `RADIO_TRANSCRIBE=false` para apagarla sin sacar la key.
- **Dos llamadas por clip**: speech-to-text y una de chat
  (`OPENAI_TRANSLATE_MODEL`, default `gpt-4o-mini`) que devuelve
  `{en, es}` en un solo JSON. Si la traducción falla queda solo el verbatim y
  se reintenta una vez por arranque del proxy, no en loop.
- `/health` expone `radioTranscription: { enabled, cached: {total, ok, empty, failed, translated} }`.
- Si se cambia el prompt de traducción, las filas viejas siguen con el texto
  viejo: `UPDATE radio_transcripts SET text_es = NULL` y reiniciar el proxy
  las vuelve a traducir (el cache en memoria se limpia al arrancar).
- Los modelos alucinan frases fijas sobre silencio ("you", "thank you");
  esas se descartan y se guardan como `empty`. Cuando el filtro descarta algo
  lo loguea (`discarded as noise`), que es la única forma de notar un falso
  positivo.

## Broadcast delay (viewer-set, 0–60s)

The dashboard runs 30–60s ahead of the TV broadcast, so each viewer can hold it
back by an amount of their own. The waiting happens **in the browser**: frames
are queued and applied once the proxy's clock has moved past their timestamp
plus the delay. The SSE stream itself stays a single shared broadcast — the
delay never multiplies work on the server.

- Every frame carries the proxy's send time in the SSE `id:` field. The client
  estimates the proxy's clock from those stamps (`serverClock.ts`, minimum of
  recent `local - server` samples) rather than trusting `Date.now()`.
- **Starting point**: `currentState` is the present, so handing it to a delayed
  viewer would spoil the next minute. `stream-buffer.js` keeps every broadcast
  frame plus a full snapshot every 10s, and `/api/sse?delay=<ms>` serves the
  newest snapshot older than the delay followed by every frame since. The
  buffer records **even with no clients connected** — that is what makes the
  first viewer's page load spoiler-free.
- The delay is part of the connection (the proxy picks the starting point from
  it), so changing it reconnects. The control debounces by 400ms so dragging
  the slider costs one reconnect, not sixty.
- `useF1DataSSE({ delayMs, ready })` keeps the stream closed until the stored
  preference is known — connecting live first and correcting afterwards would
  show exactly the seconds the viewer set a delay to avoid.
- **The session clock must be extrapolated against the same timeline** (proxy
  clock minus delay), not `Date.now()`, or the countdown runs live while the
  table sits a minute behind it.
- Everything outside the SSE stream (`/standings`, `session_result`, next
  session) is **not** delayed. Minor spoiler surface, known and accepted.
- With `delayMs === 0` frames are applied on arrival, bypassing the clock
  estimate — the live path keeps its original latency.

## Frontend — `proxyMode` and Demo Banner

`useF1DataSSE.ts` polls `/health` and reads `data.mode`. Valores posibles: `signalr-live` (producción), `mqtt-live`, `live-polling`, `replay`, `standby`, `unknown`. When `proxyMode === "replay"`, `page.tsx` shows a yellow banner: **"Modo Demo: Datos en vivo no disponibles. Mostrando sesión grabada."**

`signalrDegraded` trata `mqtt-live` y `signalr-live` como modos en vivo; si hay sesión en vivo y SignalR está caído, se muestra el banner de degradado.

`isLive` in `sessionInfo` derives from `SessionInfo.EndDate`: if set and >30 min ago → false. Affects `TrackMap` behavior.

## Log Tags (proxy)

| Tag | Source |
|---|---|
| `[proxy]` | server.js startup/shutdown |
| `[proxy-sse]` | SSE client connect/disconnect |
| `[openf1-mqtt]` | mqtt-client.js |
| `[live-polling]` | live-polling.js |
| `[Replay]` | replay.js |
| `[signalr]` | signalr-client.js — fuente live |
| `[radio-tx]` | radio-transcriber.js — transcripción de team radio |

## Tech Stack

- **Frontend**: Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS, shadcn/ui, Framer Motion
- **Backend**: Node.js 20, `ws` (WebSocket), `mqtt`, nodemon (dev)
- **Fonts**: Official F1 Display (Regular, Bold, Wide) — in `public/fonts/`
- **Path alias**: `@/*` → `src/*`
- **Dark mode**: Tailwind `class`-based

## Tailwind Theme Tokens

```
f1.red / f1.black / f1.gray / f1.darkgray
sector.purple / sector.green / sector.yellow / sector.white
tire.soft / tire.medium / tire.hard / tire.inter / tire.wet
```

## i18n

`LanguageContext.tsx` provides EN/ES translations. Toggle via `LanguageToggle` component. All user-facing strings should use the context hook.

## OpenF1 API Reference

Base URL: `https://api.openf1.org/v1`. All endpoints support generic filtering on any non-array field with `>=`, `<=`, `>`, `<` operators, and `csv=true` for CSV output.

| Endpoint | Description | Key response fields |
|---|---|---|
| `/v1/car_data` | Car telemetry ~3.7 Hz | `brake`, `throttle`, `rpm`, `speed`, `drs`, `n_gear`, `date` |
| `/v1/championship_drivers` | Driver standings (beta, races only) | `driver_number`, `points_current`, `position_current` |
| `/v1/championship_teams` | Team standings (beta, races only) | `team_name`, `points_current`, `position_current` |
| `/v1/drivers` | Driver info for a session | `driver_number`, `name_acronym`, `full_name`, `team_name`, `team_colour`, `headshot_url` |
| `/v1/intervals` | Gap to leader / interval ~4s (races only) | `driver_number`, `gap_to_leader`, `interval`, `date` |
| `/v1/laps` | Per-lap data | `driver_number`, `lap_number`, `lap_duration`, `duration_sector_1/2/3`, `segments_sector_1/2/3`, `is_pit_out_lap`, `date_start` |
| `/v1/location` | Car position on circuit ~3.7 Hz | `driver_number`, `x`, `y`, `z`, `date` |
| `/v1/meetings` | Grand Prix weekend info | `meeting_key`, `meeting_name`, `circuit_key`, `circuit_short_name`, `country_name`, `date_start`, `date_end` |
| `/v1/overtakes` | Overtake events (races only) | `overtaking_driver_number`, `overtaken_driver_number`, `position`, `date` |
| `/v1/pit` | **Pit lane events** | `driver_number`, `lap_number`, `date` (entry time), `lane_duration` (total in pit lane, seconds), `stop_duration` (stationary time, seconds) |
| `/v1/position` | Race position changes | `driver_number`, `position`, `date` |
| `/v1/race_control` | Flags, safety car, incidents | `flag`, `category`, `message`, `scope`, `sector`, `driver_number`, `lap_number`, `date` |
| `/v1/sessions` | Session info | `session_key`, `session_name`, `session_type`, `date_start`, `date_end`, `circuit_key`, `location` |
| `/v1/session_result` | Final standings (available minutes after) | `driver_number`, `position`, `gap_to_leader`, `number_of_laps` |
| `/v1/starting_grid` | Race starting grid (available minutes after) | `driver_number`, `position`, `lap_duration` |
| `/v1/stints` | Stint/tire info | `driver_number`, `stint_number`, `compound`, `lap_start`, `lap_end`, `tyre_age_at_start` |
| `/v1/team_radio` | Team radio recordings | `driver_number`, `recording_url`, `date` |
| `/v1/weather` | Track weather (per minute) | `air_temperature`, `track_temperature`, `rainfall`, `humidity`, `wind_speed`, `wind_direction` |

**Pit detection pattern**: A driver is in the pit lane between `/v1/pit`'s `date` and `date + lane_duration * 1000ms`. The `is_pit_out_lap` field in `/v1/laps` only marks the **outlap** (lap after exit) — it does NOT indicate the driver is currently in the pit lane.

**⚠️ Pit windows are only reliable in Race/Sprint.** In Practice/Quali, `lane_duration` is often null and the windows routinely cover on-track timed laps (verified against Barcelona FP1 2026: 211 timed laps fell inside supposed pit windows). Rules enforced in code: SignalR owns `in_pit` whenever it's connected (`handlePit` returns early); OpenF1 pit windows only apply as fallback in race-like sessions (mqtt-client, live-polling); replay uses a lap-activity heuristic for Practice/Quali (`isDriverOnTrackByLaps` in replay.js).

**MQTT topics** mirror REST paths: `v1/laps`, `v1/pit`, `v1/position`, etc.

## Principio rector: tiempo real ante todo

El objetivo central del dashboard es mostrar telemetría **lo más en vivo posible**. Ante cualquier decisión de diseño, preguntarse: ¿esto le llega al usuario cuando pasa, o varios segundos/vueltas después?

**Regla de fuentes de datos:**

| Dato | Fuente correcta | Por qué |
|------|-----------------|---------|
| Mini-sectores (segmentos) | SignalR | OpenF1 los entrega solo al completar la vuelta — llegan tarde |
| Tiempos de sector en curso | SignalR | Ídem |
| Bandera de pista (SC, roja, etc.) | SignalR | ~200ms vs varios segundos con polling |
| InPit / PitOut en tiempo real | SignalR | OpenF1 MQTT/REST solo confirma el stop cuando ya terminó |
| KnockedOut en clasificación | SignalR | No existe en OpenF1 |
| Tiempo restante de sesión | SignalR | OpenF1 no lo provee |
| Posición en carrera | SignalR | Más confiable y más rápida que MQTT |
| Location x/y para track map | SignalR `Position.z` | Requiere F1 TV Pro; el location live de OpenF1 era inestable |
| Neumáticos / stints | SignalR `TimingAppData` | Llega en el momento, no al cerrar la vuelta |
| Team radio | SignalR `TeamRadio` | URLs del media server oficial |
| Clima | SignalR `WeatherData` | Normalizado a la forma de OpenF1 weather |
| Car data (RPM, velocidad) | SignalR `CarData.z` | Requiere F1 TV Pro; canales 0/2/3/4/5 (sin DRS en 2026) |

La única excepción es el **retraso de transmisión** que configura cada
espectador (ver más arriba): el dato sigue llegando lo más rápido posible y la
espera ocurre en el browser, nunca en la captura.

Todo lo de la tabla sale hoy de una sola fuente: SignalR. La tabla queda porque
explica **por qué** se dejó OpenF1 MQTT, y porque la columna "fuente correcta"
es la regla a respetar si alguna vez se reactiva el código dormido.

**SignalR** = `livetiming.formula1.com/signalrcore` — feed oficial de la F1, WebSocket, datos por evento (no polling). **Gratuito pero con auth desde 2025**, y los topics de GPS/telemetría piden F1 TV Pro.
**OpenF1 MQTT** = paid tier, push-based, segmentos/sectores solo al completar la vuelta. **Ya no se usa en vivo.**

Si el modo híbrido se reactiva (`PROXY_MODE=mqtt`), la regla sigue siendo: SignalR no puede ser sobreescrito por datos de OpenF1 para los campos que gestiona (segmentos, sectores, track_status, clock, in_pit, posición).

## Conventions

- Components go in `src/components/`. Simple UI primitives go in `src/components/ui/` (shadcn/ui pattern).
- Business logic in hooks (`src/hooks/`), not components.
- No tests yet — verify by running the app.
- TypeScript strict mode is on. Don't use `any`.
