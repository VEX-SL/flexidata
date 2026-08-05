import type {
  CleaningStageStats,
  ExtractionProfile,
  ExtractionResult,
  FieldSchema,
  FieldValue,
  FieldsMap,
  NormalizedField,
  OcrDocument,
  UncertaintyReason,
} from "./types";
import { buildOcrDocument, normalizeText } from "./ocr";
import { coerce } from "./extractor/normalizer";
import { groundExtraction, isGenericItemDescription } from "./extractor/grounding";
import { detectLabelGroup, labelGroupForField } from "./extractor/label-lexicon";
import { isNoiseFragment } from "./text-quality";

/**
 * Entity Cleaner — metadata-driven normalization of grounded values.
 *
 * Grounding guarantees every value comes from OCR evidence, but the evidence
 * is often noisy: merchant names carrying surrounding separators or detached
 * digit artifacts, duplicated punctuation, invisible Unicode characters,
 * broken/collapsed spacing, non-canonical Unicode forms, and free-text
 * (notes) that survives only because it is a line-merge of real + garbage
 * lines. This stage improves the committed output WITHOUT inventing anything
 * and WITHOUT weakening the grounding gate:
 *
 *  - metadata-driven : decisions use the profile schema + field type + label
 *                      category only. No field key beyond its semantic
 *                      category, no document type, vendor, or sample-specific
 *                      pattern is consulted;
 *  - surgical ops     : invisible-character removal, Unicode-form
 *                      normalization (NFKC), whitespace collapse, duplicated
 *                      punctuation collapse, edge-separator trimming, and —
 *                      for name-like fields only — trimming detached pure-digit
 *                      edge tokens (line/reference numbers merged onto a brand
 *                      line). Nothing is removed from the middle of real
 *                      content;
 *  - free-text gate    : notes / text values must pass generic text-quality
 *                      checks AND be grounded to a single OCR line. A value
 *                      that fails either is dropped instead of surviving as
 *                      OCR garbage;
 *  - line-item gate    : line items whose description is a noise fragment, a
 *                      generic footer marker, has no letters, or is not
 *                      grounded to a single OCR line are suppressed. If every
 *                      item is suppressed the field is dropped;
 *  - provable better   : a text cleaning is committed only when the result
 *                      differs, stays non-empty, preserves every letter/digit
 *                      (content subset), preserves character order
 *                      (subsequence), and preserves bracket balance. Otherwise
 *                      the original value is kept untouched;
 *  - grounding safety  : every cleaned text value is re-grounded against the
 *                      OCR evidence through the SAME strict grounding engine.
 *                      If it cannot still be grounded, the cleaned version is
 *                      discarded — a grounded value is never replaced by an
 *                      ungrounded one. A lossless fallback presence check
 *                      (NFKC + invisible-character-insensitive substring on a
 *                      single OCR line, with the same relabel guard) covers
 *                      normalization-only changes such as full-width→half-width.
 *
 * On success the field keeps its evidence, bbox, word indices and confidence;
 * `chosenReason` becomes "entity_cleaned" and `reasons` gains "entity_cleaned".
 * Fields removed as OCR garbage are recorded in `droppedFields` and in the
 * returned stats.
 */

