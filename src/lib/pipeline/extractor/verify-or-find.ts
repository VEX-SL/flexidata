import type {
  FieldEvidence,
  FieldSchema,
  FieldValue,
  OcrDocument,
  OcrLine,
  UncertaintyReason,
} from "../types";
import { normalizeText } from "../ocr";
import { labelGroupForField, LABEL_GROUPS } from "./label-lexicon";
import { coerce } from "./normalizer";
import { spanBox } from "../geometry";

/**
 * Milestone 12 — Verify-or-Find: deterministic, metadata-driven evidence
 * discovery shared by the grounding stage (VERIFY arm) and the recovery stage
 * (FIND arm).
 *
 * VERIFY arm (`verifyEvidence`): anchors a model value that does not appear
 * verbatim in the document through deterministic normalization tiers ONLY:
 * separator-free reference numbers (label categories "number"/"tax") and
 * alternative ISO date layouts. There is no fuzzy character matching — Amazon
 * never verifies as Amzon, 999999 never verifies as 123456, "$100" never
 * verifies as "$1000". Everything returned is a real OCR span.
 *
 * FIND arm (`findFieldCandidates`): the label-driven search for required
 * fields the model left null. It uses only profile metadata (the field's
 * semantic label category from the lexicon, the field label text, the field
 * type's expected value pattern) and the OCR spans — the same metadata the
 * grounding stage uses, so recovery and grounding can never disagree about
 * what a field means.
 *
 * The recover stage keeps its contract: exactly one grounded candidate →
 * flagged (low confidence), several distinct candidates → ambiguous with
 * alternatives, none → the field stays unresolved. Nothing is invented, and a
 * value grounding already dropped is never re-discovered.
 */

export interface RecoveryCandidate {
  /** Coerced candidate value (typed per the field schema). */
  value: unknown;
  /** Verbatim source reading of the candidate. */
  raw: unknown;
  /** OCR evidence anchors (label-match). */
  evidence: FieldEvidence[];
  /** Low composed confidence (OCR quality factor × penalty). */
  confidence: number;
  /** Why this reading is uncertain (recovered-from-OCR / low OCR quality). */
  reasons: UncertaintyReason[];
}

const FLAG_CONFIDENCE_FACTOR = 0.7;
const FLAG_CONFIDENCE_CAP = 0.5;
const DEFAULT_OCR_CONFIDENCE = 0.7;
const SEPARATORS = /^[\s:;\-–—|،,.٫]+|[\s:;\-–—|،,.٫]+$/g;

// ─── VERIFY arm ────────────────────────────────────────────────────────────

/**
 * Verify a model value that no verbatim / derived match could anchor. Returns
 * evidence only when the value genuinely appears in the document in a
 * differently-printed form; otherwise an empty array (the value is dropped by
 * the caller, never invented or "corrected").
 */
export function verifyEvidence(
  ocrDoc: OcrDocument,
  field: FieldSchema,
  fv: FieldValue
): FieldEvidence[] {
  const raw = fv.rawValue ?? fv.value;

  if (field.type === "date") {
    return searchIsoDateVariants(ocrDoc, String(raw ?? ""));
  }

  const group = labelGroupForField(field);
  if (group === "number" || group === "tax") {
    if (field.type === "string" || field.type === "text") {
      return searchSeparatorFree(ocrDoc, raw);
    }
  }

  return [];
}

/** Reference-style values: "REF 2013 438351" ↔ "2013438351". */
function searchSeparatorFree(ocrDoc: OcrDocument, value: unknown): FieldEvidence[] {
  const s = typeof value === "string" ? value : String(value ?? "");
  if (!/\d/.test(s)) return [];

  const out: FieldEvidence[] = [];
  for (let i = 0; i < ocrDoc.lines.length; i++) {
    const line = ocrDoc.lines[i];
    const span = findSeparatorFreeSpan(line, s);
    if (span) out.push(buildEvidence(line, i, "derived", span));
  }
  return dedupeEvidence(out);
}

