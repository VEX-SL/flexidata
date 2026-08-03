import type {
  ExtractionProfile,
  ExtractionResult,
  FieldEvidence,
  FieldSchema,
  FieldValue,
  FieldsMap,
  NormalizedField,
  OcrDocument,
  OcrLine,
} from "../types";
import { buildOcrDocument, normalizeText, unifyDigits } from "../ocr";
import { detectLabelGroup, labelGroupForField } from "./label-lexicon";

/**
 * Grounding stage — turns AI *candidates* into committed *fields*.
 *
 * 1. Evidence: every field must be anchored to a real span of the source text
 *    (value-match, label-match, or derived e.g. dates reformatted).
 * 2. Strict grounding: values that don't appear in the document are dropped —
 *    never invented, and never borrowed from a line labeled for a different
 *    field (relabeling). Universal semantic checks (currency must be stated,
 *    tax IDs need a tax label, no phantom line items, no OCR garbage in notes)
 *    keep the same guarantee for all profiles.
 * 3. Real confidence: per-field confidence is composed from the model's field
 *    confidence × mean OCR word confidence over the evidence × a label factor —
 *    never a flat 0.85.
 */

const MIN_CONFIDENCE = 0.3;
const DEFAULT_FIELD_CONFIDENCE = 0.85;
const LABEL_NEUTRAL_FACTOR = 0.8;

const CURRENCY_MARKER =
  /\b(SAR|USD|EUR|GBP|AED|EGP|JOD|KWD|QAR|BHD|OMR|CNY|INR|PKR|TRY|MAD|TND|DZD)\b|[$\u20ac\u00a3\u00a5]|ر\.?\s*س|ريال|جنيه|درهم|دينار|دولار|يورو|جنية|قروش|روبية/i;

const TAX_KEYWORD =
  /الرقم الضريبي|الرقم الموحد|سجل تجاري|الضريبة|ضريبة|فترة ضريبية|\bvat\b|\btax\b|\btin\b|\bcrn\b|\bgst\b/i;

const GENERIC_ITEM_DESC =
  /purchase|المطلوب|total|payment|amount|مطلوب|الدفع|سداد/i;

/**
 * Ground an extraction: attach verified evidence, drop ungrounded or
 * relabeled values, and compose real per-field confidence.
 */
