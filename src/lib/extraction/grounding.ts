/**
 * Spatial Alignment Engine + GroundedDocument.
 *
 * Consumes the FINAL OCR document (Tesseract lines plus any accepted Paddle
 * rescue lines already inserted by the rescue stage) and the schema fields,
 * then produces a per-field grounding verdict:
 *
 *   VERIFIED   the field's value is present AND anchored to its printed label
 *              by a trustworthy spatial alignment (label+value inline on one
 *              line, side-by-side boxes on the same visual line, or directly
 *              below within PADDLE_PAIR_GAP) AND the reading confidence is
 *              sufficient AND (when an expected value is supplied) the aligned
 *              value matches it.
 *   UNCERTAIN  a value exists but its attribution is not trustworthy: a bare
 *              value with no label at all, a value too far from its label to
 *              be attributed, an aligned value that differs from the expected
 *              one, or a low-confidence reading.
 *   MISSING    no value for the field exists in the document at all.
 *
 * The spatial thresholds are the SAME constants the rescue stage uses to
 * accept a label/value pairing (PADDLE_SAME_LINE_TOL, PADDLE_PAIR_GAP), so a
 * field the rescue recovered is grounded under the identical spatial contract,
 * and a value that only floats in the document as a bare number — no label, no
 * trustworthy attribution — is never marked VERIFIED.
 */
import type {
  BBox,
  FieldType,
  OcrDocument,
  OcrLine,
} from "@/lib/pipeline/types";
import { normalizeText } from "@/lib/pipeline/ocr";
import {
  LABEL_GROUPS,
  labelGroupForField,
} from "@/lib/pipeline/extractor/label-lexicon";
import {
  PADDLE_PAIR_GAP,
  PADDLE_SAME_LINE_TOL,
} from "@/lib/ocr/paddle-rescue";
import { canonicalNumeric } from "@/lib/ocr/numeric-verify";

// ─── Calibrated contract (shared with the rescue layer) ────────────────────

/** Below this reading confidence an aligned field is never VERIFIED. */
export const GROUNDED_MIN_CONF = 0.6;

// ─── Public types ───────────────────────────────────────────────────────────

export type GroundedState = "VERIFIED" | "UNCERTAIN" | "MISSING";

/** Where the grounded line came from in the OCR stack. */
export type GroundedSource = "tesseract" | "paddle_rescue";

/** How the label and its value are spatially related. */
export type AlignmentKind = "inline_label" | "same_line" | "adjacent_below";

export interface GroundedFieldInput {
  /** Field key, snake_case (schema key). */
  key: string;
  /** Field type, used to derive the default label group. */
  type?: FieldType;
  /** Explicit label category override (e.g. "total", "payment"). */
  labelGroup?: string;
  /** Printed label word(s), e.g. "Cash" or "Amount Due". */
  label?: string;
  /** Expected extraction value for the field, when known. */
  expectedValue?: string | number;
}

export interface GroundedAttribution {
  /** The printed label text on the matched line. */
  label: string;
  /** Index of the label line in the OcrDocument. */
  labelLine: number;
  /** Label line box (processed-image space), when available. */
  labelBBox?: BBox;
  /** The aligned value reading, verbatim. */
  value: string;
  /** Index of the value line in the OcrDocument. */
  valueLine: number;
  /** Value box (processed-image space), when available. */
  valueBBox?: BBox;
  /** Spatial relationship between label and value. */
  alignment: AlignmentKind;
  /** Reading confidence of the value line (0..1). */
  confidence: number;
  /** OCR stack that produced the value line. */
  source: GroundedSource;
}

export interface GroundedField {
  key: string;
  state: GroundedState;
  /** The committed value reading when one exists. */
  value?: string;
  /** Spatial attribution — present when a value was located. */
  attribution?: GroundedAttribution;
  /** Human-readable reasons justifying the state. */
  reasons: string[];
}

export interface GroundedDocument {
  doc: OcrDocument;
  fields: GroundedField[];
  summary: { verified: number; uncertain: number; missing: number; total: number };
}

// ─── Small deterministic helpers ────────────────────────────────────────────

function digitsOf(text: string): number {
  let n = 0;
  for (const c of text) if (c >= "0" && c <= "9") n += 1;
  return n;
}

/** The token carrying the most digits (mirrors the rescue layer's rule). */
function findNumericToken(text: string): string | null {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  let best: string | null = null;
  let bestDigits = 1;
  for (const t of tokens) {
    const d = digitsOf(t);
    if (d > bestDigits) {
      best = t;
      bestDigits = d;
    }
  }
  return best;
}

function centerY(b: BBox): number {
  return b.y + b.height / 2;
}

function meanWordConfidence(line: OcrLine, doc: OcrDocument): number {
  const confs = line.words
    .map((w) => w.confidence)
    .filter((c): c is number => typeof c === "number");
  if (confs.length > 0) return mean(confs);
  if (typeof line.confidence === "number") return line.confidence;
  if (typeof doc.confidence === "number") return doc.confidence;
  return 1;
}

