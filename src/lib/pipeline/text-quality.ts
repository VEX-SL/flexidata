import type { OcrLine } from "./types";

/**
 * Generic text-quality assessment — decides whether an OCR fragment is real
 * content or noise, using structural, language-agnostic measures instead of
 * document/vendor-specific regexes:
 *
 *  - printable ratio        : share of characters that are printable
 *  - script consistency     : coverage of the dominant writing system
 *  - token quality          : share of whitespace-separated tokens that look
 *                             like words (letters in one script, sane length)
 *  - repetition             : how much a fragment repeats the same tokens
 *  - OCR confidence         : mean per-word OCR confidence when available
 *
 * A single noise score (0 = clean … 1 = garbage) combines these with explicit
 * weights, so "oe a il" or a bidi-smashed line scores garbage while "AL RABIH
 * SUPERMARKET" and "متجر الرحيم التجاري" score clean. Works for any script and
 * any document type; no corpus-specific rules.
 */

export interface TextQualityMetrics {
  /** 0..1 share of printable characters (letters, digits, punctuation, space). */
  printableRatio: number;
  /** 0..1 share of letters that belong to the dominant script. */
  scriptConsistency: number;
  /** 0..1 share of tokens that are word-like. */
  tokenQuality: number;
  /** 0..1 share of tokens that repeat more than twice. */
  repetition: number;
  /** Mean OCR word confidence (0..1) when the caller supplies word boxes. */
  ocrConfidence: number | undefined;
  /** 0 clean … 1 garbage. */
  noiseScore: number;
  reasons: string[];
}

// Explicit component weights (calibration contract).
const W_PRINTABLE = 0.3;
const W_SCRIPT = 0.25;
const W_TOKEN = 0.25;
const W_REPETITION = 0.1;
const W_OCR = 0.1;

/** Fragments scoring above this are treated as garbage. */
export const NOISE_THRESHOLD = 0.55;

/**
 * Structural noise rules — genuinely generic (no keywords, no vendor data):
 *  - a token longer than 24 chars that mixes letters and digits is a classic
 *    OCR line-merge artifact ("Hostinger;Description…)0123456788(");
 *  - a fragment that is more than half symbols is not field content;
 *  - a standalone symbol-only token ("©", ";)", "§") never occurs in real
 *    notes and marks an OCR/encoding artifact.
 */
function structuralGarbage(text: string): string | null {
  const tokens = text
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  for (const t of tokens) {
    if (t.length > 24 && countWhere(t, isLetter) > 0 && /[0-9]/.test(t)) {
      return `oversized letter+digit token (${t.length} chars)`;
    }
    if (countWhere(t, isLetter) === 0 && !/[0-9]/.test(t)) {
      return `standalone symbol token (${JSON.stringify(t)})`;
    }
  }
  if (text.length >= 4) {
    const nonspace = text.replace(/\s+/g, "");
    if (nonspace.length > 0) {
      const symbols = countWhere(nonspace, (ch) => /[\p{P}\p{S}]/u.test(ch) && !isLetter(ch) && !/[0-9]/.test(ch));
      if (symbols / nonspace.length > 0.5) return "symbol-dominated fragment";
    }
  }
  return null;
}

/** True when the fragment is generic OCR noise, not useful field content. */
export function isNoiseFragment(
  text: string,
  opts: { ocrConfidence?: number } = {}
): boolean {
  const q = assessTextQuality(text, opts);
  return q.noiseScore > NOISE_THRESHOLD;
}

export function assessTextQuality(
  text: string,
  opts: { ocrConfidence?: number } = {}
): TextQualityMetrics {
  const printableRatio = printableRatioOf(text);
  const scriptConsistency = scriptConsistencyOf(text);
  const tokens = tokenize(text);
  const tokenQuality = tokens.length === 0 ? 1 : mean(tokens.map(tokenQualityOf));
  const repetition = repetitionOf(tokens);
  const ocrConfidence = opts.ocrConfidence;
  const structural = structuralGarbage(text);

  const noiseScore = structural
    ? 1
    : clamp(
        (1 - printableRatio) * W_PRINTABLE +
          (1 - scriptConsistency) * W_SCRIPT +
          (1 - tokenQuality) * W_TOKEN +
          repetition * W_REPETITION +
          (ocrConfidence !== undefined ? (1 - ocrConfidence) * W_OCR : 0)
      );

  const reasons: string[] = [];
  if (structural) reasons.push(structural);
  if (printableRatio < 0.9) reasons.push(`low printable ratio (${printableRatio.toFixed(2)})`);
  if (scriptConsistency < 0.75) reasons.push(`mixed scripts (${scriptConsistency.toFixed(2)})`);
  if (tokenQuality < 0.75) reasons.push(`few word-like tokens (${tokenQuality.toFixed(2)})`);
  if (repetition > 0.5) reasons.push(`repetitive tokens (${repetition.toFixed(2)})`);
  if (ocrConfidence !== undefined && ocrConfidence < 0.5) reasons.push(`low OCR confidence (${ocrConfidence.toFixed(2)})`);

  return {
    printableRatio,
    scriptConsistency,
    tokenQuality,
    repetition,
    ocrConfidence,
    noiseScore,
    reasons,
  };
}

