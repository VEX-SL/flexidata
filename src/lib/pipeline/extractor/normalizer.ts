import type {
  ExtractionProfile,
  FieldSchema,
  FieldSource,
  FieldValue,
  FieldsMap,
  RawExtraction,
} from "../types";
import {
  DEFAULT_DYNAMIC_FIELD_CONFIDENCE,
  parseDynamicExtraction,
} from "./dynamic";
import { isMobileField, sanitizeMobileNumber } from "./sanitizers";

const DEFAULT_FIELD_CONFIDENCE = 0.85;

/** Per-field model envelope: { raw, value, confidence, evidence }. */
interface FieldEnvelope {
  raw?: unknown;
  value: unknown;
  confidence?: number;
  evidence?: string;
}

/**
 * Normalizer — coerces raw AI values into typed FieldValue objects
 * using each profile's field schema (numbers, currency, dates, enums, ...).
 * Raw values (verbatim from the source) are preserved on `rawValue`.
 */
export function normalizeFields(
  profile: ExtractionProfile,
  raw: RawExtraction
): FieldsMap {
  const map: FieldsMap = {};

  for (const field of profile.schema.fields) {
    const entry = raw.data[field.key];
    if (entry === undefined || entry === null) continue;

    const envelope = unwrapEnvelope(entry);
    const rawValue = envelope.raw !== undefined ? envelope.raw : entry;

    map[field.key] = {
      value: sanitizeTypedValue(field, coerce(field, envelope.value)),
      rawValue,
      confidence: clamp(
        envelope.confidence ??
          raw.confidence?.[field.key] ??
          DEFAULT_FIELD_CONFIDENCE
      ),
      source: "ai",
      status: "extracted",
      meta: envelope.evidence ? { evidenceQuote: envelope.evidence } : undefined,
    };
  }

  return map;
}

/**
 * Dynamic-mode normalizer — preserves arbitrary AI-discovered fields.
 *
 * Unlike `normalizeFields` (which iterates `profile.schema.fields` and silently
 * discards any non-schema key), this iterates EVERY key the AI returned:
 *  - arbitrary field names are preserved (safe-keyed, never prototype keys);
 *  - values are preserved as-is (structure kept, meaning NOT inferred — date
 *    and number interpretation belongs to later grounding/domain validation);
 *  - type / label / semantic-group / evidence from the AI are kept on `meta`
 *    (type is consumed by the compatibility adapter at the extractor boundary);
 *  - AI confidence is preserved but stays informational until grounding
 *    validates the value.
 *
 * Legacy behavior is untouched: this function is only used in dynamic mode.
 */
export function normalizeDynamicFields(
  _profile: ExtractionProfile,
  raw: RawExtraction
): FieldsMap {
  const map: FieldsMap = {};
  const specs = parseDynamicExtraction(raw);

  for (const spec of specs) {
    const meta: Record<string, unknown> = { dynamicType: spec.type };
    if (spec.label !== undefined) meta.dynamicLabel = spec.label;
    if (spec.group !== undefined) meta.dynamicGroup = spec.group;
    if (spec.evidence !== undefined) meta.evidenceQuote = spec.evidence;

    map[spec.name] = {
      value: spec.value,
      rawValue: spec.raw,
      confidence: clamp(
        spec.confidence ?? DEFAULT_DYNAMIC_FIELD_CONFIDENCE
      ),
      source: "ai",
      status: "extracted",
      meta,
    };
  }

  return map;
}

/**
 * A field value is either a bare primitive/array (backward-compatible with
 * flat model output) or an object envelope { raw, value, confidence, evidence }.
 */
function unwrapEnvelope(entry: unknown): FieldEnvelope {
  if (isPlainObject(entry) && ("value" in entry || "raw" in entry)) {
    const obj = entry as Record<string, unknown>;
    return {
      raw: obj.raw,
      value: "value" in obj ? obj.value : obj.raw,
      confidence:
        typeof obj.confidence === "number" ? obj.confidence : undefined,
      evidence: typeof obj.evidence === "string" ? obj.evidence : undefined,
    };
  }
  return { value: entry };
}

/**
 * Field-aware value shaping applied AFTER type coercion (schema
 * post-processing input). The verbatim `rawValue` is never touched here, so
 * grounding keeps anchoring evidence against the printed text. Today: the
 * Egyptian mobile sanitizer for phone/mobile fields.
 */
function sanitizeTypedValue(field: FieldSchema, value: FieldValue["value"]) {
  if (typeof value !== "string") return value;
  return isMobileField(field) ? sanitizeMobileNumber(value) : value;
}

/** Cast a raw value to the field's declared type. */
export function coerce(field: FieldSchema, rawValue: unknown): FieldValue["value"] {
  try {
    switch (field.type) {
      case "number":
        return toNumber(rawValue);
      case "currency":
        return toNumber(rawValue);
      case "date":
        return toDate(rawValue);
      case "boolean":
        return toBoolean(rawValue);
      case "enum":
        return normalizeEnum(field, rawValue);
      case "array":
        return Array.isArray(rawValue) ? rawValue : null;
      case "object":
        return isPlainObject(rawValue) ? rawValue : null;
      case "string":
      case "text":
        return String(rawValue ?? "").trim() || null;
      default:
        return String(rawValue ?? "").trim() || null;
    }
  } catch {
    return null;
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  let cleaned = value
    .replace(/\s+/g, "")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));

  // Currency symbol/words may trail the amount: "1,234.50 USD"
  const match = cleaned.match(/[-+]?\d[\d,]*(?:\.\d+)?/);
  if (!match) return null;

  cleaned = match[0].replace(/,/g, "");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function toDate(value: unknown): string | null {
  if (typeof value === "string") {
    let v = value.trim();
    // Strip a trailing time when the OCR/text carried a timestamp:
    // "02-07-2028 18:30:12" → "02-07-2028"
    const timeSuffix = v.match(/^(\d{1,4}[/-]\d{1,2}[/-]\d{1,4})\s+\d{1,2}:\d{2}/);
    if (timeSuffix) v = timeSuffix[1];
    // Already ISO (YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    // MM/DD/YYYY or DD/MM/YYYY
    const slash = v.match(/^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})$/);
    if (slash) {
      const [a, b, c] = [slash[1], slash[2], slash[3]];
      if (a.length === 4) return `${a}-${pad(b)}-${pad(c)}`;
      if (c.length === 4) return `${c}-${pad(b)}-${pad(a)}`;
    }
    const parsed = new Date(v);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return null;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  if (["true", "yes", "y", "1", "نعم", "صحيح"].includes(lower)) return true;
  if (["false", "no", "n", "0", "لا", "خطأ"].includes(lower)) return false;
  return null;
}

function normalizeEnum(field: FieldSchema, value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim().toUpperCase();
  if (!field.enum || field.enum.length === 0) return raw || null;
  const match = field.enum.find((allowed) => allowed.toUpperCase() === raw);
  // Only accept values from the allowed set — never "invent" a currency/enum
  // the model guessed. Non-matching values become null and are dropped later.
  return match ?? null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(n: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return DEFAULT_FIELD_CONFIDENCE;
  return Math.min(1, Math.max(0, n));
}

function pad(n: string): string {
  return n.length === 1 ? `0${n}` : n;
}

export type { FieldSource, FieldValue };
