import type { PipelineStage } from "../types";
import { validateExtraction } from "../validator";

/** Stage: validate. Runs the profile's declarative rules. */
export function validateStage(): PipelineStage {
  return {
    id: "validate",
    async run(ctx) {
      if (!ctx.extraction) {
        throw new Error("validate stage requires a completed extraction");
      }
      ctx.validation = validateExtraction(ctx.extraction);
    },
  };
}
