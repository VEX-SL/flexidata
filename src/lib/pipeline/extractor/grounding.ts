import type {
  ExtractionProfile,
  ExtractionResult,
  FieldAlternative,
  FieldEvidence,
  FieldSchema,
  FieldValue,
  FieldsMap,
  NormalizedField,
  OcrDocument,
  OcrLine,
  UncertaintyReason,
} from "../types";
import { buildOcrDocument, normalizeText } from "../ocr";
import { detectLabelGroup, labelGroupForField } from "./label-lexicon";
import { verifyEvidence } from "./verify-or-find";
import { isNoiseFragment } from "../text-quality";
import { spanBox } from "../geometry";
import { fieldSchemaForDynamicField } from "./dynamic";

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
/**
 * Penalty applied when a field value has OCR evidence but no matching label
 * group sat on the same line. Kept close to 1 so Arabic / payment-aggregator
 * slips (Fawry, SuperPay, Vodafone Cash, Aman) that print values without an
 * explicit on-line label are not flagged as UNCERTAIN / low-confidence.
 */
const LABEL_NEUTRAL_FACTOR = 0.92;
/** Small penalty when a value is kept despite having no OCR evidence. */
const NO_EVIDENCE_FACTOR = 0.9;
/** Below this OCR factor a field is marked as low-OCR-confidence. */
const LOW_OCR_THRESHOLD = 0.6;

const CURRENCY_MARKER =
  /\b(SAR|USD|EUR|GBP|AED|EGP|JOD|KWD|QAR|BHD|OMR|CNY|INR|PKR|TRY|MAD|TND|DZD)\b|[$\u20ac\u00a3\u00a5]|ر\.?\s*س|ريال|جنيه|درهم|دينار|دولار|يورو|جنية|قروش|روبية/i;

const TAX_KEYWORD =
  /الرقم الضريبي|الرقم الموحد|سجل تجاري|الضريبة|ضريبة|فترة ضريبية|\bvat\b|\btax\b|\btin\b|\bcrn\b|\bgst\b/i;

const GENERIC_ITEM_DESC =
  /purchase|المطلوب|total|payment|amount|مطلوب|الدفع|سداد/i;

/**
 * Generic footer/header markers that are never item descriptions ("TOTAL",
 * "AMOUNT", "المطلوب", ...). Shared with the entity cleaner so both stages
 * apply the same universal, document-type-agnostic non-item test.
 */
export function isGenericItemDescription(desc: string): boolean {
  return desc.length > 0 && GENERIC_ITEM_DESC.test(desc);
}

/**
 * M22 — Universal grounding: deterministic verbatim-existence proof that an
 * AI-supplied evidence quote genuinely appears in the OCR stream.
 *
 * This is the discovery mode's grounding primitive. It is deliberately NOT:
 *  - schema semantics / lexicon / required-field validity checks,
 *  - fuzzy character matching, edit distance, or "close enough" acceptance
 *    ("60 SuperPay eX" must NEVER ground against "$ SuperPay e&"),
 *  - cross-line stitching of fragments into one quote.
 *
 * It proves only that the normalized quote is a contiguous substring of one
 * OCR line (after the same deterministic normalization the whole pipeline
 * uses: bidi stripping, digit unification, Arabic-variant canonicalization,
 * case folding). Every accepted discovery entity must satisfy this (either
 * via its `evidence` quote or via its value).
 */
export interface UniversalGroundingResult {
  grounded: boolean;
  /** First OCR line that contains the quote, when grounded. */
  matchedLine?: number;
  /** Verbatim text of that line, when grounded. */
  quote?: string;
}

export function universalGrounding(
  evidenceText: string,
  rawOcr: string
): UniversalGroundingResult {
  const needle = normalizeText(evidenceText);
  if (!needle) return { grounded: false };

  const lines = rawOcr.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!normalizeText(lines[i]).includes(needle)) continue;
    return { grounded: true, matchedLine: i, quote: lines[i].trim() };
  }
  return { grounded: false };
}

/**
 * Ground an extraction: attach verified evidence, drop ungrounded or
 * relabeled values, and compose real per-field confidence.
 *
 * `evidenceProvider`, when supplied, replaces the raw OCR evidence scan for a
 * field (e.g. the layout-aware path). The default stays the OCR-only search,
 * so the public behavior is unchanged unless a provider is passed.
 */
