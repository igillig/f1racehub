import type { MetadataRoute } from "next";
import { currentSeasonYear, fetchSeason } from "@/lib/calendar";
import { siteUrl } from "@/lib/site";

// Regenerated alongside the calendar pages so new rounds appear without a
// deploy.
export const revalidate = 21600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const base: MetadataRoute.Sitemap = [
    {
      url: siteUrl,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 1,
    },
    {
      url: `${siteUrl}/dashboard`,
      lastModified: now,
      changeFrequency: "always",
      priority: 0.9,
    },
    {
      url: `${siteUrl}/standings`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${siteUrl}/calendario`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.8,
    },
  ];

  // One entry per Grand Prix. A round that hasn't run yet changes more often
  // (schedules get confirmed late); past ones are effectively frozen.
  const year = await currentSeasonYear();
  const season = await fetchSeason(year);
  const rounds: MetadataRoute.Sitemap = season.map((m) => {
    const finished = new Date(m.dateEnd).getTime() < now.getTime();
    return {
      url: `${siteUrl}/gp/${m.slug}`,
      lastModified: finished ? new Date(m.dateEnd) : now,
      changeFrequency: finished ? ("yearly" as const) : ("weekly" as const),
      priority: finished ? 0.5 : 0.7,
    };
  });

  return [...base, ...rounds];
}
