// Season calendar and per-Grand-Prix session schedules, read from OpenF1 on
// the server so /calendario and /gp/[slug] ship real content in their HTML.

export type Locale = "es" | "en";

export interface SessionSlot {
  sessionKey: number;
  /** OpenF1 name, e.g. "Practice 1", "Qualifying", "Race". */
  name: string;
  type: string;
  /** ISO 8601 with offset, as OpenF1 returns it. */
  dateStart: string;
  dateEnd: string | null;
}

export interface Meeting {
  meetingKey: number;
  slug: string;
  /** Localised GP name, e.g. "GP de Ciudad de México". */
  name: string;
  location: string;
  countryName: string;
  countryCode: string;
  circuitShortName: string;
  circuitKey: number;
  dateStart: string;
  dateEnd: string;
  /** Track-local UTC offset, e.g. "-06:00:00". */
  gmtOffset: string;
  year: number;
}

export interface MeetingDetail extends Meeting {
  sessions: SessionSlot[];
}

interface RawMeeting {
  meeting_key: number;
  meeting_name: string;
  location: string;
  country_name: string;
  country_code: string;
  circuit_short_name: string;
  circuit_key: number;
  gmt_offset: string;
  date_start: string;
  date_end: string;
  year: number;
  is_cancelled: boolean;
}

interface RawSession {
  session_key: number;
  session_name: string;
  session_type: string;
  date_start: string;
  date_end: string | null;
  meeting_key: number;
  is_cancelled: boolean;
}

const OPENF1 = "https://api.openf1.org/v1";

/** Calendars shift rarely; six hours of staleness is plenty. */
export const CALENDAR_REVALIDATE = 21600;

/** Cache tag for every calendar fetch, so POST /api/revalidate can drop them. */
export const CALENDAR_TAG = "calendar";

/** Strips diacritics and punctuation so "Montréal" → "montreal". */
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Display names keyed by the slug of the meeting's `location`.
 *
 * Deliberately not derived from OpenF1's `meeting_name`: that field carries
 * data errors (the 2026 Kuala Lumpur round is labelled "Bahrain Grand Prix")
 * and is English-only, while these names are what people actually search for.
 * Unlisted locations fall back to "GP de <location>".
 */
const MEETING_NAMES: Record<string, { es: string; en: string }> = {
  melbourne: { es: "GP de Australia", en: "Australian GP" },
  shanghai: { es: "GP de China", en: "Chinese GP" },
  suzuka: { es: "GP de Japón", en: "Japanese GP" },
  sakhir: { es: "GP de Baréin", en: "Bahrain GP" },
  jeddah: { es: "GP de Arabia Saudita", en: "Saudi Arabian GP" },
  "miami-gardens": { es: "GP de Miami", en: "Miami GP" },
  montreal: { es: "GP de Canadá", en: "Canadian GP" },
  "monte-carlo": { es: "GP de Mónaco", en: "Monaco GP" },
  barcelona: { es: "GP de Barcelona", en: "Barcelona GP" },
  spielberg: { es: "GP de Austria", en: "Austrian GP" },
  silverstone: { es: "GP de Gran Bretaña", en: "British GP" },
  "spa-francorchamps": { es: "GP de Bélgica", en: "Belgian GP" },
  budapest: { es: "GP de Hungría", en: "Hungarian GP" },
  zandvoort: { es: "GP de Países Bajos", en: "Dutch GP" },
  monza: { es: "GP de Italia", en: "Italian GP" },
  madrid: { es: "GP de España", en: "Spanish GP" },
  baku: { es: "GP de Azerbaiyán", en: "Azerbaijan GP" },
  "kuala-lumpur": { es: "GP de Kuala Lumpur", en: "Kuala Lumpur GP" },
  "marina-bay": { es: "GP de Singapur", en: "Singapore GP" },
  austin: { es: "GP de Estados Unidos", en: "United States GP" },
  "mexico-city": { es: "GP de Ciudad de México", en: "Mexico City GP" },
  "sao-paulo": { es: "GP de São Paulo", en: "São Paulo GP" },
  "las-vegas": { es: "GP de Las Vegas", en: "Las Vegas GP" },
  lusail: { es: "GP de Qatar", en: "Qatar GP" },
  "yas-marina": { es: "GP de Abu Dabi", en: "Abu Dhabi GP" },
};

/** Session labels; OpenF1 only speaks English. */
const SESSION_LABELS: Record<string, { es: string; en: string }> = {
  "Practice 1": { es: "Práctica 1", en: "Practice 1" },
  "Practice 2": { es: "Práctica 2", en: "Practice 2" },
  "Practice 3": { es: "Práctica 3", en: "Practice 3" },
  Qualifying: { es: "Clasificación", en: "Qualifying" },
  Race: { es: "Carrera", en: "Race" },
  Sprint: { es: "Sprint", en: "Sprint" },
  "Sprint Qualifying": { es: "Clasificación Sprint", en: "Sprint Qualifying" },
  "Sprint Shootout": { es: "Sprint Shootout", en: "Sprint Shootout" },
};

