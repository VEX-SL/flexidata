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
 * turns every OCR line into a label-less passage, so the Inspector always
 * renders the text (with its exact on-image region when boxes exist).
 *
 * It never duplicates what the extraction already surfaced:
 *  - a line covered by an existing field's evidence (lineIndex) is skipped;
 *  - a line whose verbatim text is already a field/passage value is skipped
 *    (e.g. a model that discovered "Surah name" from the title line — that
 *    line is already represented).
 *  - existing fields/passages keep their place; the addition is purely
 *    additive and never re-orders or rewrites discovered structure.
 *
 * Guards:
 *  - runs only in dynamic mode (legacy/schema extractions are untouched);
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

      // Lines already represented by the extraction (evidence or value).
      const coveredIndexes = new Set<number>();
      const surfacedValues = new Set<string>();
      const usedKeys = new Set<string>();
      for (const f of extraction.fields) {
        usedKeys.add(f.field.key);
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

      const passages: NormalizedField[] = [];
      const lines = ocr.lines.slice(0, MAX_OCR_PASSAGES);
      outer: for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const text = line.text.trim();
        if (!text) continue;
        if (coveredIndexes.has(i)) continue;
        if (surfacedValues.has(text)) continue;

        const confidence = clamp(line.confidence ?? pageConfidence);
        let slot = i;
        let key = `passage_${slot + 1}`;
        while (usedKeys.has(key)) {
          slot += 1;
          key = `passage_${slot + 1}`;
          if (slot > lines.length + 8) continue outer;
        }
        usedKeys.add(key);

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