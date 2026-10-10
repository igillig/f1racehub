import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ContentPageShell from "@/components/ContentPageShell";
import ViewerTime from "@/components/ViewerTime";
import {
  CALENDAR_REVALIDATE,
  currentSeasonYear,
  fetchMeeting,
  fetchSeason,
  formatInTrackTime,
  isGrandPrix,
  sessionLabel,
  type MeetingDetail,
} from "@/lib/calendar";
import { COUNTRY_CODES } from "@/lib/constants";
import { siteUrl } from "@/lib/site";
import { socialMeta } from "@/lib/social";

export const revalidate = CALENDAR_REVALIDATE;

const f1Font = { fontFamily: "'Formula1 Display', sans-serif" } as const;
const f1Wide = { fontFamily: "'Formula1 Display Wide', sans-serif" } as const;

interface Params {
  params: { slug: string };
}

/** Prerender the whole current season at build time; later years render on demand. */
export async function generateStaticParams() {
  const year = await currentSeasonYear();
  const season = await fetchSeason(year);
  return season.map((m) => ({ slug: m.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const meeting = await fetchMeeting(params.slug, "es");
  if (!meeting) return {};

  const title = `${meeting.name} ${meeting.year}: horarios y resultados en vivo`;
  const description = `Horarios del ${meeting.name} ${meeting.year} en ${meeting.circuitShortName}: prácticas, clasificación y carrera en tu zona horaria, más timing en vivo y telemetría durante la sesión.`;

  return {
    title,
    description,
    keywords: [
      `${meeting.name} ${meeting.year}`,
      `horarios ${meeting.name}`,
      `${meeting.location} F1 ${meeting.year}`,
      "a qué hora es la carrera F1",
      `F1 ${meeting.circuitShortName}`,
    ],
    alternates: { canonical: `/gp/${meeting.slug}` },
    ...socialMeta({ url: `/gp/${meeting.slug}`, title, description }),
  };
}

/**
 * One SportsEvent per session, so Google can surface "when is the race"
 * directly. The race is the top-level event; the rest are sub-events.
 */
function meetingJsonLd(meeting: MeetingDetail) {
  const place = {
    "@type": "Place",
    name: meeting.circuitShortName,
    address: {
      "@type": "PostalAddress",
      addressLocality: meeting.location,
      addressCountry: meeting.countryName,
    },
  };

  return {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    "@id": `${siteUrl}/gp/${meeting.slug}#event`,
    name: `${meeting.name} ${meeting.year}`,
    url: `${siteUrl}/gp/${meeting.slug}`,
    startDate: meeting.dateStart,
    endDate: meeting.dateEnd,
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    sport: "Formula 1",
    location: place,
    subEvent: meeting.sessions.map((s) => ({
      "@type": "SportsEvent",
      name: `${sessionLabel(s.name, "es")} — ${meeting.name} ${meeting.year}`,
      startDate: s.dateStart,
      ...(s.dateEnd ? { endDate: s.dateEnd } : {}),
      eventStatus: "https://schema.org/EventScheduled",
      location: place,
    })),
  };
}

export default async function GrandPrixPage({ params }: Params) {
  const meeting = await fetchMeeting(params.slug, "es");
  if (!meeting) notFound();

  const iso = COUNTRY_CODES[meeting.countryName];
  const now = Date.now();
  const race = meeting.sessions.find(isGrandPrix);
  const isOver = new Date(meeting.dateEnd).getTime() < now;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(meetingJsonLd(meeting)) }}
      />

      <ContentPageShell backHref="/calendario" backLabel="Calendario">
        <div className="mb-8 text-center">
          {iso && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://flagcdn.com/w80/${iso}.png`}
              alt={meeting.countryName}
              className="mx-auto mb-4 h-8 rounded shadow-lg shadow-black/50"
            />
          )}
          <h1
            className="text-[clamp(1.5rem,7vw,3rem)] uppercase leading-none text-white"
            style={f1Wide}
          >
            {meeting.name} {meeting.year}
          </h1>
          <p
            className="mt-3 text-xs uppercase tracking-[0.2em] text-zinc-500"
            style={f1Font}
          >
            {meeting.circuitShortName} · {meeting.location}
          </p>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-zinc-400">
            Horarios de todas las sesiones del {meeting.name} {meeting.year} en{" "}
            {meeting.circuitShortName}. La columna de la izquierda es la hora
            del circuito; la de la derecha, tu hora local.
          </p>
        </div>

        <section>
          <h2
            className="mb-3 text-[11px] uppercase tracking-[0.3em] text-primary"
            style={f1Font}
          >
            Horarios
          </h2>

          {meeting.sessions.length === 0 ? (
            <p className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-6 text-center text-sm text-zinc-500">
              Los horarios de este Gran Premio todavía no están publicados.
            </p>
          ) : (
            <ul className="space-y-2">
              {meeting.sessions.map((s) => {
                const isRace = isGrandPrix(s);
                return (
                  <li
                    key={s.sessionKey}
                    className="relative flex items-center gap-3 overflow-hidden rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-3 sm:gap-4 sm:px-4"
                  >
                    <span
                      className="absolute bottom-0 left-0 top-0 w-1"
                      style={{
                        background: isRace ? "hsl(var(--primary))" : "#3f3f46",
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-sm uppercase leading-tight text-white sm:text-base"
                        style={{ ...f1Font, fontWeight: 700 }}
                      >
                        {sessionLabel(s.name, "es")}
                      </span>
                      <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-zinc-500 sm:text-[11px]">
                        {formatInTrackTime(s.dateStart, meeting.gmtOffset, "es", {
                          weekday: "long",
                          day: "numeric",
                          month: "long",
                        })}
                      </span>
                    </span>

                    <span className="flex-none text-right">
                      <span
                        className="block text-base tabular-nums leading-none text-white sm:text-lg"
                        style={f1Wide}
                      >
                        {formatInTrackTime(s.dateStart, meeting.gmtOffset, "es", {
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })}
                      </span>
                      <span className="mt-1 block text-[9px] uppercase tracking-[0.15em] text-zinc-600">
                        hora circuito
                      </span>
                    </span>

                    <span className="flex-none border-l border-zinc-800 pl-3 text-right sm:pl-4">
                      <span
                        className="block text-base tabular-nums leading-none text-zinc-300 sm:text-lg"
                        style={f1Wide}
                      >
                        <ViewerTime iso={s.dateStart} />
                      </span>
                      <span className="mt-1 block text-[9px] uppercase tracking-[0.15em] text-zinc-600">
                        tu hora
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="mt-8 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-5">
          <h2
            className="text-sm uppercase tracking-wide text-white"
            style={{ ...f1Font, fontWeight: 700 }}
          >
            {isOver
              ? `¿Qué pasó en el ${meeting.name} ${meeting.year}?`
              : `Seguí el ${meeting.name} ${meeting.year} en vivo`}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            {isOver
              ? "Este Gran Premio ya se corrió. Podés ver cómo quedó el campeonato tras la carrera, o entrar al timing en vivo durante la próxima sesión."
              : `Durante cada sesión el dashboard muestra tiempos por vuelta, mini-sectores, intervalos, neumáticos, mapa de pista y radio de equipo en tiempo real${race ? ` — desde la práctica 1 hasta la carrera del ${formatInTrackTime(race.dateStart, meeting.gmtOffset, "es", { day: "numeric", month: "long" })}` : ""}.`}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              href="/dashboard"
              className="rounded-full bg-primary px-4 py-2 text-[11px] uppercase tracking-[0.15em] text-white transition-opacity hover:opacity-90"
              style={f1Font}
            >
              Timing en vivo
            </Link>
            <Link
              href="/standings"
              className="rounded-full border border-zinc-700 px-4 py-2 text-[11px] uppercase tracking-[0.15em] text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white"
              style={f1Font}
            >
              Clasificación {meeting.year}
            </Link>
          </div>
        </section>

        <p
          className="mt-8 text-center text-[10px] uppercase tracking-[0.2em] text-zinc-700"
          style={f1Font}
        >
          Datos: OpenF1
        </p>
      </ContentPageShell>
    </>
  );
}
