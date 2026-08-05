/**
 * Generic Arabic OCR repair layer.
 *
 * Repairs common OCR distortions *before* extraction, gated so it never
 * guesses content:
 *
 *  - isolated Arabic letters that OCR split apart ("ا ل ر ح ي م" → "الرحيم")
 *  - duplicated characters ("الللرحيم" → "الرحيم", only when confidence
 *    suggests the glyphs doubled — a real 2-letter double like "الله" is never
 *    touched)
 *  - spacing corruption / mixed Arabic-Latin fragments ("SuperPay60" →
 *    "SuperPay 60", "رقم2013" → "رقم 2013")
 *  - line-edge fragments from the row above/below ("gla المطلوب : 68.38" → the
 *    "gla" bleed is moved to its own flagged line; nothing is deleted, so
 *    values like "391803452" are never touched)
 *
 * Every rule is structural — script ratios, token shapes, digit boundaries.
 * No document-specific keywords, no vendor-specific logic, no invented text.
 */
import type { BBox } from "@/lib/pipeline/types";
import { unionBoxes } from "@/lib/pipeline/geometry";
import {
  countArabicLetters,
  countLatinLetters,
  isArabicLetter,
} from "./scripts";
import { normalizeArabicText } from "./normalize";

/** A word token with optional OCR metadata, manipulated by the repair pass. */
export interface RepairToken {
  text: string;
  confidence?: number;
  bbox?: BBox;
}

/** One observable repair, reported for before/after tooling and QA. */
export interface RepairChange {
  kind: string;
  detail: string;
  originalText: string;
  repairedText: string;
}

/** Confidence below which OCR glyph doubling is likely (duplicate collapse). */
const DUPLICATE_CONFIDENCE_THRESHOLD = 0.8;
/** Runs of 4+ identical letters collapse regardless of confidence. */
const HARD_DUPLICATE_RUN = 4;
/** Edge fragments longer than this many letters are treated as real content. */
const MAX_FRAGMENT_LETTERS = 4;

const COMBINING_MARKS = /[\u064b-\u065f\u0670]/g;

/**
 * Repair one OCR line's tokens. Returns one or more token lists: the main
 * line plus any edge fragments detached to their own lines. Text is never
 * deleted — detached fragments move to separate lines so downstream stages can
 * flag them as low-signal.
 */
export function repairLineWords(
  tokens: RepairToken[]
): { lines: RepairToken[][]; changes: RepairChange[] } {
  const changes: RepairChange[] = [];
  let toks = tokens.map(normalizeToken);

  const joined = joinSingleLetters(toks);
  if (joined.text !== toks.map((t) => t.text).join(" ")) {
    changes.push({
      kind: "join-isolated-letters",
      detail: "consecutive single Arabic letters reassembled into a word",
      originalText: toks.map((t) => t.text).join(" "),
      repairedText: joined.text,
    });
  }
  toks = joined.tokens;

  const deduped = collapseDuplicates(toks, changes);
  toks = deduped;

  const split = splitBoundaryTokens(toks);
  if (split !== toks) {
    changes.push({
      kind: "insert-boundary-spaces",
      detail: "spacing inserted at Arabic/Latin/digit boundaries",
      originalText: toks.map((t) => t.text).join(" "),
      repairedText: split.map((t) => t.text).join(" "),
    });
  }
  toks = split;

  const detached = detachEdgeFragments(toks, changes);
  return { lines: detached.lines, changes };
}

function normalizeToken(t: RepairToken): RepairToken {
  const text = normalizeArabicText(t.text);
  if (text === t.text) return t;
  return { ...t, text };
}

// ─── Isolated-letter reassembly ───────────────────────────────────────────

interface Joined {
  tokens: RepairToken[];
  text: string;
}

