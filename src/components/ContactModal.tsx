"use client";

import { useState, FormEvent, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

type Status = "idle" | "sending" | "sent" | "error";

interface ContactModalProps {
  // Custom trigger (e.g. a drawer nav item). Defaults to a footer text link.
  renderTrigger?: (open: () => void) => ReactNode;
}

export default function ContactModal({ renderTrigger }: ContactModalProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const { t } = useLanguage();

  const close = () => {
    setOpen(false);
    if (status === "sent") {
      setStatus("idle");
      setName("");
      setEmail("");
      setMessage("");
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (status === "sending") return;
    setStatus("sending");
    setErrorKey(null);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, message, website }),
      });
      if (res.ok) {
        setStatus("sent");
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setErrorKey(
        data.error === "rate_limited"
          ? "contact.errorRateLimited"
          : data.error === "invalid_fields"
            ? "contact.errorInvalid"
            : "contact.errorGeneric",
      );
      setStatus("error");
    } catch {
      setErrorKey("contact.errorGeneric");
      setStatus("error");
    }
  };

  const inputClass =
    "w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500";

  return (
    <>
      {renderTrigger ? (
        renderTrigger(() => setOpen(true))
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="text-zinc-400 hover:text-white transition-colors text-sm font-bold"
        >
          {t("footer.contact")}
        </button>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          onClick={close}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-sm shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-2">
              <img
                src="/images/logo.png"
                alt="F1 RaceHub"
                className="h-14 w-auto shrink-0"
              />
              <div className="flex flex-col leading-tight">
                <span
                  className="text-white font-bold text-lg tracking-tight"
                  style={{ fontFamily: "'Formula1 Display', sans-serif" }}
                >
                  F1 RaceHub
                </span>
                <h2 className="text-zinc-300 font-semibold text-sm">
                  {t("contact.title")}
                </h2>
              </div>
            </div>
            <p className="text-zinc-400 text-sm mb-5">{t("contact.desc")}</p>

            {status === "sent" ? (
              <div className="flex flex-col gap-4">
                <p className="text-green-400 text-sm">{t("contact.sent")}</p>
                <button
                  onClick={close}
                  className="w-full py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-semibold transition-colors"
                >
                  {t("support.close")}
                </button>
              </div>
            ) : (
              <form onSubmit={submit} className="flex flex-col gap-3">
                <input
                  type="text"
                  required
                  maxLength={80}
                  placeholder={t("contact.name")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={inputClass}
                />
                <input
                  type="email"
                  required
                  maxLength={120}
                  placeholder={t("contact.email")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClass}
                />
                <textarea
                  required
                  minLength={10}
                  maxLength={3000}
                  rows={5}
                  placeholder={t("contact.message")}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className={`${inputClass} resize-none`}
                />
                {/* Honeypot: hidden from humans, bots fill it */}
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  className="hidden"
                  aria-hidden="true"
                />

                {status === "error" && errorKey && (
                  <p className="text-red-400 text-xs">{t(errorKey)}</p>
                )}

                <div className="flex gap-2 mt-1">
                  <button
                    type="button"
                    onClick={close}
                    className="flex-1 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-semibold transition-colors"
                  >
                    {t("support.close")}
                  </button>
                  <button
                    type="submit"
                    disabled={status === "sending"}
                    className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors inline-flex items-center justify-center gap-2"
                  >
                    {status === "sending" && (
                      <Loader2 size={14} className="animate-spin" />
                    )}
                    {status === "sending"
                      ? t("contact.sending")
                      : t("contact.send")}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
