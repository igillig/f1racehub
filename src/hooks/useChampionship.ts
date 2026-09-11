"use client";

import { useState, useEffect, useCallback } from "react";

export interface DriverStanding {
  position: number;
  positionStart: number;
  driverNumber: number;
  points: number;
  pointsStart: number;
  firstName: string;
  lastName: string;
  fullName: string;
  acronym: string;
  teamName: string;
  teamColour: string; // hex without '#'
  headshotUrl: string | null;
}

export interface TeamStanding {
  position: number;
  positionStart: number;
  teamName: string;
  points: number;
  pointsStart: number;
  teamColour: string; // hex without '#'
}

export interface ChampionshipData {
  drivers: DriverStanding[];
  teams: TeamStanding[];
  meetingName: string | null;
  year: number | null;
  loading: boolean;
  error: boolean;
}

interface RawStanding {
  meeting_key: number;
  session_key: number;
  driver_number?: number;
  team_name?: string;
  position_start: number;
  position_current: number;
  points_start: number;
  points_current: number;
}

interface RawDriver {
  driver_number: number;
  first_name: string;
  last_name: string;
  full_name: string;
  name_acronym: string;
  team_name: string;
  team_colour: string | null;
  headshot_url: string | null;
}

interface RawMeeting {
  meeting_key: number;
  meeting_name: string;
  date_start?: string;
  year?: number;
}

const OPENF1 = "https://api.openf1.org/v1";
const PROXY = "/api/proxy/api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fetch directly from OpenF1 (no auth needed for these endpoints) so the page
// works even when the proxy isn't running. OpenF1's free tier rate-limits
// bursts (HTTP 429), so we retry with backoff and, as a last resort, fall back
// to the proxy (which forwards with paid-tier auth — no rate limit).
// Callers should invoke these sequentially, not in parallel, to stay under the
// burst limit in the first place.
// While a session is live, OpenF1 locks its REST API to paid accounts (503
// for everyone else). Once we see that, skip straight to the proxy for the
// rest of the page load instead of burning retries on every request.
let preferProxy = false;

async function fetchViaProxy<T>(path: string): Promise<T> {
  const r = await fetch(`${PROXY}/${path}`);
  if (r.status === 404) return [] as unknown as T;
  if (!r.ok) throw new Error(`proxy ${r.status}`);
  return (await r.json()) as T;
}