function mean(xs: number[]): number {
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

/** Canonical value comparison: amounts by numeric value, others by digits/text. */
function valuesMatch(expected: string | number, token: string): boolean {
  const exp = String(expected).trim();
  if (!exp) return false;
  const eNum = Number(exp.replace(/[^\d.]/g, ""));
  const tNum = Number(token.replace(/[^\d.]/g, ""));
  if (Number.isFinite(eNum) && Number.isFinite(tNum) && exp.replace(/[^\d.]/g, "").length <= 14) {
    return Math.abs(eNum - tNum) < 1e-6;
  }
  return canonicalNumeric(exp) === canonicalNumeric(token) || normalizeText(exp) === normalizeText(token);
}

// ─── Label token resolution ─────────────────────────────────────────────────

/**
 * The set of printed tokens that identify this field's label: the label group's
 * lexicon words, the explicit label, and the field key words.
 */
function labelTokensFor(input: GroundedFieldInput): string[] {
  const tokens = new Set<string>();
  const group = input.labelGroup ?? labelGroupForField({
    key: input.key,
    type: input.type ?? "string",
  });
  if (group) {
    const def = LABEL_GROUPS.find((g) => g.group === group);
    for (const w of def?.words ?? []) tokens.add(w);
  }
  if (input.label) {
    for (const w of input.label.split(/\s+/)) {
      if (w.trim().length > 0) tokens.add(w.trim());
    }
  }
  for (const w of input.key.split(/[_ ]+/)) {
    if (w.trim().length > 0) tokens.add(w.trim());
  }
  return Array.from(tokens).filter((t) => normalizeText(t).length >= 2);
}

function lineHasLabel(line: OcrLine, tokens: string[]): boolean {
  const norm = normalizeText(line.text);
  return tokens.some((t) => norm.includes(normalizeText(t)));
}

// ─── Rescue provenance ──────────────────────────────────────────────────────

interface RescueLike {
  triggered?: unknown;
  accepted?: unknown;
}

function rescueOf(doc: OcrDocument): RescueLike | undefined {
  return doc.meta?.paddleRescue as RescueLike | undefined;
}

/**
 * Best-effort provenance: rescue-inserted lines are built with a single
 * uniform confidence across all their words (the Paddle reading), while
 * Tesseract lines carry per-word confidences. Combined with an inline
 * label+value shape, this deterministically identifies a rescue line.
 */
function isRescueLine(line: OcrLine, rescue: RescueLike | undefined): boolean {
  if (!rescue || rescue.triggered !== true) return false;
  if (typeof rescue.accepted !== "number" || rescue.accepted <= 0) return false;
  if (line.words.length < 2) return false;
  const confs = new Set(
    line.words
      .map((w) => w.confidence)
      .filter((c): c is number => typeof c === "number")
  );
  return confs.size <= 1;
}

// ─── Spatial alignment ──────────────────────────────────────────────────────

interface AlignmentCandidate {
  label: string;
  labelLine: number;
  labelBBox?: BBox;
  value: string;
  valueLine: number;
  valueBBox?: BBox;
  alignment: AlignmentKind;
}

const TIER: Record<AlignmentKind, number> = {
  inline_label: 30,
  same_line: 20,
  adjacent_below: 10,
};

/**
 * The core spatial engine. For every label line of the field it tries, in
 * order of trust, to attach a value: inline on the same line, side-by-side on
 * the same visual line, then directly below within PADDLE_PAIR_GAP. Candidates
 * are ranked by expected-value match first, then alignment tier, then reading
 * confidence, and the strongest one wins.
 */
function alignField(
  doc: OcrDocument,
  input: GroundedFieldInput,
  tokens: string[]
): AlignmentCandidate | null {
  const candidates: Array<AlignmentCandidate & { score: number }> = [];
  const expected = input.expectedValue !== undefined ? String(input.expectedValue) : undefined;

  for (let i = 0; i < doc.lines.length; i++) {
    const labelLine = doc.lines[i];
    if (!labelLine.bbox || !lineHasLabel(labelLine, tokens)) continue;

    // 1. Inline label+value on one line ("TOTAL 38.40").
    const inline = findNumericToken(labelLine.text);
    if (inline !== null) {
      candidates.push({
        label: labelLine.text,
        labelLine: i,
        labelBBox: labelLine.bbox,
        value: inline,
        valueLine: i,
        valueBBox: labelLine.bbox,
        alignment: "inline_label",
        score: tierScore("inline_label", inline, expected),
      });
    }

    // 2. Side-by-side boxes on the same visual line.
    for (let j = 0; j < doc.lines.length; j++) {
      const other = doc.lines[j];
      if (j === i || !other.bbox) continue;
      if (Math.abs(centerY(labelLine.bbox) - centerY(other.bbox)) > PADDLE_SAME_LINE_TOL) continue;
      const value = findNumericToken(other.text);
      if (value === null) continue;
      candidates.push({
        label: labelLine.text,
        labelLine: i,
        labelBBox: labelLine.bbox,
        value,
        valueLine: j,
        valueBBox: other.bbox,
        alignment: "same_line",
        score: tierScore("same_line", value, expected),
      });
    }

    // 3. Directly below within PADDLE_PAIR_GAP.
    for (let j = 0; j < doc.lines.length; j++) {
      const other = doc.lines[j];
      if (j === i || !other.bbox) continue;
      const gap = other.bbox.y - (labelLine.bbox.y + labelLine.bbox.height);
      if (gap < 0 || gap > PADDLE_PAIR_GAP) continue;
      const value = findNumericToken(other.text);
      if (value === null) continue;
      candidates.push({
        label: labelLine.text,
        labelLine: i,
        labelBBox: labelLine.bbox,
        value,
        valueLine: j,
        valueBBox: other.bbox,
        alignment: "adjacent_below",
        score: tierScore("adjacent_below", value, expected),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.alignment.localeCompare(a.alignment));
  const best = candidates[0];
  if (!best) return null;
  const { score, ...candidate } = best;
  return candidate;
}

function tierScore(tier: AlignmentKind, value: string, expected?: string): number {
  const match = expected !== undefined && valuesMatch(expected, value) ? 100 : 0;
  return match + TIER[tier];
}

// ─── Verdict classification ─────────────────────────────────────────────────

function locateBareValue(
  doc: OcrDocument,
  expected: string
): { value: string; line: number; bbox?: BBox } | null {
  for (let i = 0; i < doc.lines.length; i++) {
    const token = findNumericToken(doc.lines[i].text);
    if (token !== null && valuesMatch(expected, token)) {
      return { value: token, line: i, bbox: doc.lines[i].bbox };
    }
  }
  return null;
}

function classifyField(
  doc: OcrDocument,
  input: GroundedFieldInput,
  tokens: string[],
  rescue: RescueLike | undefined
): GroundedField {
  const expected = input.expectedValue !== undefined ? String(input.expectedValue) : undefined;
  const aligned = alignField(doc, input, tokens);
  const labelLines = doc.lines.filter((l) => l.bbox !== undefined && lineHasLabel(l, tokens)).length;

  if (aligned === null) {
    // No trustworthy spatial attribution.
    if (expected !== undefined) {
      const bare = locateBareValue(doc, expected);
      if (bare !== null) {
        const reason = labelLines > 0 ? "label_value_gap_too_large" : "value_without_label";
        return {
          key: input.key,
          state: "UNCERTAIN",
          value: bare.value,
          reasons: [reason],
        };
      }
    }
    return { key: input.key, state: "MISSING", reasons: [] };
  }

  const confidence = meanWordConfidence(doc.lines[aligned.valueLine], doc);
  const attribution: GroundedAttribution = {
    label: aligned.label,
    labelLine: aligned.labelLine,
    labelBBox: aligned.labelBBox,
    value: aligned.value,
    valueLine: aligned.valueLine,
    valueBBox: aligned.valueBBox,
    alignment: aligned.alignment,
    confidence,
    source: isRescueLine(doc.lines[aligned.valueLine], rescue) ? "paddle_rescue" : "tesseract",
  };

  if (expected !== undefined && !valuesMatch(expected, aligned.value)) {
    return {
      key: input.key,
      state: "UNCERTAIN",
      value: aligned.value,
      attribution,
      reasons: ["value_mismatch_expected"],
    };
  }
  if (confidence < GROUNDED_MIN_CONF) {
    return {
      key: input.key,
      state: "UNCERTAIN",
      value: aligned.value,
      attribution,
      reasons: ["low_confidence"],
    };
  }
  return {
    key: input.key,
    state: "VERIFIED",
    value: aligned.value,
    attribution,
    reasons: [],
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Ground every schema field against the final OCR document (Tesseract + accepted
 * Paddle rescues). Each field gets an explicit state plus its spatial
 * attribution. A field is VERIFIED only when its value is anchored to a printed
 * label by a trustworthy spatial alignment — bare floating numbers, distant
 * labels, mismatched values and low-confidence readings are never VERIFIED.
 */
export function groundDocument(
  doc: OcrDocument,
  fields: GroundedFieldInput[]
): GroundedDocument {
  const rescue = rescueOf(doc);
  const grounded: GroundedField[] = fields.map((input) => {
    const tokens = labelTokensFor(input);
    return classifyField(doc, input, tokens, rescue);
  });
  const counts = { verified: 0, uncertain: 0, missing: 0 };
  for (const f of grounded) {
    counts[f.state.toLowerCase() as keyof typeof counts] += 1;
  }
  return {
    doc,
    fields: grounded,
    summary: { ...counts, total: grounded.length },
  };
}