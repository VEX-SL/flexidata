import type { OcrDocument, OcrLine, OcrWord } from "./types";

/**
 * Build a neutral OcrDocument from a plain text string (no word-level OCR
 * confidence available). Used when the pipeline receives source text directly
 * rather than a structured OCR result. Words carry no confidence — consumers
 * must treat "unknown" as neutral, not as certainty.
 */
export function buildOcrDocument(text: string, language?: string): OcrDocument {
  const lines: OcrLine[] = text.split(/\r?\n/).map((lineText) => ({
    text: lineText,
    words: splitWords(lineText),
  }));

  return { text, lines, language };
}

function splitWords(lineText: string): OcrWord[] {
  return lineText
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((text) => ({ text }));
}

/**
 * Normalize a string for grounded matching: drop bidi control characters,
 * collapse whitespace, lowercase, and unify digit families (Latin + Arabic +
 * Arabic-Indic) so "2013438351" and its variants compare equal.
 */
export function normalizeText(s: string): string {
  return unifyDigits(s)
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Map Arabic-Indic (٠١٢٣٤٥٦٧٨٩) and Arabic (۰۱۲۳۴۵۶۷۸۹) digits to Latin. */
export function unifyDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}