export function groundExtraction(
  profile: ExtractionProfile,
  extraction: ExtractionResult,
  sourceText: string,
  ocr?: OcrDocument,
  evidenceProvider?: (field: FieldSchema, fv: FieldValue) => readonly FieldEvidence[]
): ExtractionResult {
  const ocrDoc = ocr ?? buildOcrDocument(sourceText);
  const map: FieldsMap = { ...extraction.fieldsMap };
  const drops: Record<string, string> = {};

  const totalField = profile.schema.fields.find((f) => f.key === "total_amount");
  const totalValue = totalField ? map[totalField.key]?.value : undefined;

  // ── Pass 1: evidence + strict grounding ─────────────────────────────
  // Iterate every field in the map: schema fields first (schema order), then
  // any additional discovered fields (dynamic mode) in their insertion order.
  // The universal semantic checks and evidence anchoring apply to all of them —
  // grounding is the authority for both legacy and dynamic extraction.
  for (const { field, dynamic } of enumerateFields(profile, map)) {
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
        continue;
      }
    }
    if (field.key === "line_items" && Array.isArray(fv.value)) {
      if (!looksLikeItemizedList(fv.value, totalValue, sourceText)) {
        drops[field.key] = "no itemized product list in document";
        delete map[field.key];
        continue;
      }
    }
    if (field.key === "notes") {
      if (isNoiseFragment(String(fv.value))) {
        drops[field.key] = "OCR artifacts / non-clean text";
        delete map[field.key];
        continue;
      }
      // A clean note is still anchored to its OCR span below (evidence, label
      // verdict, confidence) like every other field — never `no_direct_evidence`.
    }
    if (field.type === "text" && isNoiseFragment(String(fv.value))) {
      drops[field.key] = "OCR artifacts / non-clean text";
      delete map[field.key];
      continue;
    }

    // Anchor the value to the source document. Dates are commonly printed in
    // more than one format (ISO header, dd-mm-yyyy footer); union both so
    // differing readings surface as honest alternatives. Other types only
    // fall back to derived variants (e.g. amounts with thousands separators)
    // when no verbatim match exists.
    let evidence =
      evidenceProvider !== undefined
        ? [...evidenceProvider(field, fv)]
        : findEvidence(ocrDoc, field, fv);
    // Fallback: when the layout-aware path yields nothing (layout failure or
    // an empty match) the OCR-only search runs unchanged — extraction never
    // loses evidence because layout failed.
    if (evidenceProvider !== undefined && evidence.length === 0) {
      evidence = findEvidence(ocrDoc, field, fv);
    }
    if (field.type === "date") {
      evidence = dedupeEvidence([
        ...evidence,
        ...findDerivedEvidence(ocrDoc, field, fv.value),
      ]);
    } else if (evidence.length === 0) {
      evidence = findDerivedEvidence(ocrDoc, field, fv.value);
    }
    // Verify-or-Find (M12): when no verbatim/derived evidence exists, verify
    // the value against the document in deterministic normalization tiers
    // (separator-free reference numbers, alternative ISO date layouts). This
    // stays strict grounding — no fuzzy matching, nothing invented.
    if (evidence.length === 0) {
      evidence = verifyEvidence(ocrDoc, field, fv);
    }
    if (evidence.length === 0) {
      drops[field.key] = "not found in source text";
      delete map[field.key];
      continue;
    }

    // M22 — evidence-text anchoring for discovery entities: when the AI
    // supplied an evidence quote that universal grounding proves verbatim,
    // those lines become the field's anchor (displayed alongside the value
    // evidence). This runs AFTER the value-existence gate, so a fabricated
    // value can never be smuggled in via a grounded quote — the value must
    // still anchor (see the drop above).
    if (dynamic) {
      const hint = evidenceQuoteOf(fv);
      if (hint && universalGrounding(hint, ocrDoc.text).grounded) {
        const quoteEvidence = findQuoteEvidence(ocrDoc, hint);
        if (quoteEvidence.length > 0) {
          evidence = dedupeEvidence([...quoteEvidence, ...evidence]);
        }
      }
    }

    // Line items are evidence in their own right: each item's description is
    // anchored to the OCR line it came from, so the whole matching set is the
    // field's evidence. There is no single value being borrowed from a labeled
    // line (the relabel veto does not apply — the descriptions ARE the line
    // content) and no single "primary reading" to rank, so the evidence is
    // kept as-is instead of being split into a primary plus alternatives.
    if (field.key === "line_items") {
      map[field.key] = { ...fv, evidence: dedupeEvidence(evidence) };
      continue;
    }

    // Never relabel: a value sitting on a line labeled for another category
    // (e.g. a reference number used as a tax ID) is dropped, not borrowed.
    // This veto guards SCHEMA fields — it is derived from the field-key →
    // label-category heuristic, which is meaningless for arbitrary AI-discovered
    // labels. For dynamic fields the AI declared the field, its label and its
    // evidence together, and the value still must anchor verbatim above; the
    // lexicon heuristic must not veto that (e.g. "Reference Date" hits the
    // "reference" number word).
    let verdict: LabelVerdict = "ok";
    if (!dynamic) {
      verdict = labelVerdict(field, evidence);
    }
    if (verdict === "conflict") {
      drops[field.key] = "value labeled for a different field";
      delete map[field.key];
      continue;
    }

    // Choose the strongest span as primary; record differing spans as
    // alternatives so downstream stages can flag near-duplicates honestly.
    const chosen = choosePrimaryEvidence(field, fv, evidence);
    map[field.key] = {
      ...fv,
      evidence: [chosen.primary, ...chosen.others],
      alternatives: chosen.alternatives.length > 0 ? chosen.alternatives : fv.alternatives,
      chosenReason: chosen.chosenReason ?? fv.chosenReason,
    };
  }

  // ── Pass 2: composed confidence ─────────────────────────────────────
  for (const { field } of enumerateFields(profile, map)) {
    const fv = map[field.key];
    if (!fv || isEmpty(fv.value)) continue;
    const aiConf = clampFieldConfidence(fv);
    const ocrFactor = ocrConfidenceFactor(fv.evidence, ocrDoc);
    const labelFactor = labelConfidenceFactor(field, fv.evidence ?? []);
    const hasEvidence = (fv.evidence?.length ?? 0) > 0;
    const reasons = uncertaintyReasons(ocrFactor, labelFactor, hasEvidence);
    map[field.key] = {
      ...fv,
      confidence: clamp(aiConf * ocrFactor * labelFactor * (hasEvidence ? 1 : NO_EVIDENCE_FACTOR)),
      reasons,
    };
  }

  // ── Pass 3: post-processing (drop empty / low-confidence) ───────────
  const fields: NormalizedField[] = [];
  const cleanFields: Record<string, unknown> = {};
  for (const { field } of enumerateFields(profile, map)) {
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

/**
 * Enumerate every field in the extraction map: profile schema fields in schema
 * order first, then any additional discovered keys (dynamic mode) in their
 * insertion order. Dynamic keys get a per-field schema synthesized from the
 * value's own metadata (type/label) — a compatibility adapter, never a field
 * registry. In legacy mode the map only holds schema keys, so this is a no-op
 * over the original behavior.
 */
function enumerateFields(
  profile: ExtractionProfile,
  map: FieldsMap
): Array<{ field: FieldSchema; dynamic: boolean }> {
  const schemaKeys = new Set(profile.schema.fields.map((f) => f.key));
  const out: Array<{ field: FieldSchema; dynamic: boolean }> =
    profile.schema.fields.map((field) => ({ field, dynamic: false }));
  for (const key of Object.keys(map)) {
    if (schemaKeys.has(key)) continue;
    out.push({ field: fieldSchemaForDynamicField(key, map[key]), dynamic: true });
  }
  return out;
}

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
      if (isNumericField(field)) {
        // Numeric fields anchor on value equality, never raw substring:
        // "$100" must not ground against a printed "$1000" (no invented
        // amounts), while "38.4" ↔ "38.40" and "1234.5" ↔ "1,234.50" match.
        const span = findNumericSpan(line, norm);
        if (span) out.push(makeEvidence(line, i, "value-match", norm, span));
      } else if (normalizeText(line.text).includes(norm)) {
        out.push(makeEvidence(line, i, "value-match", norm));
      }
    }
  }
  return dedupeEvidence(out);
}

