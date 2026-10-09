import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Timing en vivo F1 — vueltas, sectores y mapa de pista",
  description:
    "Timing en vivo de Fórmula 1: tiempos por vuelta, mini-sectores, intervalos, posiciones, neumáticos, mapa de pista en tiempo real, radio de equipo y control de carrera. Gratis y sin registro.",
  alternates: {
    canonical: "/dashboard",
  },
  openGraph: {
    url: "/dashboard",
    title: "Timing en vivo F1 — vueltas, sectores y mapa de pista",
    description:
      "Timing en vivo de Fórmula 1: vueltas, mini-sectores, intervalos, neumáticos y mapa de pista en tiempo real.",
  },
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