/** Alternative ISO-order date layouts: "2028/07/02", "2028.07.02", "20280702". */
function searchIsoDateVariants(ocrDoc: OcrDocument, iso: string): FieldEvidence[] {
  const variants = isoOrderVariants(iso);
  if (variants.length === 0) return [];

  const out: FieldEvidence[] = [];
  for (let i = 0; i < ocrDoc.lines.length; i++) {
    const line = ocrDoc.lines[i];
    const norm = normalizeText(line.text);
    if (!norm) continue;
    const variant = variants.find((v) => norm.includes(v));
    if (variant === undefined) continue;
    const span = findWordSpan(line, variant);
    out.push(span ? buildEvidence(line, i, "derived", span) : buildLineEvidence(line, i, "derived"));
  }
  return dedupeEvidence(out);
}

function isoOrderVariants(iso: string): string[] {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [];
  const [, y, mo, d] = m;
  const out = new Set<string>();
  for (const sep of ["/", "."]) out.add(`${y}${sep}${mo}${sep}${d}`);
  out.add(`${y}${mo}${d}`);
  return Array.from(out);
}

/**
 * Minimal contiguous word span whose separator-free text contains the needle
 * AND carries exactly the needle's digit count. The digit-count guard stops
 * a shorter reference ("1234") from being verified against a longer printed
 * number ("12345") while still accepting printed separators ("2013-438351").
 */
function findSeparatorFreeSpan(
  line: OcrLine,
  needle: string
): { start: number; end: number } | null {
  const words = line.words;
  if (words.length === 0) return null;
  const tokens = words.map((w) => alnum(normalizeText(w.text)));
  const target = alnum(normalizeText(needle));
  if (!target || !/\d/.test(target)) return null;
  const targetDigits = digitCount(target);

  for (let start = 0; start < tokens.length; start++) {
    let acc = tokens[start];
    if (acc.includes(target) && digitCount(acc) === targetDigits) {
      return { start, end: start };
    }
    for (let end = start + 1; end < tokens.length; end++) {
      acc += tokens[end];
      if (acc.includes(target) && digitCount(acc) === targetDigits) {
        return { start, end };
      }
      if (digitCount(acc) > targetDigits) break;
    }
  }
  return null;
}

function alnum(s: string): string {
  return s.replace(/[^a-z0-9]+/g, "");
}

function digitCount(s: string): number {
  let n = 0;
  for (const ch of s) if (ch >= "0" && ch <= "9") n += 1;
  return n;
}

// ─── FIND arm ──────────────────────────────────────────────────────────────

/**
 * Label-driven search for a field's grounded candidates (profile metadata
 * only). Ported from the recovery stage's deterministic pass so grounding and
 * recovery share one engine.
 */
export function findFieldCandidates(
  field: FieldSchema,
  ocrDoc: OcrDocument
): RecoveryCandidate[] {
  const words = labelWords(field);
  if (words.length === 0) return [];

  const out: RecoveryCandidate[] = [];
  for (let i = 0; i < ocrDoc.lines.length; i++) {
    const line = ocrDoc.lines[i];
    const norm = normalizeText(line.text);
    if (!norm) continue;

    const word = firstMatchingLabel(norm, words);
    if (!word) continue;

    const hits = extractLineCandidates(field, line, i, norm, word);
    for (const hit of hits) out.push(hit);
  }
  return out;
}

/**
 * The label category words + the field's own label PHRASE (whitespace-
 * collapsed). The label is never tokenized into single words: a generic token
 * such as "receipt" from "Receipt number" must not anchor a match by itself —
 * only the complete label phrase or a category lexicon anchor may.
 */
function labelWords(field: FieldSchema): string[] {
  const set = new Set<string>();
  const group = labelGroupForField(field);
  if (group) {
    const def = LABEL_GROUPS.find((g) => g.group === group);
    for (const w of def?.words ?? []) set.add(normalizeText(w));
  }
  const phrase = normalizeText(field.label ?? "");
  if (phrase.length >= 2) set.add(phrase);
  set.delete("");
  return Array.from(set).sort((a, b) => b.length - a.length);
}

