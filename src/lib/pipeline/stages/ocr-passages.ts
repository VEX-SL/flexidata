import type {
  ExtractionResult,
  NormalizedField,
  PipelineStage,
} from "../types";
import { buildOcrDocument } from "../ocr";

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

      // Nothing is covered (no fields) — every non-empty line is content.
      const lines = ocr.lines.filter((line) => line.text.trim().length > 0);
      if (lines.length === 0) return;
      const taken = lines.slice(0, MAX_OCR_PASSAGES);

      const groups = groupLinesByPage(taken);
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
    if (key === "content" || key.startsWith(CONTENT_KEY_PREFIX)) return true;
  }
  return false;
}

const CONTENT_KEY_PREFIX = "content_page_";
const SINGLE_CONTENT_KEY = "content";

/** One line plus the index it had in `ocr.lines` (its evidence anchor). */
interface IndexedLine {
  line: import("../types").OcrLine;
  lineIndex: number;
}

/**
 * Group lines by page, preserving OCR order. Lines without a page number are
 * all collected under `null`, which renders as the single un-paginated
 * `content` field. Pages are returned in ascending numeric order so the
 * reviewer's field list always reads page 1, 2, 3 … regardless of the order
 * the OCR happened to emit them in.
 */
function groupLinesByPage(
  lines: import("../types").OcrLine[]
): Array<[string, IndexedLine[]]> {
  const buckets = new Map<number | null, IndexedLine[]>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const page = typeof line.page === "number" ? line.page : null;
    const bucket = buckets.get(page);
    if (bucket) bucket.push({ line, lineIndex: i });
    else buckets.set(page, [{ line, lineIndex: i }]);
  }

  const numbered = [...buckets.entries()]
    .filter((entry): entry is [number, IndexedLine[]] => entry[0] !== null)
    .sort((a, b) => a[0] - b[0]);
  const unnumbered = buckets.get(null);

  const groups: Array<[string, IndexedLine[]]> = numbered.map(
    ([page, group]) => [`${CONTENT_KEY_PREFIX}${page}`, group]
  );
  if (unnumbered && unnumbered.length > 0) {
    groups.push([SINGLE_CONTENT_KEY, unnumbered]);
  }
  return groups;
}

/**
 * Build one label-less `content*` field. The label stays empty — these are the
 * document's own words, never an invented title. `page` rides in `meta` so the
 * UI can group/sort by page and so the Inspector can highlight exactly the
 * page this field was read from.
 */
function buildContentField(
  key: string,
  group: IndexedLine[],
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