/**
 * Verbatim (or best-guess) source strings to search for. An array field (e.g.
 * line items) anchors on its ITEM descriptions — each item is its own OCR line
 * — never on the model's concatenated `rawValue`, which is not a single span.
 */
export function valueNeedles(field: FieldSchema, fv: FieldValue): string[] {
  if (field.type === "array" && Array.isArray(fv.value)) {
    return (fv.value as Array<Record<string, unknown>>)
      .map((it) => it?.description)
      .filter((d): d is string => typeof d === "string" && d.trim().length > 0);
  }

  const raw = fv.rawValue !== undefined && fv.rawValue !== null
    ? fv.rawValue
    : fv.value;
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
      if (isNumericField(field)) {
        const span = findNumericSpan(line, variant);
        if (span) out.push(makeEvidence(line, i, "derived", variant, span));
      } else if (normalizeText(line.text).includes(variant)) {
        out.push(makeEvidence(line, i, "derived", variant));
      }
    }
  }
  return dedupeEvidence(out);
}

export function derivedVariants(field: FieldSchema, value: unknown): string[] {
  if (field.type === "date") {
    return dateVariants(String(value));
  }
  if (typeof value === "number") {
    // Printed amounts may use thousands separators the model strips.
    return [normalizeText(Number(value).toLocaleString("en-US"))];
  }
  return [];
}

