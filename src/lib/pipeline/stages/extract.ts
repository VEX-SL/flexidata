import type { AIClient, PipelineStage } from "../types";
import { extractDocument } from "../extractor";
import { getProfileManager } from "../profiles/registry";

/**
 * Stage: extract. Resolves the profile from the classification (this is the
 * only place that maps a type to a profile package) and runs the AI extraction
 * as *candidates* only — grounding is a separate stage, so extraction never
 * commits unverified values.
 */
export function extractStage(opts: { ai?: AIClient } = {}): PipelineStage {
  return {
    id: "extract",
    async run(ctx) {
      const type = ctx.classification?.profileType ?? "unknown";
      const profile = getProfileManager().getOrFallback(type);
      ctx.profile = profile;
      ctx.extraction = await extractDocument(
        { profile, sourceText: ctx.sourceText, ocr: ctx.ocr },
        opts.ai,
        { grounded: false }
      );
    },
  };
}
