"use client";

import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { Mail } from "lucide-react";
import LanguageToggle from "@/components/LanguageToggle";
import ContactModal from "@/components/ContactModal";
import { useLanguage } from "@/contexts/LanguageContext";
import { useNextF1Session, OpenF1Session } from "@/hooks/useNextF1Session";
import { COUNTRY_CODES } from "@/lib/constants";

interface ReplaySession {
  meetingName: string;
  sessionName: string;
  circuitName: string;
  location: string;
}

interface Props {
  onEnterDemo: () => void;
  replaySession?: ReplaySession | null;
  activeViewers?: number | null;
  proxyAvailable?: boolean;
}

const f1Font = { fontFamily: "'Formula1 Display', sans-serif" } as const;
const f1Wide = { fontFamily: "'Formula1 Display Wide', sans-serif" } as const;

const IG_GRADIENT =
  "linear-gradient(45deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)";

const SESSION_NAMES: Record<string, { es: string; en: string }> = {
  "Practice 1": { es: "Práctica 1", en: "Practice 1" },
  "Practice 2": { es: "Práctica 2", en: "Practice 2" },
  "Practice 3": { es: "Práctica 3", en: "Practice 3" },
  Qualifying: { es: "Clasificación", en: "Qualifying" },
  Race: { es: "Carrera", en: "Race" },
  Sprint: { es: "Sprint", en: "Sprint" },
  "Sprint Qualifying": { es: "Sprint Clasif.", en: "Sprint Qualifying" },
  "Sprint Shootout": { es: "Sprint Shootout", en: "Sprint Shootout" },
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function CountdownBox({ value, label }: { value: number; label: string }) {
  const str = pad(value);
  return (
    <div className="flex flex-col items-center gap-1.5 sm:gap-2.5">
      <div
        className="w-13 h-13 sm:w-20 sm:h-20 md:w-24 md:h-24 relative overflow-hidden"
        style={{
          width: "clamp(3rem,14vw,6rem)",
          height: "clamp(3rem,14vw,6rem)",
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.07)",
          borderBottom: "2px solid hsl(var(--primary))",
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={str}
            initial={{ y: -14, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 14, opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute inset-0 flex items-center justify-center text-3xl sm:text-5xl md:text-6xl text-white tabular-nums leading-none"
            style={{ ...f1Font, fontWeight: 700, fontSize: "clamp(1.5rem,7vw,3.75rem)" }}
          >
            {str}
          </motion.span>
        </AnimatePresence>
      </div>
      <span
        className="text-[8px] sm:text-[9px] tracking-[0.3em] text-zinc-500 uppercase"
        style={f1Font}
      >
        {label}
      </span>
    </div>
  );
}

function ScheduleRow({
  session,
  isNext,
  lang,
}: {
  session: OpenF1Session;
  isNext: boolean;
  lang: "es" | "en";
}) {
  const start = new Date(session.date_start);
  const locale = lang === "es" ? "es-ES" : "en-GB";
  const dayStr = start
    .toLocaleDateString(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
    })
    .toUpperCase();
  const timeStr = start.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const map = SESSION_NAMES[session.session_name];
  const name = map ? map[lang] : session.session_name;

  return (
    <div
      className={`flex items-center gap-3 px-3 sm:px-4 py-1 sm:py-2.5 transition-colors ${
        isNext
          ? "border-l-2 border-primary bg-primary/10"
          : "border-l-2 border-transparent"
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full flex-none ${
          isNext ? "bg-primary animate-pulse" : "bg-zinc-700"
        }`}
      />
      <span
        className={`text-xs font-semibold uppercase tracking-wide w-32 flex-none ${
          isNext ? "text-white" : "text-zinc-500"
        }`}
        style={f1Font}
      >
        {name}
      </span>
      <span className="text-[11px] text-zinc-600 flex-1 truncate">
        {dayStr}
      </span>
      <span
        className={`text-xs tabular-nums font-semibold flex-none ${
          isNext ? "text-primary" : "text-zinc-600"
        }`}
        style={f1Font}
      >
        {timeStr}
      </span>
      {isNext && (
        <span
          className="text-[9px] tracking-widest text-primary border border-primary/40 px-1.5 py-0.5 rounded-sm flex-none"
          style={f1Font}
        >
          NEXT
        </span>
      )}
    </div>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-4 w-full">
      <motion.div
        className="flex-1 h-px bg-zinc-800"
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        style={{ originX: 0 }}
        transition={{ delay: 0.5, duration: 0.7, ease: "easeOut" }}
      />
      <span
        className="text-[10px] tracking-[0.35em] text-zinc-600 uppercase flex-none"
        style={f1Font}
      >
        {label}
      </span>
      <motion.div
        className="flex-1 h-px bg-zinc-800"
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        style={{ originX: 1 }}
        transition={{ delay: 0.5, duration: 0.7, ease: "easeOut" }}
      />
    </div>
  );
}

const stagger = (i: number) => ({
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { delay: 0.1 + i * 0.1, duration: 0.5, ease: "easeOut" as const },
});

/**
 * Instagram's glyph in the brand gradient.
 *
 * Inlined rather than taken from lucide because a gradient has to be painted
 * on the SVG stroke itself — there is no way to hand a CSS gradient to an
 * imported icon component, and a flat purple is not the brand.
 */
function InstagramGlyph({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="url(#ig-brand)"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <defs>
        <linearGradient id="ig-brand" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#f09433" />
          <stop offset="25%" stopColor="#e6683c" />
          <stop offset="50%" stopColor="#dc2743" />
          <stop offset="75%" stopColor="#cc2366" />
          <stop offset="100%" stopColor="#bc1888" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
    </svg>
  );
}

/**
 * Pill row above the CTA: Instagram and the contact form, as icons only.
 *
 * No visible labels, so both carry `aria-label` and `title` — an icon-only
 * control is otherwise unreachable for a screen reader and unguessable for
 * anyone else.
 */
function SocialBar({ contactLabel }: { contactLabel: string }) {
  const itemClass =
    "group relative flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20";

  // No backdrop-filter on the pill: it would become the containing block for
  // the contact modal's position:fixed overlay and knock it off-centre.
  return (
    <motion.div
      className="flex items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.03] px-1 py-1"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.75, duration: 0.5, ease: "easeOut" }}
    >
      <a
        href="https://www.instagram.com/f1racehub.ok"
        target="_blank"
        rel="noopener noreferrer"
        className={itemClass}
        title="Instagram @f1racehub.ok"
        aria-label="Instagram @f1racehub.ok"
      >
        {/* Brand gradient blooms behind the glyph on hover */}
        <span
          aria-hidden
          className="absolute inset-1 rounded-full opacity-0 blur-[7px] transition-opacity duration-300 group-hover:opacity-70"
          style={{ background: IG_GRADIENT }}
        />
        <span className="relative flex items-center justify-center">
          <InstagramGlyph />
        </span>
      </a>

      <span className="h-6 w-px flex-none bg-white/[0.09]" aria-hidden />

      <ContactModal
        renderTrigger={(openModal) => (
          <button
            onClick={openModal}
            className={itemClass}
            title={contactLabel}
            aria-label={contactLabel}
          >
            <span
              aria-hidden
              className="absolute inset-1 rounded-full bg-primary opacity-0 blur-[7px] transition-opacity duration-300 group-hover:opacity-60"
            />
            <Mail
              size={27}
              strokeWidth={2}
              className="relative text-zinc-400 transition-colors group-hover:text-white"
            />
          </button>
        )}
      />
    </motion.div>
  );
}

export default function F1LandingPage({ onEnterDemo, replaySession, activeViewers, proxyAvailable = false }: Props) {
  const { t, language } = useLanguage();
  const { nextSession, weekendSessions, loading, countdown } =
    useNextF1Session();

  const countryCode = nextSession
    ? COUNTRY_CODES[nextSession.country_name]
    : null;

  const countdownUnits = [
    { value: countdown.days, label: t("landing.countdown.days") },
    { value: countdown.hours, label: t("landing.countdown.hours") },
    { value: countdown.minutes, label: t("landing.countdown.minutes") },
    { value: countdown.seconds, label: t("landing.countdown.seconds") },
  ];

  return (
    <div
      className="h-svh bg-background flex flex-col overflow-hidden relative"
      style={{
        backgroundImage: `
          repeating-linear-gradient(
            -60deg,
            transparent 0px,
            transparent 38px,
            rgba(255,255,255,0.012) 38px,
            rgba(255,255,255,0.012) 39px
          )
        `,
      }}
    >
      {/* Subtle red glow from bottom */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 70% 35% at 50% 100%, rgba(225,6,0,0.07) 0%, transparent 70%)",
        }}
      />

      {/* Language toggle + active viewers */}
      <div className="absolute top-4 right-6 z-20 flex items-center gap-3">
        {activeViewers != null && activeViewers > 0 && (
          <span
            className="flex items-center gap-1.5 text-[11px] text-zinc-500 tracking-wide cursor-default"
            style={f1Font}
            title={t("viewers.watching")}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            {activeViewers}
          </span>
        )}
        <LanguageToggle />
      </div>

      {/* Main */}
      <main className="relative z-10 flex-1 min-h-0 flex flex-col items-center justify-center px-4 py-2 sm:py-6 gap-2 sm:gap-6">
        {/* "PRÓXIMA CARRERA" label */}
        <motion.div className="flex items-center gap-3" {...stagger(0)}>
          <div className="w-10 h-px bg-primary opacity-70" />
          <span
            className="text-[11px] tracking-[0.35em] text-primary uppercase"
            style={f1Font}
          >
            {t("landing.nextRace")}
          </span>
          <div className="w-10 h-px bg-primary opacity-70" />
        </motion.div>

        {/* Flag + Event name */}
        {loading ? (
          <div className="flex flex-col items-center gap-4">
            <div className="text-5xl opacity-20">🏁</div>
            <div className="w-64 h-14 rounded bg-zinc-800/60 animate-pulse" />
            <div className="w-40 h-4 rounded bg-zinc-800/40 animate-pulse" />
          </div>
        ) : nextSession ? (
          <>
            {countryCode && (
              <motion.div {...stagger(1)}>
                <img
                  src={`https://flagcdn.com/w80/${countryCode}.png`}
                  srcSet={`https://flagcdn.com/w160/${countryCode}.png 2x`}
                  alt={nextSession!.country_name}
                  className="h-8 sm:h-12 rounded shadow-lg shadow-black/50"
                />
              </motion.div>
            )}
            <motion.div className="text-center" {...stagger(2)}>
              <h1
                className="text-[clamp(1.5rem,7vw,3.75rem)] sm:text-6xl md:text-[3.6rem] uppercase text-white leading-none tracking-tight"
                style={f1Wide}
              >
                {nextSession.location}
              </h1>
              <p
                className="mt-1 sm:mt-3 text-xs tracking-[0.25em] text-zinc-500 uppercase"
                style={f1Font}
              >
                {nextSession.circuit_short_name} &nbsp;·&nbsp;{" "}
                {nextSession.country_name}
              </p>
            </motion.div>
          </>
        ) : (
          <motion.p
            className="text-xl text-zinc-600 uppercase tracking-widest"
            style={f1Font}
            {...stagger(1)}
          >
            {t("landing.scheduleUnavailable")}
          </motion.p>
        )}

        {/* Countdown section */}
        {nextSession && !loading && (
          <>
            <motion.div className="w-full max-w-sm" {...stagger(3)}>
              <Divider
                label={
                  countdown.isPast
                    ? t("landing.liveNow")
                    : t("landing.startsIn")
                }
              />
            </motion.div>

            {!countdown.isPast && (
              <motion.div
                className="flex items-start gap-2 sm:gap-4 md:gap-5"
                {...stagger(4)}
              >
                {countdownUnits.map((unit, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 sm:gap-4 md:gap-5"
                  >
                    <CountdownBox value={unit.value} label={unit.label} />
                    {i < 3 && (
                      <span
                        className="text-xl sm:text-2xl md:text-3xl text-zinc-700 font-bold mt-6 sm:mt-8 md:mt-10 select-none"
                        style={f1Font}
                      >
                        :
                      </span>
                    )}
                  </div>
                ))}
              </motion.div>
            )}

            {countdown.isPast && (
              <motion.div
                className="flex flex-col items-center gap-5"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4 }}
              >
                <div className="flex items-center gap-3">
                  <motion.span
                    className="w-2 h-2 rounded-full bg-primary inline-block"
                    animate={{ opacity: [0.4, 1, 0.4], scale: [0.9, 1.2, 0.9] }}
                    transition={{ repeat: Infinity, duration: 1.4 }}
                  />
                  <span
                    className="text-sm text-zinc-200 uppercase tracking-[0.18em]"
                    style={f1Font}
                  >
                    {t("landing.waitingSignal")}
                  </span>
                </div>
                <div className="flex gap-1.5">
                  {[0, 1, 2].map((i) => (
                    <motion.div
                      key={i}
                      className="w-1.5 h-1.5 rounded-full bg-primary"
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.2 }}
                    />
                  ))}
                </div>
                <p
                  className="text-[10px] text-zinc-600 tracking-[0.25em] uppercase text-center"
                  style={f1Font}
                >
                  {t("landing.sessionAboutToStart")}
                </p>
              </motion.div>
            )}

            {/* Weekend schedule */}
            {weekendSessions.length > 0 && (
              <motion.div
                className="w-full max-w-sm"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.6, duration: 0.5 }}
              >
                <div className="flex items-center gap-3 mb-0.5 sm:mb-3">
                  <div className="h-px flex-1 bg-zinc-800/60" />
                  <span
                    className="text-[10px] tracking-[0.3em] text-zinc-600 uppercase flex-none"
                    style={f1Font}
                  >
                    {t("landing.weekendSchedule")}
                  </span>
                  <div className="h-px flex-1 bg-zinc-800/60" />
                </div>
                <div className="space-y-0.5">
                  {weekendSessions.map((s, i) => (
                    <ScheduleRow
                      key={s.session_key}
                      session={s}
                      isNext={i === 0}
                      lang={language}
                    />
                  ))}
                </div>
              </motion.div>
            )}
          </>
        )}
      </main>

      {/* CTA */}
      <footer className="relative z-10 shrink-0 flex flex-col items-center gap-2 sm:gap-4 py-3 sm:py-8 px-4">
        {/* Instagram + contact, right above the demo button */}
        <SocialBar contactLabel={t("footer.contact")} />

        {/* Links to the indexable content pages — these are the homepage's
            internal links, so they matter for crawl discovery as well as
            navigation. */}
        <nav className="flex items-center gap-3 text-[11px] uppercase tracking-[0.15em]">
          <Link
            href="/calendario"
            className="text-zinc-500 transition-colors hover:text-zinc-200"
            style={f1Font}
          >
            {t("drawer.calendar")}
          </Link>
          <span className="text-zinc-800">/</span>
          <Link
            href="/standings"
            className="text-zinc-500 transition-colors hover:text-zinc-200"
            style={f1Font}
          >
            {t("drawer.standings")}
          </Link>
        </nav>

        <AnimatePresence mode="wait">
          {proxyAvailable ? (
            <motion.div
              key="cta"
              className="flex flex-col items-center gap-2"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
            >
              <motion.button
                onClick={onEnterDemo}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                className="group flex items-center gap-3 bg-primary hover:bg-primary/90 text-white px-6 sm:px-10 py-4 text-sm uppercase tracking-[0.12em] sm:tracking-[0.2em] transition-colors whitespace-nowrap"
                style={{ ...f1Font, fontWeight: 700 }}
              >
                <span>{t("landing.enterDemo")}</span>
                <motion.span
                  className="text-white/60 group-hover:text-white transition-colors"
                  animate={{ x: [0, 5, 0] }}
                  transition={{ repeat: Infinity, duration: 1.6, ease: "easeInOut" }}
                >
                  →
                </motion.span>
              </motion.button>
              <p className="text-[11px] text-zinc-600 tracking-wide" style={f1Font}>
                {replaySession
                  ? `${replaySession.meetingName} · ${replaySession.sessionName} · ${replaySession.circuitName}`
                  : t("landing.replayInfo")}
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="connecting"
              className="flex flex-col items-center gap-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            >
              <div className="flex gap-1.5">
                {[0, 1, 2].map((i) => (
                  <motion.div
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-zinc-600"
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.2 }}
                  />
                ))}
              </div>
              <p className="text-[11px] text-zinc-600 tracking-[0.2em] uppercase" style={f1Font}>
                {t("error.connection")}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </footer>
    </div>
  );
}