async function fetchJSON<T>(path: string, retries = 2): Promise<T> {
  if (preferProxy) return fetchViaProxy<T>(path);
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${OPENF1}/${path}`);
      if (r.status === 429 && attempt < retries) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      // OpenF1 answers 404 "No results found" for empty queries — not an error
      if (r.status === 404) return [] as unknown as T;
      if (r.status === 503 || r.status === 401 || r.status === 403) {
        preferProxy = true;
        return fetchViaProxy<T>(path);
      }
      if (!r.ok) throw new Error(`${r.status}`);
      return (await r.json()) as T;
    } catch (err) {
      if (attempt < retries) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      // Last resort: the proxy (authenticated, higher rate limit).
      try {
        return await fetchViaProxy<T>(path);
      } catch {
        throw err;
      }
    }
  }
}

const DEFAULT: ChampionshipData = {
  drivers: [],
  teams: [],
  meetingName: null,
  year: null,
  loading: true,
  error: false,
};

export function useChampionship(): ChampionshipData {
  const [data, setData] = useState<ChampionshipData>(DEFAULT);

  const load = useCallback(async () => {
    try {
      // Sequential (not Promise.all) to stay under OpenF1's free-tier burst limit.
      const rawMeetings = await fetchJSON<RawMeeting[]>(
        "meetings?meeting_key=latest",
      );
      let meeting: RawMeeting | undefined = rawMeetings[0];
      let rawDrivers = await fetchJSON<RawStanding[]>(
        "championship_drivers?meeting_key=latest",
      );
      let rawTeams: RawStanding[] = [];

      // Standings for a meeting only exist once its race has been scored.
      // During a GP weekend `latest` is the ongoing meeting (no standings yet),
      // so walk back through the season to the most recent scored one.
      if (rawDrivers.length === 0 && meeting?.date_start) {
        const seasonYear =
          meeting.year ?? new Date(meeting.date_start).getFullYear();
        const season = await fetchJSON<RawMeeting[]>(
          `meetings?year=${seasonYear}`,
        );
        const previous = season
          .filter(
            (m) =>
              m.meeting_key !== meeting!.meeting_key &&
              m.date_start &&
              m.date_start < meeting!.date_start!,
          )
          .sort((a, b) => (a.date_start! < b.date_start! ? 1 : -1))
          .slice(0, 3);
        for (const m of previous) {
          rawDrivers = await fetchJSON<RawStanding[]>(
            `championship_drivers?meeting_key=${m.meeting_key}`,
          );
          if (rawDrivers.length > 0) {
            meeting = m;
            break;
          }
        }
      }
      if (rawDrivers.length === 0 || !meeting) throw new Error("no standings");

      rawTeams = await fetchJSON<RawStanding[]>(
        `championship_teams?meeting_key=${meeting.meeting_key}`,
      );
      const rawInfo = await fetchJSON<RawDriver[]>(
        `drivers?meeting_key=${meeting.meeting_key}`,
      );

      // A meeting can have several scored sessions (e.g. Sprint + Race); the
      // endpoint returns one standings row per driver per session. Keep only
      // the latest session's rows (highest session_key = most recent).
      const latestSession = (rows: RawStanding[]) => {
        if (rows.length === 0) return rows;
        const max = Math.max(...rows.map((r) => r.session_key));
        return rows.filter((r) => r.session_key === max);
      };
      const driverRows = latestSession(rawDrivers);
      const teamRows = latestSession(rawTeams);

      // Build a driver-info lookup (dedupe: a meeting has many sessions).
      const infoByNumber = new Map<number, RawDriver>();
      for (const d of rawInfo) {
        if (!infoByNumber.has(d.driver_number)) infoByNumber.set(d.driver_number, d);
      }

      // Map team name → colour (from any driver on that team).
      const colourByTeam = new Map<string, string>();
      for (const d of rawInfo) {
        if (d.team_name && d.team_colour && !colourByTeam.has(d.team_name)) {
          colourByTeam.set(d.team_name, d.team_colour);
        }
      }

      const drivers: DriverStanding[] = driverRows
        .map((s) => {
          const info = infoByNumber.get(s.driver_number!);
          return {
            position: s.position_current,
            positionStart: s.position_start,
            driverNumber: s.driver_number!,
            points: s.points_current,
            pointsStart: s.points_start,
            firstName: info?.first_name ?? "",
            lastName: info?.last_name ?? "",
            fullName: info?.full_name ?? `#${s.driver_number}`,
            acronym: info?.name_acronym ?? "",
            teamName: info?.team_name ?? "",
            teamColour: info?.team_colour ?? "9C9FA2",
            headshotUrl: info?.headshot_url ?? null,
          };
        })
        .sort((a, b) => a.position - b.position);

      const teams: TeamStanding[] = teamRows
        .map((s) => ({
          position: s.position_current,
          positionStart: s.position_start,
          teamName: s.team_name!,
          points: s.points_current,
          pointsStart: s.points_start,
          teamColour: colourByTeam.get(s.team_name!) ?? "9C9FA2",
        }))
        .sort((a, b) => a.position - b.position);

      const year = meeting?.year
        ? meeting.year
        : meeting?.date_start
          ? new Date(meeting.date_start).getFullYear()
          : null;

      setData({
        drivers,
        teams,
        meetingName: meeting?.meeting_name ?? null,
        year,
        loading: false,
        error: false,
      });
    } catch {
      setData((prev) => ({ ...prev, loading: false, error: true }));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return data;
}
