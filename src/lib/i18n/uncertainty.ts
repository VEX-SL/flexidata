import type { UncertaintyReason } from "../pipeline/types";

/**
 * Shared mapping of UncertaintyReason → a short, human-readable phrase.
 * Used by the review UI (P4), exports (P5), and the agent context (P1) so the
 * exact same explanation appears everywhere. The agent is instructed to restate
 * the meaning in the conversation language, never paste these labels.
 */
export const UNCERTAINTY_REASONS: Record<UncertaintyReason, string> = {
  recovered_from_ocr:
    "value was recovered directly from the OCR text by label matching, not independently verified",
  ambiguous_candidates:
    "several distinct candidates appear in the document and the correct one could not be determined",
  ocr_confidence_low:
    "OCR confidence for this value is low (blurry, faint, or misread characters)",
  label_not_matched:
    "value was found in the text but no matching field label sat on the same line",
  no_direct_evidence:
    "value does not directly appear in the OCR text and was inferred rather than read verbatim",
};

export function uncertaintyLabel(reason: UncertaintyReason): string {
  return UNCERTAINTY_REASONS[reason] ?? reason;
}
