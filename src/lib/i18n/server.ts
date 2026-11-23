import en from "./locales/en.json";
import fr from "./locales/fr.json";
import ar from "./locales/ar.json";
import zh from "./locales/zh.json";
import { getNested } from "./get-nested";

export type SupportedLocale = "en" | "fr" | "ar" | "zh";

const DICTS: Record<SupportedLocale, Record<string, unknown>> = {
  en,
  fr,
  ar,
  zh,
};

export function resolveLocale(locale?: string): SupportedLocale {
  const base = (locale ?? "").split("-")[0].toLowerCase();
  if (base === "ar" || base === "fr" || base === "zh" || base === "en") {
    return base;
  }
  return "en";
}

export function translateServer(
  locale: string | undefined,
  key: string,
  fallback?: string
): string {
  const lang = resolveLocale(locale);
  return (
    getNested(DICTS[lang], key) ??
    getNested(DICTS.en, key) ??
    fallback ??
    key
  );
}