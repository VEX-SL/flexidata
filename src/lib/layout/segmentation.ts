/**
 * Adaptive-gap block segmentation.
 *
 * Converts an `OcrDocument`'s positioned words into immutable `LayoutBlock`s
 * using ONLY geometry and the document's own spacing distribution:
 *
 *   1. Word geometry is collected (words without a bbox are skipped — they
 *      have no position to segment, mirroring `buildWordIndex`).
 *   2. Horizontal gap samples come from consecutive words within each source
 *      line, ordered left-to-right; vertical gap samples come from each word's
 *      nearest vertically-adjacent word in the same column, found through the
 *      `SpatialIndex`.
 *   3. The adaptive thresholds are `median + scale × MAD` of those samples —
 *      never fixed pixel thresholds, never OCR text, language or keywords.
 *   4. Blocks are grown with a BFS over `SpatialIndex.searchNearby`, so
 *      neighborhood lookup always goes through the spatial index and never
 *      scans the full word set (no O(N²)).
 *
 * Determinism: identical input yields identical blocks (and thresholds). All
 * iteration is source-ordered and the index returns results in insertion
 * order, so every tie-break is stable.
 */
import type { BBox, OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { unionBoxes } from "@/lib/pipeline/geometry";
import {
  horizontalGap,
  horizontalOverlap,
  verticalGap,
  verticalOverlap,
} from "./geometry";
import { buildWordIndex } from "./spatial-index";
import type { IndexedWord, SpatialEntry } from "./spatial-index";
import { gapThreshold, median } from "./stats";
import { createLayoutBlock } from "./blocks";
import type { BlockChild, LayoutBlock } from "./blocks";
import type { CompositeScorePolicy } from "./confidence";

/** The page index of the segmented document (OCR is single-page). */
const DOC_PAGE_INDEX = 0;

export interface SegmentationOptions {
  /**
   * Multiplier on the median absolute deviation when estimating the adaptive
   * gap thresholds. Default 3.
   */
  readonly gapScale?: number;
  /**
   * Cap for the vertical gap candidate search, as a multiple of the median
   * word height. This bounds only the candidate gathering — the threshold
   * itself is still the document's own gap distribution. Default 10.
   */
  readonly verticalSearchCapFactor?: number;
  /**
   * Page dimensions used for the blocks' normalized bboxes. Defaults to the
   * content bounds (union of all positioned words).
   */
  readonly pageSize?: { width: number; height: number };
  /** Composite confidence policy for the block confidence profiles. */
  readonly confidencePolicy?: CompositeScorePolicy;
}

export interface SegmentationThresholds {
  readonly horizontal: number;
  readonly vertical: number;
}

export interface SegmentationResult {
  readonly blocks: readonly LayoutBlock[];
  /** Number of OCR words without geometry that were skipped. */
  readonly skippedWordCount: number;
  /** The adaptive thresholds the segmentation actually used. */
  readonly thresholds: SegmentationThresholds;
}

interface PositionedWord {
  readonly lineIndex: number;
  readonly wordIndex: number;
  readonly word: OcrWord;
  readonly bbox: BBox;
  readonly key: string;
}

/** Segment the document's positioned words into immutable blocks. */
export function segmentDocument(
  ocr: OcrDocument,
  options: SegmentationOptions = {}
): SegmentationResult {
  const positioned: PositionedWord[] = [];
  let skipped = 0;
  ocr.lines.forEach((line, li) => {
    line.words.forEach((word, wi) => {
      if (word.bbox) {
        positioned.push({
          lineIndex: li,
          wordIndex: wi,
          word,
          bbox: word.bbox,
          key: `${li}:${wi}`,
        });
      } else {
        skipped += 1;
      }
    });
  });

  if (positioned.length === 0) {
    return freeze({
      blocks: Object.freeze([]),
      skippedWordCount: skipped,
      thresholds: freeze({ horizontal: 0, vertical: 0 }),
    });
  }

  const index = buildWordIndex(ocr.lines);

  const hThreshold = gapThreshold(horizontalGapSamples(positioned), {
    scale: options.gapScale,
  });
  const vThreshold = gapThreshold(
    verticalGapSamples(positioned, index, options.verticalSearchCapFactor),
    { scale: options.gapScale }
  );

  const blocks = growBlocks(positioned, index, hThreshold, vThreshold);

  const contentBounds = unionBoxes(positioned.map((p) => p.bbox))!;
  const pageSize = options.pageSize ?? {
    width: contentBounds.width > 0 ? contentBounds.width : 1,
    height: contentBounds.height > 0 ? contentBounds.height : 1,
  };

  const built = blocks.map((members, i) =>
    createLayoutBlock({
      id: `block-${i}`,
      page: DOC_PAGE_INDEX,
      children: members,
      lines: uniqueLines(ocr, members),
      pageSize,
      confidencePolicy: options.confidencePolicy,
    })
  );

  return freeze({
    blocks: Object.freeze(built),
    skippedWordCount: skipped,
    thresholds: freeze({ horizontal: hThreshold, vertical: vThreshold }),
  });
}

// ─── Gap sample gathering ────────────────────────────────────────────────────

/** Consecutive within-line word gaps, ordered left-to-right. */
function horizontalGapSamples(positioned: readonly PositionedWord[]): number[] {
  const byLine = groupByLine(positioned);
  const gaps: number[] = [];
  for (const lineWords of byLine.values()) {
    const sorted = [...lineWords].sort(
      (a, b) => a.bbox.x - b.bbox.x || a.wordIndex - b.wordIndex
    );
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (verticalOverlap(prev.bbox, cur.bbox) > 0) {
        gaps.push(horizontalGap(prev.bbox, cur.bbox));
      }
    }
  }
  return gaps;
}

