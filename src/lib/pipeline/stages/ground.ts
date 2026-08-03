import type { PipelineStage } from "../types";
import { groundExtraction } from "../extractor/grounding";

/**
 * Stage: ground. The strict-grounding gate between extraction and validation.
 * Attaches verified source evidence to every field, drops values that are not
 * anchored in the document (never invent, never relabel), and composes real
 * per-field confidence (OCR × extraction × validation).
 */
export function groundStage(): PipelineStage {
  return {
    id: "ground",
    async run(ctx) {
      if (!ctx.extraction || !ctx.profile) {
        throw new Error("ground stage requires a completed extraction and profile");
      }
      ctx.extraction = groundExtraction(
        ctx.profile,
        ctx.extraction,
        ctx.sourceText,
        ctx.ocr
      );
    },
  };
}
