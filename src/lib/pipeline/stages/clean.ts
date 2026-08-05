import type { PipelineStage } from "../types";
import { cleanExtraction } from "../entity-cleaner";

/**
 * Stage: clean. Metadata-driven normalization of grounded values between the
 * strict-grounding gate and recovery. Only provable improvements are
 * committed, and a cleaned value is kept only when it re-grounds against the
 * OCR evidence (a grounded value is never replaced by an ungrounded one).
 */
export function cleanStage(): PipelineStage {
  return {
    id: "clean",
    async run(ctx) {
      if (!ctx.extraction || !ctx.profile) {
        throw new Error("clean stage requires a completed extraction and profile");
      }
      const result = cleanExtraction(
        ctx.profile,
        ctx.extraction,
        ctx.sourceText,
        ctx.ocr
      );
      ctx.extraction = result.extraction;
      ctx.cleaning = result.stats;
    },
  };
}
