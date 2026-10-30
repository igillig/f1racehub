import type { Metadata } from "next";
import { siteConfig } from "./site";

/**
 * Both blocks together, because Next replaces `openGraph` wholesale (a page
 * declaring it loses the inherited image) and `twitter` is a separate field
 * that would otherwise keep the home page's title.
 *
 * The card is a static asset, not a generated `opengraph-image` route, so its
 * URL carries no build hash and a page can reference it explicitly.
 */
const CARD = {
  url: "/og/card.png",
  width: 1200,
  height: 630,
} as const;

export function socialMeta({
  url,
  title,
  description,
}: {
  url: string;
  title: string;
  description: string;
}): Pick<Metadata, "openGraph" | "twitter"> {
  const images = [{ ...CARD, alt: title }];

  return {
    openGraph: {
      type: "website",
      locale: siteConfig.locale,
      siteName: siteConfig.name,
      url,
      title,
      description,
      images,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images,
    },
  };
}
