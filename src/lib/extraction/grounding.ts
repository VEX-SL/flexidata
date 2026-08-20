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
  OcrWord,
} from "@/lib/pipeline/types";
import { normalizeText } from "@/lib/pipeline/ocr";
import { normalizeArabicNumerals } from "@/lib/ocr/arabic-numerals";
import {
  LABEL_GROUPS,
  labelGroupForField,
} from "@/lib/pipeline/extractor/label-lexicon";
import {
  PADDLE_PAIR_GAP,
} from "@/lib/ocr/paddle-rescue";
import { canonicalNumeric } from "@/lib/ocr/numeric-verify";

// ─── Calibrated contract (shared with the rescue layer) ────────────────────

/** Below this reading confidence an aligned field is never VERIFIED. */
export const GROUNDED_MIN_CONF = 0.6;

/**
 * Vertical tolerance for the side-by-side tier. Arabic labels and Latin
 * numerals on the same printed line often have visibly different x-heights,
 * so their boxes' vertical centers can drift further apart than a pure
 * same-font comparison would allow; this constant is intentionally wider than
 * the strict OCR same-line tolerance.
 */
export const GROUNDED_SAME_LINE_TOL = 24;

/**
 * Table-column alignment contract. A value sits in a table column when its
 * box shares significant horizontal (x-axis) overlap with the column header's
 * word box and lies directly beneath it. The gap tolerance is wider than the
 * side-by-side PADDLE_PAIR_GAP because table cells can be several rows below
 * their header; the x-overlap requirement is what keeps a distant value in
 * the same column from being attributed to a neighboring header.
 */
export const COLUMN_X_OVERLAP_MIN = 0.35;
export const COLUMN_PAIR_MAX_GAP = 120;

// ─── Public types ───────────────────────────────────────────────────────────

export type GroundedState = "VERIFIED" | "UNCERTAIN" | "MISSING";

/** Where the grounded line came from in the OCR stack. */
export type GroundedSource = "tesseract" | "paddle_rescue";

/** How the label and its value are spatially related. */
export type AlignmentKind =
  | "inline_label"
  | "same_line"
  | "column_below"
  | "adjacent_below";

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
  /**
   * Expected digit count of the value. When absent, it is derived from a pure
   * digit expectedValue of 8+ digits (fixed-width identifiers on receipts).
   */
  expectedLength?: number;
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
  summary: {
    verified: number;
    uncertain: number;
    missing: number;
    total: number;
    /**
     * Share of schema fields whose printed label tokens appear somewhere in
     * the document (0..1). This is the structural-overlap signal used by the
     * transformer's schema-fit gate: a document that contains none of the
     * requested schema's labels is likely the wrong document type, and
     * confidence must be penalized accordingly.
     */
    labelCoverage: number;
  };
}

// ─── Small deterministic helpers ────────────────────────────────────────────

function digitsOf(text: string): number {
  let n = 0;
  for (const c of text) if (c >= "0" && c <= "9") n += 1;
  return n;
}

/**
 * Strip stray non-numeric envelope characters from a token's edges — "]", ")",
 * "(", ":" and similar debris that thermal/bidi OCR glues to identifiers
 * ("607021830113216]", "(0123456788)"). Interior characters are untouched so a
 * genuinely corrupted token stays recognizable as invalid.
 */
function cleanNumericToken(token: string): string {
  return token.replace(/^[^0-9.,\-]+|[^0-9.,\-]+$/g, "");
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
  return best !== null ? cleanNumericToken(best) : null;
}

/**
 * Word-level numeric reading for the table-column tier. Unlike the
 * line-level `findNumericToken` (which needs 2+ digits so "Sugar 1kg" never
 * reads as a value), a table cell may legitimately be a single digit (الكمية
 * = "2"); the numeric-ratio guard keeps glued letter+digit tokens ("1kg",
 * "رقم2013") out, and the caller's x-overlap requirement keeps the reading in
 * its own column.
 */
function numericWordCandidates(line: OcrLine): Array<{ text: string; bbox: BBox }> {
  const out: Array<{ text: string; bbox: BBox }> = [];
  for (const w of line.words) {
    if (!w.bbox) continue;
    const t = normalizeArabicNumerals(w.text);
    if (!t) continue;
    let digits = 0;
    let numericish = 0;
    for (const c of t) {
      if (c >= "0" && c <= "9") {
        digits += 1;
        numericish += 1;
      } else if (/[.,:/-]/.test(c)) {
        numericish += 1;
      }
    }
    if (digits === 0) continue;
    if (numericish / t.length < 0.6) continue;
    const text = cleanNumericToken(t);
    if (!text) continue;
    out.push({ text, bbox: w.bbox });
  }
  return out;
}

