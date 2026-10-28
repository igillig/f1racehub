"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Driver,
  SessionInfo,
  TrackStatusInfo,
  SectorStatus,
  TireInfo,
  WeatherData,
  RadioCapture,
  RaceControlMessage,
  CarData,
} from "@/types/f1";
import { CIRCUIT_TO_COUNTRY } from "@/lib/constants";
import { createServerClock } from "@/lib/serverClock";
import {
  createFrameQueue,
  type StreamEventName,
} from "@/lib/frameQueue";

// Use NEXT_PUBLIC_PROXY_URL if set (preferred — direct connection, no Next.js rewrite needed).
// Falls back to /api/proxy (Next.js rewrite) for backwards compatibility.
const PROXY_URL =
  process.env.NEXT_PUBLIC_PROXY_URL ||
  (typeof window !== "undefined"
    ? "/api/proxy"
    : process.env.INTERNAL_PROXY_URL || "http://localhost:4000");

interface F1DataState {
  drivers: Driver[];
  sessionInfo: SessionInfo;
  trackStatus: TrackStatusInfo;
  weather?: WeatherData;
  teamRadios: RadioCapture[];
  raceControlMessages: RaceControlMessage[];
  carData: Record<string, CarData>;
  isConnected: boolean;
  error: string | null;
  proxyMode: string | null;
  signalrDegraded: boolean;
  /**
   * True while a requested delay cannot be honoured yet because the stream
   * does not reach that far back — the first seconds after the proxy starts.
   * What is on screen is older than live, just not by the full amount.
   */
  delaySyncing: boolean;
  /**
   * Increments on every (re)connect. Downstream state that keeps its own
   * playback clock (the track map's GPS buffer) uses it to reset in step with
   * the fresh snapshot a reconnect serves.
   */
  streamEpoch: number;
}

const defaultSessionInfo: SessionInfo = {
  type: "Unknown",
  name: "No Active Session",
  sessionName: "",
  track: "",
  country: "",
  remainingTime: "--:--",
  currentLap: 0,
  totalLaps: 0,
  circuitKey: undefined,
  isLive: false,
  qualifyingPart: undefined,
};

const defaultTrackStatus: TrackStatusInfo = {
  status: 1,
  message: "",
};

// Map OpenF1/SignalR track flag string to numeric status used by the UI
const FLAG_TO_STATUS: Record<string, number> = {
  GREEN: 1,
  YELLOW: 2,
  SC: 4,
  RED: 5,
  VSC: 6,
  CHEQUERED: 7,
  "VSC ENDING": 8,
};

// Format raw seconds to "M:SS.mmm" lap time string
function formatLapTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds <= 0) return "";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const secsStr = secs.toFixed(3).padStart(6, "0");
  return mins > 0 ? `${mins}:${secsStr}` : secsStr;
}

// Format raw gap/interval (number in seconds) to "+X.XXX" string
function formatGap(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === 0) return "";
  if (typeof value === "string") return value; // e.g. "LAP" for lapped cars
  return `+${value.toFixed(3)}`;
}

// Segment status code → SectorStatus
function segmentStatus(code: number): SectorStatus {
  if (code === 2051) return "purple";
  if (code === 2049) return "green";
  if (code === 2064) return "blue";
  if (code === 2048) return "yellow";
  return "none";
}

// Derive sector time colour from actual timing data.
// Purple = beats or matches the session record; green = personal best; yellow = slower.
function computeSectorTimeStatus(
  current: number | null | undefined,
  personal: number | null | undefined,
  sessionBest: number,
): SectorStatus {
  if (current == null) return "none";
  if (sessionBest < Infinity && current <= sessionBest) return "purple";
  if (personal == null || current <= personal) return "green";
  return "yellow";
}

interface StreamOptions {
  /**
   * How far behind live to run, in ms. Zero streams as it arrives. Frames are
   * held in a queue and applied once the proxy's clock has moved past their
   * timestamp plus this much, which is what lets someone line the dashboard up
   * with a TV broadcast. See useBroadcastDelay.
   */
  delayMs?: number;
  /**
   * Whether `delayMs` is final. The proxy picks a viewer's starting point from
   * it, so the stream stays closed until it is known — connecting live first
   * and correcting afterwards would show exactly the seconds a delay is set to
   * avoid.
   */
  ready?: boolean;
}

