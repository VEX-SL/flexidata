/**
 * LayoutBlock — the atomic segmentation output of the layout layer.
 *
 * A block is an immutable, geometry-only grouping of OCR words produced by
 * adaptive-gap segmentation (see segmentation.ts). Every block:
 *   - has a union `bbox` plus a unit-square `normalizedBBox`;
 *   - links every child word back to its source OCR primitive through
 *     `sourceRefs` and the unique child sets `ocrLineIndices`/`ocrWordKeys`;
 *   - carries density and spacing metrics, a geometry summary and a
 *     confidence profile over the child words' OCR confidence;
 *   - carries `type` = UNKNOWN — no semantic label is ever assigned here.
 *
 * Immutability: the factory deep-freezes every structure it owns (including
 * frozen copies of the child OCR words/lines), so blocks are safe to share
 * across layers without accidental mutation.
 */
import type { BBox, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { unionBoxes } from "@/lib/pipeline/geometry";
import {
  boxArea,
  boxCenter,
  horizontalGap,
  horizontalOverlap,
  normalizeBox,
  verticalGap,
  verticalOverlap,
} from "./geometry";
import type { Point } from "./geometry";
import { REGION_TYPE } from "./region-types";
import type { RegionType } from "./region-types";
import {
  createConfidenceComponents,
  createConfidenceProfile,
  defaultCompositeScore,
} from "./confidence";
import type { CompositeScorePolicy, ConfidenceProfile } from "./confidence";

/** A child word of a block, with its source position. */
export interface BlockChild {
  readonly lineIndex: number;
  readonly wordIndex: number;
  readonly word: OcrWord;
}

/** Link back to the source OCR word that produced a block child. */
export interface BlockSourceRef {
  /** 0-based page index (always 0 in this milestone; OCR is single-page). */
  readonly pageIndex: number;
  /** 0-based line index into the source OcrDocument. */
  readonly lineIndex: number;
  /** 0-based word index within that line. */
  readonly wordIndex: number;
}

/** Density summary of a block. */
export interface BlockDensityMetrics {
  readonly wordCount: number;
  readonly lineCount: number;
  readonly charCount: number;
  /** Area of the union bbox. */
  readonly area: number;
  /** Words per square unit of area (0 for a zero-area block). */
  readonly wordDensity: number;
  /** Lines per square unit of area (0 for a zero-area block). */
  readonly lineDensity: number;
}

/** Intra-block spacing summary. Zero when a block has a single word. */
export interface BlockSpacingMetrics {
  /** Mean gap between horizontally adjacent words (within a line). */
  readonly meanHorizontalGap: number;
  /** Mean gap between vertically adjacent lines. */
  readonly meanVerticalGap: number;
  /** Population variance of the horizontal gaps. */
  readonly horizontalGapVariance: number;
  /** Largest horizontal gap between adjacent words. */
  readonly maxHorizontalGap: number;
}

/** Geometry summary of a block's union bbox. */
export interface BlockGeometry {
  readonly center: Point;
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
  readonly area: number;
  /** width/height; 0 for any zero-sized dimension. */
  readonly aspectRatio: number;
}

/** An atomic geometry-only grouping of OCR words. */
export interface LayoutBlock {
  readonly id: string;
  /** Page this block belongs to (always 0 in this milestone). */
  readonly page: number;
  /** Union box of the block's words, in page coordinates. */
  readonly bbox: BBox;
  /** The union box mapped onto the unit square. */
  readonly normalizedBBox: BBox;
  /** Always UNKNOWN — segmentation never assigns semantic roles. */
  readonly type: RegionType;
  /** Source word references, in source order. */
  readonly sourceRefs: readonly BlockSourceRef[];
  /** Unique child line indices, ascending. */
  readonly ocrLineIndices: readonly number[];
  /** Unique child word keys ("lineIndex:wordIndex"), ascending. */
  readonly ocrWordKeys: readonly string[];
  /** Child OCR words, frozen copies in source order. */
  readonly words: readonly OcrWord[];
  /** Child OCR lines, frozen copies in source order. */
  readonly lines: readonly OcrLine[];
  readonly densityMetrics: BlockDensityMetrics;
  readonly spacingMetrics: BlockSpacingMetrics;
  /** Confidence profile over the child words' OCR confidence. */
  readonly confidence: ConfidenceProfile;
  readonly geometry: BlockGeometry;
}

export function computeBlockDensityMetrics(
  words: readonly OcrWord[],
  bbox: BBox,
  lineCount: number
): BlockDensityMetrics {
  let charCount = 0;
  for (const w of words) charCount += w.text.length;
  const area = boxArea(bbox);
  return {
    wordCount: words.length,
    lineCount,
    charCount,
    area,
    wordDensity: area > 0 ? words.length / area : 0,
    lineDensity: area > 0 ? lineCount / area : 0,
  };
}

/**
 * Intra-block spacing from the child words. Horizontal gaps come from
 * consecutive words within each source line (ordered left-to-right by x),
 * vertical gaps from consecutive lines that share horizontal extent.
 */
export function computeBlockSpacingMetrics(
  children: readonly BlockChild[]
): BlockSpacingMetrics {
  const hGaps: number[] = [];
  const byLine = groupByLine(children);
  for (const lineChildren of byLine) {
    const sorted = [...lineChildren].sort(
      (a, b) => a.word.bbox!.x - b.word.bbox!.x || a.wordIndex - b.wordIndex
    );
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (verticalOverlap(prev.word.bbox!, cur.word.bbox!) > 0) {
        hGaps.push(horizontalGap(prev.word.bbox!, cur.word.bbox!));
      }
    }
  }

  const vGaps: number[] = [];
  const lineBoxes: Array<{ lineIndex: number; bbox: BBox }> = [];
  for (const lineChildren of byLine) {
    const bbox = unionBoxes(lineChildren.map((c) => c.word.bbox!));
    if (bbox) lineBoxes.push({ lineIndex: lineChildren[0].lineIndex, bbox });
  }
  lineBoxes.sort(
    (a, b) => a.bbox.y - b.bbox.y || a.lineIndex - b.lineIndex
  );
  for (let i = 1; i < lineBoxes.length; i++) {
    const prev = lineBoxes[i - 1];
    const cur = lineBoxes[i];
    if (horizontalOverlap(prev.bbox, cur.bbox) > 0) {
      vGaps.push(verticalGap(prev.bbox, cur.bbox));
    }
  }

  return {
    meanHorizontalGap: hGaps.length === 0 ? 0 : meanOf(hGaps),
    meanVerticalGap: vGaps.length === 0 ? 0 : meanOf(vGaps),
    horizontalGapVariance:
      hGaps.length === 0 ? 0 : populationVariance(hGaps),
    maxHorizontalGap: hGaps.length === 0 ? 0 : Math.max(...hGaps),
  };
}

