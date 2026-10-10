import type { Metadata } from "next";
import Link from "next/link";
import ContentPageShell from "@/components/ContentPageShell";
import ViewerTime from "@/components/ViewerTime";
import {
  CALENDAR_REVALIDATE,
  currentSeasonYear,
  fetchSeason,
  formatInTrackTime,
  type Meeting,
} from "@/lib/calendar";
import { COUNTRY_CODES } from "@/lib/constants";
import { siteUrl } from "@/lib/site";
import { socialMeta } from "@/lib/social";

export const revalidate = CALENDAR_REVALIDATE;

const f1Font = { fontFamily: "'Formula1 Display', sans-serif" } as const;
const f1Wide = { fontFamily: "'Formula1 Display Wide', sans-serif" } as const;

export async function generateMetadata(): Promise<Metadata> {
  const year = await currentSeasonYear();
  const title = `Calendario F1 ${year} — Fechas y horarios de todas las carreras`;
  const description = `Calendario completo de la Fórmula 1 ${year}: todas las fechas, circuitos y horarios de prácticas, clasificación y carrera, Gran Premio por Gran Premio.`;

  return {
    title,
    description,
    keywords: [
      `calendario F1 ${year}`,
      `calendario Fórmula 1 ${year}`,
      "horarios F1",
      "fechas carreras F1",
      "próxima carrera F1",
      "circuitos F1",
    ],
    alternates: { canonical: "/calendario" },
    ...socialMeta({ url: "/calendario", title, description }),
  };
}

function seasonJsonLd(year: number, meetings: Meeting[]) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${siteUrl}/calendario#season`,
    name: `Calendario F1 ${year}`,
    url: `${siteUrl}/calendario`,
    numberOfItems: meetings.length,
    itemListOrder: "https://schema.org/ItemListOrderAscending",
    itemListElement: meetings.map((m, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "SportsEvent",
        name: `${m.name} ${m.year}`,
        url: `${siteUrl}/gp/${m.slug}`,
        startDate: m.dateStart,
        endDate: m.dateEnd,
        eventStatus: "https://schema.org/EventScheduled",
        location: {
          "@type": "Place",
          name: m.circuitShortName,
          address: {
            "@type": "PostalAddress",
            addressLocality: m.location,
            addressCountry: m.countryName,
          },
        },
      },
    })),
  };
}

function RoundCard({
  meeting,
  round,
  isNext,
}: {
  meeting: Meeting;
  round: number;
  isNext: boolean;
}) {
  const iso = COUNTRY_CODES[meeting.countryName];
  const dates = `${formatInTrackTime(meeting.dateStart, meeting.gmtOffset, "es", { day: "numeric", month: "short" })} – ${formatInTrackTime(meeting.dateEnd, meeting.gmtOffset, "es", { day: "numeric", month: "short" })}`;

  return (
    <Link
      href={`/gp/${meeting.slug}`}
      className="relative flex items-center gap-3 overflow-hidden rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-3 transition-colors hover:border-zinc-700 hover:bg-zinc-900/70 sm:gap-4 sm:px-4"
    >
      <span
        className="absolute bottom-0 left-0 top-0 w-1"
        style={{ background: isNext ? "hsl(var(--primary))" : "#3f3f46" }}
      />

      <span
        className="w-6 flex-none text-center text-sm tabular-nums text-zinc-500 sm:w-8 sm:text-base"
        style={f1Wide}
      >
        {round}
      </span>

      {iso ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://flagcdn.com/w40/${iso}.png`}
          alt=""
          className="h-5 w-7 flex-none rounded-[2px] object-cover"
        />
      ) : (
        <span className="h-5 w-7 flex-none rounded-[2px] bg-zinc-800" />
      )}

      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-sm uppercase leading-tight text-white sm:text-base"
          style={{ ...f1Font, fontWeight: 700 }}
        >
          {meeting.name}
        </span>
        <span
          className="mt-0.5 block truncate text-[10px] uppercase tracking-wide text-zinc-500 sm:text-[11px]"
          style={f1Font}
        >
          {meeting.circuitShortName} · {meeting.location}
        </span>
      </span>

      <span className="flex-none text-right">
        <span
          className="block text-[11px] uppercase tracking-wide text-zinc-300 sm:text-xs"
          style={f1Font}
        >
          {dates}
        </span>
        {isNext && (
          <span
            className="mt-0.5 block text-[9px] uppercase tracking-[0.2em] text-primary"
            style={f1Font}
          >
            Próxima
          </span>
        )}
      </span>
    </Link>
  );
}

export default async function CalendarioPage() {
  const year = await currentSeasonYear();
  const meetings = await fetchSeason(year, "es");

  const now = Date.now();
  const nextIndex = meetings.findIndex(
    (m) => new Date(m.dateEnd).getTime() >= now,
  );
  const next = nextIndex >= 0 ? meetings[nextIndex] : null;

  return (
    <>
      {meetings.length > 0 && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(seasonJsonLd(year, meetings)),
          }}
        />
      )}

      <ContentPageShell backHref="/" backLabel="Inicio">
        <div className="mb-8 text-center">
          <div className="mb-3 flex items-center justify-center gap-3">
            <div className="h-px w-8 bg-primary opacity-70" />
            <span
              className="text-[11px] uppercase tracking-[0.35em] text-primary"
              style={f1Font}
            >
              Temporada {year}
            </span>
            <div className="h-px w-8 bg-primary opacity-70" />
          </div>
          <h1
            className="text-[clamp(1.75rem,8vw,3.25rem)] uppercase leading-none text-white"
            style={f1Wide}
          >
            Calendario F1 {year}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-zinc-400">
            Las {meetings.length} carreras de la temporada {year} de Fórmula 1,
            con las fechas de cada Gran Premio en la hora del circuito. Entrá a
            cualquier ronda para ver los horarios de prácticas, clasificación y
            carrera en tu propia zona horaria.
          </p>
        </div>

        {next && (
          <section className="mb-8 rounded-lg border border-primary/30 bg-primary/[0.06] px-4 py-4">
            <h2
              className="text-[10px] uppercase tracking-[0.25em] text-primary"
              style={f1Font}
            >
              Próxima carrera
            </h2>
            <p
              className="mt-2 text-lg uppercase leading-tight text-white"
              style={f1Wide}
            >
              {next.name}
            </p>
            <p className="mt-1 text-xs text-zinc-400">
              {next.circuitShortName} ·{" "}
              {formatInTrackTime(next.dateStart, next.gmtOffset, "es", {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
              <span className="text-zinc-500">
                {" "}
                (hora del circuito)
              </span>
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              En tu hora: <ViewerTime iso={next.dateStart} withDate />
            </p>
          </section>
        )}

        {meetings.length === 0 ? (
          <div className="py-20 text-center">
            <div className="mb-3 text-4xl opacity-20">🏁</div>
            <p className="text-sm text-zinc-500" style={f1Font}>
              Calendario no disponible
            </p>
          </div>
        ) : (
          <ol className="space-y-2">
            {meetings.map((m, i) => (
              <li key={m.slug}>
                <RoundCard
                  meeting={m}
                  round={i + 1}
                  isNext={m.slug === next?.slug}
                />
              </li>
            ))}
          </ol>
        )}

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
