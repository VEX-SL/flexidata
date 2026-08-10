import type { FieldSchema, FieldType, FieldValue, RawExtraction } from "../types";

/**
 * M20 — Dynamic extraction contract.
 *
 * Internal representation of AI-discovered fields. The AI is asked to discover
 * fields from the document content with NO predefined field list; the normalizer
 * preserves every discovered field instead of filtering against a schema.
 *
 * This is an INTERNAL representation only — it is not persisted, not exported,
 * and it does NOT introduce a field registry. `DynamicFieldSpec` entries are
 * adapted into the existing `NormalizedField`/`FieldValue` shape at the
 * extractor boundary (see `fieldSchemaForDynamicField`) so the downstream
 * pipeline keeps working unchanged.
 */

/** Default per-field confidence when the model omits one (mirrors legacy). */
export const DEFAULT_DYNAMIC_FIELD_CONFIDENCE = 0.85;

/** One AI-discovered field. */
export interface DynamicFieldSpec {
  /** Canonical safe key (snake_case, never a JS object-prototype key). */
  name: string;
  /** Human-readable label from the AI, when provided. */
  label?: string;
  /** AI-declared value type; defaults to "string". */
  type: FieldType;
  /** AI-declared semantic category hint (informational; future grounding). */
  group?: string;
  /**
   * Value preserved as-is — the normalizer does NOT infer meaning.
   * Date/number/enum interpretation belongs to later schema/domain grounding.
   */
  value: unknown;
  /** Verbatim raw value, when provided. */
  raw?: unknown;
  /**
   * Model confidence 0..1 — informational only until downstream grounding
   * validates the value. Never treated as verified truth.
   */
  confidence?: number;
  /** Verbatim evidence quote, when provided (a grounding HINT, not proof). */
  evidence?: string;
}

/**
 * Field names come from the AI and must never be trusted as executable /
 * internal identifiers. Normalization rules:
 *  - deterministic snake_case (camelCase → snake, symbols/space → "_");
 *  - preserves the human-readable meaning (no semantic rewrite);
 *  - never returns a JS object-prototype key (prototype pollution guard).
 *
 * "Account Number" → "account_number". Returns "" for empty/dangerous names.
 */
export function safeFieldKey(name: string): string {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return "";
  const snake = trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!snake) return "";
  if (BLOCKED_FIELD_NAMES.has(snake)) return "";
  return snake;
}

/** "account_number" → "Account Number" (display fallback when no AI label). */
export function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Parse a raw AI response into dynamic field specs.
 * Fails safely: non-object payloads yield nothing, malformed entries are
 * skipped, dangerous/empty names are dropped. No field is ever fabricated.
 */
export function parseDynamicExtraction(raw: RawExtraction): DynamicFieldSpec[] {
  const data = raw.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return [];
  }

  const out: DynamicFieldSpec[] = [];
  for (const [name, entry] of Object.entries(data)) {
    const key = safeFieldKey(name);
    if (!key) continue;
    const spec = toSpec(key, name, entry);
    if (spec) out.push(spec);
  }
  return out;
}

/**
 * Compatibility adapter: build a synthetic FieldSchema for a dynamic field so
 * the existing pipeline (grounding/clean/validate/export) can carry it in the
 * `NormalizedField` shape. This is NOT a registry — the schema is derived per
 * document from the AI's own discovered `type`/`label`. Unknown types degrade
 * to "string" (matching the legacy rebuildExtraction fallback).
 */
export function fieldSchemaForDynamicField(
  key: string,
  fv: FieldValue
): FieldSchema {
  const meta = (fv.meta ?? {}) as {
    dynamicType?: string;
    dynamicLabel?: string;
  };
  const type = isValidFieldType(meta.dynamicType) ? meta.dynamicType : "string";
  return {
    key,
    type,
    label: meta.dynamicLabel ?? humanizeKey(key),
  };
}

// ─── Internals ─────────────────────────────────────────────────────────────

/**
 * JS object-prototype / dangerous inherited keys, after snake normalization.
 * Assigning `map["__proto__"]` on a plain object would mutate its prototype
 * (prototype pollution); `constructor`/`prototype` are the other well-known
 * collisions. "__proto__" normalizes to "proto", so that spelling is blocked
 * too (defense in depth). The Object.prototype method names are guarded
 * defensively.
 */
const BLOCKED_FIELD_NAMES = new Set([
  "proto",
  "constructor",
  "prototype",
  "has_own_property",
  "is_prototype_of",
  "property_is_enumerable",
  "to_locale_string",
  "to_string",
  "value_of",
]);

const VALID_FIELD_TYPES = new Set([
  "string",
  "number",
  "currency",
  "date",
  "boolean",
  "enum",
  "object",
  "array",
  "text",
]);

function isValidFieldType(t: unknown): t is FieldType {
  return typeof t === "string" && VALID_FIELD_TYPES.has(t);
}

/** An envelope is a plain object that declares `value` and/or `raw`. */
function isEnvelope(entry: Record<string, unknown>): boolean {
  return "value" in entry || "raw" in entry;
}

function toSpec(
  key: string,
  originalName: string,
  entry: unknown
): DynamicFieldSpec | null {
  if (entry === null || entry === undefined) return null;

  if (typeof entry === "object" && !Array.isArray(entry)) {
    const obj = entry as Record<string, unknown>;
    if (!isEnvelope(obj)) {
      return {
        name: key,
        label: originalName,
        type: inferType(entry),
        value: entry,
      };
    }
    const type = isValidFieldType(obj.type) ? obj.type : "string";
    const value = "value" in obj ? obj.value : obj.raw;
    return {
      name: key,
      label: typeof obj.label === "string" ? obj.label : originalName,
      type,
      group: typeof obj.group === "string" ? obj.group : undefined,
      value,
      raw: obj.raw,
      confidence:
        typeof obj.confidence === "number" ? obj.confidence : undefined,
      evidence: typeof obj.evidence === "string" ? obj.evidence : undefined,
    };
  }

  return {
    name: key,
    label: originalName,
    type: inferType(entry),
    value: entry,
  };
}

function inferType(v: unknown): FieldType {
  if (Array.isArray(v)) return "array";
  if (v === null || v === undefined) return "string";
  switch (typeof v) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    default:
      return "object";
  }
}
