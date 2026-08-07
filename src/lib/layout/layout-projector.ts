/**
 * Milestone 9 — OCR → Layout projection and cleaning.
 *
 * The projector is the Milestone 1 `OcrLayoutProjector` port made concrete.
 * It performs the deterministic, geometry-only cleaning every later stage
 * relies on, then projects the cleaned OCR into the Milestone 1 structural
 * `LayoutDocument`:
 *
 *   - Cleaning (`cleanOcr`) drops words that carry no usable geometry (a
 *     missing or non-finite bbox) and drops the lines that end up with no
 *     positioned word. The cleaned document is compact (dense line and word
 *     indices), deterministic and shares no arrays with the input — the source
 *     OCR is never mutated.
 *   - Projection (`project`) turns every positioned word into a `LayoutNode`
 *     (id `word-<line>-<word>`, page 0, its own confidence distribution, and a
 *     `LayoutSourceRef` back into the cleaned document). Words are grouped into
 *     one structural `LayoutRegion` per source line — the OCR's own line
 *     structure, not an inference — so there is no page-level duplicate region
 *     ("avoid duplicate page block").
 *
 * Skipped words are ordinary projection, never a failure: `segmentDocument`
 * and `buildHierarchy` already skip positionless words (M3/M4 semantics), so a
 * page with no positioned words projects to an empty structural model instead
 * of failing.
 *
 * Determinism: cleaning and projection are pure functions of the input; all
 * iteration is source-ordered and every produced value is deep-frozen through
 * the existing M1 constructors.
 */
import type { BBox, OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { unionBoxes } from "@/lib/pipeline/geometry";
import {
  createConfidenceDistribution,
  createLayoutDocument,
  createLayoutNode,
  createLayoutPage,
  createLayoutRegion,
} from "./models";
import type {
  LayoutDocument,
  LayoutNode,
  LayoutPage,
  LayoutRegion,
} from "./types";
import { LAYOUT_VERSION } from "./types";
import type { OcrLayoutProjector } from "./interfaces";

/** The page index of the projected document (OCR is single-page). */
const DOC_PAGE_INDEX = 0;

/** Summary of the words/lines the projection dropped. */
export interface ProjectionSkipSummary {
  /** Words dropped because they carry no usable (finite) bbox. */
  readonly skippedWordCount: number;
  /** Lines dropped entirely because they ended up with no positioned word. */
  readonly skippedLineCount: number;
}

/** The cleaned OCR plus its skip accounting — the layout pipeline's input. */
export interface ProjectionInput {
  /** The cleaned OCR document the layout derives from (compact indices). */
  readonly ocr: OcrDocument;
  /** Skip accounting of the cleaning pass. */
  readonly skips: ProjectionSkipSummary;
}

/** True when a box exists and every coordinate is finite. */
export function isFiniteBBox(box: BBox | undefined): box is BBox {
  return (
    box !== undefined &&
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height)
  );
}

/**
 * Deterministic geometry-only cleaning. Words without a usable bbox are
 * dropped (they have no position to project, mirroring `buildWordIndex`);
 * lines that end up with no positioned word are dropped as well. The output is
 * a fresh document with compact line/word indices — the source is never
 * mutated and no OCR text or content is edited.
 */
export function cleanOcr(ocr: OcrDocument): ProjectionInput {
  const lines: OcrLine[] = [];
  let skippedWordCount = 0;
  let skippedLineCount = 0;
  for (const line of ocr.lines) {
    const words: OcrWord[] = [];
    for (const word of line.words) {
      if (isFiniteBBox(word.bbox)) {
        words.push(word);
      } else {
        skippedWordCount += 1;
      }
    }
    if (words.length === 0) {
      skippedLineCount += 1;
      continue;
    }
    lines.push({ ...line, words });
  }
  const cleaned: OcrDocument = { ...ocr, lines };
  return { ocr: cleaned, skips: { skippedWordCount, skippedLineCount } };
}

/**
 * The concrete M1 projector: clean the OCR, then project every positioned
 * word into a structural `LayoutDocument`. Words group into one region per
 * source line (OCR structure, not inference); an empty projection yields a
 * single empty page rather than failing.
 */
export class LayoutProjector implements OcrLayoutProjector {
  project(ocr: OcrDocument): LayoutDocument {
    const { ocr: cleaned } = cleanOcr(ocr);

    const nodes: LayoutNode[] = [];
    const nodesByLine: Array<{ lineIndex: number; nodes: LayoutNode[] }> = [];
    cleaned.lines.forEach((line, li) => {
      const lineNodes: LayoutNode[] = [];
      line.words.forEach((word, wi) => {
        const bbox = word.bbox!;
        lineNodes.push(
          createLayoutNode({
            id: `word-${li}-${wi}`,
            page: DOC_PAGE_INDEX,
            bbox,
            confidence: createConfidenceDistribution([word.confidence ?? 0]),
            source: { lineIndex: li, wordIndex: wi },
          })
        );
      });
      if (lineNodes.length > 0) {
        nodesByLine.push({ lineIndex: li, nodes: lineNodes });
        nodes.push(...lineNodes);
      }
    });

    const regions: LayoutRegion[] = [];
    const regionIds: string[] = [];
    for (const { lineIndex, nodes: lineNodes } of nodesByLine) {
      const bbox = unionBoxes(lineNodes.map((n) => n.bbox))!;
      const region = createLayoutRegion({
        id: `region-${DOC_PAGE_INDEX}-${lineIndex}`,
        page: DOC_PAGE_INDEX,
        bbox,
        nodeIds: lineNodes.map((n) => n.id),
      });
      regions.push(region);
      regionIds.push(region.id);
    }

    const pageBounds = unionBoxes(nodes.map((n) => n.bbox)) ?? {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };
    const page: LayoutPage = createLayoutPage({
      index: DOC_PAGE_INDEX,
      bounds: pageBounds,
      nodeIds: nodes.map((n) => n.id),
      regionIds,
    });

    return createLayoutDocument({
      version: LAYOUT_VERSION,
      pages: [page],
      nodes,
      regions,
      source: cleaned,
    });
  }
}

/** Create a default projector instance. */
export function buildProjector(): LayoutProjector {
  return new LayoutProjector();
}
