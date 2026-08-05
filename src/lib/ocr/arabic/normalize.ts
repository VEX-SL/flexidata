/**
 * Arabic normalization layer.
 *
 * Repairs the *surface* of OCR text so it is as close as possible to the real
 * Arabic document before extraction begins. Every rule is a Unicode-level
 * canonicalization — alef variants, yeh variants, ta-marbuta, Arabic-Indic
 * digits, invisible characters, RTL markers, kashida and presentation forms —
 * and applies to any Arabic document. No keywords, no vendors, no per-receipt
 * logic.
 *
 * Matching stays symmetric: the pipeline's `normalizeText` applies the same
 * canonicalization to values and labels, so a value that differs only by an
 * alef variant or a ta-marbuta still grounds against the repaired surface.
 */
import { unifyDigits } from "@/lib/pipeline/ocr";

const INVISIBLE =
  /[\u00ad\u061c\u200b\u200c\u200d\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Alef variants (hamza carriers, dagger alef…) → bare alef. */
const ALEF_VARIANTS = /[\u0622\u0623\u0625\u0671\u0673\u0675]/g;
/** Yeh variants (alef maksura, Farsi yeh, …) → standard yeh. */
const YEH_VARIANTS = /[\u0649\u06cc\u06cd\u06d0\u06d1\u0678]/g;
/** Ta marbuta → heh. */
const TA_MARBUTA = /\u0629/g;
/** Kashida / tatweel (decorative stretch) → removed. */
const KASHIDA = /\u0640/g;
/** Arabic decimal separator → Latin dot; Arabic thousands separator → comma. */
const ARABIC_SEPARATORS = /[\u066b\u066c]/g;

/**
 * Canonical Arabic form of a string: NFC/NFKC first (collapses Arabic
 * presentation forms — isolated/final letter shapes OCR sometimes emits — to
 * base letters), then strips invisible characters, RTL markers, kashida,
 * unifies Arabic-Indic digits and collapses alef/yeh/ta-marbuta variants.
 */
export function normalizeArabicText(s: string): string {
  return unifyDigits(
    s
      .normalize("NFKC")
      .replace(INVISIBLE, "")
      .replace(KASHIDA, "")
      .replace(ALEF_VARIANTS, "\u0627")
      .replace(YEH_VARIANTS, "\u064a")
      .replace(TA_MARBUTA, "\u0647")
      .replace(ARABIC_SEPARATORS, (sep) => (sep === "\u066b" ? "." : ","))
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Strip RTL / bidi control characters only (no other changes). Used to clean
 * a raw string for display and for plain-token classification.
 */
export function stripBidiControls(s: string): string {
  return s.replace(BIDI_CONTROLS, "");
}
