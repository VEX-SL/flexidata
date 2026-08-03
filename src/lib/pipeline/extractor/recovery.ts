import type {
  ExtractionProfile,
  ExtractionResult,
  FieldEvidence,
  FieldSchema,
  FieldValue,
  OcrDocument,
  OcrLine,
} from "../types";
import { buildOcrDocument, normalizeText } from "../ocr";
import { labelGroupForField } from "./label-lexicon";
import { LABEL_GROUPS } from "./label-lexicon";
import { coerce } from "./normalizer";

/**
 * Deterministic recovery — a second, label-driven evidence pass for required
 * fields the extraction stage could not resolve (model returned null, or the
 * value was not grounded).
 *
 * It uses ONLY existing profile metadata: the field's semantic label category
 * (label-lexicon), the field label text, the field type's expected value
 * pattern (via the normalizer's `coerce`), and the OCR spans. No document
 * type, vendor, or field key is special-cased — any profile gets the same
 * treatment, so this replaces all future per-document backstops.
 *
 * Results are never verified truth:
 *   - exactly one grounded candidate → source "ocr", status "flagged", low
 *     confidence (label-inferred, not model-verified);
 *   - several distinct grounded candidates → status "ambiguous" with the
 *     candidates exposed as `alternatives`, value kept null;
 *   - no grounded candidate → nothing, the field stays unresolved.
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
}

export interface RecoverResult {
  /** Required fields resolved to a single grounded candidate (flagged). */
  flagged: Map<string, FieldValue>;
  /** Required fields with several distinct candidates (ambiguous). */
  ambiguous: Map<string, FieldValue>;
  /** Candidate sets per field (for observability / retry gating). */
  candidates: Map<string, RecoveryCandidate[]>;
}

const FLAG_CONFIDENCE_FACTOR = 0.7;
const FLAG_CONFIDENCE_CAP = 0.5;
const DEFAULT_OCR_CONFIDENCE = 0.7;
const SEPARATORS = /^[\s:;\-–—|،,.٫]+|[\s:;\-–—|،,.٫]+$/g;

/**
 * Recover required fields that have no grounded value. `extraction` must be
 * the post-grounding result (missing required fields absent from fieldsMap).
 */
export function recoverMissingFields(
  profile: ExtractionProfile,
  extraction: ExtractionResult,
  sourceText: string,
  ocr?: OcrDocument
): RecoverResult {
  const ocrDoc = ocr ?? buildOcrDocument(sourceText);
  const flagged = new Map<string, FieldValue>();
  const ambiguous = new Map<string, FieldValue>();
  const candidates = new Map<string, RecoveryCandidate[]>();

  for (const field of profile.schema.fields) {
    if (!field.required) continue;
    const fv = extraction.fieldsMap[field.key];
    if (fv && !isEmpty(fv.value)) continue;

    const found = searchField(field, ocrDoc);
    candidates.set(field.key, found);
    if (found.length === 0) continue;

    const distinct = dedupeByValue(found);
    if (distinct.length === 1) {
      const c = distinct[0];
      flagged.set(field.key, {
        value: c.value,
        rawValue: c.raw,
        confidence: c.confidence,
        source: "ocr",
        status: "flagged",
        evidence: c.evidence,
      });
    } else {
      ambiguous.set(field.key, {
        value: null,
        rawValue: null,
        confidence: 0,
        source: "ocr",
        status: "ambiguous",
        evidence: distinct.flatMap((c) => c.evidence),
        alternatives: distinct.map((c) => c.value),
        meta: {
          candidates: distinct.map((c) => ({ value: c.value, raw: c.raw })),
        },
      });
    }
  }

  return { flagged, ambiguous, candidates };
}

// ─── Per-field search ──────────────────────────────────────────────────────

function searchField(field: FieldSchema, ocrDoc: OcrDocument): RecoveryCandidate[] {
  const words = labelWords(field);
  if (words.length === 0) return [];

  const out: RecoveryCandidate[] = [];
  for (let i = 0; i < ocrDoc.lines.length; i++) {
    const line = ocrDoc.lines[i];
    const norm = normalizeText(line.text);
    if (!norm) continue;

    const word = firstMatchingLabel(norm, words);
    if (!word) continue;

    const hits = extractLineCandidates(field, line, i, norm, word, ocrDoc.lines);
    for (const hit of hits) out.push(hit);
  }
  return out;
}

/** The label category words + the field's own label text, best-effort. */
function labelWords(field: FieldSchema): string[] {
  const set = new Set<string>();
  const group = labelGroupForField(field);
  if (group) {
    const def = LABEL_GROUPS.find((g) => g.group === group);
    for (const w of def?.words ?? []) set.add(normalizeText(w));
  }
  for (const w of (field.label ?? "").split(/\s+/)) {
    const n = normalizeText(w);
    if (n.length >= 2) set.add(n);
  }
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
  label: string,
  lines: OcrLine[]
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
      return textCandidates(field, line, lineIndex, norm, label, base, evidence, lines);
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
  evidence: FieldEvidence,
  lines: OcrLine[]
): RecoveryCandidate[] {
  const valueText = valueAfterLabel(line.text, label);
  const extracted =
    valueText.length > 0 ? valueText : nextLineText(lines, lineIndex);
  if (extracted.length === 0) return [];

  const value = coerce(field, extracted);
  if (value === null) return [];

  const ev = valueText.length > 0 ? [evidence] : [evidenceForNextLine(lines, lineIndex, extracted)];
  return [makeCandidate(extracted, value, base, ev)];
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

function nextLineText(lines: OcrLine[], afterIndex: number): string {
  const next = lines[afterIndex + 1];
  if (!next) return "";
  const text = next.text.trim();
  if (!text) return "";
  // Never swallow another label line as a value.
  const norm = normalizeText(text);
  const anyLabel = LABEL_GROUPS.some((g) =>
    g.words.some((w) => {
      const n = normalizeText(w);
      return isLatin(n)
        ? new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(norm)
        : norm.includes(n);
    })
  );
  if (anyLabel) return "";
  return text.replace(SEPARATORS, "");
}

function evidenceForNextLine(
  lines: OcrLine[],
  afterIndex: number,
  value: string
): FieldEvidence {
  const next = lines[afterIndex + 1];
  return {
    quote: next?.text ?? value,
    lineIndex: afterIndex + 1,
    role: "label-match",
    context: next?.text ?? value,
    confidence: next ? baseConfidence(next) : undefined,
  };
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

// ─── Helpers ───────────────────────────────────────────────────────────────

function dedupeByValue(candidates: RecoveryCandidate[]): RecoveryCandidate[] {
  const byValue = new Map<string, RecoveryCandidate>();
  for (const c of candidates) {
    const key = JSON.stringify(c.value);
    const existing = byValue.get(key);
    if (!existing) {
      byValue.set(key, c);
    } else {
      // Merge evidence + keep the highest-confidence candidate value.
      existing.evidence = dedupeEvidence([...existing.evidence, ...c.evidence]);
      existing.confidence = Math.max(existing.confidence, c.confidence);
    }
  }
  return Array.from(byValue.values());
}

function dedupeEvidence(list: FieldEvidence[]): FieldEvidence[] {
  const seen = new Set<string>();
  const out: FieldEvidence[] = [];
  for (const e of list) {
    const key = `${e.lineIndex ?? "?"}:${e.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function isEmpty(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0)
  );
}

function mean(xs: number[]): number {
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}
