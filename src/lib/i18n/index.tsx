"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import ar from "./locales/ar.json";
import zh from "./locales/zh.json";

const locales: Record<string, Record<string, any>> = { en, fr, ar, zh };

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "ar", label: "العربية" },
  { code: "zh", label: "中文" },
] as const;

type Lang = keyof typeof locales;

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  lang: "en",
  setLang: () => {},
  t: (k) => k,
});

export function useTranslation() {
  return useContext(I18nContext);
}

function getNested(obj: Record<string, any>, path: string): string | undefined {
  return path.split(".").reduce<any>((acc, key) => acc?.[key], obj);
}

function detectLanguage(): Lang {
  if (typeof window === "undefined") return "en";
  const stored = localStorage.getItem("lang") as Lang | null;
  if (stored && locales[stored]) return stored;

  const browserLangs = navigator.languages || [navigator.language];
  for (const bl of browserLangs) {
    const code = bl.split("-")[0].toLowerCase();
    if (code in locales) return code as Lang;
  }
  return "en";
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    setLangState(detectLanguage());
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    localStorage.setItem("lang", l);
    document.documentElement.setAttribute("lang", l);
    if (l === "ar") {
      document.documentElement.setAttribute("dir", "rtl");
    } else {
      document.documentElement.setAttribute("dir", "ltr");
    }
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const dict = locales[lang] || locales.en;
      let value = getNested(dict, key);
      if (value === undefined) {
        value = getNested(locales.en, key);
      }
      if (value === undefined) return key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          value = value.replace(new RegExp(`{{${k}}}`, "g"), String(v));
        }
      }
      return value;
    },
    [lang]
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}
