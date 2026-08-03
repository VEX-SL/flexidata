import type { PipelineStage } from "../types";
import { computeConfidence } from "../confidence";

/** Stage: confidence. Multi-signal scoring over extraction + validation. */
export function confidenceStage(): PipelineStage {
  return {
    id: "confidence",
    async run(ctx) {
      if (!ctx.extraction || !ctx.validation) {
        throw new Error("confidence stage requires completed extraction and validation");
      }
      ctx.confidence = computeConfidence(ctx.extraction, ctx.validation, {
        sourceText: ctx.sourceText,
        textStats: ctx.textStats,
        ocr: ctx.ocr,
      });
    },
  };
}
