export interface Driver {
  position: number;
  driverNumber: string;
  code: string;
  name: string;
  team: string;
  teamColor?: string; // Color from F1 API
  gap: string;
  interval: string;
  lastLap: string;
  bestLap: string;
  sector1: string;
  sector2: string;
  sector3: string;
  bestSector1?: string;
  bestSector2?: string;
  bestSector3?: string;
  hasSector1Record?: boolean; // Has the overall best S1 time
  hasSector2Record?: boolean; // Has the overall best S2 time
  hasSector3Record?: boolean; // Has the overall best S3 time
  sector1Status: SectorStatus;
  sector2Status: SectorStatus;
  sector3Status: SectorStatus;
  miniSectors?: SectorStatus[];
  sector1SegmentCount?: number;
  sector2SegmentCount?: number;
  sector3SegmentCount?: number;
  tire: TireInfo;
  inPit: boolean;
  isPitOutLap?: boolean;
  pitCount: number;
  retired: boolean;
  knockedOut: boolean; // Eliminated in qualifying
  currentLap?: number;
  drsEnabled?: boolean;
  positionChange?: number;
  lastLapPersonalBest?: boolean;
  lastLapOverallFastest?: boolean; // Last lap is the session's fastest lap
  trackProgress?: number; // 0-1 position on track for map
  trackX?: number; // X coordinate on track
  trackY?: number; // Y coordinate on track
  trackT?: number; // Timestamp of that GPS fix (epoch ms, from the data source)
  // Every GPS fix delivered in this update, oldest first. The proxy queues them
  // between SSE flushes so the map gets the full ~3.7 Hz stream, not just the
  // one fix that survived the flush window.
  trackFixes?: { x: number; y: number; t: number }[];
}

export interface TireInfo {
  compound: string;
  age: number;
  isNew: boolean;
}

export type SectorStatus = "purple" | "green" | "yellow" | "blue" | "none";

export interface SessionInfo {
  type: string;
  name: string;
  sessionName: string; // "Practice 3", "Qualifying", "Race", etc.
  track: string;
  country: string;
  remainingTime: string;
  currentLap: number;
  totalLaps: number;
  circuitKey?: number;
  isLive: boolean;
  qualifyingPart?: number; // 1 = Q1, 2 = Q2, 3 = Q3
}

export interface TrackStatusInfo {
  status: number;
  message: string;
}

export interface WeatherData {
  airTemp: number;
  humidity: number;
  pressure: number;
  rainfall: boolean;
  trackTemp: number;
  windDirection: number;
  windSpeed: number;
}

export interface RadioCapture {
  utc: string;
  racingNumber: string;
  path: string;
}

export interface TeamRadio {
  captures: RadioCapture[];
}

export interface RaceControlMessage {
  utc: string;
  message: string;
  category?: string;
  flag?: string;
  lap?: number;
  driverNumber?: string;
  sector?: number; // Sector number for yellow flags
}

export interface F1State {
  drivers: Driver[];
  sessionInfo: SessionInfo;
  trackStatus: TrackStatusInfo;
  weather?: WeatherData;
  teamRadios: RadioCapture[];
  raceControlMessages: RaceControlMessage[];
  isConnected: boolean;
  error: string | null;
}

// OpenF1 proxy state types (snake_case, emitted by proxy/server.js)

export interface OpenF1Session {
  session_key: number;
  session_name: string;
  session_type: string;
  circuit_key: number;
  circuit_short_name: string;
  country_name: string;
  country_code: string;
  date_start: string;
  date_end: string | null;
  location: string;
  meeting_name: string;
}

export interface OpenF1Driver {
  driver_number: number;
  name_acronym: string;
  full_name: string;
  team_name: string;
  team_colour: string;
}

export interface OpenF1TimingEntry {
  position: number | null;
  gap_to_leader: number | string | null;
  interval: number | string | null;
  last_lap: number | null;
  best_lap: number | null;
  last_lap_is_pb: boolean;
  lap_number: number;
  sector_1: number | null;
  sector_2: number | null;
  sector_3: number | null;
  segments_1: number[];
  segments_2: number[];
  segments_3: number[];
  compound: string;
  tyre_age: number;
  stint_number: number;
  in_pit: boolean;
  pit_count: number;
  retired: boolean;
  knocked_out: boolean;
  is_pit_out_lap: boolean;
}

export interface OpenF1Weather {
  air_temperature: number;
  track_temperature: number;
  humidity: number;
  pressure: number;
  rainfall: boolean;
  wind_speed: number;
  wind_direction: number;
}

export interface OpenF1RaceControlMessage {
  date: string;
  message: string;
  flag: string | null;
  category: string;
  scope: string | null;
  sector: number | null;
  driver_number: number | null;
  lap_number: number | null;
}

export interface OpenF1TeamRadio {
  date: string;
  driver_number: number;
  recording_url: string;
}

export interface CarData {
  brake: number;      // 0–100
  throttle: number;   // 0–100
  rpm: number;        // 0–~13500
  speed: number;      // km/h
  n_gear: number;     // 0 = neutral, 1–8
  drs: number;        // 0=off, 8=eligible, 10/12/14=active
  date?: string;
}

export interface ProxyState {
  session?: OpenF1Session;
  drivers?: Record<string, OpenF1Driver>;
  timing?: Record<string, OpenF1TimingEntry>;
  location?: Record<string, { x: number; y: number }>;
  car_data?: Record<string, CarData>;
  lap_count?: { current: number; total: number };
  track_status?: { flag: string };
  weather?: OpenF1Weather;
  race_control_messages?: OpenF1RaceControlMessage[];
  team_radio?: OpenF1TeamRadio[];
  clock?: { remaining: string; utc: string };
}
