import type {
  ExtractionResult,
  NormalizedField,
  PipelineStage,
} from "../types";
import { buildOcrDocument } from "../ocr";
import {
  CONTENT_KEY_PREFIX,
  SINGLE_CONTENT_KEY,
  groupOcrLinesByPage,
  type IndexedOcrLine,
} from "../content-fields";

/**
 * Stage: ocr-passages. The OCR is a ground-truth reading of the document, and
 * in discovery (dynamic) mode the reviewer wants to see the document's content
 * — not just whatever the model happened to name. This stage folds the OCR
 * reading into label-less `content` fields so the review shows the document's
 * content (exportable, searchable) whose evidence still anchors every
 * individual line for on-image highlights.
 *
 * MULTI-PAGE OCR is distributed one field PER PAGE (`content_page_1`,
 * `content_page_2`, …) instead of a single blob spanning the whole document:
 * an 8-page booklet dumped into one field is unreviewable — the reviewer cannot
 * tell which page a value came from, the page chips in the Inspector light up
 * on every page at once, and the Inspector's per-page evidence remap has no
 * way to tell fields apart. One field per page keeps each value anchored to
 * the page it was read from. Lines that carry no page number (plain-text OCR)
 * stay in a single `content` field exactly as before.
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
      // A `content*` field already exists (this run surfaced it, or a rerun
      // preserved it) — never stack a second copy.
      if (hasContentField(extraction)) return;
      // The model found fields (even just quoted passages) — the extraction
      // already represents the document; a leftover OCR blob would only add
      // stray noise. Fire only for a truly empty discovery.
      if (extraction.fields.length > 0) return;

      const ocr = ctx.ocr ?? buildOcrDocument(ctx.sourceText ?? "");
      const pageConfidence =
        typeof ocr.confidence === "number" ? ocr.confidence : 0.9;

      // Nothing is covered (no fields) — every non-empty line is content,
      // grouped one field per page. The grouping keeps each line's index in
      // the ORIGINAL `ocr.lines` array, which is what the Inspector's per-page
      // remap and the bbox resolver index by.
      const groups = groupOcrLinesByPage(ocr.lines, { limit: MAX_OCR_PASSAGES });
      if (groups.length === 0) return;

      const added: NormalizedField[] = [];
      for (const [key, group] of groups) {
        added.push(
          buildContentField(key, group, {
            page: group[0].line.page,
            pageConfidence,
          })
        );
      }
      if (added.length === 0) return;

      const cleanFields: Record<string, unknown> = { ...extraction.cleanFields };
      const fieldsMap = { ...extraction.fieldsMap };
      for (const f of added) {
        fieldsMap[f.field.key] = f.value;
        cleanFields[f.field.key] = f.value.value;
      }

      ctx.extraction = {
        ...extraction,
        fields: [...extraction.fields, ...added],
        fieldsMap,
        cleanFields,
      } as ExtractionResult;
    },
  };
}

/** True when any per-page `content*` field is already present. */
function hasContentField(extraction: ExtractionResult): boolean {
  for (const key of Object.keys(extraction.fieldsMap)) {
    if (key === SINGLE_CONTENT_KEY || key.startsWith(CONTENT_KEY_PREFIX)) return true;
  }
  return false;
}

/**
 * Build one label-less `content*` field. The label stays empty — these are the
 * document's own words, never an invented title. `page` rides in `meta` so the
 * UI can group/sort by page and so the Inspector can highlight exactly the
 * page this field was read from.
 */
function buildContentField(
  key: string,
  group: IndexedOcrLine[],
  opts: { page?: number; pageConfidence: number }
): NormalizedField {
  const { page, pageConfidence } = opts;
  const text = group.map(({ line }) => line.text.trim()).join("\n");
  return {
    field: { key, type: "text", label: "" },
    value: {
      value: text,
      rawValue: text,
      confidence: clamp(pageConfidence),
      source: "ocr",
      status: "extracted",
      evidence: group.map(({ line, lineIndex }) => ({
        quote: line.text,
        lineIndex,
        role: "value-match" as const,
        source: "ocr" as const,
        bbox: line.bbox,
        confidence: clamp(line.confidence ?? pageConfidence),
        ...(page !== undefined ? { page } : {}),
      })),
      ...(page !== undefined ? { meta: { page } } : {}),
    },
  };
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.9));
}
