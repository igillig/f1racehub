import type { Metadata, Viewport } from "next";
import "./globals.css";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { socialMeta } from "@/lib/social";
import { siteConfig, siteUrl } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteConfig.title,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  keywords: [...siteConfig.keywords],
  applicationName: siteConfig.name,
  authors: [{ name: "Ivan Gillig" }],
  creator: "Ivan Gillig",
  category: "sports",
  alternates: {
    canonical: "/",
  },
  ...socialMeta({
    url: siteUrl,
    title: siteConfig.title,
    description: siteConfig.description,
  }),
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  // logo.png is the white-on-transparent mark used inside the app, which on a
  // white background renders as a lone red "F1" floating on nothing — that is
  // what Google was showing beside the result. These come from logo_bg.png,
  // which carries its own dark background, so the stopwatch and the flag
  // survive at 16px. Stable paths rather than the app/icon file convention:
  // Google caches favicons and recrawls them rarely, so the URL should not
  // change with every build.
  icons: {
    icon: [
      { url: "/icons/icon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/icons/icon-96.png", sizes: "96x96", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
    apple: { url: "/icons/apple-touch-icon.png", sizes: "180x180" },
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
};

// One @graph so Google can tie the app, the site and the brand together
// instead of seeing three unrelated entities.
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebApplication",
      "@id": `${siteUrl}/#app`,
      name: siteConfig.name,
      url: siteUrl,
      description: siteConfig.description,
      applicationCategory: "SportsApplication",
      operatingSystem: "Web",
      browserRequirements: "Requires JavaScript",
      inLanguage: ["es", "en"],
      isAccessibleForFree: true,
      publisher: { "@id": `${siteUrl}/#org` },
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
    },
    {
      "@type": "WebSite",
      "@id": `${siteUrl}/#website`,
      name: siteConfig.shortName,
      alternateName: siteConfig.name,
      url: siteUrl,
      inLanguage: "es",
      publisher: { "@id": `${siteUrl}/#org` },
    },
    {
      "@type": "Organization",
      "@id": `${siteUrl}/#org`,
      name: siteConfig.shortName,
      url: siteUrl,
      logo: `${siteUrl}/images/logo.png`,
      sameAs: [siteConfig.instagram],
    },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body className="antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <LanguageProvider>{children}</LanguageProvider>
      </body>
    </html>
  );
}