/**
 * Per word, the gap to its nearest vertically-adjacent word sharing horizontal
 * extent. Candidates come from `SpatialIndex.searchNearby`, so this never
 * scans the full word set.
 */
function verticalGapSamples(
  positioned: readonly PositionedWord[],
  index: ReturnType<typeof buildWordIndex>,
  capFactor: number | undefined
): number[] {
  const heights = positioned.map((p) => p.bbox.height);
  const cap = median(heights) * (capFactor ?? 10);
  const gaps: number[] = [];
  for (const p of positioned) {
    let best: number | undefined;
    for (const c of index.searchNearby(p.bbox, cap)) {
      if (c.key === p.key) continue;
      if (horizontalOverlap(p.bbox, c.bbox) > 0) {
        const g = verticalGap(p.bbox, c.bbox);
        if (g > 0 && (best === undefined || g < best)) best = g;
      }
    }
    if (best !== undefined) gaps.push(best);
  }
  return gaps;
}

// ─── Region growing ──────────────────────────────────────────────────────────

function growBlocks(
  positioned: readonly PositionedWord[],
  index: ReturnType<typeof buildWordIndex>,
  hThreshold: number,
  vThreshold: number
): BlockChild[][] {
  const radius = Math.max(hThreshold, vThreshold);
  const visited = new Set<string>();
  const blocks: BlockChild[][] = [];

  for (const start of positioned) {
    if (visited.has(start.key)) continue;
    const members: PositionedWord[] = [];
    const queue: PositionedWord[] = [start];
    visited.add(start.key);
    members.push(start);
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      for (const c of index.searchNearby(cur.bbox, radius)) {
        if (visited.has(c.key)) continue;
        const sameLine =
          verticalOverlap(cur.bbox, c.bbox) > 0 &&
          horizontalGap(cur.bbox, c.bbox) <= hThreshold;
        const sameColumn =
          horizontalOverlap(cur.bbox, c.bbox) > 0 &&
          verticalGap(cur.bbox, c.bbox) <= vThreshold;
        if (sameLine || sameColumn) {
          visited.add(c.key);
          const member = positionedOfEntry(c);
          members.push(member);
          queue.push(member);
        }
      }
    }
    blocks.push(sortBySourceOrder(members));
  }
  return blocks;
}

function positionedOfEntry(
  entry: SpatialEntry<IndexedWord>
): PositionedWord {
  const { key, bbox, value } = entry;
  return {
    key,
    bbox,
    word: value.word,
    lineIndex: value.lineIndex,
    wordIndex: value.wordIndex,
  };
}

function sortBySourceOrder(members: readonly PositionedWord[]): BlockChild[] {
  return [...members]
    .sort((a, b) => a.lineIndex - b.lineIndex || a.wordIndex - b.wordIndex)
    .map((m) => ({
      lineIndex: m.lineIndex,
      wordIndex: m.wordIndex,
      word: m.word,
    }));
}

function uniqueLines(
  ocr: OcrDocument,
  members: readonly BlockChild[]
): OcrLine[] {
  const out: OcrLine[] = [];
  let last = -1;
  const sorted = [...members]
    .map((m) => m.lineIndex)
    .sort((a, b) => a - b);
  for (const li of sorted) {
    if (li !== last) {
      out.push(ocr.lines[li]);
      last = li;
    }
  }
  return out;
}

function groupByLine(
  positioned: readonly PositionedWord[]
): Map<number, PositionedWord[]> {
  const byLine = new Map<number, PositionedWord[]>();
  for (const p of positioned) {
    const bucket = byLine.get(p.lineIndex);
    if (bucket) bucket.push(p);
    else byLine.set(p.lineIndex, [p]);
  }
  return byLine;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
