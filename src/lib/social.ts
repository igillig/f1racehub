import type { Metadata } from "next";
import { siteConfig } from "./site";

/**
 * The OpenGraph block plus the Twitter block, for one page.
 *
 * Every page needs both rather than just an `openGraph` object, for two
 * reasons Next's metadata merging makes easy to get wrong:
 *
 *  - a page that declares `openGraph` replaces the parent's wholesale, which
 *    silently drops the image. Every page except the home used to share with
 *    an empty card while still advertising `summary_large_image`.
 *  - `twitter` is a separate field, so overriding only `openGraph` left every
 *    page claiming the home page's title and description on Twitter/X.
 *
 * The card is identical for every page and every build, so it is a static
 * asset rather than a generated `opengraph-image` route: one URL with no build
 * hash, which is what lets a page reference it explicitly at all.
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
