// Centralized site metadata for SEO.
// The public URL comes from NEXT_PUBLIC_SITE_URL so it can change per deploy.
const rawUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://f1racehub.com";

// Normalize: no trailing slash, must include protocol.
export const siteUrl = rawUrl.replace(/\/+$/, "");

export const siteConfig = {
  name: "F1 Race Hub",
  shortName: "F1 RaceHub",
  instagram: "https://www.instagram.com/f1racehub.ok",
  url: siteUrl,
  locale: "es_ES",
  title: "F1 RaceHub — Telemetría y tiempos en vivo de Fórmula 1",
  description:
    "Dashboard de Fórmula 1 en tiempo real: tiempos por vuelta, intervalos, mini-sectores, mapa de pista, neumáticos, radio de equipo, clima y control de carrera. Telemetría en vivo, gratis.",
  keywords: [
    "F1 RaceHub",
    "F1 en vivo",
    "Fórmula 1 tiempo real",
    "telemetría F1",
    "tiempos F1",
    "live timing F1",
    "F1 dashboard",
    "mapa de pista F1",
    "intervalos F1",
    "control de carrera F1",
    "F1 live timing",
    "Formula 1 live",
  ],
} as const;
