import type {
  ExtractionProfile,
  FieldSchema,
  FieldSource,
  FieldValue,
  FieldsMap,
  RawExtraction,
} from "../types";

const DEFAULT_FIELD_CONFIDENCE = 0.85;

/**
 * Normalizer — coerces raw AI values into typed FieldValue objects
 * using each profile's field schema (numbers, currency, dates, enums, ...).
 */
export function normalizeFields(
  profile: ExtractionProfile,
  raw: RawExtraction
): FieldsMap {
  const map: FieldsMap = {};

  for (const field of profile.schema.fields) {
    const rawValue = raw.data[field.key];
    if (rawValue === undefined || rawValue === null) continue;

    const confidence = clamp(raw.confidence?.[field.key] ?? DEFAULT_FIELD_CONFIDENCE);

    map[field.key] = {
      value: coerce(field, rawValue),
      confidence,
      source: "ai",
      status: "extracted",
    };
  }

  return map;
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
    // Already ISO (YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    // MM/DD/YYYY or DD/MM/YYYY
    const slash = value.match(/^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})$/);
    if (slash) {
      const [a, b, c] = [slash[1], slash[2], slash[3]];
      if (a.length === 4) return `${a}-${pad(b)}-${pad(c)}`;
      if (c.length === 4) return `${c}-${pad(b)}-${pad(a)}`;
    }
    const parsed = new Date(value);
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
  return match ?? (raw || null);
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