/**
 * The Grand Prix itself, as opposed to the Sprint.
 *
 * OpenF1 labels both with `session_type: "Race"`, so matching on the type picks
 * whichever comes first — the Sprint, on a sprint weekend. Only `session_name`
 * tells them apart.
 */
export function isGrandPrix(session: SessionSlot): boolean {
  return session.name === "Race";
}

export function sessionLabel(name: string, locale: Locale): string {
  return SESSION_LABELS[name]?.[locale] ?? name;
}

export function meetingName(location: string, locale: Locale): string {
  const mapped = MEETING_NAMES[slugify(location)];
  if (mapped) return mapped[locale];
  return locale === "es" ? `GP de ${location}` : `${location} GP`;
}

/** `/gp/mexico-city-2026` — location plus year, stable across seasons. */
export function meetingSlug(location: string, year: number): string {
  return `${slugify(location)}-${year}`;
}

const cacheOpts = {
  next: { revalidate: CALENDAR_REVALIDATE, tags: [CALENDAR_TAG] },
} as RequestInit;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The proxy forwards these with the paid-tier token (OPENF1_PASSTHROUGH in
// proxy/server.js). Only reachable server-side, which is where every calendar
// fetch happens.
const PROXY_PASSTHROUGH = ["meetings", "sessions"];

const proxyBase = () =>
  `${process.env.INTERNAL_PROXY_URL || "http://f1-prod-api:4000"}/api`;

/**
 * Set when OpenF1 locks REST to authenticated callers, which it does for the
 * whole duration of every live session — the entire race weekend, in practice.
 * Without the pin a full season render pays that failure ~30 times over; with
 * it, only the first request does. It expires so a long-lived server goes back
 * to the direct route once the session is over.
 */
let proxyPinnedUntil = 0;
const PROXY_PIN_MS = 10 * 60 * 1000;

/** The same read through the proxy, which has the credentials. */
async function viaProxy<T>(path: string): Promise<T | null> {
  if (!PROXY_PASSTHROUGH.includes(path.split("?")[0])) return null;

  try {
    const r = await fetch(`${proxyBase()}/${path}`, cacheOpts);
    if (r.status === 404) return [] as unknown as T;
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/**
 * One OpenF1 read, with backoff on rate limiting and a fallback through the
 * proxy.
 *
 * Returns `[]` for a genuine "no results" (OpenF1 answers 404 for an empty
 * query) and `null` when the request actually failed. The distinction matters:
 * a build that prerenders the whole season fires one request per round and
 * trips the free tier's 30/min limit, and treating that 429 as "no sessions"
 * would bake empty schedules into the HTML and cache them for hours.
 *
 * The fallback is what keeps a deploy during a race weekend from shipping an
 * empty calendar: OpenF1 answers 401 for *every* endpoint, past seasons
 * included, while a session is live, and only the proxy holds the token.
 */
async function openf1<T>(path: string, attempts = 4): Promise<T | null> {
  if (Date.now() < proxyPinnedUntil) {
    const pinned = await viaProxy<T>(path);
    if (pinned !== null) return pinned;
  }

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const r = await fetch(`${OPENF1}/${path}`, cacheOpts);
      if (r.status === 404) return [] as unknown as T;
      if (r.ok) return (await r.json()) as T;

      // 401/403: REST is locked to authenticated callers for the duration of a
      // live session. Retrying is pointless — the lock outlasts any backoff —
      // so go straight to the proxy and remember to start there.
      if (r.status === 401 || r.status === 403) {
        proxyPinnedUntil = Date.now() + PROXY_PIN_MS;
        return viaProxy<T>(path);
      }

      // 429 (burst limit) and 5xx are worth waiting out; jitter keeps parallel
      // page renders from retrying in lockstep.
      if (r.status === 429 || r.status >= 500) {
        if (attempt < attempts - 1) {
          await sleep(900 * (attempt + 1) + Math.random() * 400);
          continue;
        }
      }
      return viaProxy<T>(path);
    } catch {
      if (attempt < attempts - 1) {
        await sleep(900 * (attempt + 1) + Math.random() * 400);
        continue;
      }
      return viaProxy<T>(path);
    }
  }
  return null;
}

function toMeeting(raw: RawMeeting, locale: Locale): Meeting {
  return {
    meetingKey: raw.meeting_key,
    slug: meetingSlug(raw.location, raw.year),
    name: meetingName(raw.location, locale),
    location: raw.location,
    countryName: raw.country_name,
    countryCode: raw.country_code,
    circuitShortName: raw.circuit_short_name,
    circuitKey: raw.circuit_key,
    dateStart: raw.date_start,
    dateEnd: raw.date_end,
    gmtOffset: raw.gmt_offset,
    year: raw.year,
  };
}

/**
 * The season's race weekends, in calendar order.
 *
 * Drops cancelled rounds (the 2026 Bahrain GP is flagged `is_cancelled`),
 * pre-season testing, and duplicate locations — OpenF1 sometimes lists the
 * same venue twice while a calendar is being finalised.
 */
export async function fetchSeason(
  year: number,
  locale: Locale = "es",
): Promise<Meeting[]> {
  const raw = await openf1<RawMeeting[]>(`meetings?year=${year}`);
  // Throw on a failed request, the same way fetchSeasonSessions does, instead
  // of reporting it as a season with no rounds. Returning [] here let one
  // transient failure during a build bake a 404 into that round's GP page and
  // cache it for the whole revalidate window — `openf1` already answers [] for
  // a genuinely empty result, so an empty array still means empty.
  if (raw === null) {
    throw new Error(`OpenF1 meetings unavailable for season ${year}`);
  }

  const bySlug = new Map<string, Meeting>();
  for (const m of raw) {
    if (m.is_cancelled) continue;
    if (!/grand prix/i.test(m.meeting_name)) continue; // skips testing
    const meeting = toMeeting(m, locale);
    const seen = bySlug.get(meeting.slug);
    if (!seen || meeting.dateStart < seen.dateStart) {
      bySlug.set(meeting.slug, meeting);
    }
  }

  return Array.from(bySlug.values()).sort((a, b) =>
    a.dateStart < b.dateStart ? -1 : 1,
  );
}

/** The season currently in progress, per OpenF1's own `latest` pointer. */
export async function currentSeasonYear(): Promise<number> {
  const raw = await openf1<RawMeeting[]>("meetings?meeting_key=latest");
  return raw?.[0]?.year ?? new Date().getUTCFullYear();
}

/** One Grand Prix with its session schedule, or null if the slug is unknown. */
export async function fetchMeeting(
  slug: string,
  locale: Locale = "es",
): Promise<MeetingDetail | null> {
  const year = Number(slug.slice(-4));
  if (!Number.isFinite(year)) return null;

  const season = await fetchSeason(year, locale);
  const meeting = season.find((m) => m.slug === slug);
  if (!meeting) return null;

  const sessions = await fetchSeasonSessions(year);
  return {
    ...meeting,
    sessions: sessions.get(meeting.meetingKey) ?? [],
  };
}

/**
 * Every session of a season, grouped by meeting.
 *
 * One request for the whole year rather than one per round: prerendering the
 * season would otherwise fire ~25 calls in parallel and trip OpenF1's
 * 30-requests-per-minute free-tier limit, and a rate-limited round would
 * render as "schedule not published yet" and get cached that way. This single
 * URL is served from Next's data cache for every page in the build.
 */
async function fetchSeasonSessions(
  year: number,
): Promise<Map<number, SessionSlot[]>> {
  const raw = await openf1<RawSession[]>(`sessions?year=${year}`);
  // Fail loudly rather than cache a GP page that wrongly claims its schedule
  // isn't out yet.
  if (raw === null) {
    throw new Error(`OpenF1 sessions unavailable for season ${year}`);
  }

  const byMeeting = new Map<number, SessionSlot[]>();
  for (const s of raw) {
    if (s.is_cancelled) continue;
    const slot: SessionSlot = {
      sessionKey: s.session_key,
      name: s.session_name,
      type: s.session_type,
      dateStart: s.date_start,
      dateEnd: s.date_end,
    };
    const list = byMeeting.get(s.meeting_key);
    if (list) list.push(slot);
    else byMeeting.set(s.meeting_key, [slot]);
  }

  byMeeting.forEach((list) =>
    list.sort((a, b) => (a.dateStart < b.dateStart ? -1 : 1)),
  );
  return byMeeting;
}

/**
 * Formats an instant in the track's own timezone.
 *
 * The server has no idea what timezone the reader is in, so pages render
 * track-local time (stable, cacheable, crawlable) and a client component
 * converts to the viewer's zone after hydration.
 */
export function formatInTrackTime(
  iso: string,
  gmtOffset: string,
  locale: Locale,
  options: Intl.DateTimeFormatOptions,
): string {
  // "-06:00:00" → -360, "08:00:00" → 480. OpenF1 omits the sign on positive
  // offsets, so it has to be optional — requiring it silently rendered every
  // east-of-UTC circuit in UTC.
  const m = /^([+-]?)(\d{2}):(\d{2})/.exec(gmtOffset);
  const sign = m?.[1] === "-" ? -1 : 1;
  const offsetMinutes = m ? sign * (Number(m[2]) * 60 + Number(m[3])) : 0;

  // Shift the instant by the track offset, then format as UTC — this renders
  // the wall-clock time at the circuit regardless of where the server runs.
  const shifted = new Date(new Date(iso).getTime() + offsetMinutes * 60_000);
  return new Intl.DateTimeFormat(locale === "es" ? "es-ES" : "en-GB", {
    ...options,
    timeZone: "UTC",
  }).format(shifted);
}