export function cleanExtraction(
  profile: ExtractionProfile,
  extraction: ExtractionResult,
  sourceText: string,
  ocr?: OcrDocument
): { extraction: ExtractionResult; stats: CleaningStageStats } {
  const ocrDoc = ocr ?? buildOcrDocument(sourceText);
  let map: FieldsMap = { ...extraction.fieldsMap };
  let clean = { ...extraction.cleanFields };
  const drops = { ...extraction.droppedFields };
  let fields = [...extraction.fields];
  const cleanedKeys: string[] = [];
  const droppedKeys: string[] = [];
  let unchanged = 0;

  for (const field of profile.schema.fields) {
    const fv = map[field.key];
    if (!fv) continue;

    // Free text (notes / text fields) must be non-garbage AND grounded to a
    // single OCR line; otherwise it is a line-merge artifact or invention.
    if (isFreeTextField(field)) {
      const text = valueText(fv);
      if (text !== null) {
        const verdict = freeTextVerdict(field, text, ocrDoc);
        if (verdict) {
          map = withoutKey(map, field.key);
          clean = withoutKey(clean, field.key);
          drops[field.key] = verdict;
          fields = fields.filter((nf) => nf.field.key !== field.key);
          droppedKeys.push(field.key);
          continue;
        }
      }
    }

    // Line items: suppress fragments / footer text / ungrounded descriptions.
    if (field.key === "line_items" && Array.isArray(fv.value)) {
      const kept = cleanLineItems(field, fv.value, ocrDoc);
      if (kept === null) continue; // nothing changed
      if (kept.length === 0) {
        map = withoutKey(map, field.key);
        clean = withoutKey(clean, field.key);
        drops[field.key] = "no line item grounded to a real OCR line";
        fields = fields.filter((nf) => nf.field.key !== field.key);
        droppedKeys.push(field.key);
        continue;
      }
      const next: FieldValue = {
        ...fv,
        value: kept,
        chosenReason: "entity_cleaned",
        reasons: appendReason(fv.reasons, "entity_cleaned"),
      };
      map[field.key] = next;
      clean[field.key] = kept;
      fields = upsertField(fields, field, next);
      cleanedKeys.push(field.key);
      continue;
    }

    if (!isCleanable(field)) continue;

    const original = valueText(fv);
    if (original === null) continue;

    const cleaned = cleanText(original, { nameField: isNameField(field) });
    if (cleaned === null) {
      unchanged += 1;
      continue;
    }
    if (!canGround(profile, field, cleaned, sourceText, ocrDoc)) {
      unchanged += 1;
      continue;
    }

    const next: FieldValue = {
      ...fv,
      value: cleaned,
      chosenReason: "entity_cleaned",
      reasons: appendReason(fv.reasons, "entity_cleaned"),
    };
    map[field.key] = next;
    clean[field.key] = cleaned;
    fields = upsertField(fields, field, next);
    cleanedKeys.push(field.key);
  }

  return {
    extraction: {
      ...extraction,
      fields,
      fieldsMap: map,
      cleanFields: clean,
      droppedFields: drops,
    },
    stats: { cleaned: cleanedKeys, unchanged, dropped: droppedKeys },
  };
}

// ─── Metadata-driven eligibility ───────────────────────────────────────────

/**
 * Only free-text entities are cleaned. Structured types (number, currency,
 * date, boolean, enum, array, object) are already coerced to canonical values
 * and have no printable-noise surface to clean.
 */
function isCleanable(field: FieldSchema): boolean {
  return field.type === "string" || field.type === "text";
}

/** Free-text fields where the value itself must be non-garbage + grounded. */
function isFreeTextField(field: FieldSchema): boolean {
  return field.type === "text" || field.key === "notes";
}

/**
 * Name-like identity fields (merchant, buyer, any *_name): these frequently
 * carry detached digit artifacts (line/reference numbers merged onto the brand
 * line by OCR), so detached pure-digit edge tokens are trimmed.
 */
function isNameField(field: FieldSchema): boolean {
  const group = labelGroupForField(field);
  return (
    field.type === "string" &&
    (group === "merchant" ||
      group === "buyer" ||
      field.key === "name" ||
      field.key.endsWith("_name"))
  );
}

/** The committed string we would normalize (value first, raw as fallback). */
function valueText(fv: FieldValue): string | null {
  if (typeof fv.value === "string" && fv.value.trim().length > 0) return fv.value;
  if (typeof fv.rawValue === "string" && fv.rawValue.trim().length > 0) {
    return fv.rawValue;
  }
  return null;
}

// ─── Free-text gate (notes / text) ─────────────────────────────────────────

/**
 * Verdict on a free-text value: a drop reason when it must not survive, null
 * when it is acceptable. Garbage is rejected by generic text quality; a clean
 * value must still be grounded to a single OCR line (contiguous span), which
 * rejects line-merge artifacts and inventions.
 */
function freeTextVerdict(
  field: FieldSchema,
  text: string,
  ocrDoc: OcrDocument
): string | null {
  if (isNoiseFragment(text)) return "OCR artifacts / non-clean text";
  if (!appearsInOcr(field, text, ocrDoc)) {
    return "not grounded to a single OCR line";
  }
  return null;
}

// ─── Line-item gate ────────────────────────────────────────────────────────

/**
 * Suppress line items that are obvious OCR fragments or footer text. An item
 * survives only when its description contains letters, is not generic footer
 * noise, is not a text-quality garbage fragment, and is grounded to a single
 * OCR line. Returns null when nothing changed, otherwise the kept items.
 */
function cleanLineItems(
  field: FieldSchema,
  items: unknown[],
  ocrDoc: OcrDocument
): unknown[] | null {
  let removed = false;
  const kept: unknown[] = [];
  for (const item of items) {
    if (!isPlainRecord(item)) {
      removed = true;
      continue;
    }
    const desc = item.description;
    if (typeof desc !== "string" || desc.trim().length === 0) {
      removed = true;
      continue;
    }
    if (!isPlausibleItemDescription(field, desc.trim(), ocrDoc)) {
      removed = true;
      continue;
    }
    kept.push(item);
  }
  return removed ? kept : null;
}

