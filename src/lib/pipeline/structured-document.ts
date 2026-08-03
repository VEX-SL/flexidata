import { runPipeline } from "./defaults";
import { getProfileManager } from "./profiles/registry";
import { MAX_SOURCE_TEXT } from "./constants";
import type { RunJobInput, RunJobOutput, UncertaintyReason } from "./types";

/**
 * Structured Document — the pipeline's final artifact, JSON-safe so it can be
 * persisted next to the raw text (documents.structured_content) and injected
 * into the agent chat as the authoritative reading of a file. This is the SAME
 * engine output that /documents persists as `extractions.fields_json`; this
 * module only serializes it for the agent side of the product.
 */

export interface StructuredFieldEvidence {
  quote: string;
  lineIndex?: number;
  role?: string;
  confidence?: number;
}

export interface StructuredField {
  key: string;
  label: string;
  value: unknown;
  /** Verbatim source reading (raw OCR value), never normalized away. */
  rawValue?: unknown;
  /** Composed confidence (OCR × extraction × label), 0..1. */
  confidence: number;
  source: string;
  status: string;
  evidence?: StructuredFieldEvidence[];
  /** Distinct grounded candidates when status is "ambiguous". */
  alternatives?: unknown[];
  /** Why this value is uncertain (flagged/ambiguous/low confidence). */
  reasons?: UncertaintyReason[];
}

export interface StructuredDroppedField {
  key: string;
  reason: string;
}

export interface StructuredDocument {
  profileType: string;
  profileLabel: string;
  /** Overall extraction confidence, 0..1. */
  overallConfidence: number;
  extractedAt: string;
  fields: StructuredField[];
  /** Schema fields that could not be confirmed — never invented. */
  dropped: StructuredDroppedField[];
}

/**
 * Serialize a completed pipeline run into the Structured Document shape.
 * Returns null when the run did not complete (or had no job result), so
 * callers keep their raw-text fallback.
 */
export function toStructuredDocument(out: RunJobOutput): StructuredDocument | null {
  if (out.status !== "complete" || !out.job) return null;

  const { extraction, confidence } = out.job;
  const profile = getProfileManager().getOrFallback(extraction.profileType);

  return {
    profileType: extraction.profileType,
    profileLabel: profile.label,
    overallConfidence: round4(confidence.overall),
    extractedAt: new Date().toISOString(),
    fields: extraction.fields.map((f) => ({
      key: f.field.key,
      label: f.field.label ?? f.field.key,
      value: f.value.value,
      rawValue: f.value.rawValue,
      confidence: round4(f.value.confidence),
      source: f.value.source,
      status: f.value.status,
      evidence: f.value.evidence?.map((e) => ({
        quote: e.quote,
        lineIndex: e.lineIndex,
        role: e.role,
        confidence: e.confidence !== undefined ? round4(e.confidence) : undefined,
      })),
      alternatives: f.value.alternatives,
      reasons: f.value.reasons,
    })),
    dropped: Object.entries(extraction.droppedFields).map(([key, reason]) => ({
      key,
      reason,
    })),
  };
}

/**
 * Run the extraction engine for an agent document and produce its Structured
 * Document. Never throws: on failure it returns null so the caller keeps the
 * raw-text fallback. Obvious non-document content (audio/video metadata
 * stubs, empty text) is skipped — the engine must only consume real content.
 */
export async function extractStructuredDocument(
  input: RunJobInput
): Promise<StructuredDocument | null> {
  const text = (input.sourceText ?? "").trim();
  if (text.length < 30) return null;
  if (/^\[(Audio|Video|Could not extract|No text found)/.test(text)) return null;

  try {
    const out = await runPipeline({
      ...input,
      sourceText: text.slice(0, MAX_SOURCE_TEXT),
    });
    return toStructuredDocument(out);
  } catch (err) {
    console.error("[StructuredDocument] Extraction failed:", err);
    return null;
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
