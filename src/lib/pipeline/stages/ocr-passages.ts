import type {
  ExtractionResult,
  NormalizedField,
  PipelineStage,
} from "../types";
import { buildOcrDocument } from "../ocr";

/**
 * Stage: ocr-passages. Deterministic content fallback for discovery runs.
 *
 * A dynamic extraction that surfaced ZERO fields leaves the reviewer looking
 * at an empty Inspector for a document that clearly has content (a textbook
 * page, a scanned paragraph, a page of prose). The AI is not the only reader
 * of the document: the OCR itself is a ground-truth reading. When discovery
 * found nothing to highlight, this stage turns the OCR lines themselves into
 * label-less passages — one verbatim line per passage, each carrying its own
 * line-indexed (boxed) evidence, so the Inspector renders every line of text
 * with its exact on-image region.
 *
 * Strictly additive and guarded:
 *  - runs only in dynamic mode (legacy/schema extractions are untouched);
 *  - only when the extraction produced no fields at all (never duplicates or
 *    disturbs discovered structure);
 *  - only non-empty lines; capped to keep the reviewer view readable.
 */
export const MAX_OCR_PASSAGES = 80;

export function ocrPassagesStage(): PipelineStage {
  return {
    id: "ocr-passages",
    async run(ctx) {
      if (!ctx.extraction) {
        throw new Error(
          "ocr-passages stage requires a completed extraction"
        );
      }
      const extraction = ctx.extraction;
      if (extraction.extractionMode !== "dynamic") return;
      if (extraction.fields.length > 0) return;

      const ocr = ctx.ocr ?? buildOcrDocument(ctx.sourceText ?? "");
      const pageConfidence =
        typeof ocr.confidence === "number" ? ocr.confidence : 0.9;

      const passages: NormalizedField[] = [];
      const lines = ocr.lines.slice(0, MAX_OCR_PASSAGES);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const text = line.text.trim();
        if (!text) continue;

        const confidence = clamp(line.confidence ?? pageConfidence);
        const key = `passage_${i + 1}`;
        passages.push({
          field: { key, type: "text", label: "" },
          value: {
            value: text,
            rawValue: line.text,
            confidence,
            source: "ocr",
            status: "extracted",
            evidence: [
              {
                quote: line.text,
                lineIndex: i,
                role: "value-match",
                source: "ocr",
                bbox: line.bbox,
                confidence,
              },
            ],
          },
        });
      }

      if (passages.length === 0) return;

      const fieldsMap = { ...extraction.fieldsMap };
      const cleanFields = { ...extraction.cleanFields };
      for (const passage of passages) {
        fieldsMap[passage.field.key] = passage.value;
        cleanFields[passage.field.key] = passage.value.value;
      }

      ctx.extraction = {
        ...extraction,
        fields: [...extraction.fields, ...passages],
        fieldsMap,
        cleanFields,
      } as ExtractionResult;
    },
  };
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.9));
}