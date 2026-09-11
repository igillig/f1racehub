"use client";

import { useEffect } from "react";
import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { LayoutDashboard, Trophy, GitCompare, User, Mail, ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useLanguage } from "@/contexts/LanguageContext";
import ContactModal from "./ContactModal";

interface AppDrawerProps {
  open: boolean;
  onClose: () => void;
}

const DRAWER_WIDTH = 260;

const LANGUAGES = [
  { code: "es", label: "Es", countryCode: "ar" },
  { code: "en", label: "En", countryCode: "gb" },
] as const;

export default function AppDrawer({ open, onClose }: AppDrawerProps) {
  const { language, setLanguage, t } = useLanguage();

  const navItems: Array<{
    icon: React.ElementType;
    label: string;
    href?: string;
    active?: boolean;
    soon?: boolean;
  }> = [
    { icon: LayoutDashboard, label: "Dashboard",             href: "/dashboard", active: true },
    { icon: Trophy,          label: t("drawer.standings"),   href: "/standings" },
    { icon: GitCompare,      label: t("drawer.comparisons"), soon: true },
    { icon: User,            label: t("drawer.login"),       soon: true },
  ];

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.aside
          initial={{ width: 0 }}
          animate={{ width: DRAWER_WIDTH }}
          exit={{ width: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 38 }}
          className="flex-shrink-0 overflow-hidden border-r border-zinc-800 bg-zinc-950"
        >
          <div className="flex flex-col h-full" style={{ width: DRAWER_WIDTH }}>
            {/* Nav items */}
            <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
              {navItems.map((item) => {
                const isDisabled = "soon" in item && item.soon;
                const isActive = "active" in item && item.active;

                if (isDisabled) {
                  return (
                    <div
                      key={item.label}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-zinc-600 cursor-default select-none whitespace-nowrap"
                    >
                      <item.icon size={16} className="text-zinc-700 shrink-0" />
                      <span>{item.label}</span>
                      <span className="ml-auto text-[10px] uppercase tracking-widest font-bold text-zinc-700 border border-zinc-800 rounded px-1.5 py-0.5">
                        {t("drawer.soon")}
                      </span>
                    </div>
                  );
                }

                return (
                  <Link
                    key={item.label}
                    href={item.href ?? "#"}
                    onClick={onClose}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                      isActive
                        ? "bg-zinc-800 text-zinc-100"
                        : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60"
                    }`}
                  >
                    <item.icon
                      size={16}
                      className={isActive ? "text-primary shrink-0" : "text-zinc-500 shrink-0"}
                    />
                    <span>{item.label}</span>
                  </Link>
                );
              })}

              {/* Contact — opens the modal instead of navigating */}
              <ContactModal
                renderTrigger={(openModal) => (
                  <button
                    onClick={openModal}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60"
                  >
                    <Mail size={16} className="text-zinc-500 shrink-0" />
                    <span>{t("footer.contact")}</span>
                  </button>
                )}
              />
            </nav>

            {/* Footer */}
            <div className="border-t border-zinc-800">
              {/* Language switcher */}
              <div className="px-4 py-3 flex items-center gap-2 border-b border-zinc-800/60">
                <span className="text-xs text-zinc-500 whitespace-nowrap mr-1">{t("drawer.language")}</span>
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.code}
                    onClick={() => setLanguage(lang.code)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                      language === lang.code
                        ? "bg-zinc-700 text-zinc-100"
                        : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                    }`}
                  >
                    <img
                      src={`https://flagcdn.com/w20/${lang.countryCode}.png`}
                      alt={lang.label}
                      className="w-4 h-3 object-cover rounded-sm"
                    />
                    {lang.label}
                  </button>
                ))}
              </div>

              {/* Version + close */}
              <div className="px-4 py-3 flex items-center justify-between">
                <p className="text-xs text-zinc-600 whitespace-nowrap">F1 RaceHub · Beta</p>
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
                  aria-label="Cerrar menú"
                >
                  <ChevronLeft size={16} />
                </button>
              </div>
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