// ─── Component measures ────────────────────────────────────────────────────

const PRINTABLE = /[\p{L}\p{N}\p{P}\p{S}\s]/u;
const LETTER = /\p{L}/u;

function isLetter(ch: string): boolean {
  return LETTER.test(ch);
}

function printableRatioOf(text: string): number {
  if (text.length === 0) return 1;
  let printable = 0;
  for (const ch of text) {
    if (PRINTABLE.test(ch)) printable += 1;
  }
  return printable / text.length;
}

/** Coverage of the dominant writing system among letters. */
function scriptConsistencyOf(text: string): number {
  const counts = new Map<string, number>();
  let total = 0;
  for (const ch of text) {
    const script = scriptOf(ch);
    if (!script) continue;
    counts.set(script, (counts.get(script) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return 1;
  let max = 0;
  for (const n of counts.values()) max = Math.max(max, n);
  return max / total;
}

/** Classify a letter into a coarse script family (language-agnostic). */
function scriptOf(ch: string): string | null {
  if (!LETTER.test(ch)) return null;
  const code = ch.codePointAt(0)!;
  if (code >= 0x0600 && code <= 0x06ff) return "arabic";
  if (code >= 0x0400 && code <= 0x04ff) return "cyrillic";
  if (code >= 0x0900 && code <= 0x097f) return "devanagari";
  if (code >= 0x0e00 && code <= 0x0e7f) return "thai";
  if (code >= 0x4e00 && code <= 0x9fff) return "han";
  // Everything else (Latin + Latin-extended) collapses to "latin".
  return "latin";
}

function tokenize(text: string): string[] {
  return text
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** 1 for a word-like token, 0 for a fragment (digits, symbols, repeated chars). */
function tokenQualityOf(token: string): number {
  if (token.length === 0) return 0;
  if (token.length > 60) return 0;
  const letters = countWhere(token, isLetter);
  if (letters === 0) {
    // Pure-symbol tokens are not words; digit tokens can be amounts.
    return /[0-9]/.test(token) ? 0.5 : 0.1;
  }
  const letterRatio = letters / token.length;
  if (letterRatio < 0.4) return 0.25;
  // A word that glues digits and punctuation ("Word123,") is OCR noise.
  if (letterRatio < 0.9 && /[0-9]/.test(token) && /[\p{P}\p{S}]/u.test(token)) {
    return 0.25;
  }
  // Repeated single character ("aaaaaaaa") is not a word.
  const unique = new Set([...token]).size;
  if (unique <= 2 && token.length >= 4) return 0;
  return 1;
}

function repetitionOf(tokens: string[]): number {
  if (tokens.length < 3) return 0;
  const counts = new Map<string, number>();
  for (const t of tokens) {
    const key = t.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let repeated = 0;
  for (const n of counts.values()) if (n >= 3) repeated += 1;
  return Math.min(1, repeated / counts.size);
}

function countWhere(s: string, test: (ch: string) => boolean): number {
  let n = 0;
  for (const ch of s) if (test(ch)) n += 1;
  return n;
}

/** Mean OCR confidence over a line's words (undefined when unknown). */
export function lineOcrConfidence(line?: OcrLine): number | undefined {
  if (!line) return undefined;
  const confs = line.words
    .map((w) => w.confidence)
    .filter((c): c is number => typeof c === "number");
  if (confs.length > 0) return mean(confs);
  return typeof line.confidence === "number" ? line.confidence : undefined;
}

function mean(xs: number[]): number {
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}