/** AI-supplied evidence quote carried on the value's meta (grounding hint). */
function evidenceQuoteOf(fv: FieldValue): string | undefined {
  const meta = fv.meta as { evidenceQuote?: unknown } | undefined;
  return typeof meta?.evidenceQuote === "string" &&
    meta.evidenceQuote.trim().length > 0
    ? meta.evidenceQuote
    : undefined;
}

/**
 * Anchor a verbatim evidence quote to the OCR line(s) containing it. Used to
 * turn a universally-grounded AI quote into a real FieldEvidence anchor.
 */
function findQuoteEvidence(ocrDoc: OcrDocument, hint: string): FieldEvidence[] {
  const norm = normalizeText(hint);
  if (!norm) return [];
  const out: FieldEvidence[] = [];
  for (let i = 0; i < ocrDoc.lines.length; i++) {
    const line = ocrDoc.lines[i];
    if (!normalizeText(line.text).includes(norm)) continue;
    out.push(makeEvidence(line, i, "value-match", norm));
  }
  return dedupeEvidence(out);
}

/**
 * Build evidence for a matching line. When the line carries per-word boxes,
 * the exact word span is located so downstream consumers get wordIndices and a
 * bounding box; otherwise the whole line is used (text-only fallback).
 */
function makeEvidence(
  line: OcrLine,
  lineIndex: number,
  role: FieldEvidence["role"],
  normNeedle?: string,
  explicitSpan?: { start: number; end: number }
): FieldEvidence {
  const span = explicitSpan ?? findWordSpan(line, normNeedle);
  if (span) {
    const { start, end } = span;
    const wordConfs = line.words
      .slice(start, end + 1)
      .map((w) => w.confidence)
      .filter((c): c is number => typeof c === "number");
    return {
      quote: line.words.slice(start, end + 1).map((w) => w.text).join(" "),
      lineIndex,
      wordIndices: range(start, end + 1),
      bbox: spanBox(line, start, end),
      role,
      source: "ocr",
      confidence: wordConfs.length > 0 ? mean(wordConfs) : meanWordConfidence(line),
      context: line.text,
    };
  }
  // Fallback region: when the matched line carries real coordinates (a line
  // bbox) but no recognizable word boxes / no word-span match, copy the whole
  // line box onto the evidence so the UI Inspector can still draw an overlay.
  return {
    quote: line.text,
    lineIndex,
    role,
    source: "ocr",
    confidence: meanWordConfidence(line),
    ...(line.bbox !== undefined ? { bbox: line.bbox } : {}),
    context: line.text,
  };
}

