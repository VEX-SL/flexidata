// /src/lib/browser-agent/policy.ts
export const ALLOWED_BROWSER_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "Shift+Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
] as const;

export type AllowedBrowserKey = (typeof ALLOWED_BROWSER_KEYS)[number];

export function isAllowedBrowserKey(value: unknown): value is AllowedBrowserKey {
  return typeof value === "string" && (ALLOWED_BROWSER_KEYS as readonly string[]).includes(value);
}

export function stripBrowserSkillCommand(text: string): { text: string; forced: boolean } {
  const match = text.match(/^\s*\/browser(?:\s+|$)/i);
  if (!match) return { text, forced: false };
  return { text: text.slice(match[0].length).trim(), forced: true };
}

export function shouldAttachBrowserContext(text: string): boolean {
  return /^\s*\/browser(?:\s+|$)/i.test(text) ||
    /\b(?:browser|web(?:site)?|tab|open|click|hover|scroll|type|press|visit|navigate|go to|search)\b|https?:\/\//i.test(text) ||
    /المتصفح|صفح(?:ة|ات)|تبويب|موقع|افتح|ادخل|انتقل|اذهب|اضغط|انقر|مرر|اكتب|ابحث/i.test(text);
}