function isPlausibleItemDescription(
  field: FieldSchema,
  text: string,
  ocrDoc: OcrDocument
): boolean {
  if (isNoiseFragment(text)) return false;
  if (!/[\p{L}]/u.test(text)) return false;
  if (isGenericItemDescription(text)) return false;
  if (!appearsInOcr(field, text, ocrDoc)) return false;
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Cleaning pipeline ─────────────────────────────────────────────────────

const INVISIBLE =
  /[\u00ad\u200b\u200c\u200d\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufffe\uffff]/g;

/** Repeated identical punctuation → single mark ("SuperPay,,," → "SuperPay,"). */
const DUP_PUNCTUATION = /([.,;:!?*#])\1+/g;

/** Repeated identical dashes → single dash ("--" → "-", "——" → "—"). */
const DUP_DASH = /([-–—])\1+/g;

/**
 * Characters never legitimately attach to the edges of an entity: whitespace,
 * Unicode symbols (box drawing, dingbats, currency markers), dashes,
 * connectors, brackets, quotes, structural separators and ordinary sentence
 * punctuation. Letters and digits are deliberately excluded so real content
 * is never trimmed.
 */
const EDGE_SEPARATORS =
  "\\s\\p{S}\\p{Pd}\\p{Pc}\\p{Ps}\\p{Pe}\\p{Pi}\\p{Pf}:;|/\\\\_=+<>\"«»#@$%^&*~·•.,!?";

/** Values like ".NET" keep a leading dot attached to a letter. */
const LEADING_DOT_KEEP = /^[.,](?=[\p{L}\p{N}])/u;

/** Whitespace-separated token made up entirely of digits (any script). */
const PURE_DIGIT_TOKEN = /^\p{N}+$/u;

interface CleanOptions {
  nameField?: boolean;
}

/** Returns the cleaned text, or null when cleaning cannot prove an improvement. */
function cleanText(original: string, opts: CleanOptions = {}): string | null {
  let cleaned = stripEdgeSeparators(
    collapseDuplicatedPunctuation(
      collapseWhitespace(original.normalize("NFKC").replace(INVISIBLE, ""))
    )
  );
  if (opts.nameField) {
    // Re-strip separators in case a trimmed digit token exposed new ones
    // ("SuperPay 60 -" → trim "60" → "SuperPay -" → "SuperPay").
    cleaned = stripEdgeSeparators(trimNameEdgeArtifacts(cleaned));
  }

  if (cleaned === original) return null;
  if (cleaned.length === 0) return null;
  if (!preservesContent(original, cleaned)) return null;
  if (!preservesOrder(original, cleaned)) return null;
  if (!preservesBracketBalance(original, cleaned)) return null;
  return cleaned;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function collapseDuplicatedPunctuation(s: string): string {
  return s.replace(DUP_PUNCTUATION, "$1").replace(DUP_DASH, "$1");
}

function stripEdgeSeparators(s: string): string {
  const trailingOnly = LEADING_DOT_KEEP.test(s);
  if (trailingOnly) {
    return s.replace(new RegExp(`[${EDGE_SEPARATORS}]+$`, "u"), "");
  }
  // `/g` is required: with both edges noisy, the alternation must clear each
  // end separately (a single unanchored match would only clear the leading one).
  return s.replace(
    new RegExp(`^[${EDGE_SEPARATORS}]+|[${EDGE_SEPARATORS}]+$`, "gu"),
    ""
  );
}

/**
 * Detached pure-digit edge tokens are classic OCR line-merge artifacts for
 * name fields (reference/line numbers glued to a brand line): "SuperPay 60"
 * → "SuperPay", "123 Pharmacy" → "Pharmacy". Only whitespace-separated tokens
 * made entirely of digits are removed; alphanumeric tokens are never touched.
 */
function trimNameEdgeArtifacts(s: string): string {
  const tokens = s.split(/\s+/);
  let start = 0;
  let end = tokens.length;
  while (start < end && PURE_DIGIT_TOKEN.test(tokens[start].normalize("NFKC"))) {
    start += 1;
  }
  while (end > start && PURE_DIGIT_TOKEN.test(tokens[end - 1].normalize("NFKC"))) {
    end -= 1;
  }
  if (start === 0 && end === tokens.length) return s;
  return tokens.slice(start, end).join(" ");
}

// ─── "Objectively better" proof ────────────────────────────────────────────

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Cleaned must not have invented or dropped any letter/digit (multiset subset). */
function preservesContent(original: string, cleaned: string): boolean {
  const counts = new Map<string, number>();
  for (const ch of original.normalize("NFKC")) {
    if (LETTER_OR_DIGIT.test(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  for (const ch of cleaned.normalize("NFKC")) {
    if (!LETTER_OR_DIGIT.test(ch)) continue;
    const n = counts.get(ch) ?? 0;
    if (n <= 0) return false;
    counts.set(ch, n - 1);
  }
  return true;
}

/** Cleaned must keep the original character order (no reordering, no invention). */
function preservesOrder(original: string, cleaned: string): boolean {
  return isSubsequence(comparable(original), comparable(cleaned));
}

/** Comparison space: pipeline normalization + lossless Unicode normalization. */
function comparable(s: string): string {
  return normalizeText(s).normalize("NFKC").replace(INVISIBLE, "");
}

function isSubsequence(haystack: string, needle: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/** Cleaning must not create an unbalanced bracket (e.g. drop only the ")" of "(X)"). */
function preservesBracketBalance(original: string, cleaned: string): boolean {
  const pairs: Array<[string, string]> = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
    ["<", ">"],
    ["«", "»"],
  ];
  for (const [open, close] of pairs) {
    const before = countChar(original, open) - countChar(original, close);
    const after = countChar(cleaned, open) - countChar(cleaned, close);
    if (before !== after) return false;
  }
  return true;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}

// ─── Grounding safety ──────────────────────────────────────────────────────

function canGround(
  profile: ExtractionProfile,
  field: FieldSchema,
  cleanedValue: string,
  sourceText: string,
  ocrDoc: OcrDocument
): boolean {
  // Primary gate: the strict pipeline grounding engine (single source of truth).
  if (strictlyGrounded(profile, field, cleanedValue, sourceText, ocrDoc)) {
    return true;
  }
  // Fallback gate for normalization-only changes (NFKC / invisible chars): the
  // cleaned value must still appear verbatim inside a single OCR line after
  // lossless normalization, and the line must not carry a conflicting label.
  return appearsInOcr(field, cleanedValue, ocrDoc);
}

function strictlyGrounded(
  profile: ExtractionProfile,
  field: FieldSchema,
  cleanedValue: string,
  sourceText: string,
  ocrDoc: OcrDocument
): boolean {
  try {
    const fv: FieldValue = {
      value: coerce(field, cleanedValue),
      rawValue: cleanedValue,
      confidence: 0.9,
      source: "ai",
      status: "extracted",
    };
    const candidate: ExtractionResult = {
      profileType: profile.id as ExtractionResult["profileType"],
      profileVersion: profile.version,
      fields: [{ field, value: fv }],
      fieldsMap: { [field.key]: fv },
      cleanFields: { [field.key]: fv.value },
      droppedFields: {},
    };
    const grounded = groundExtraction(profile, candidate, sourceText, ocrDoc);
    const out = grounded.fieldsMap[field.key];
    return !!out && (out.evidence?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

function appearsInOcr(
  field: FieldSchema,
  cleanedValue: string,
  ocrDoc: OcrDocument
): boolean {
  const needle = comparable(cleanedValue);
  if (!needle) return false;

  const group = labelGroupForField(field);
  if (field.type === "text" || field.key === "notes") {
    if (isNoiseFragment(cleanedValue)) return false;
  }

  for (const line of ocrDoc.lines) {
    if (!comparable(line.text).includes(needle)) continue;
    // Never relabel: a value sitting on a line labeled for another category is
    // not acceptable evidence (mirrors the strict grounding label verdict).
    const detected = detectLabelGroup(line.text);
    if (group && detected && detected !== group) return false;
    return true;
  }
  return false;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function appendReason(
  reasons: UncertaintyReason[] | undefined,
  reason: UncertaintyReason
): UncertaintyReason[] {
  if (reasons && reasons.includes(reason)) return reasons;
  return [...(reasons ?? []), reason];
}

function withoutKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  if (!(key in obj)) return obj;
  const next = { ...obj };
  delete next[key];
  return next;
}

function upsertField(
  fields: NormalizedField[],
  field: FieldSchema,
  value: FieldValue
): NormalizedField[] {
  const idx = fields.findIndex((nf) => nf.field.key === field.key);
  if (idx >= 0) {
    const next = [...fields];
    next[idx] = { ...next[idx], value };
    return next;
  }
  return [...fields, { field, value }];
}