/** Longest matching label word wins (most specific signal). */
function firstMatchingLabel(norm: string, words: string[]): string | null {
  for (const w of words) {
    if (isLatin(w)) {
      const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`).test(norm)) return w;
    } else if (norm.includes(w)) {
      return w;
    }
  }
  return null;
}

function isLatin(s: string): boolean {
  return /^[a-z0-9\s]+$/.test(s);
}

function extractLineCandidates(
  field: FieldSchema,
  line: OcrLine,
  lineIndex: number,
  norm: string,
  label: string
): RecoveryCandidate[] {
  const base = baseConfidence(line);
  const evidence: FieldEvidence = {
    quote: line.text,
    lineIndex,
    role: "label-match",
    context: line.text,
    confidence: base,
  };

  switch (field.type) {
    case "date":
      return dateCandidates(field, norm, base, evidence);
    case "number":
    case "currency":
      return numberCandidates(field, norm, label, base, evidence);
    case "enum":
      return enumCandidates(field, norm, base, evidence);
    case "boolean":
      return booleanCandidates(field, norm, base, evidence);
    case "string":
    case "text":
      return textCandidates(field, line, lineIndex, norm, label, base, evidence);
    default:
      return [];
  }
}

function dateCandidates(
  field: FieldSchema,
  norm: string,
  base: number,
  evidence: FieldEvidence
): RecoveryCandidate[] {
  const m = norm.match(/\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/);
  if (!m) return [];
  const raw = m[0];
  const value = coerce(field, raw);
  if (value === null) return [];
  return [makeCandidate(raw, value, base, [evidence])];
}

function numberCandidates(
  field: FieldSchema,
  norm: string,
  label: string,
  base: number,
  evidence: FieldEvidence
): RecoveryCandidate[] {
  const matches = Array.from(norm.matchAll(/-?\d[\d,]*(?:\.\d+)?/g));
  if (matches.length === 0) return [];
  // Prefer the match that follows the label (amounts/totals sit after it).
  const labelIdx = norm.indexOf(label);
  const after = matches.filter((m) => m.index !== undefined && m.index > labelIdx);
  const pick = (after[after.length - 1] ?? matches[matches.length - 1])[0];
  const value = coerce(field, pick);
  if (value === null) return [];
  return [makeCandidate(pick, value, base, [evidence])];
}

function enumCandidates(
  field: FieldSchema,
  norm: string,
  base: number,
  evidence: FieldEvidence
): RecoveryCandidate[] {
  const out: RecoveryCandidate[] = [];
  for (const allowed of field.enum ?? []) {
    if (!isLatin(allowed) || norm.includes(allowed.toLowerCase())) {
      const value = coerce(field, allowed);
      if (value !== null) out.push(makeCandidate(allowed, value, base, [evidence]));
    }
  }
  return out;
}

function booleanCandidates(
  field: FieldSchema,
  norm: string,
  base: number,
  evidence: FieldEvidence
): RecoveryCandidate[] {
  for (const [word, value] of [
    ["true", true],
    ["yes", true],
    ["نعم", true],
    ["false", false],
    ["no", false],
    ["لا", false],
  ] as const) {
    if (norm.includes(word)) {
      return [makeCandidate(word, value, base, [evidence])];
    }
  }
  return [];
}

function textCandidates(
  field: FieldSchema,
  line: OcrLine,
  lineIndex: number,
  norm: string,
  label: string,
  base: number,
  evidence: FieldEvidence
): RecoveryCandidate[] {
  // The value must follow the label on the SAME line — a generic label token
  // (e.g. "receipt" on a bare "RECEIPT" header) must never borrow the next OCR
  // line as a value.
  const extracted = valueAfterLabel(line.text, label);
  if (extracted.length === 0) return [];

  if (isReferenceField(field) && !looksLikeReference(extracted)) return [];

  const value = coerce(field, extracted);
  if (value === null) return [];

  return [makeCandidate(extracted, value, base, [evidence])];
}

/** Strip bidi control chars and take the remainder after the label. */
function valueAfterLabel(lineText: string, label: string): string {
  const stripped = lineText
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const idx = stripped.toLowerCase().indexOf(label);
  if (idx < 0) return "";
  const rest = stripped.slice(idx + label.length).replace(SEPARATORS, "");
  return rest.length >= 2 ? rest : "";
}

/** Reference-category fields (receipt numbers, tax ids) whose strings are identifiers. */
function isReferenceField(field: FieldSchema): boolean {
  const group = labelGroupForField(field);
  return group === "number" || group === "tax";
}

/**
 * A reference reading must look like an identifier: at least one digit and
 * every whitespace-separated token must carry digits ("2013438351" and
 * "2013 438351" are fine; "MILK 3.50" and "code A100" are not).
 */
function looksLikeReference(s: string): boolean {
  if (!/\d/.test(s)) return false;
  return s.split(/\s+/).every((tok) => /\d/.test(tok));
}

function makeCandidate(
  raw: string,
  value: unknown,
  baseConfidence: number,
  evidence: FieldEvidence[]
): RecoveryCandidate {
  return {
    value,
    raw,
    evidence,
    confidence: flagConfidence(baseConfidence),
    reasons: baseConfidence < 0.6
      ? ["recovered_from_ocr", "ocr_confidence_low"]
      : ["recovered_from_ocr"],
  };
}

function baseConfidence(line: OcrLine): number {
  if (typeof line.confidence === "number") return clamp(line.confidence);
  const wordConfs = line.words
    .map((w) => w.confidence)
    .filter((c): c is number => typeof c === "number");
  if (wordConfs.length > 0) return clamp(mean(wordConfs));
  return DEFAULT_OCR_CONFIDENCE;
}

/** Low confidence: OCR quality × penalty, capped so flagged ≠ verified. */
function flagConfidence(base: number): number {
  return Math.min(FLAG_CONFIDENCE_CAP, clamp(base * FLAG_CONFIDENCE_FACTOR));
}

// ─── Evidence builders ─────────────────────────────────────────────────────

/** Span-anchored evidence (word indices + bbox) mirroring the grounding path. */
function buildEvidence(
  line: OcrLine,
  lineIndex: number,
  role: FieldEvidence["role"],
  span: { start: number; end: number }
): FieldEvidence {
  const wordConfs = line.words
    .slice(span.start, span.end + 1)
    .map((w) => w.confidence)
    .filter((c): c is number => typeof c === "number");
  return {
    quote: line.words.slice(span.start, span.end + 1).map((w) => w.text).join(" "),
    lineIndex,
    wordIndices: range(span.start, span.end + 1),
    bbox: spanBox(line, span.start, span.end),
    role,
    source: "ocr",
    confidence: wordConfs.length > 0 ? mean(wordConfs) : meanWordConfidence(line),
    context: line.text,
  };
}

function buildLineEvidence(
  line: OcrLine,
  lineIndex: number,
  role: FieldEvidence["role"]
): FieldEvidence {
  return {
    quote: line.text,
    lineIndex,
    role,
    source: "ocr",
    confidence: meanWordConfidence(line),
    context: line.text,
  };
}

/** Minimal contiguous word span whose joined text contains the needle. */
function findWordSpan(
  line: OcrLine,
  normNeedle: string
): { start: number; end: number } | null {
  const words = line.words;
  if (words.length === 0 || !normNeedle) return null;
  const normWords = words.map((w) => normalizeText(w.text));
  let best: { start: number; end: number } | null = null;
  for (let start = 0; start < normWords.length; start++) {
    let acc = normWords[start];
    if (acc && acc.includes(normNeedle)) {
      if (!best || start + 1 - start < best.end - best.start + 1) best = { start, end: start };
      continue;
    }
    for (let end = start + 1; end < normWords.length; end++) {
      acc = `${acc} ${normWords[end]}`;
      if (acc.includes(normNeedle)) {
        if (!best || end - start < best.end - best.start) best = { start, end };
        break;
      }
      if (acc.length > normNeedle.length * 2) break;
    }
  }
  return best;
}

function dedupeEvidence(list: FieldEvidence[]): FieldEvidence[] {
  const seen = new Set<string>();
  const out: FieldEvidence[] = [];
  for (const e of list) {
    const key = `${e.lineIndex ?? "?"}:${e.role}:${e.wordIndices?.[0] ?? "line"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function meanWordConfidence(line: OcrLine): number | undefined {
  const wordConfs = line.words
    .map((w) => w.confidence)
    .filter((c): c is number => typeof c === "number");
  if (wordConfs.length > 0) return mean(wordConfs);
  return typeof line.confidence === "number" ? line.confidence : undefined;
}

function mean(xs: number[]): number {
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}
