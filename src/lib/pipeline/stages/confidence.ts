import type { PipelineStage } from "../types";
import { computeConfidence } from "../confidence";

/** Per-field confidence penalty when a validation rule for the field fails. */
const VALIDATION_ADJUSTMENT = 0.85;

/** Stage: confidence. Multi-signal scoring over extraction + validation. */
export function confidenceStage(): PipelineStage {
  return {
    id: "confidence",
    async run(ctx) {
      if (!ctx.extraction || !ctx.validation) {
        throw new Error("confidence stage requires completed extraction and validation");
      }

      // Validation failures are real signals: lower the affected field's
      // confidence before composing the overall score.
      const failedKeys = new Set(
        ctx.validation.results.filter((r) => !r.ok).map((r) => r.key)
      );
      let adjusted = false;
      const fields = ctx.extraction.fields.map((nf) => {
        if (!failedKeys.has(nf.field.key)) return nf;
        adjusted = true;
        return {
          ...nf,
          value: {
            ...nf.value,
            confidence: clamp(nf.value.confidence * VALIDATION_ADJUSTMENT),
          },
        };
      });

      const extraction = adjusted
        ? { ...ctx.extraction, fields, fieldsMap: { ...ctx.extraction.fieldsMap } }
        : ctx.extraction;
      if (adjusted) {
        for (const nf of fields) extraction.fieldsMap[nf.field.key] = nf.value;
      }

      const result = computeConfidence(extraction, ctx.validation, {
        sourceText: ctx.sourceText,
        textStats: ctx.textStats,
        ocr: ctx.ocr,
      });

      // Surface the classifier's confidence when one was produced.
      if (ctx.classification && typeof ctx.classification.confidence === "number") {
        result.signals.classification = clamp(ctx.classification.confidence);
      }

      ctx.extraction = extraction;
      ctx.confidence = result;
    },
  };
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}