/** Join consecutive single-Arabic-letter tokens into one word. */
function joinSingleLetters(tokens: RepairToken[]): Joined {
  const out: RepairToken[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (
      isSingleArabicLetter(tokens[i]) &&
      i + 1 < tokens.length &&
      isSingleArabicLetter(tokens[i + 1])
    ) {
      let j = i;
      let text = "";
      const confs: number[] = [];
      const boxes: BBox[] = [];
      while (j < tokens.length && isSingleArabicLetter(tokens[j])) {
        text += tokens[j].text;
        if (tokens[j].confidence !== undefined) confs.push(tokens[j].confidence!);
        const b = tokens[j].bbox;
        if (b) boxes.push(b);
        j += 1;
      }
      out.push({
        text,
        confidence: confs.length > 0 ? Math.min(...confs) : undefined,
        bbox: unionBoxes(boxes),
      });
      i = j;
    } else {
      out.push(tokens[i]);
      i += 1;
    }
  }
  return { tokens: out, text: out.map((t) => t.text).join(" ") };
}

/** A token that is exactly one Arabic letter (diacritics allowed). */
function isSingleArabicLetter(t: RepairToken): boolean {
  const base = t.text.replace(COMBINING_MARKS, "");
  if (base.length !== 1) return false;
  return isArabicLetter(base);
}

// ─── Duplicate-character collapse ─────────────────────────────────────────

function collapseDuplicates(tokens: RepairToken[], changes: RepairChange[]): RepairToken[] {
  const out: RepairToken[] = [];
  for (const t of tokens) {
    let changed = false;
    const text = t.text.replace(
      /([\u0621-\u064a])\1+/gu,
      (run: string, letter: string) => {
        if (run.length >= HARD_DUPLICATE_RUN) {
          changed = true;
          return letter;
        }
        if (run.length >= 3 && (t.confidence ?? 1) < DUPLICATE_CONFIDENCE_THRESHOLD) {
          changed = true;
          return letter;
        }
        return run;
      }
    );
    if (changed) {
      changes.push({
        kind: "collapse-duplicated-letters",
        detail: `"${t.text}" → "${text}" (glyph doubling)`,
        originalText: t.text,
        repairedText: text,
      });
      out.push({ ...t, text });
    } else {
      out.push(t);
    }
  }
  return out;
}

// ─── Spacing corruption / mixed-fragment splitting ────────────────────────

type CharClass = "a" | "l" | "d" | "o";

function charClass(ch: string): CharClass {
  if (isArabicLetter(ch)) return "a";
  if (/[a-zA-Z]/.test(ch)) return "l";
  if (/[0-9]/.test(ch)) return "d";
  return "o";
}

/**
 * Insert a space inside a glued token at script/digit boundaries:
 * Arabic↔Latin always; letter↔digit only when the token is long enough to be
 * a merge rather than a code. Arabic words glue to digits ("رقم2013" —
 * short 3-letter roots dominate), while a Latin letter+digit token needs a
 * real word of at least five letters ("SuperPay60") so alphanumeric
 * references ("SA1234567890", "CT2025881", "ABC123456") are never split —
 * splitting them would break value grounding.
 */
function splitBoundaryTokens(tokens: RepairToken[]): RepairToken[] {
  const out: RepairToken[] = [];
  for (const t of tokens) {
    const parts = splitTokenAtBoundaries(t);
    out.push(...parts);
  }
  return out;
}

function splitTokenAtBoundaries(t: RepairToken): RepairToken[] {
  const chars = [...t.text];
  if (chars.length < 2) return [t];
  const cls = chars.map(charClass);
  const arLetters = countWhere(chars, isArabicLetter);
  const laLetters = countWhere(chars, (ch) => /[a-zA-Z]/.test(ch));
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < chars.length; i++) {
    if (
      i > 0 &&
      shouldSplit(cls[i - 1], cls[i], chars.length, arLetters, laLetters)
    ) {
      parts.push(cur);
      cur = "";
    }
    cur += chars[i];
  }
  parts.push(cur);
  if (parts.length === 1) return [t];
  return parts.map((p) => ({ text: p, confidence: t.confidence, bbox: t.bbox }));
}

