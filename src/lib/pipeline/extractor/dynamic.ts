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

/**
 * M22 — Discovery entity contract.
 *
 * The discovery result is a set of entities the AI discovered from the
 * document content. It has NO binding to any profile schema: there are no
 * required document fields and no hidden universal field list. The contract
 * invariants (non-negotiable):
 *
 *  1. label      — human-readable semantic label, AI-discovered (never a
 *                  schema label; `label` defaults to a safe derivation of the
 *                  AI's own field name, never to a schema key).
 *  2. raw_value  — the value exactly as the AI claims it from the document.
 *  3. evidence_text — the grounding anchor: a verbatim quote that universal
 *                  grounding must prove exists in the OCR (see
 *                  `universalGrounding`). Never proof by itself — the value
 *                  must also anchor.
 *  4. normalized_value — OPTIONAL typed/normalized reading. It NEVER replaces
 *                  raw_value; the raw reading is always preserved and exported.
 *  5. confidence — informational only. Never treated as verified truth until
 *                  universal grounding validates the value.
 *  6. type       — descriptive hint from the AI, NOT a schema restriction.
 *  7. No required document fields, no no-invention exception, no fabricated
 *                  relationships.
 *
 * Mapped onto the existing architecture:
 *   DynamicFieldSpec.name            → id (safe snake_case key)
 *   DynamicFieldSpec.label           → label
 *   DynamicFieldSpec.value           → raw_value (preserved as-is)
 *   DynamicFieldSpec.raw             → optional verbatim source reading
 *   DynamicFieldSpec.evidence        → evidence_text (grounding hint)
 *   DynamicFieldSpec.type/confidence → type / confidence
 *   FieldValue (NormalizedField)     → the committed entity
 *
 * Relationships are intentionally NOT modeled in this release: discovery must
 * never fabricate links between entities, so nothing in the contract asks for
 * them.
 */
export interface DiscoveredEntity {
  /** Stable identity: the safe snake_case key (never a JS prototype key). */
  id: string;
  /** Human-readable semantic label — AI-discovered, never a schema label. */
  label?: string;
  /** The value exactly as the AI claims it from the document. */
  raw_value: unknown;
  /** Optional typed/normalized reading. NEVER replaces `raw_value`. */
  normalized_value?: unknown;
  /** Descriptive type from the AI. Informational, not a schema restriction. */
  type: FieldType;
  /** Verbatim quote the AI anchors the value to (grounding anchor, not proof). */
  evidence_text?: string;
  /** Model confidence 0..1 — informational until universal grounding validates. */
  confidence?: number;
}

/** One AI-discovered field (runtime shape underlying the contract). */
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
    .replace(/[^\p{L}\p{N}]+/gu, "_")
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

// ─── Content passages (label-less body text) ───────────────────────────────

/**
 * M22 — content passage contract. Free-form documents (a paragraph, a page of
 * a book, a letter) have no field : value structure, so the model reports the
 * meaningful body text as passages instead of forcing fabricated field names.
 * Each passage is a contiguous run of verbatim text; grounding anchors it to
 * its OCR lines, and the UI shows it in the Inspector as a text-only row whose
 * on-image location is highlighted.
 */
export interface PassageSpec {
  /** Verbatim passage text (a contiguous run of the source document). */
  text: string;
  /** Informational 0..1 confidence (grounding re-validates verbatim). */
  confidence?: number;
}

/**
 * Parse the model's `passages` channel into passage specs. Fails safely:
 * non-array payloads yield nothing, malformed / placeholder-shaped entries are
 * skipped, confidence is clamped. Nothing is ever fabricated here — grounding
 * remains the verbatim authority.
 */
export function parseDynamicPassages(raw: RawExtraction): PassageSpec[] {
  const list = raw.passages;
  if (!Array.isArray(list)) return [];

  const out: PassageSpec[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const text = (entry as Record<string, unknown>).text;
    if (typeof text !== "string" || !isPassageText(text)) continue;

    const rawConfidence = (entry as Record<string, unknown>).confidence;
    out.push({
      text: text.trim(),
      confidence:
        typeof rawConfidence === "number"
          ? clampPassageConfidence(rawConfidence)
          : undefined,
    });
  }
  return out;
}

/**
 * A passage must be real body text: several characters across at least two
 * tokens, and not pure digits/standalone symbols (those are field values or
 * fragments, not free-form prose).
 */
function isPassageText(text: string): boolean {
  const t = text.trim();
  if (t.length < 4) return false;
  if (t.split(/\s+/).length < 2) return false;
  if (/^[\p{N}\p{P}\p{S}\s]+$/u.test(t)) return false;
  return true;
}

function clampPassageConfidence(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_DYNAMIC_FIELD_CONFIDENCE;
  return Math.min(1, Math.max(0, n));
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
