import type {
  ExtractionResult,
  NormalizedField,
  PipelineStage,
} from "../types";
import { buildOcrDocument } from "../ocr";

/**
 * Stage: ocr-passages. The OCR is a ground-truth reading of the document, and
 * in discovery (dynamic) mode the reviewer wants to see the document's content
 * — not just whatever few attributes the model happened to name. This stage
 * folds the OCR's unrecovered lines into ONE label-less `content` field, so the
 * review shows the whole reading as a single block (exportable, searchable)
 * whose evidence still anchors every individual line for on-image highlights.
 *
 * It never duplicates what the extraction already surfaced:
 *  - a line covered by an existing field's evidence (lineIndex) is skipped;
 *  - a line whose verbatim text is already a field value is skipped
 *    (e.g. a model that discovered "Surah name" from the title line — that
 *    line is already represented).
 *  - existing fields keep their place; the addition is purely additive.
 *
 * Guards:
 *  - runs only in dynamic mode (legacy/schema extractions are untouched);
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

      // Lines already represented by the extraction (evidence or value).
      const coveredIndexes = new Set<number>();
      const surfacedValues = new Set<string>();
      for (const f of extraction.fields) {
        for (const e of f.value.evidence ?? []) {
          if (typeof e.lineIndex === "number") coveredIndexes.add(e.lineIndex);
          if (e.quote) surfacedValues.add(e.quote.trim());
        }
        const v = f.value.value;
        if (typeof v === "string") surfacedValues.add(v.trim());
      }

      const ocr = ctx.ocr ?? buildOcrDocument(ctx.sourceText ?? "");
      const pageConfidence =
        typeof ocr.confidence === "number" ? ocr.confidence : 0.9;

      // Unrecovered lines: not covered by evidence, not a verbatim field value.
      const uncovered: Array<{ line: (typeof ocr.lines)[number]; index: number }> = [];
      for (let i = 0; i < ocr.lines.length; i += 1) {
        const line = ocr.lines[i];
        if (!line.text.trim()) continue;
        if (coveredIndexes.has(i)) continue;
        if (surfacedValues.has(line.text.trim())) continue;
        uncovered.push({ line, index: i });
        if (uncovered.length >= MAX_OCR_PASSAGES) break;
      }
      if (uncovered.length === 0) return;

      const text = uncovered.map((u) => u.line.text.trim()).join("\n");
      const content: NormalizedField = {
        field: { key: "content", type: "text", label: "" },
        value: {
          value: text,
          rawValue: text,
          confidence: clamp(pageConfidence),
          source: "ocr",
          status: "extracted",
          evidence: uncovered.map((u) => ({
            quote: u.line.text,
            lineIndex: u.index,
            role: "value-match",
            source: "ocr",
            bbox: u.line.bbox,
            confidence: clamp(u.line.confidence ?? pageConfidence),
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