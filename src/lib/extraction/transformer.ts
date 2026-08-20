/**
 * Transformer — converts a GroundedDocument into the FINAL extraction result.
 *
 * The boundary contract of this module is the leak-proof rule: only fields
 * with state VERIFIED may appear in `data`. A field that is UNCERTAIN or
 * MISSING is NEVER written to `data` — it is surfaced exclusively through
 * `issues`, where its raw reading and spatial rejection reasons are kept for
 * manual review (the UI/agent never guesses on an unattributed value).
 *
 *   data   — verified fields only (the committed document values).
 *   meta   — every field's state, reading, confidence and spatial attribution,
 *            for the review UI.
 *   issues — one entry per UNCERTAIN/MISSING field: the explicit rejection
 *            reason(s) plus the raw value/attribution context, so a human can
 *            decide whether to promote it.
 */
import type {
  GroundedAttribution,
  GroundedDocument,
  GroundedField,
  GroundedState,
} from "./grounding";

// ─── Public types ───────────────────────────────────────────────────────────

export interface GroundedFieldMeta {
  state: GroundedState;
  value?: string;
  /** Reading confidence (0..1) when a value was located. */
  confidence?: number;
  /** Spatial attribution when the value was anchored to a label. */
  attribution?: GroundedAttribution;
  /** Explicit reasons justifying the state. */
  reasons: string[];
}

export interface GroundingIssue {
  key: string;
  state: Extract<GroundedState, "UNCERTAIN" | "MISSING">;
  /** Primary human-readable reason (first reason or a stable default). */
  reason: string;
  /** All recorded reasons. */
  reasons: string[];
  /** The raw reading that was found but not committed, for manual review. */
  rawValue?: string;
  /** Spatial context when the value was partially attributed. */
  attribution?: GroundedAttribution;
}

export interface FinalExtractionResult {
  /** Committed values — VERIFIED fields only. Never contains an unverified value. */
  data: Record<string, unknown>;
  /** Per-field state + confidence + spatial attribution for the UI. */
  meta: Record<string, GroundedFieldMeta>;
  /** Explicit list of every rejected field with its reasons and raw reading. */
  issues: GroundingIssue[];
  /**
   * Calibrated document-level confidence (0..1): the mean of per-field
   * confidence — a VERIFIED field contributes its reading confidence, an
   * UNCERTAIN field a flat 0.35, a MISSING field 0. Rounded to 2 decimals, so
   * a document with unresolved fields scores visibly lower than a clean one.
   */
  overallConfidence: number;
}

/** Stable default reasons for a field with no recorded reason. */
const DEFAULT_MISSING_REASON = "no value found in document";
const DEFAULT_UNCERTAIN_REASON = "value lacks trustworthy spatial attribution";
/** Confidence contribution of an UNCERTAIN field (attribution not trustworthy). */
const UNCERTAIN_CONFIDENCE = 0.35;

/**
 * Transform a GroundedDocument into the final extraction result. Only
 * VERIFIED fields are committed to `data`; every other field is reported
 * through `issues` (UNCERTAIN / MISSING) and described in `meta`.
 */
export function toFinalExtractionResult(g: GroundedDocument): FinalExtractionResult {
  const data: Record<string, unknown> = {};
  const meta: Record<string, GroundedFieldMeta> = {};
  const issues: GroundingIssue[] = [];
  let confidenceSum = 0;

  for (const field of g.fields) {
    meta[field.key] = fieldMeta(field);

    if (field.state === "VERIFIED") {
      data[field.key] = field.value;
      confidenceSum += field.attribution?.confidence ?? 1;
      continue;
    }

    confidenceSum += field.state === "UNCERTAIN" ? UNCERTAIN_CONFIDENCE : 0;
    issues.push(fieldIssue(field));
  }

  const overallConfidence =
    g.fields.length === 0
      ? 0
      : Math.round((confidenceSum / g.fields.length) * 100) / 100;

  return { data, meta, issues, overallConfidence };
}

function fieldMeta(field: GroundedField): GroundedFieldMeta {
  return {
    state: field.state,
    ...(field.value !== undefined ? { value: field.value } : {}),
    ...(field.attribution !== undefined
      ? { confidence: field.attribution.confidence, attribution: field.attribution }
      : {}),
    reasons: field.reasons,
  };
}

function fieldIssue(field: GroundedField): GroundingIssue {
  const state = field.state === "UNCERTAIN" ? "UNCERTAIN" : "MISSING";
  const reasons = field.reasons.length > 0 ? field.reasons : [defaultReason(state)];
  return {
    key: field.key,
    state,
    reason: reasons[0],
    reasons,
    ...(field.value !== undefined ? { rawValue: field.value } : {}),
    ...(field.attribution !== undefined ? { attribution: field.attribution } : {}),
  };
}

function defaultReason(state: Extract<GroundedState, "UNCERTAIN" | "MISSING">): string {
  return state === "MISSING" ? DEFAULT_MISSING_REASON : DEFAULT_UNCERTAIN_REASON;
}