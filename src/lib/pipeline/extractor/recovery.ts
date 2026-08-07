import type {
  ExtractionProfile,
  ExtractionResult,
  FieldEvidence,
  FieldValue,
  OcrDocument,
} from "../types";
import { buildOcrDocument } from "../ocr";
import { findFieldCandidates } from "./verify-or-find";
import type { RecoveryCandidate } from "./verify-or-find";

export type { RecoveryCandidate };

/**
 * Deterministic recovery — the FIND arm of the shared Verify-or-Find engine
 * (M12). It is a second, label-driven evidence pass for required fields the
 * extraction stage could not resolve (model returned null, or the value was
 * not grounded).
 *
 * The label search itself lives in `verify-or-find.findFieldCandidates` so the
 * recovery stage and the grounding stage share ONE engine and can never
 * disagree about what a field means. It uses ONLY existing profile metadata:
 * the field's semantic label category (label-lexicon), the field label text,
 * the field type's expected value pattern (via the normalizer's `coerce`),
 * and the OCR spans. No document type, vendor, or field key is special-cased.
 *
 * Results are never verified truth:
 *   - exactly one grounded candidate → source "ocr", status "flagged", low
 *     confidence (label-inferred, not model-verified);
 *   - several distinct grounded candidates → status "ambiguous" with the
 *     candidates exposed as `alternatives`, value kept null;
 *   - no grounded candidate → nothing, the field stays unresolved.
 */

export interface RecoverResult {
  /** Required fields resolved to a single grounded candidate (flagged). */
  flagged: Map<string, FieldValue>;
  /** Required fields with several distinct candidates (ambiguous). */
  ambiguous: Map<string, FieldValue>;
  /** Candidate sets per field (for observability / retry gating). */
  candidates: Map<string, RecoveryCandidate[]>;
}

/**
 * Recover required fields that have no grounded value. `extraction` must be
 * the post-grounding result (missing required fields absent from fieldsMap).
 */
export function recoverMissingFields(
  profile: ExtractionProfile,
  extraction: ExtractionResult,
  sourceText: string,
  ocr?: OcrDocument
): RecoverResult {
  const ocrDoc = ocr ?? buildOcrDocument(sourceText);
  const flagged = new Map<string, FieldValue>();
  const ambiguous = new Map<string, FieldValue>();
  const candidates = new Map<string, RecoveryCandidate[]>();

  for (const field of profile.schema.fields) {
    if (!field.required) continue;
    const fv = extraction.fieldsMap[field.key];
    if (fv && !isEmpty(fv.value)) continue;

    const found = findFieldCandidates(field, ocrDoc);
    candidates.set(field.key, found);
    if (found.length === 0) continue;

    const distinct = dedupeByValue(found);
    if (distinct.length === 1) {
      const c = distinct[0];
      flagged.set(field.key, {
        value: c.value,
        rawValue: c.raw,
        confidence: c.confidence,
        source: "ocr",
        status: "flagged",
        evidence: c.evidence,
        reasons: c.reasons,
      });
    } else {
      ambiguous.set(field.key, {
        value: null,
        rawValue: null,
        confidence: 0,
        source: "ocr",
        status: "ambiguous",
        evidence: distinct.flatMap((c) => c.evidence),
        alternatives: distinct.map((c) => c.value),
        reasons: ["ambiguous_candidates"],
        meta: {
          candidates: distinct.map((c) => ({ value: c.value, raw: c.raw })),
        },
      });
    }
  }

  return { flagged, ambiguous, candidates };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function dedupeByValue(candidates: RecoveryCandidate[]): RecoveryCandidate[] {
  const byValue = new Map<string, RecoveryCandidate>();
  for (const c of candidates) {
    const key = JSON.stringify(c.value);
    const existing = byValue.get(key);
    if (!existing) {
      byValue.set(key, c);
    } else {
      // Merge evidence + keep the highest-confidence candidate value.
      existing.evidence = dedupeEvidence([...existing.evidence, ...c.evidence]);
      existing.confidence = Math.max(existing.confidence, c.confidence);
    }
  }
  return Array.from(byValue.values());
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

function isEmpty(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0)
  );
}
