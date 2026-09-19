import type {
  ExtractionResult,
  NormalizedField,
  PipelineStage,
} from "../types";
import { buildOcrDocument } from "../ocr";

/**
 * Stage: ocr-passages. The OCR is a ground-truth reading of the document, and
 * in discovery (dynamic) mode the reviewer wants to see the document's content
 * — not just whatever the model happened to name. This stage folds the ENTIRE
 * OCR reading into ONE label-less `content` field, so the review shows the
 * whole document as a single block (exportable, searchable) whose evidence
 * still anchors every individual line for on-image highlights.
 *
 * It fires ONLY when the extraction surfaced nothing: when the model already
 * found fields (schema fields or quoted passages), those ARE the document's
 * content and the leftover OCR remainder would only be a pile of stray
 * fragments — so this stage stays out of the way.
 *
 * Guards:
 *  - runs only in dynamic mode (legacy/schema extractions are untouched);
 *  - runs only on an empty extraction (fields.length === 0);
 *  - only non-empty lines; capped so enormous documents stay reviewable.
 */
export const MAX_OCR_PASSAGES = 500;

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
      // A `content` field already exists (this run surfaced it, or a rerun
      // preserved it) — never stack a second copy.
      if (extraction.fieldsMap.content) return;
      // The model found fields (even just quoted passages) — the extraction
      // already represents the document; a leftover OCR blob would only add
      // stray noise. Fire only for a truly empty discovery.
      if (extraction.fields.length > 0) return;

      const ocr = ctx.ocr ?? buildOcrDocument(ctx.sourceText ?? "");
      const pageConfidence =
        typeof ocr.confidence === "number" ? ocr.confidence : 0.9;

      // Nothing is covered (no fields) — every non-empty line is content.
      const lines = ocr.lines.filter((line) => line.text.trim().length > 0);
      if (lines.length === 0) return;
      const taken = lines.slice(0, MAX_OCR_PASSAGES);

      const text = taken.map((line) => line.text.trim()).join("\n");
      const content: NormalizedField = {
        field: { key: "content", type: "text", label: "" },
        value: {
          value: text,
          rawValue: text,
          confidence: clamp(pageConfidence),
          source: "ocr",
          status: "extracted",
          evidence: taken.map((line, i) => ({
            quote: line.text,
            lineIndex: i,
            role: "value-match",
            source: "ocr",
            bbox: line.bbox,
            confidence: clamp(line.confidence ?? pageConfidence),
          })),
        },
      };

      ctx.extraction = {
        ...extraction,
        fields: [...extraction.fields, content],
        fieldsMap: {
          ...extraction.fieldsMap,
          content: content.value,
        },
        cleanFields: {
          ...extraction.cleanFields,
          content: text,
        },
      } as ExtractionResult;
    },
  };
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.9));
}