export function computeBlockGeometry(bbox: BBox): BlockGeometry {
  const width = bbox.width;
  const height = bbox.height;
  return {
    center: boxCenter(bbox),
    top: bbox.y,
    left: bbox.x,
    right: bbox.x + width,
    bottom: bbox.y + height,
    width,
    height,
    area: boxArea(bbox),
    aspectRatio: width === 0 || height === 0 ? 0 : width / height,
  };
}

/**
 * Confidence profile over the child words: each word contributes one sample
 * whose `ocr` component is its OCR confidence (0 when absent); all other
 * components are neutral zero. The composite policy is injectable and the
 * shipped default is the temporary equal-weight policy — swappable here
 * without any public API change.
 */
export function buildBlockConfidence(
  words: readonly OcrWord[],
  policy: CompositeScorePolicy = defaultCompositeScore
): ConfidenceProfile {
  const samples = words.map((w) =>
    createConfidenceComponents({ ocr: w.confidence ?? 0 })
  );
  return createConfidenceProfile(samples, policy);
}

export interface CreateLayoutBlockOptions {
  id: string;
  page: number;
  /** Child words in source order (order is re-sorted deterministically). */
  children: readonly BlockChild[];
  /** Unique child lines in source order. */
  lines: readonly OcrLine[];
  /** Target dimensions for the normalized bbox. */
  pageSize: { width: number; height: number };
  confidencePolicy?: CompositeScorePolicy;
}