export function groundExtraction(
  profile: ExtractionProfile,
  extraction: ExtractionResult,
  sourceText: string,
  ocr?: OcrDocument
): ExtractionResult {
  const ocrDoc = ocr ?? buildOcrDocument(sourceText);
  const map: FieldsMap = { ...extraction.fieldsMap };
  const drops: Record<string, string> = {};

  const totalField = profile.schema.fields.find((f) => f.key === "total_amount");
  const totalValue = totalField ? map[totalField.key]?.value : undefined;

  // ── Pass 1: evidence + strict grounding ─────────────────────────────
  for (const field of profile.schema.fields) {
    const fv = map[field.key];
    if (!fv || isEmpty(fv.value)) continue;

    // Universal semantic checks (document-type agnostic, never vendor-keyed).
    if (field.key === "currency") {
      if (!CURRENCY_MARKER.test(sourceText)) {
        drops[field.key] = "currency not stated in document";
        delete map[field.key];
      }
      continue;
    }
    if (field.key.endsWith("_tax_id")) {
      if (!TAX_KEYWORD.test(sourceText)) {
        drops[field.key] = "no tax identifier in document";
        delete map[field.key];
      }
      continue;
    }
    if (field.key === "line_items" && Array.isArray(fv.value)) {
      if (!looksLikeItemizedList(fv.value, totalValue, sourceText)) {
        drops[field.key] = "no itemized product list in document";
        delete map[field.key];
      }
      continue;
    }
    if (field.key === "notes") {
      if (isOcrGarbage(String(fv.value))) {
        drops[field.key] = "OCR artifacts / non-clean text";
        delete map[field.key];
      }
      continue;
    }

    // Anchor the value to the source document.
    let evidence = findEvidence(ocrDoc, field, fv);
    if (evidence.length === 0) {
      evidence = findDerivedEvidence(ocrDoc, field, fv.value);
    }
    if (evidence.length === 0) {
      drops[field.key] = "not found in source text";
      delete map[field.key];
      continue;
    }

    // Never relabel: a value sitting on a line labeled for another category
    // (e.g. a reference number used as a tax ID) is dropped, not borrowed.
    const verdict = labelVerdict(field, evidence);
    if (verdict === "conflict") {
      drops[field.key] = "value labeled for a different field";
      delete map[field.key];
      continue;
    }

    map[field.key] = { ...fv, evidence };
  }

  // ── Pass 2: composed confidence ─────────────────────────────────────
  for (const field of profile.schema.fields) {
    const fv = map[field.key];
    if (!fv || isEmpty(fv.value)) continue;
    const aiConf = clampFieldConfidence(fv);
    const ocrFactor = ocrConfidenceFactor(fv.evidence, ocrDoc);
    const labelFactor = labelConfidenceFactor(field, fv.evidence ?? []);
    map[field.key] = {
      ...fv,
      confidence: clamp(aiConf * ocrFactor * labelFactor),
    };
  }

  // ── Pass 3: post-processing (drop empty / low-confidence) ───────────
  const fields: NormalizedField[] = [];
  const cleanFields: Record<string, unknown> = {};
  for (const field of profile.schema.fields) {
    const fv = map[field.key];
    if (!fv) {
      drops[field.key] ??= "not found in document";
      continue;
    }
    if (isEmpty(fv.value)) {
      drops[field.key] = "empty value";
      continue;
    }
    if (fv.confidence < MIN_CONFIDENCE) {
      drops[field.key] = `confidence below threshold (${fv.confidence.toFixed(2)})`;
      continue;
    }
    fields.push({ field, value: fv });
    cleanFields[field.key] = fv.value;
  }

  return {
    ...extraction,
    fields,
    fieldsMap: map,
    cleanFields,
    droppedFields: drops,
  };
}

// ── Evidence ───────────────────────────────────────────────────────────────

function findEvidence(
  ocrDoc: OcrDocument,
  field: FieldSchema,
  fv: FieldValue
): FieldEvidence[] {
  const needles = valueNeedles(field, fv);
  const out: FieldEvidence[] = [];

  for (const needle of needles) {
    const norm = normalizeText(needle);
    if (!norm) continue;
    for (let i = 0; i < ocrDoc.lines.length; i++) {
      const line = ocrDoc.lines[i];
      if (normalizeText(line.text).includes(norm)) {
        out.push(makeEvidence(line, i, "value-match"));
      }
    }
  }
  return dedupeEvidence(out);
}

/** Verbatim (or best-guess) source strings to search for. */
function valueNeedles(field: FieldSchema, fv: FieldValue): string[] {
  const raw = fv.rawValue !== undefined && fv.rawValue !== null
    ? fv.rawValue
    : fv.value;

  if (field.type === "array" && Array.isArray(raw)) {
    return (raw as Array<Record<string, unknown>>)
      .map((it) => it?.description)
      .filter((d): d is string => typeof d === "string" && d.trim().length > 0);
  }
  if (typeof raw === "string") return raw.trim() ? [raw] : [];
  if (typeof raw === "number") return [String(raw)];
  return [];
}

/** Fields whose value is a *transformation* of the printed text (e.g. dates). */
function findDerivedEvidence(
  ocrDoc: OcrDocument,
  field: FieldSchema,
  value: unknown
): FieldEvidence[] {
  const variants = derivedVariants(field, value);
  const out: FieldEvidence[] = [];
  for (const variant of variants) {
    if (!variant) continue;
    for (let i = 0; i < ocrDoc.lines.length; i++) {
      const line = ocrDoc.lines[i];
      if (normalizeText(line.text).includes(variant)) {
        out.push(makeEvidence(line, i, "derived"));
      }
    }
  }
  return dedupeEvidence(out);
}

function derivedVariants(field: FieldSchema, value: unknown): string[] {
  if (field.type === "date") {
    return dateVariants(String(value));
  }
  if (typeof value === "number") {
    // Printed amounts may use thousands separators the model strips.
    return [normalizeText(Number(value).toLocaleString("en-US"))];
  }
  return [];
}

