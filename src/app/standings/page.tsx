import type { Metadata } from "next";
import StandingsView from "@/components/StandingsView";
import {
  fetchChampionship,
  STANDINGS_REVALIDATE,
  type ChampionshipSnapshot,
} from "@/lib/championship";
import { siteUrl } from "@/lib/site";
import { socialMeta } from "@/lib/social";

// Standings only change once a race is scored, so an hour of staleness is
// fine — and it means crawlers always get a fully populated table.
export const revalidate = STANDINGS_REVALIDATE;

/**
 * Title and description carry the season year, which is why they're built here
 * rather than in a static `metadata` export — otherwise they'd need editing
 * every January.
 */
export async function generateMetadata(): Promise<Metadata> {
  const data = await fetchChampionship();
  const year = data?.year ?? new Date().getFullYear();

  const title = `Clasificación F1 ${year} — Mundial de Pilotos y Constructores`;
  const description = `Tabla de posiciones de la Fórmula 1 ${year} actualizada: campeonato de pilotos y de constructores con puntos, posiciones y cambios tras cada Gran Premio.`;

  return {
    title,
    description,
    keywords: [
      `clasificación F1 ${year}`,
      "tabla de posiciones F1",
      "mundial de pilotos F1",
      "campeonato de constructores F1",
      `puntos F1 ${year}`,
      "F1 standings",
    ],
    alternates: {
      canonical: "/standings",
    },
    ...socialMeta({ url: "/standings", title, description }),
  };
}

/** ItemList of the driver standings, so Google can read the table as data. */
function standingsJsonLd(data: ChampionshipSnapshot) {
  // OpenF1 occasionally has no driver record for a number in the current
  // meeting (the UI falls back to "#22"). Skip those rather than publish a
  // placeholder name as structured data.
  const named = data.drivers.filter((d) => d.lastName && d.teamName);

  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${siteUrl}/standings#drivers`,
    name: `Clasificación F1 ${data.year ?? ""} — Mundial de Pilotos`.trim(),
    url: `${siteUrl}/standings`,
    numberOfItems: named.length,
    itemListOrder: "https://schema.org/ItemListOrderAscending",
    itemListElement: named.map((d) => ({
      "@type": "ListItem",
      position: d.position,
      name: d.fullName,
      description: `${d.teamName} — ${d.points} pts`,
    })),
  };
}

export default async function StandingsPage() {
  const data = await fetchChampionship();

  return (
    <>
      {data && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(standingsJsonLd(data)),
          }}
        />
      )}
      <StandingsView data={data} />
    </>
  );
}