/** Minimal contiguous word span whose joined text contains the needle. */
function findWordSpan(
  line: OcrLine,
  normNeedle?: string
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

/** Fields whose printed form is a normalized variant of the model value. */
function isNumericField(field: FieldSchema): boolean {
  return field.type === "number" || field.type === "currency";
}

/**
 * Locate the minimal contiguous word span whose text is numerically equal to
 * the needle. Printed separators are ignored ("1,234.50" = "1234.5") and the
 * magnitude must match exactly — a shorter reference never anchors to a longer
 * printed number, so "$100" can never be grounded on "$1000".
 */
function findNumericSpan(
  line: OcrLine,
  normNeedle: string
): { start: number; end: number } | null {
  const words = line.words;
  if (words.length === 0 || !normNeedle) return null;

  const target = numericKey(normNeedle);
  if (target === null) return null;
  const targetMag = target.magnitude;

  const normWords = words.map((w) => normalizeText(w.text));
  let best: { start: number; end: number } | null = null;
  for (let start = 0; start < normWords.length; start++) {
    let acc = "";
    for (let end = start; end < normWords.length; end++) {
      acc = acc ? `${acc} ${normWords[end]}` : normWords[end];
      const key = numericKey(acc);
      if (key === null) continue;
      if (key.magnitude === targetMag && key.value === target.value) {
        if (!best || end - start < best.end - best.start) best = { start, end };
        break;
      }
      if (key.magnitude > targetMag) break;
    }
  }
  return best;
}

/**
 * Canonical numeric key: the parsed value plus its magnitude (integer part of
 * the absolute value), so "38.40", "38.4", "$38.40" and "1,234.50" compare by
 * numeric value regardless of printed separators or trailing zeros, while
 * "$100" and "$1000" stay distinct. `null` when the text is not a plain
 * number.
 */
function numericKey(text: string): { magnitude: number; value: number } | null {
  const stripped = text.replace(/[^0-9.\-]/g, "");
  if (!stripped || stripped === "-" || stripped === "." || stripped === "-.") return null;
  const value = Number(stripped);
  if (!Number.isFinite(value)) return null;
  return { magnitude: Math.floor(Math.abs(value)), value };
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

/**
 * Pick the strongest span as the primary evidence and expose the others:
 * differing readings become `alternatives` (ocr_near_duplicate), identical
 * ones are kept as supporting evidence. Never invents a value — everything
 * comes from real OCR spans.
 */
function choosePrimaryEvidence(
  field: FieldSchema,
  fv: FieldValue,
  evidence: FieldEvidence[]
): {
  primary: FieldEvidence;
  others: FieldEvidence[];
  alternatives: FieldAlternative[];
  chosenReason?: string;
} {
  const group = labelGroupForField(field);
  const scored = [...evidence].map((e) => ({
    e,
    score:
      (group && detectLabelGroup(e.context ?? e.quote) === group ? 1 : 0) * 10 +
      (typeof e.confidence === "number" ? e.confidence : 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  const primary = scored[0].e;
  const others = scored.slice(1).map((s) => s.e);

  const primaryNorm = normalizeText(primary.quote ?? primary.context ?? "");
  const seenReadings = new Set<string>();
  const alternatives: FieldAlternative[] = [];
  for (const e of others) {
    const reading = normalizeText(e.quote ?? e.context ?? "");
    if (!reading || reading === primaryNorm || seenReadings.has(reading)) continue;
    seenReadings.add(reading);
    alternatives.push({
      value: reading,
      raw: reading,
      reason: "ocr_near_duplicate",
      confidence: e.confidence,
    });
  }

  let chosenReason: string | undefined;
  const labelMatched = group && detectLabelGroup(primary.context ?? primary.quote) === group;
  if (alternatives.length > 0) {
    chosenReason = labelMatched
      ? "chosen the highest-confidence span on a matching field label; other readings in the document were not used"
      : "chosen the highest-confidence OCR span; the document also contains differing readings";
  } else if (others.length > 0) {
    chosenReason = `the same reading appears on ${evidence.length} lines`;
  }

  return { primary, others, alternatives, chosenReason };
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

/** Reasons a composed confidence is below certainty, for review + agent UX. */
function uncertaintyReasons(
  ocrFactor: number,
  labelFactor: number,
  hasEvidence: boolean
): UncertaintyReason[] {
  const reasons: UncertaintyReason[] = [];
  if (!hasEvidence) reasons.push("no_direct_evidence");
  if (ocrFactor < LOW_OCR_THRESHOLD) reasons.push("ocr_confidence_low");
  if (labelFactor < 1) reasons.push("label_not_matched");
  return reasons;
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

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
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

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}