/**
 * Word boxes inside a label line that actually carry the label token. A table
 * header line often prints several column headers ("الصنف الكمية السعر
 * الإجمالي") on ONE OCR line, so the column anchor must be the header WORD's
 * box — never the whole line box (which spans every column).
 */
function labelWordAnchors(line: OcrLine, tokens: string[]): BBox[] {
  const anchors: BBox[] = [];
  for (const w of line.words) {
    if (!w.bbox) continue;
    const norm = normalizeText(w.text);
    if (tokens.some((t) => norm.includes(normalizeText(t)))) {
      anchors.push(w.bbox);
    }
  }
  return anchors;
}

/** Share of [a.x, a.x+a.width] ∩ [b.x, b.x+b.width] over the narrower box. */
function xOverlapRatio(a: BBox, b: BBox): number {
  const overlap = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  );
  if (overlap <= 0) return 0;
  return overlap / Math.max(1, Math.min(a.width, b.width));
}

/**
 * The expected digit count for the field: the explicit expectedLength, or —
 * when the expected value is a pure digit string of 8+ digits — its length
 * (thermal receipts print identifiers like transaction/reference numbers with
 * a fixed width, so a token with a different digit count can never be that
 * value; this is the guard that keeps a 5-digit hotline number from being
 * misattributed to a 16-digit transaction field).
 */
export function expectedLengthOf(input: GroundedFieldInput): number | undefined {
  if (
    typeof input.expectedLength === "number" &&
    Number.isInteger(input.expectedLength) &&
    input.expectedLength > 0
  ) {
    return input.expectedLength;
  }
  if (input.expectedValue !== undefined) {
    const exp = String(input.expectedValue);
    if (/^[0-9]+$/.test(exp) && exp.length >= 8) return exp.length;
  }
  return undefined;
}

function centerY(b: BBox): number {
  return b.y + b.height / 2;
}

/**
 * Do two boxes sit on the same visual line? Tolerant of mixed Arabic/Latin
 * x-heights: boxes whose centers fall within GROUNDED_SAME_LINE_TOL count, and
 * boxes whose vertical spans overlap by at least half the shorter box's height
 * also count (a short Arabic label drawn at the top of a tall digit box).
 */
function sameVisualLine(a: BBox, b: BBox): boolean {
  if (Math.abs(centerY(a) - centerY(b)) <= GROUNDED_SAME_LINE_TOL) return true;
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const overlap = Math.max(0, bottom - top);
  return overlap >= 0.5 * Math.min(a.height, b.height);
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
  column_below: 15,
  adjacent_below: 10,
};

/**
 * The core spatial engine. For every label line of the field it tries, in
 * order of trust, to attach a value: inline on the same line, side-by-side on
 * the same visual line, directly below within the same column (table
 * headers), then directly below within PADDLE_PAIR_GAP. Candidates are ranked
 * by expected-value match first, then alignment tier, then reading confidence,
 * and the strongest one wins.
 */
