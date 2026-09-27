import type { OcrLine } from "./types";

/**
 * Shared conventions for the label-less `content*` fields that carry a
 * document's OCR reading into review.
 *
 * Both the `ocr-passages` pipeline stage AND the review page's client-side
 * fallback build these fields, and they MUST agree — otherwise the same
 * document reviewed before/after a save shows different field keys, and
 * evidence anchors point at the wrong lines. Hence one implementation here
 * rather than a copy on each side.
 *
 * Two rules this module exists to enforce:
 *
 * 1. `lineIndex` is an index into the ORIGINAL `ocr.lines` array, never into a
 *    filtered/sliced view of it. Every consumer treats it that way:
 *    `PdfInspector` builds its per-page remap from `ocr.lines` indices,
 *    `bbox-utils` reads `ocr.lines[lineIndex]`, and `layout-aware-evidence`
 *    does the same. A blank line dropped upstream would shift every later
 *    index by one and silently strand the field's highlights on the wrong
 *    lines (the Inspector then shows no page chips and no boxes at all).
 *
 * 2. Paginated OCR becomes one field per page (`content_page_N`, ascending);
 *    un-paginated OCR stays a single `content` field. A one-page document is
 *    still paginated OCR, so it gets `content_page_1` — not `content` — so
 *    that a document's field keys do not change shape when a second page
 *    happens to be OCR'd later. Lines that carry no page number are never
 *    dropped: they collect under `content` alongside the numbered pages.
 */

export const CONTENT_KEY_PREFIX = "content_page_";
export const SINGLE_CONTENT_KEY = "content";

/** One OCR line plus the index it held in the original `ocr.lines` array. */
export interface IndexedOcrLine {
  line: OcrLine;
  /** Evidence anchor: index into the original `ocr.lines` array. */
  lineIndex: number;
}

/** Field key the pipeline uses for one page of OCR content. */
export function contentPageKey(page: number): string {
  return `${CONTENT_KEY_PREFIX}${page}`;
}

/** The page a `content_page_N` key belongs to, or null for any other key. */
export function contentPageOf(key: string): number | null {
  const m = /^content_page_(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** True for the label-less OCR content fields (single or per-page). */
export function isOcrContentKey(key: string, source: string): boolean {
  return (
    source === "ocr" &&
    (key === SINGLE_CONTENT_KEY || contentPageOf(key) !== null)
  );
}

/**
 * Group an OCR reading into `[fieldKey, lines]` pairs, dropping blank lines
 * while preserving each surviving line's ORIGINAL index. Pages come back in
 * ascending numeric order regardless of the order the OCR emitted them in, so
 * the reviewer's field list always reads page 1, 2, 3 …
 *
 * `limit` caps how many non-empty lines are taken (huge documents stay
 * reviewable); omit it for no cap.
 */
export function groupOcrLinesByPage(
  lines: readonly OcrLine[],
  opts: { limit?: number } = {}
): Array<[string, IndexedOcrLine[]]> {
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const buckets = new Map<number | null, IndexedOcrLine[]>();
  let taken = 0;

  for (let i = 0; i < lines.length; i++) {
    if (taken >= limit) break;
    const line = lines[i];
    // Blank lines are not content, but they still occupy a slot in
    // `ocr.lines` — that is why the index comes from the loop counter and
    // not from a position in a filtered array.
    if (line.text.trim().length === 0) continue;
    taken++;

    const page = typeof line.page === "number" ? line.page : null;
    const entry: IndexedOcrLine = { line, lineIndex: i };
    const bucket = buckets.get(page);
    if (bucket) bucket.push(entry);
    else buckets.set(page, [entry]);
  }

  const numbered = [...buckets.entries()]
    .filter((entry): entry is [number, IndexedOcrLine[]] => entry[0] !== null)
    .sort((a, b) => a[0] - b[0]);

  const groups: Array<[string, IndexedOcrLine[]]> = numbered.map(
    ([page, group]) => [contentPageKey(page), group]
  );

  const unnumbered = buckets.get(null);
  if (unnumbered && unnumbered.length > 0) {
    groups.push([SINGLE_CONTENT_KEY, unnumbered]);
  }
  return groups;
}
