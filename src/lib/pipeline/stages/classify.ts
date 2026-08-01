import type { AIClient, PipelineStage } from "../types";
import { classifyDocument } from "../classifier";

/** Stage: classify. AI-first, rule-validated, "unknown" fallback. */
export function classifyStage(opts: { ai?: AIClient } = {}): PipelineStage {
  return {
    id: "classify",
    async run(ctx) {
      ctx.classification = await classifyDocument(ctx.sourceText, {
        pinned: ctx.input.profileType,
        ai: opts.ai,
      });
    },
  };
}