function alignField(
  doc: OcrDocument,
  input: GroundedFieldInput,
  tokens: string[]
): AlignmentCandidate | null {
  const candidates: Array<AlignmentCandidate & { score: number }> = [];
  const expected = input.expectedValue !== undefined ? String(input.expectedValue) : undefined;
  const expectedLen = expectedLengthOf(input);

  const lengthValid = (token: string): boolean =>
    expectedLen === undefined || digitsOf(token) === expectedLen;

  for (let i = 0; i < doc.lines.length; i++) {
    const labelLine = doc.lines[i];
    if (!labelLine.bbox || !lineHasLabel(labelLine, tokens)) continue;

    // 1. Inline label+value on one line ("TOTAL 38.40").
    const inline = findNumericToken(labelLine.text);
    if (inline !== null && lengthValid(inline)) {
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
      if (!sameVisualLine(labelLine.bbox, other.bbox)) continue;
      const value = findNumericToken(other.text);
      if (value === null || !lengthValid(value)) continue;
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

    // 3. Table columns: a value word below the header whose box overlaps the
    //    header WORD's box on the x-axis (الكمية column → quantity cells).
    //    Word-level, so a multi-column row ("قمح 2 25.00 50.00") attributes
    //    each cell to its own header instead of grabbing the row's most
    //    digit-dense token.
    const anchors = labelWordAnchors(labelLine, tokens);
    if (anchors.length > 0) {
      for (let j = 0; j < doc.lines.length; j++) {
        const other = doc.lines[j];
        if (j === i || !other.bbox) continue;
        const gap = other.bbox.y - (labelLine.bbox.y + labelLine.bbox.height);
        if (gap < 0 || gap > COLUMN_PAIR_MAX_GAP) continue;
        for (const cell of numericWordCandidates(other)) {
          if (!lengthValid(cell.text)) continue;
          if (!anchors.some((a) => xOverlapRatio(a, cell.bbox) >= COLUMN_X_OVERLAP_MIN)) {
            continue;
          }
          candidates.push({
            label: labelLine.text,
            labelLine: i,
            labelBBox: labelLine.bbox,
            value: cell.text,
            valueLine: j,
            valueBBox: cell.bbox,
            alignment: "column_below",
            score: tierScore("column_below", cell.text, expected),
          });
        }
      }
    }

    // 4. Directly below within PADDLE_PAIR_GAP.
    for (let j = 0; j < doc.lines.length; j++) {
      const other = doc.lines[j];
      if (j === i || !other.bbox) continue;
      const gap = other.bbox.y - (labelLine.bbox.y + labelLine.bbox.height);
      if (gap < 0 || gap > PADDLE_PAIR_GAP) continue;
      const value = findNumericToken(other.text);
      if (value === null || !lengthValid(value)) continue;
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
  return {
    label: best.label,
    labelLine: best.labelLine,
    labelBBox: best.labelBBox,
    value: best.value,
    valueLine: best.valueLine,
    valueBBox: best.valueBBox,
    alignment: best.alignment,
  };
}

function tierScore(tier: AlignmentKind, value: string, expected?: string): number {
  const match = expected !== undefined && valuesMatch(expected, value) ? 100 : 0;
  return match + TIER[tier];
}

// ─── Verdict classification ─────────────────────────────────────────────────

function locateBareValue(
  doc: OcrDocument,
  expected: string,
  expectedLen?: number
): { value: string; line: number; bbox?: BBox } | null {
  for (let i = 0; i < doc.lines.length; i++) {
    const token = findNumericToken(doc.lines[i].text);
    if (
      token !== null &&
      (expectedLen === undefined || digitsOf(token) === expectedLen) &&
      valuesMatch(expected, token)
    ) {
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
  const expectedLen = expectedLengthOf(input);

  if (aligned === null) {
    // No trustworthy spatial attribution.
    if (expected !== undefined) {
      const bare = locateBareValue(doc, expected, expectedLen);
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
    if (labelLines > 0 && expectedLen !== undefined) {
      return { key: input.key, state: "MISSING", reasons: ["no_valid_length_value"] };
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
 * Normalize every numeral in a document to ASCII digits (Eastern Arabic and
 * Persian families → 0-9) while preserving all spatial coordinates. Applied at
 * the grounding boundary so grounding, verification and lexicon logic always
 * operate on a standardized surface, regardless of which OCR stack produced
 * the document (Tesseract, Paddle rescue insertions, or text-only input).
 */
export function normalizeDocumentNumerals(doc: OcrDocument): OcrDocument {
  const lines: OcrLine[] = doc.lines.map((line) => {
    let words: OcrWord[] = line.words;
    let changed = false;
    if (line.words.some((w) => w.text !== normalizeArabicNumerals(w.text))) {
      words = line.words.map((w) => {
        const text = normalizeArabicNumerals(w.text);
        return text === w.text ? w : { ...w, text };
      });
      changed = true;
    }
    if (!changed) return line;
    const text = words.map((w) => w.text).join(" ");
    return { ...line, words, text, originalText: line.originalText ?? line.text };
  });
  return { ...doc, lines, text: lines.map((l) => l.text).join("\n") };
}

/**
 * Share of schema fields whose label tokens appear in the document — the
 * structural-overlap signal behind the transformer's schema-fit gate. Fields
 * whose label group/words cannot be found at all count as uncovered.
 */
export function fieldLabelCoverage(
  doc: OcrDocument,
  fields: GroundedFieldInput[]
): number {
  if (fields.length === 0) return 1;
  let covered = 0;
  for (const input of fields) {
    const tokens = labelTokensFor(input);
    if (tokens.length > 0 && doc.lines.some((l) => lineHasLabel(l, tokens))) {
      covered += 1;
    }
  }
  return covered / fields.length;
}

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
  const normalized = normalizeDocumentNumerals(doc);
  const rescue = rescueOf(normalized);
  const grounded: GroundedField[] = fields.map((input) => {
    const tokens = labelTokensFor(input);
    return classifyField(normalized, input, tokens, rescue);
  });
  const counts = { verified: 0, uncertain: 0, missing: 0 };
  for (const f of grounded) {
    counts[f.state.toLowerCase() as keyof typeof counts] += 1;
  }
  return {
    doc: normalized,
    fields: grounded,
    summary: {
      ...counts,
      total: grounded.length,
      labelCoverage: fieldLabelCoverage(normalized, fields),
    },
  };
}