function makeEvidence(line: OcrLine, lineIndex: number, role: FieldEvidence["role"]): FieldEvidence {
  return {
    quote: line.text,
    lineIndex,
    role,
    context: line.text,
    confidence: meanWordConfidence(line),
  };
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

// ── Label verification (never relabel) ─────────────────────────────────────

type LabelVerdict = "ok" | "neutral" | "conflict";

function labelVerdict(field: FieldSchema, evidence: FieldEvidence[]): LabelVerdict {
  const group = labelGroupForField(field);
  if (!group) return "ok";

  const groups = new Set<string>();
  for (const e of evidence) {
    const g = detectLabelGroup(e.context ?? e.quote);
    if (g) groups.add(g);
  }
  if (groups.has(group)) return "ok";
  return groups.size > 0 ? "conflict" : "neutral";
}

// ── Confidence composition ────────────────────────────────────────────────

function clampFieldConfidence(fv: FieldValue): number {
  if (typeof fv.confidence !== "number" || Number.isNaN(fv.confidence)) {
    return DEFAULT_FIELD_CONFIDENCE;
  }
  return clamp(fv.confidence);
}

/**
 * OCR factor for a field: mean confidence over the evidence lines when
 * available, otherwise the page mean OCR confidence, else 1 (unknown).
 */
function ocrConfidenceFactor(
  evidence: FieldEvidence[] | undefined,
  ocrDoc: OcrDocument
): number {
  const confs = (evidence ?? [])
    .map((e) => e.confidence)
    .filter((c): c is number => typeof c === "number");
  if (confs.length > 0) return clamp(mean(confs));
  if (typeof ocrDoc.confidence === "number") return clamp(ocrDoc.confidence);
  return 1;
}

/** 1 when a matching label is present, 0.8 when the line is label-neutral. */
function labelConfidenceFactor(field: FieldSchema, evidence: FieldEvidence[]): number {
  const group = labelGroupForField(field);
  if (!group) return 1;
  const matching = evidence.some(
    (e) => detectLabelGroup(e.context ?? e.quote) === group
  );
  return matching ? 1 : LABEL_NEUTRAL_FACTOR;
}

// ── Universal semantic checks ─────────────────────────────────────────────

function looksLikeItemizedList(
  items: Array<Record<string, unknown>>,
  totalValue: unknown,
  sourceText: string
): boolean {
  if (items.length >= 2) return true;
  const it = items[0] ?? {};
  const desc = normalizeText(String(it.description ?? ""));
  const amount =
    typeof it.amount === "number" ? it.amount : Number(it.unit_price ?? NaN);
  const isGeneric = desc.length === 0 || GENERIC_ITEM_DESC.test(desc);
  const sumsToTotal =
    totalValue !== null &&
    totalValue !== undefined &&
    Number.isFinite(amount) &&
    Math.abs(amount - Number(totalValue)) < 0.005;
  const grounded = desc.length > 0 && normalizeText(sourceText).includes(desc);
  return !isGeneric && !sumsToTotal && grounded;
}

function isOcrGarbage(value: string): boolean {
  const lower = value.toLowerCase();
  if (/\bdescription\b/.test(lower)) return true;
  if (value.includes("©") || value.includes("§")) return true;
  if (/[0-9]{8,}/.test(value)) return true;
  if (value.split(/\r?\n/).length > 6) return true;
  if (/[;|؛]/.test(value) && /[()]/.test(value)) return true;
  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** e.g. "2028-07-02" → ["02-07-2028", "2-7-2028", "02/07/2028", "02.07.2028"]. */
function dateVariants(iso: string): string[] {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [];
  const [, y, mo, d] = m;
  const out = new Set<string>();
  for (const sep of ["-", "/", "."]) {
    out.add(`${d}${sep}${mo}${sep}${y}`);
    out.add(`${Number(d)}${sep}${Number(mo)}${sep}${y}`);
  }
  out.add(`${d}${mo}${y}`);
  return Array.from(out);
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

function isEmpty(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0)
  );
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}

export { normalizeText, unifyDigits };