function shouldSplit(
  a: CharClass,
  b: CharClass,
  totalLen: number,
  arLetters: number,
  laLetters: number
): boolean {
  if ((a === "a" && b === "l") || (a === "l" && b === "a")) return true;
  const letterDigit = (a === "d" && (b === "a" || b === "l")) ||
    ((a === "a" || a === "l") && b === "d");
  if (!letterDigit || totalLen < 4) return false;
  // Arabic short words glue to digits; Latin letter+digit tokens need a real
  // word before we treat the digit run as a separate value.
  return (arLetters >= 3 && laLetters === 0) || laLetters >= 5;
}

function countWhere(chars: string[], test: (ch: string) => boolean): number {
  let n = 0;
  for (const ch of chars) if (test(ch)) n += 1;
  return n;
}

// ─── Line-edge fragment detachment ────────────────────────────────────────

/**
 * Move short non-dominant-script letter runs at the line edges to their own
 * lines. This targets the classic "bleed" from the row above/below ("gla
 * المطلوب", "glad | العلى", "له SuperPay 60"). Digit-bearing tokens are never
 * moved (they protect values like "391803452"), and nothing is deleted.
 */
function detachEdgeFragments(
  tokens: RepairToken[],
  changes: RepairChange[]
): { lines: RepairToken[][] } {
  if (tokens.length < 2) return { lines: [tokens] };

  const totalAr = tokens.reduce((n, t) => n + countArabicLetters(t.text), 0);
  const totalLa = tokens.reduce((n, t) => n + countLatinLetters(t.text), 0);
  if (totalAr === 0 || totalLa === 0) return { lines: [tokens] };

  const dominant = totalAr >= totalLa ? "ar" : "la";
  const dominantLetters = dominant === "ar" ? totalAr : totalLa;

  const runOk = (run: RepairToken[]): boolean => {
    if (run.length === 0) return false;
    const letters = run.reduce(
      (n, t) =>
        n + (dominant === "ar" ? countLatinLetters(t.text) : countArabicLetters(t.text)),
      0
    );
    if (letters < 1 || letters > MAX_FRAGMENT_LETTERS) return false;
    if (dominantLetters < letters) return false;
    return true;
  };

  const isFragmentToken = (t: RepairToken): boolean => {
    if (/[0-9]/.test(t.text)) return false;
    const ar = countArabicLetters(t.text);
    const la = countLatinLetters(t.text);
    if (ar === 0 && la === 0) return true; // symbol-only token rides along
    if (dominant === "ar") return la > 0 && ar === 0;
    return ar > 0 && la === 0;
  };

  let leadEnd = 0;
  while (leadEnd < tokens.length && isFragmentToken(tokens[leadEnd])) leadEnd += 1;
  let trailStart = tokens.length;
  while (trailStart > leadEnd && isFragmentToken(tokens[trailStart - 1])) trailStart -= 1;

  const lead = tokens.slice(0, leadEnd);
  const trail = tokens.slice(trailStart);
  const detachLead = runOk(lead);
  const detachTrail = runOk(trail);

  // A consumed run that is not a real fragment (e.g. a symbol-only trail
  // token like ";") folds back into the main line instead of vanishing.
  const mainStart = detachLead ? leadEnd : 0;
  const mainEnd = detachTrail ? trailStart : tokens.length;
  const main = tokens.slice(mainStart, mainEnd);
  if (main.length === 0) return { lines: [tokens] };

  const detached: RepairToken[][] = [];
  if (detachLead) {
    detached.push(lead);
    changes.push({
      kind: "detach-edge-fragment",
      detail: `leading non-dominant-script fragment "${lead.map((t) => t.text).join(" ")}" moved to its own line`,
      originalText: tokens.map((t) => t.text).join(" "),
      repairedText: main.map((t) => t.text).join(" "),
    });
  }
  if (detachTrail) {
    detached.push(trail);
    changes.push({
      kind: "detach-edge-fragment",
      detail: `trailing non-dominant-script fragment "${trail.map((t) => t.text).join(" ")}" moved to its own line`,
      originalText: tokens.map((t) => t.text).join(" "),
      repairedText: main.map((t) => t.text).join(" "),
    });
  }

  if (detached.length === 0) return { lines: [tokens] };
  return { lines: [main, ...detached] };
}
