import Link from "next/link";
import { ArrowLeft } from "lucide-react";

interface Props {
  /** Where the back arrow goes. */
  backHref: string;
  backLabel: string;
  children: React.ReactNode;
}

/**
 * Chrome shared by the server-rendered content pages (/calendario, /gp/*):
 * the same carbon-stripe background and sticky header as the dashboard pages,
 * without any client-side state.
 */
export default function ContentPageShell({
  backHref,
  backLabel,
  children,
}: Props) {
  const f1Font = { fontFamily: "'Formula1 Display', sans-serif" } as const;

  return (
    <div
      className="h-svh overflow-y-auto bg-background relative"
      style={{
        backgroundImage:
          "repeating-linear-gradient(-60deg, transparent 0px, transparent 38px, rgba(255,255,255,0.012) 38px, rgba(255,255,255,0.012) 39px)",
      }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-64"
        style={{
          background:
            "radial-gradient(ellipse 70% 60% at 50% 0%, rgba(225,6,0,0.10) 0%, transparent 70%)",
        }}
      />

      <header className="sticky top-0 z-20 border-b border-zinc-800/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Link
            href={backHref}
            className="flex items-center gap-2 text-zinc-400 transition-colors hover:text-zinc-100"
          >
            <ArrowLeft size={16} />
            <span
              className="text-xs uppercase tracking-[0.15em]"
              style={f1Font}
            >
              {backLabel}
            </span>
          </Link>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-3xl px-4 pb-16 pt-8">
        {children}
      </main>
    </div>
  );
}
