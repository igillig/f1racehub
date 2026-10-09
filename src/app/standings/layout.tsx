import type { Metadata } from "next";

const title = "Clasificación F1 2026 — Mundial de Pilotos y Constructores";
const description =
  "Tabla de posiciones de la Fórmula 1 2026 actualizada: campeonato de pilotos y de constructores con puntos, posiciones y cambios tras cada Gran Premio.";

export const metadata: Metadata = {
  title,
  description,
  keywords: [
    "clasificación F1 2026",
    "tabla de posiciones F1",
    "mundial de pilotos F1",
    "campeonato de constructores F1",
    "puntos F1 2026",
    "F1 standings",
  ],
  alternates: {
    canonical: "/standings",
  },
  openGraph: {
    url: "/standings",
    title,
    description,
  },
};

export default function StandingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