/**
 * Create an immutable layout block from its child words. Every owned value is
 * deep-frozen, including frozen copies of the child OCR words and lines.
 */
export function createLayoutBlock(
  opts: CreateLayoutBlockOptions
): LayoutBlock {
  if (opts.children.length === 0) {
    throw new Error("layout block requires at least one child word");
  }
  const children = [...opts.children].sort(
    (a, b) => a.lineIndex - b.lineIndex || a.wordIndex - b.wordIndex
  );
  for (const c of children) {
    if (!c.word.bbox) {
      throw new Error(
        `layout block child ${c.lineIndex}:${c.wordIndex} has no bbox`
      );
    }
  }
  const bbox = unionBoxes(children.map((c) => c.word.bbox!))!;
  const words = children.map((c) => c.word);
  const lineIndices = uniqueSorted(children.map((c) => c.lineIndex));

  return freezeBlock({
    id: opts.id,
    page: opts.page,
    bbox: freezeBox(bbox),
    normalizedBBox: freezeBox(
      normalizeBox(bbox, opts.pageSize.width, opts.pageSize.height)
    ),
    type: REGION_TYPE.UNKNOWN,
    sourceRefs: Object.freeze(
      children.map((c) =>
        Object.freeze({
          pageIndex: opts.page,
          lineIndex: c.lineIndex,
          wordIndex: c.wordIndex,
        })
      )
    ),
    ocrLineIndices: Object.freeze(lineIndices),
    ocrWordKeys: Object.freeze(
      children.map((c) => `${c.lineIndex}:${c.wordIndex}`)
    ),
    words: Object.freeze(words.map(freezeWordCopy)),
    lines: Object.freeze(opts.lines.map(freezeLineCopy)),
    densityMetrics: Object.freeze(
      computeBlockDensityMetrics(words, bbox, lineIndices.length)
    ),
    spacingMetrics: Object.freeze(computeBlockSpacingMetrics(children)),
    confidence: buildBlockConfidence(words, opts.confidencePolicy),
    geometry: Object.freeze(computeBlockGeometry(bbox)),
  });
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function freezeBlock(block: LayoutBlock): LayoutBlock {
  return Object.freeze(block);
}

function freezeBox(bbox: BBox): BBox {
  return Object.freeze({ ...bbox });
}

function freezeWordCopy(word: OcrWord): OcrWord {
  return Object.freeze({
    ...word,
    ...(word.bbox ? { bbox: freezeBox(word.bbox) } : {}),
  });
}

function freezeLineCopy(line: OcrLine): OcrLine {
  return Object.freeze({
    ...line,
    words: Object.freeze(line.words.map(freezeWordCopy)),
    ...(line.bbox ? { bbox: freezeBox(line.bbox) } : {}),
  }) as OcrLine;
}

function groupByLine(children: readonly BlockChild[]): BlockChild[][] {
  const groups: BlockChild[][] = [];
  let current: BlockChild[] | undefined;
  let currentLine = -1;
  for (const c of children) {
    if (c.lineIndex !== currentLine) {
      current = [];
      groups.push(current);
      currentLine = c.lineIndex;
    }
    current!.push(c);
  }
  return groups;
}

function uniqueSorted(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

function meanOf(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function populationVariance(values: readonly number[]): number {
  const m = meanOf(values);
  let sse = 0;
  for (const v of values) sse += (v - m) * (v - m);
  return sse / values.length;
}
