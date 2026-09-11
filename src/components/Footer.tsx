"use client";

import { useLanguage } from "@/contexts/LanguageContext";
import SupportModal from "./SupportModal";
import ContactModal from "./ContactModal";

export default function Footer() {
  const { t } = useLanguage();

  return (
    <footer className="w-full border-t border-zinc-800 bg-zinc-950 py-1.5 px-4 shrink-0">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-4 text-xs text-zinc-500">
        <span className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
          {t("footer.madeWith")} <span className="text-red-500">♥</span> by{" "}
          <a
            href="https://www.linkedin.com/in/ivangillig/"
            className="text-blue-400 hover:underline"
          >
            Ivan Gillig
          </a>
          <span className="text-zinc-700">•</span>
          <SupportModal />
          <span className="text-zinc-700">•</span>
          <ContactModal />
          <span className="text-zinc-700">•</span>
          v2.0.0
        </span>
        <span className="hidden sm:block text-[10px] text-zinc-600 text-right">
          {t("footer.disclaimer")}
        </span>
      </div>
    </footer>
  );
}