export function useF1DataSSE({
  delayMs = 0,
  ready = true,
}: StreamOptions = {}): F1DataState {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [sessionInfo, setSessionInfo] =
    useState<SessionInfo>(defaultSessionInfo);
  const [trackStatus, setTrackStatus] =
    useState<TrackStatusInfo>(defaultTrackStatus);
  const [weather, setWeather] = useState<WeatherData | undefined>(undefined);
  const [teamRadios, setTeamRadios] = useState<RadioCapture[]>([]);
  const [raceControlMessages, setRaceControlMessages] = useState<
    RaceControlMessage[]
  >([]);
  const [carData, setCarData] = useState<Record<string, CarData>>({});
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proxyMode, setProxyMode] = useState<string | null>(null);
  // True when there's a live session (mqtt-live) but the official SignalR
  // timing feed is down — some data arrives delayed or is missing.
  const [signalrDegraded, setSignalrDegraded] = useState(false);
  const [delaySyncing, setDelaySyncing] = useState(false);
  // Increments every time the stream (re)connects. A reconnect serves a fresh
  // snapshot, so anything that keeps its own playback state keyed to the data
  // clock — the track map's GPS buffer — has to be told to start over, or it
  // keeps playing the pre-reconnect positions against a rewound stream.
  const [streamEpoch, setStreamEpoch] = useState(0);

  // ── Broadcast delay ────────────────────────────────────────────────────────
  // Frames wait in the queue until the proxy's clock, as estimated from the
  // timestamps the frames themselves carry, has moved past their own plus the
  // delay. Everything downstream — the table, the map, the session clock — is
  // then uniformly that far behind live, with no component left looking at the
  // present.
  const queueRef = useRef(createFrameQueue());
  const serverClockRef = useRef(createServerClock());
  const delayMsRef = useRef(delayMs);
  delayMsRef.current = delayMs;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  // Set when the proxy was reachable but the delay was not settled yet, so the
  // stream can be opened as soon as it is.
  const startWhenReadyRef = useRef(false);
  // Send time of the newest frame applied, i.e. how old what is on screen is.
  const lastAppliedTsRef = useRef<number | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const healthCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const statusPollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const clockIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isConnectedRef = useRef(false);
  // Stale-connection watchdog: tracks the last time an SSE event actually
  // arrived. If the stream silently stops delivering (a half-dead socket buffers
  // writes without throwing, so onerror never fires), we force a reconnect so
  // the dashboard self-heals instead of freezing until the user refreshes.
  const lastSseEventRef = useRef<number>(Date.now());
  const staleWatchdogRef = useRef<NodeJS.Timeout | null>(null);
  const STALE_EVENT_MS = 45000; // no SSE event in 45s → stale, force reconnect
  const WATCHDOG_CHECK_MS = 10000;

  // Clock data received from the proxy (data.clock)
  const clockRef = useRef<{ utc: string; remaining: string; extrapolating?: boolean } | null>(null);

  // Driver info cache populated from data.drivers
  const driverListRef = useRef<
    Record<
      string,
      { name: string; team: string; code: string; teamColor: string }
    >
  >({});

  // Car location cache from data.location
  const carDataRef = useRef<
    Record<string, { x: number; y: number; t?: number }>
  >({});
  // Merged timing for every driver. The proxy only sends drivers whose entry
  // actually changed (~1 of 22 per frame), so the update alone is not a picture
  // of the session: session-wide values like the best sector times, and the
  // driver rows themselves, have to be built from the accumulated state.
  const timingRef = useRef<Record<string, Record<string, unknown>>>({});

  // Session-wide max segment counts so all drivers show the same bar count
  const maxSegCounts = useRef<{ s1: number; s2: number; s3: number }>({
    s1: 6,
    s2: 6,
    s3: 6,
  });

  // Session type drives the sort order (Race vs Practice/Qualifying)
  const sessionTypeRef = useRef<string>("Race");

  // Fastest lap seen in this session (raw seconds), used to set lastLapOverallFastest
  const sessionFastestLapRef = useRef<number>(Infinity);
  const sessionFastestDriverRef = useRef<string | null>(null);

  // Track qualifying part so we can reset fastest-lap tracking when it advances
  const qualifyingPartRef = useRef<number | undefined>(undefined);

  // Whether the official SignalR feed is the authoritative live position source
  // (mqtt-live mode with SignalR connected). When true, race positions update on
  // every change and are the correct sort key. When false (replay, live-polling,
  // or a degraded mqtt session without SignalR), position can be stale, so we
  // fall back to sorting by gap.
  const signalrOwnsPositionRef = useRef(false);

  const processData = useCallback((data: any) => {
    if (!data) return;

    try {
      // ── 1. Driver info cache ─────────────────────────────────────────────
      const driversData = data.drivers;
      if (driversData && typeof driversData === "object") {
        Object.entries(driversData).forEach(([num, d]: [string, any]) => {
          if (d && typeof d === "object") {
            driverListRef.current[num] = {
              name: d.full_name || `Driver ${num}`,
              team: d.team_name || null,
              code: d.name_acronym || num,
              teamColor: d.team_colour ? `#${d.team_colour}` : "",
            };
          }
        });
      }

      // ── 2. Location cache ───────────────────────────────────────────────
      const locationData = data.location;
      if (locationData && typeof locationData === "object") {
        Object.entries(locationData).forEach(([num, loc]: [string, any]) => {
          if (loc?.x !== undefined && loc?.y !== undefined) {
            carDataRef.current[num] = { x: loc.x, y: loc.y, t: loc.t };
          }
        });
      }

      // ── 3. Session info ─────────────────────────────────────────────────
      const sessionData = data.session;
      const lapCount = data.lap_count;

      if (sessionData || lapCount) {
        const sessionType = sessionData?.session_type;
        if (sessionType) sessionTypeRef.current = sessionType;

        const circuitShortName = sessionData?.circuit_short_name;
        const countryName =
          sessionData?.country_name ||
          (circuitShortName ? CIRCUIT_TO_COUNTRY[circuitShortName] : undefined);
        const dateEnd = sessionData?.date_end;

        setSessionInfo((prev) => ({
          ...prev,
          type: sessionType || prev.type,
          name: sessionData?.meeting_name || prev.name,
          sessionName: sessionData?.session_name || prev.sessionName,
          track: circuitShortName || prev.track,
          country: countryName || prev.country,
          currentLap: lapCount?.current || prev.currentLap,
          totalLaps: lapCount?.total || prev.totalLaps,
          circuitKey: sessionData?.circuit_key || prev.circuitKey,
          qualifyingPart: sessionData?.qualifying_part ?? prev.qualifyingPart,
          isLive: dateEnd
            ? new Date(dateEnd) > new Date(Date.now() - 30 * 60 * 1000)
            : true,
        }));

        // When the qualifying segment advances (Q1→Q2, Q2→Q3), reset fastest-lap
        // tracking so the new segment starts fresh.
        const newPart = sessionData?.qualifying_part;
        if (
          newPart != null &&
          qualifyingPartRef.current != null &&
          newPart > qualifyingPartRef.current
        ) {
          sessionFastestLapRef.current = Infinity;
          sessionFastestDriverRef.current = null;
        }
        if (newPart != null) qualifyingPartRef.current = newPart;
      }

      // ── 4. Clock ────────────────────────────────────────────────────────
      const clockData = data.clock;
      if (clockData?.remaining && clockData?.utc) {
        clockRef.current = {
          remaining: clockData.remaining,
          utc: clockData.utc,
          extrapolating: clockData.extrapolating,
        };
      }

      // ── 5. Track status ─────────────────────────────────────────────────
      const trackStatusData = data.track_status;
      if (trackStatusData?.flag) {
        setTrackStatus((prev) => {
          const next = FLAG_TO_STATUS[trackStatusData.flag] ?? 1;
          // Once CHEQUERED is showing in Q3 (or non-qualifying), don't let a
          // concurrent yellow flag from an incident downgrade it — the session
          // is over and the clock code would re-assert CHEQUERED every second.
          const qualiPart = qualifyingPartRef.current;
          const isEndOfSession = qualiPart === undefined || qualiPart >= 3;
          if (prev.status === 7 && isEndOfSession && next !== 7) return prev;
          return { status: next, message: trackStatusData.flag };
        });
      }

      // ── 6. Weather ──────────────────────────────────────────────────────
      const weatherData = data.weather;
      if (weatherData) {
        setWeather({
          airTemp: weatherData.air_temperature ?? 0,
          humidity: weatherData.humidity ?? 0,
          pressure: weatherData.pressure ?? 0,
          rainfall: weatherData.rainfall === true,
          trackTemp: weatherData.track_temperature ?? 0,
          windDirection: weatherData.wind_direction ?? 0,
          windSpeed: weatherData.wind_speed ?? 0,
        });
      }

      // ── 7. Team radio ────────────────────────────────────────────────────
      const teamRadioData = data.team_radio;
      if (Array.isArray(teamRadioData) && teamRadioData.length > 0) {
        setTeamRadios((prev) => {
          const newCaptures: RadioCapture[] = teamRadioData
            .filter((r: any) => r?.recording_url)
            .map((r: any) => ({
              utc: r.date,
              racingNumber: String(r.driver_number),
              path: r.recording_url, // already a full URL from OpenF1
            }));
          const merged = [...newCaptures, ...prev];
          const unique = merged.filter(
            (c, i) => merged.findIndex((x) => x.path === c.path) === i,
          );
          unique.sort(
            (a, b) => new Date(b.utc).getTime() - new Date(a.utc).getTime(),
          );
          return unique.slice(0, 20);
        });
      }

      // ── 8. Race control messages ─────────────────────────────────────────
      const raceControlData = data.race_control_messages;
      if (Array.isArray(raceControlData) && raceControlData.length > 0) {
        setRaceControlMessages((prev) => {
          const newMessages: RaceControlMessage[] = raceControlData
            .filter((m: any) => m?.message)
            .map((m: any) => ({
              utc: m.date,
              message: m.message,
              category: m.category,
              flag: m.flag,
              lap: m.lap_number,
              driverNumber:
                m.driver_number != null ? String(m.driver_number) : undefined,
              sector: m.sector,
            }));
          const merged = [...newMessages, ...prev];
          const unique = merged.filter(
            (m, i) =>
              merged.findIndex(
                (x) => x.utc === m.utc && x.message === m.message,
              ) === i,
          );
          unique.sort(
            (a, b) => new Date(b.utc).getTime() - new Date(a.utc).getTime(),
          );
          return unique.slice(0, 200);
        });
      }

      // ── 9. Car telemetry ────────────────────────────────────────────────────
      const carDataRaw = data.car_data;
      if (carDataRaw && typeof carDataRaw === "object") {
        setCarData(carDataRaw as Record<string, CarData>);
      }

      // Every GPS fix the proxy queued since its last flush, per driver. The
      // single `location` slot only carries the newest one; these are the full
      // stream, and the track map needs them to interpolate without holes.
      const locationFixes = data.location_fixes as
        | Record<string, { x: number; y: number; t: number }[]>
        | undefined;

      // ── 10. Timing data → drivers ─────────────────────────────────────────
      // Merge this update's drivers into the accumulated timing, then work from
      // the accumulated copy: a frame carries only the drivers that changed, and
      // an update with no timing at all still has to rebuild the rows so the
      // track map receives its GPS fixes.
      if (data.timing) {
        Object.entries(data.timing).forEach(([num, entry]) => {
          timingRef.current[num] = {
            ...timingRef.current[num],
            ...(entry as Record<string, unknown>),
          };
        });
      }
      const timingData = timingRef.current;
      if (Object.keys(timingData).length === 0) return;

      // Update session fastest lap tracking before building drivers
      Object.entries(timingData).forEach(([num, entry]: [string, any]) => {
        const lastLap = entry?.last_lap;
        if (
          lastLap != null &&
          lastLap > 0 &&
          lastLap < sessionFastestLapRef.current
        ) {
          sessionFastestLapRef.current = lastLap;
          sessionFastestDriverRef.current = num;
        }
      });

      // Compute overall session-best sector times across all drivers (for purple highlighting)
      const overallBestSectors = { s1: Infinity, s2: Infinity, s3: Infinity };
      Object.values(timingData).forEach((entry: any) => {
        if (
          entry.best_sector_1 != null &&
          entry.best_sector_1 < overallBestSectors.s1
        )
          overallBestSectors.s1 = entry.best_sector_1;
        if (
          entry.best_sector_2 != null &&
          entry.best_sector_2 < overallBestSectors.s2
        )
          overallBestSectors.s2 = entry.best_sector_2;
        if (
          entry.best_sector_3 != null &&
          entry.best_sector_3 < overallBestSectors.s3
        )
          overallBestSectors.s3 = entry.best_sector_3;
      });

      setDrivers((prev) => {
        const driversMap = new Map(prev.map((d) => [d.driverNumber, d]));

        Object.entries(timingData).forEach(([num, entry]: [string, any]) => {
          const existing = driversMap.get(num);

          const apiInfo = driverListRef.current[num];
          const driverInfo = {
            name: apiInfo?.name || `Driver ${num}`,
            team: apiInfo?.team || "Unknown",
            code: apiInfo?.code || num,
            teamColor: apiInfo?.teamColor || "",
          };

          // Tire info comes from timing entry directly
          const tire: TireInfo = {
            compound: entry.compound || existing?.tire?.compound || "UNKNOWN",
            age: entry.tyre_age ?? existing?.tire?.age ?? 0,
            isNew: false,
          };

          // Segments (plain number arrays)
          const segs1: number[] = Array.isArray(entry.segments_1)
            ? entry.segments_1
            : [];
          const segs2: number[] = Array.isArray(entry.segments_2)
            ? entry.segments_2
            : [];
          const segs3: number[] = Array.isArray(entry.segments_3)
            ? entry.segments_3
            : [];

          // Update session-wide max so all drivers show equal bar counts
          if (segs1.length > maxSegCounts.current.s1)
            maxSegCounts.current.s1 = segs1.length;
          if (segs2.length > maxSegCounts.current.s2)
            maxSegCounts.current.s2 = segs2.length;
          if (segs3.length > maxSegCounts.current.s3)
            maxSegCounts.current.s3 = segs3.length;

          const s1Count =
            maxSegCounts.current.s1 || existing?.sector1SegmentCount || 6;
          const s2Count =
            maxSegCounts.current.s2 || existing?.sector2SegmentCount || 6;
          const s3Count =
            maxSegCounts.current.s3 || existing?.sector3SegmentCount || 6;

          // Build padded mini-sector array
          const padNone = (arr: SectorStatus[], n: number): SectorStatus[] => {
            const r = arr.slice(0, n);
            while (r.length < n) r.push("none");
            return r;
          };
          const hasSegs =
            segs1.some((s) => s !== 0) ||
            segs2.some((s) => s !== 0) ||
            segs3.some((s) => s !== 0);
          const miniSectors: SectorStatus[] = hasSegs
            ? [
                ...padNone(segs1.map(segmentStatus), s1Count),
                ...padNone(segs2.map(segmentStatus), s2Count),
                ...padNone(segs3.map(segmentStatus), s3Count),
              ]
            : existing?.miniSectors || [];

          // Track progress: fraction of non-zero segments
          const allSegs = [...segs1, ...segs2, ...segs3];
          const trackProgress =
            allSegs.length > 0
              ? allSegs.filter((s) => s !== 0).length / allSegs.length
              : 0;

          // Sector-level status based on actual timing data (not mini-segments).
          // Only one driver can hold the session record per sector.
          const s1Status =
            entry.sector_1 != null
              ? computeSectorTimeStatus(
                  entry.sector_1,
                  entry.best_sector_1,
                  overallBestSectors.s1,
                )
              : existing?.sector1Status || "none";
          const s2Status =
            entry.sector_2 != null
              ? computeSectorTimeStatus(
                  entry.sector_2,
                  entry.best_sector_2,
                  overallBestSectors.s2,
                )
              : existing?.sector2Status || "none";
          const s3Status =
            entry.sector_3 != null
              ? computeSectorTimeStatus(
                  entry.sector_3,
                  entry.best_sector_3,
                  overallBestSectors.s3,
                )
              : existing?.sector3Status || "none";

          const driver: Driver = {
            position: entry.position ?? existing?.position ?? 0,
            driverNumber: num,
            code: driverInfo.code,
            name: driverInfo.name,
            team: driverInfo.team,
            teamColor: driverInfo.teamColor || existing?.teamColor,
            gap:
              entry.gap_to_leader !== undefined
                ? formatGap(entry.gap_to_leader)
                : (existing?.gap ?? ""),
            interval:
              entry.interval !== undefined
                ? formatGap(entry.interval)
                : (existing?.interval ?? ""),
            lastLap:
              entry.last_lap !== undefined
                ? formatLapTime(entry.last_lap)
                : (existing?.lastLap ?? ""),
            lastLapPersonalBest: entry.last_lap_is_pb || false,
            lastLapOverallFastest: num === sessionFastestDriverRef.current,
            bestLap:
              entry.best_lap !== undefined
                ? formatLapTime(entry.best_lap)
                : (existing?.bestLap ?? ""),
            sector1:
              entry.sector_1 !== undefined
                ? formatLapTime(entry.sector_1)
                : (existing?.sector1 ?? ""),
            sector2:
              entry.sector_2 !== undefined
                ? formatLapTime(entry.sector_2)
                : (existing?.sector2 ?? ""),
            sector3:
              entry.sector_3 !== undefined
                ? formatLapTime(entry.sector_3)
                : (existing?.sector3 ?? ""),
            bestSector1:
              entry.best_sector_1 !== undefined
                ? formatLapTime(entry.best_sector_1)
                : (existing?.bestSector1 ?? ""),
            bestSector2:
              entry.best_sector_2 !== undefined
                ? formatLapTime(entry.best_sector_2)
                : (existing?.bestSector2 ?? ""),
            bestSector3:
              entry.best_sector_3 !== undefined
                ? formatLapTime(entry.best_sector_3)
                : (existing?.bestSector3 ?? ""),
            hasSector1Record:
              entry.best_sector_1 != null &&
              overallBestSectors.s1 < Infinity &&
              entry.best_sector_1 === overallBestSectors.s1,
            hasSector2Record:
              entry.best_sector_2 != null &&
              overallBestSectors.s2 < Infinity &&
              entry.best_sector_2 === overallBestSectors.s2,
            hasSector3Record:
              entry.best_sector_3 != null &&
              overallBestSectors.s3 < Infinity &&
              entry.best_sector_3 === overallBestSectors.s3,
            sector1Status: s1Status,
            sector2Status: s2Status,
            sector3Status: s3Status,
            miniSectors,
            sector1SegmentCount: s1Count,
            sector2SegmentCount: s2Count,
            sector3SegmentCount: s3Count,
            tire,
            inPit:
              entry.in_pit !== undefined
                ? entry.in_pit
                : (existing?.inPit ?? false),
            // OUT badge is only meaningful in Practice/Qualifying (lap doesn't count).
            // In Race/Sprint, the out-lap is a normal racing lap — suppress the badge.
            isPitOutLap:
              (sessionTypeRef.current !== "Race" && sessionTypeRef.current !== "Sprint")
                ? (entry.is_pit_out_lap !== undefined
                    ? entry.is_pit_out_lap
                    : (existing?.isPitOutLap ?? false))
                : false,
            pitCount: entry.pit_count ?? existing?.pitCount ?? 0,
            retired:
              entry.retired !== undefined
                ? entry.retired
                : (existing?.retired ?? false),
            knockedOut:
              entry.knocked_out !== undefined
                ? entry.knocked_out
                : (existing?.knockedOut ?? false),
            currentLap: entry.lap_number || existing?.currentLap,
            trackProgress,
            trackX: carDataRef.current[num]?.x ?? existing?.trackX,
            trackY: carDataRef.current[num]?.y ?? existing?.trackY,
            trackT: carDataRef.current[num]?.t ?? existing?.trackT,
            // Only this update's fixes — no carry-over, they are consumed once.
            trackFixes: locationFixes?.[num],
          };

          driversMap.set(num, driver);
        });

        // Parse lap time string to milliseconds for sorting
        const parseLapTime = (lapTime: string | undefined): number => {
          if (!lapTime || lapTime === "" || lapTime === "---") return Infinity;
          const parts = lapTime.split(/[:.]/).map(Number);
          if (parts.length === 3)
            return parts[0] * 60000 + parts[1] * 1000 + parts[2];
          if (parts.length === 2) return parts[0] * 1000 + parts[1];
          return Infinity;
        };

        const isPracticeOrQualy =
          sessionTypeRef.current === "Practice" ||
          sessionTypeRef.current === "Qualifying" ||
          sessionTypeRef.current?.includes("Practice") ||
          sessionTypeRef.current?.includes("Qualifying");

        // If OpenF1 has returned a session driver list, use it as the authority.
        // This prevents stale drivers from a previous session (e.g. replay) from showing up.
        const sessionDriverNums = Object.keys(driverListRef.current);
        if (sessionDriverNums.length > 0) {
          for (const num of Array.from(driversMap.keys())) {
            if (!sessionDriverNums.includes(num)) driversMap.delete(num);
          }
        }

        const sortedDrivers = Array.from(driversMap.values())
          .filter((d) => d.driverNumber)
          .sort((a, b) => {
            if (a.retired && !b.retired) return 1;
            if (!a.retired && b.retired) return -1;
            // Both retired → more laps completed = ranked higher (retired later)
            if (a.retired && b.retired) {
              return (b.currentLap || 0) - (a.currentLap || 0);
            }
            if (a.knockedOut && !b.knockedOut) return 1;
            if (!a.knockedOut && b.knockedOut) return -1;

            if (isPracticeOrQualy) {
              const timeA = parseLapTime(a.bestLap);
              const timeB = parseLapTime(b.bestLap);
              if (timeA === Infinity && timeB === Infinity) {
                return (a.position || 99) - (b.position || 99);
              }
              if (timeA === Infinity) return 1;
              if (timeB === Infinity) return -1;
              return timeA - timeB;
            } else {
              // Race/Sprint: sort by gap_to_leader when available — it is
              // self-consistent because gap and interval come from the same
              // API call. The position field can lag or disagree with gap data
              // (OpenF1 /v1/position only fires on changes, so a stale position
              // event can place a driver ahead of someone with a smaller gap).
              // Fall back to position only when gap data hasn't arrived yet
              // (early laps, first poll window).
              const parseGap = (g: string) => {
                if (!g) return 0; // leader (empty string = 0 gap)
                if (g.toUpperCase().includes("LAP")) {
                  // "+1 LAP" → 10000, "+2 LAPS" → 11000, etc.
                  const laps = parseInt(g, 10) || 1;
                  return 9000 + laps * 1000;
                }
                if (g.startsWith("+")) return parseFloat(g.slice(1)) || 0;
                return 99999; // any other non-numeric → end
              };

              // When SignalR is the authoritative live position source it updates
              // position on every change, making position the correct primary
              // sort key. Gap can diverge from the real running order during VSC
              // or pit stops and made the leaderboard look wrong (bug #12).
              if (signalrOwnsPositionRef.current && a.position > 0 && b.position > 0) {
                if (a.position !== b.position) return a.position - b.position;
                return parseGap(a.gap) - parseGap(b.gap);
              }

              // A driver "has gap data" if their gap string is non-empty, OR
              // if they are the known leader (position === 1, gap deliberately "").
              const aHasGap = a.gap !== "" || a.position === 1;
              const bHasGap = b.gap !== "" || b.position === 1;
              if (aHasGap && bHasGap) {
                const gapDiff = parseGap(a.gap) - parseGap(b.gap);
                if (gapDiff !== 0) {
                  // If explicit positions strongly contradict the gap order by
                  // 3+ places, trust position: gap can freeze for a retired or
                  // stopped driver while SignalR position continues updating.
                  const posA = a.position;
                  const posB = b.position;
                  if (
                    posA > 0 &&
                    posB > 0 &&
                    Math.sign(gapDiff) !== Math.sign(posA - posB) &&
                    Math.abs(posA - posB) >= 3
                  ) {
                    return posA - posB;
                  }
                  return gapDiff;
                }
                // Same gap bucket (e.g. both "+1 LAP") → fall back to position
                const posA = a.position;
                const posB = b.position;
                if (posA > 0 && posB > 0) return posA - posB;
                return 0;
              }
              // One or both missing gap data — use API position so a driver
              // without a gap reading doesn't drop below everyone who has one.
              const posA = a.position;
              const posB = b.position;
              if (posA > 0 && posB > 0) return posA - posB;
              if (posA > 0) return -1;
              if (posB > 0) return 1;
              return 0;
            }
          });

        const fastestTime = isPracticeOrQualy
          ? Math.min(...sortedDrivers.map((d) => parseLapTime(d.bestLap)))
          : 0;

        return sortedDrivers.map((driver, index) => {
          let gap = driver.gap;
          let interval = driver.interval;

          if (isPracticeOrQualy && driver.bestLap) {
            const driverTime = parseLapTime(driver.bestLap);
            if (index === 0) {
              gap = "";
              interval = "";
            } else if (driverTime !== Infinity) {
              const gapMs = driverTime - fastestTime;
              gap = gapMs > 0 ? `+${(gapMs / 1000).toFixed(3)}` : "";

              const prevDriver = sortedDrivers[index - 1];
              const prevTime = parseLapTime(prevDriver?.bestLap);
              if (prevTime !== Infinity) {
                const intervalMs = driverTime - prevTime;
                interval =
                  intervalMs > 0 ? `+${(intervalMs / 1000).toFixed(3)}` : "";
              }
            }
          }

          return { ...driver, position: index + 1, gap, interval };
        });
      });
    } catch (err) {
      console.error("Error processing data:", err);
    }
  }, []);

  // Everything accumulated for one session. A fresh snapshot and a session
  // reset both start from here; what they clear on top of it differs.
  const clearSessionState = useCallback(() => {
    setDrivers([]);
    driverListRef.current = {};
    timingRef.current = {};
    maxSegCounts.current = { s1: 6, s2: 6, s3: 6 };
    sessionFastestLapRef.current = Infinity;
    sessionFastestDriverRef.current = null;
    qualifyingPartRef.current = undefined;
  }, []);

  // The one place a frame reaches the UI, whether it was just received or has
  // been waiting out a broadcast delay.
  const applyFrame = useCallback(
    (frame: { ts: number; event: StreamEventName; raw: string }) => {
      lastAppliedTsRef.current = frame.ts;

      // Proxy signals a session change — clear all accumulated state
      if (frame.event === "reset") {
        console.log("[SSE] Session reset — clearing state");
        clearSessionState();
        carDataRef.current = {};
        setRaceControlMessages([]);
        setTeamRadios([]);
        return;
      }

      const data = JSON.parse(frame.raw);

      if (frame.event === "initial") {
        // Reset driver-related state so stale entries from a previous session
        // don't persist. carDataRef (location) is intentionally NOT cleared: if
        // this is a reconnect mid-session we keep last known positions so the
        // map doesn't dump everyone to pit lane while waiting for the next MQTT
        // location batch. processData below will overwrite with fresh positions
        // as soon as they arrive.
        clearSessionState();
      }

      if (Object.keys(data).length > 0) processData(data);
    },
    [processData, clearSessionState],
  );

  // Release every frame whose time has come. Called on arrival, so a viewer
  // with no delay set sees it in the same tick, and on a timer, so a delayed
  // viewer doesn't need a new frame to arrive before the previous one shows.
  const drainDueFrames = useCallback(() => {
    const delay = delayMsRef.current;
    // No delay means due on arrival. Going through the clock estimate instead
    // would cost every frame the network latency it has already spent, which
    // is the opposite of what this dashboard is for.
    const until =
      delay === 0 ? Infinity : serverClockRef.current.now() - delay;
    for (const frame of queueRef.current.drainUpTo(until)) applyFrame(frame);
  }, [applyFrame]);

  // What the last connect() asked the proxy for, so a change of mind can be
  // told apart from a reconnect.
  const connectedDelayRef = useRef(delayMs);

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // Bump the epoch before the snapshot arrives, so playback state that keeps
    // its own clock (the map's GPS buffer) is cleared and re-keys to the
    // snapshot rather than playing the old live positions against it.
    setStreamEpoch((e) => e + 1);

    console.log(`[SSE] Connecting to ${PROXY_URL}/api/sse`);

    let clientId = localStorage.getItem("f1_client_id");
    if (!clientId) {
      clientId = crypto.randomUUID();
      localStorage.setItem("f1_client_id", clientId);
    }

    // The delay travels with the connection: it decides where in its stored
    // window the proxy starts this viewer off. Everything after that point is
    // the same stream every other viewer gets.
    const requestedDelay = delayMsRef.current;
    connectedDelayRef.current = requestedDelay;
    queueRef.current.clear();

    const eventSource = new EventSource(
      `${PROXY_URL}/api/sse?clientId=${clientId}&delay=${requestedDelay}`,
    );
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      console.log("[SSE] Connected");
      lastSseEventRef.current = Date.now();
      setIsConnected(true);
      isConnectedRef.current = true;
      setError(null);
      if (healthCheckIntervalRef.current) {
        clearInterval(healthCheckIntervalRef.current);
        healthCheckIntervalRef.current = null;
      }
    };

    // Frames go in the queue and come out when they are due. Arrival time is
    // only used to keep the stale-connection watchdog honest — the proxy's own
    // timestamp, carried in the SSE id, is what the delay is measured against.
    const receive =
      (name: StreamEventName) => (message: MessageEvent<string>) => {
        lastSseEventRef.current = Date.now();
        const ts = Number(message.lastEventId) || Date.now();
        serverClockRef.current.sample(ts);

        if (name === "initial") {
          console.log(
            `[SSE] Received initial state (${(Date.now() - ts) / 1000}s old)`,
          );
          // A snapshot replaces the stream it starts, so anything still queued
          // from before belongs to the old one. And it goes on screen straight
          // away rather than waiting its turn: the proxy never hands out a
          // snapshot newer than the delay asked for, so this is the oldest
          // state available, and holding it back would leave the dashboard
          // blank while the proxy's window is still filling.
          queueRef.current.clear();
          applyFrame({ ts, event: name, raw: message.data });
          return;
        }

        queueRef.current.push({ ts, event: name, raw: message.data });
        drainDueFrames();
      };

    eventSource.addEventListener("initial", receive("initial"));
    eventSource.addEventListener("reset", receive("reset"));
    eventSource.addEventListener("update", receive("update"));

    eventSource.onerror = (err) => {
      console.error("[SSE] Error:", err);
      setIsConnected(false);
      isConnectedRef.current = false;
      setError("RECONNECTING");
      eventSource.close();
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 5000);
    };

    // Stale-connection watchdog — reconnect if the stream goes quiet for too
    // long. This recovers the case where the EventSource stays "open" but the
    // proxy's writes buffer on a half-dead socket and never arrive, leaving the
    // dashboard frozen on stale data until a manual refresh.
    if (staleWatchdogRef.current) clearInterval(staleWatchdogRef.current);
    staleWatchdogRef.current = setInterval(() => {
      if (eventSourceRef.current !== eventSource) return; // a newer connect owns this
      if (Date.now() - lastSseEventRef.current > STALE_EVENT_MS) {
        console.warn(
          `[SSE] No data for ${STALE_EVENT_MS / 1000}s — forcing reconnect`,
        );
        connect();
      }
    }, WATCHDOG_CHECK_MS);
  }, [applyFrame, drainDueFrames]);

  // The proxy is reachable — open the stream, unless the delay this viewer
  // wants is still being read, in which case opening it is what the effect
  // below does as soon as it is known.
  const startStream = useCallback(() => {
    if (!readyRef.current) {
      startWhenReadyRef.current = true;
      return;
    }
    connect();
  }, [connect]);

  // Queued frames fall due whether or not new ones are arriving, so the queue
  // is checked on a timer too. 10 Hz matches the proxy's flush cadence, which
  // keeps a delayed viewer on the same rhythm the data was produced in.
  useEffect(() => {
    const interval = setInterval(drainDueFrames, 100);
    return () => clearInterval(interval);
  }, [drainDueFrames]);

  // The proxy picks a viewer's starting point from the delay they connect with,
  // so changing it means reconnecting — which also discards a queue that was
  // timed against the old setting. While disconnected there is nothing to do:
  // the next connect reads the current value anyway.
  useEffect(() => {
    if (!ready) return;
    if (startWhenReadyRef.current) {
      startWhenReadyRef.current = false;
      connect();
      return;
    }
    if (!isConnectedRef.current) return;
    if (connectedDelayRef.current === delayMs) return;
    console.log(`[SSE] Broadcast delay changed to ${delayMs / 1000}s`);
    connect();
  }, [ready, delayMs, connect]);

  // Whether the delay asked for is actually in force. The proxy keeps a window
  // of the stream, not all of it, so for the first minute after it starts the
  // oldest state it can serve may still be younger than the delay.
  useEffect(() => {
    if (delayMs === 0) {
      setDelaySyncing(false);
      return;
    }
    const check = () => {
      const applied = lastAppliedTsRef.current;
      if (applied === null) {
        setDelaySyncing(false); // nothing on screen to be behind with
        return;
      }
      // The tolerance absorbs the gap between frames and the clock estimate.
      setDelaySyncing(serverClockRef.current.now() - applied < delayMs - 3000);
    };
    check();
    const interval = setInterval(check, 1000);
    return () => clearInterval(interval);
  }, [delayMs]);

  // Clock extrapolation — ticks every second
  useEffect(() => {
    const updateClock = () => {
      const clock = clockRef.current;
      if (!clock) return;

      const remainingParts = clock.remaining.split(":").map(Number);
      let totalSeconds: number;
      if (remainingParts.length === 3) {
        totalSeconds =
          remainingParts[0] * 3600 + remainingParts[1] * 60 + remainingParts[2];
      } else if (remainingParts.length === 2) {
        totalSeconds = remainingParts[0] * 60 + remainingParts[1];
      } else {
        return;
      }

      // Only extrapolate when the clock is running (red flag / session end sets extrapolating=false)
      if (clock.extrapolating !== false) {
        // Against the same timeline the data is on, not the wall clock: with a
        // broadcast delay set, Date.now() would run the countdown at the real
        // time while the table sits a minute behind it. That is the "clock
        // live, table behind" mismatch the proxy's delta frames were written
        // to avoid, and a delay would reintroduce it for free.
        const elapsed = Math.floor(
          (serverClockRef.current.now() -
            delayMsRef.current -
            new Date(clock.utc).getTime()) /
            1000,
        );
        totalSeconds = Math.max(0, totalSeconds - elapsed);
      }

      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const formatted =
        hours > 0
          ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
          : `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

      setSessionInfo((prev) => ({ ...prev, remainingTime: formatted }));

      // Session ended: clock at 0:00 and stopped (extrapolating=false means
      // end-of-session, not a mid-session red flag where remaining > 0).
      // Skip for Q1/Q2 — the segment ends but the session continues; the proxy
      // resets track_status to GREEN when the next part starts.
      const qualiPart = qualifyingPartRef.current;
      const isIntermediateQualy = qualiPart !== undefined && qualiPart < 3;
      if (totalSeconds === 0 && clock.extrapolating === false && !isIntermediateQualy) {
        setTrackStatus((prev) =>
          prev.status === 7
            ? prev
            : { status: 7, message: "CHEQUERED" },
        );
      }
    };

    updateClock();
    clockIntervalRef.current = setInterval(updateClock, 1000);

    return () => {
      if (clockIntervalRef.current) clearInterval(clockIntervalRef.current);
    };
  }, []);

  useEffect(() => {
    const tryConnect = () => {
      fetch(`${PROXY_URL}/health`)
        .then((res) => res.json())
        .then((data) => {
          console.log(`[SSE] Health: status=${data.status} mode=${data.mode}`);
          if (data.status === "ok") {
            setError(null);
            setProxyMode(data.mode ?? null);
            if (healthCheckIntervalRef.current) {
              clearInterval(healthCheckIntervalRef.current);
              healthCheckIntervalRef.current = null;
            }
            startStream();
          } else {
            throw new Error("Proxy not ok");
          }
        })
        .catch(() => {
          console.log("[SSE] Proxy offline, retrying every 10s");
          setError("OFFLINE");
          if (!healthCheckIntervalRef.current) {
            healthCheckIntervalRef.current = setInterval(() => {
              if (isConnectedRef.current) return;
              fetch(`${PROXY_URL}/health`)
                .then((res) => res.json())
                .then((data) => {
                  if (data.status === "ok" && !isConnectedRef.current) {
                    setError(null);
                    clearInterval(healthCheckIntervalRef.current!);
                    healthCheckIntervalRef.current = null;
                    startStream();
                  }
                })
                .catch(() => {});
            }, 10000);
          }
        });
    };

    tryConnect();

    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
      if (reconnectTimeoutRef.current)
        clearTimeout(reconnectTimeoutRef.current);
      if (healthCheckIntervalRef.current)
        clearInterval(healthCheckIntervalRef.current);
      if (staleWatchdogRef.current) clearInterval(staleWatchdogRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Periodic status poll — keeps proxyMode fresh and detects when the official
  // SignalR timing feed is down during a live session. The main connect effect
  // only reads /health once (then stops), so this is the source of truth for
  // banners that need to react to mode/SignalR changes over time.
  useEffect(() => {
    const pollStatus = () => {
      fetch(`${PROXY_URL}/health`)
        .then((res) => res.json())
        .then((data) => {
          if (data.status !== "ok") return;
          setProxyMode(data.mode ?? null);
          signalrOwnsPositionRef.current =
            data.mode === "mqtt-live" && data.signalrRunning === true;
          // Degraded only when we actually have a live session running on MQTT
          // but SignalR isn't connected. In replay/standby a missing SignalR is
          // expected, so we don't warn there.
          setSignalrDegraded(
            data.mode === "mqtt-live" && data.signalrRunning === false,
          );
        })
        .catch(() => {});
    };

    pollStatus();
    statusPollIntervalRef.current = setInterval(pollStatus, 15000);

    return () => {
      if (statusPollIntervalRef.current)
        clearInterval(statusPollIntervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    drivers,
    sessionInfo,
    trackStatus,
    weather,
    teamRadios,
    raceControlMessages,
    carData,
    isConnected,
    error,
    proxyMode,
    signalrDegraded,
    delaySyncing,
    streamEpoch,
  };
}
