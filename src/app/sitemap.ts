import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
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
  ];
}
