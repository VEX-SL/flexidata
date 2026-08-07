/**
 * Milestone 5 region geometry features — the immutable feature surface the
 * adaptive region classifier reasons over.
 *
 * Every feature is a pure function of the hierarchy's geometry and the page's
 * own content. No OCR text, label, keyword, language or regex is ever
 * inspected: classification evidence is geometry only. All features are
 * page-relative (ratios over the page's content box) so documents of any size
 * produce comparable values, and every derived statistic below reuses the
 * existing stats/geometry/confidence modules — nothing is duplicated.
 *
 * Features produced per region:
 *   - normalized position (x/y/right/bottom/centerX/centerY on the unit box)
 *   - center offset (horizontal distance of the region's center from the page
 *     center — how far into the left/right margin a region sits)
 *   - area/width/height/aspect ratios vs the page content box
 *   - density (words per unit area) and whitespace ratio inside the region
 *   - alignment score (shared vertical edges with sibling regions)
 *   - grid score (shared horizontal edges with sibling regions)
 *   - neighbor count (siblings within the page's own spacing radius)
 *   - isolation score (nearest-neighbor distance relative to the page's own)
 *   - containment score (how much of the region overlaps sibling content)
 *   - page coverage (content footprint vs the page area)
 *   - child count and dominant block orientation
 *
 * Determinism: extraction walks the page's children in deterministic pre-order
 * and every tolerance is document-derived (median sizes/spacings), so identical
 * inputs reproduce identical features. All outputs are deep-frozen.
 */
import type { BBox } from "@/lib/pipeline/types";
import { unionBoxes } from "@/lib/pipeline/geometry";
import {
  boxArea,
  centerDistance,
  intersectionArea,
} from "./geometry";
import type { LayoutBlock } from "./blocks";
import type { HierarchyNode, LayoutHierarchy } from "./hierarchy";
import { NODE_LEVEL } from "./node-levels";
import { median } from "./stats";

const FEATURE_EPS = 1e-9;

/** A page-normalized position on the unit box. */
export interface NormalizedPosition {
  readonly x: number;
  readonly y: number;
  readonly right: number;
  readonly bottom: number;
  readonly centerX: number;
  readonly centerY: number;
}

/** Dominant shape of a region's child blocks. */
export type BlockOrientation =
  | "horizontal"
  | "vertical"
  | "square"
  | "none";

/** Immutable geometry feature set of one region. */
export interface RegionFeatureSet {
  readonly regionId: string;
  readonly normalizedPosition: NormalizedPosition;
  /**
   * Horizontal distance of the region's center from the page's horizontal
   * center, in [0, 0.5] — 0 for a centered region, larger the further the
   * region sits into a margin.
   */
  readonly centerOffsetX: number;
  /** region area / page content area. */
  readonly areaRatio: number;
  /** region width / page content width. */
  readonly widthRatio: number;
  /** region height / page content height. */
  readonly heightRatio: number;
  /** width / height of the region box (0 for degenerate). */
  readonly aspectRatio: number;
  /** words per unit area of the region. */
  readonly density: number;
  /** 1 − (content union area / region area), in [0, 1]. */
  readonly whitespaceRatio: number;
  /** Shared vertical edges with sibling regions, in [0, 1]. */
  readonly alignmentScore: number;
  /** Shared horizontal edges with sibling regions, in [0, 1]. */
  readonly gridScore: number;
  /** Sibling regions within the page's own spacing radius. */
  readonly neighborCount: number;
  /** Nearest-neighbor distance relative to the page's own, in [0, 1]. */
  readonly isolationScore: number;
  /** Overlap with sibling content, in [0, 1]. */
  readonly containmentScore: number;
  /** Content footprint / page content area, in [0, 1]. */
  readonly pageCoverage: number;
  /** Number of block children. */
  readonly childCount: number;
  readonly dominantBlockOrientation: BlockOrientation;
  /** Page content box area (0 for a degenerate page). */
  readonly pageArea: number;
  /** Region box area (0 for a degenerate region). */
  readonly regionArea: number;
  /** Number of words inside the region. */
  readonly wordCount: number;
}

/** The numeric features a classification decision may cite as evidence. */
export type NumericRegionFeature =
  | "areaRatio"
  | "widthRatio"
  | "heightRatio"
  | "aspectRatio"
  | "density"
  | "whitespaceRatio"
  | "alignmentScore"
  | "gridScore"
  | "neighborCount"
  | "isolationScore"
  | "containmentScore"
  | "pageCoverage"
  | "childCount"
  | "normalizedPosition.x"
  | "normalizedPosition.y"
  | "normalizedPosition.right"
  | "normalizedPosition.bottom"
  | "normalizedPosition.centerX"
  | "normalizedPosition.centerY"
  | "centerOffsetX";

/** Read a numeric feature value from a feature set. */
export function readRegionFeature(
  features: RegionFeatureSet,
  name: NumericRegionFeature
): number {
  switch (name) {
    case "areaRatio":
      return features.areaRatio;
    case "widthRatio":
      return features.widthRatio;
    case "heightRatio":
      return features.heightRatio;
    case "aspectRatio":
      return features.aspectRatio;
    case "density":
      return features.density;
    case "whitespaceRatio":
      return features.whitespaceRatio;
    case "alignmentScore":
      return features.alignmentScore;
    case "gridScore":
      return features.gridScore;
    case "neighborCount":
      return features.neighborCount;
    case "isolationScore":
      return features.isolationScore;
    case "containmentScore":
      return features.containmentScore;
    case "pageCoverage":
      return features.pageCoverage;
    case "childCount":
      return features.childCount;
    case "normalizedPosition.x":
      return features.normalizedPosition.x;
    case "normalizedPosition.y":
      return features.normalizedPosition.y;
    case "normalizedPosition.right":
      return features.normalizedPosition.right;
    case "normalizedPosition.bottom":
      return features.normalizedPosition.bottom;
    case "normalizedPosition.centerX":
      return features.normalizedPosition.centerX;
    case "normalizedPosition.centerY":
      return features.normalizedPosition.centerY;
    case "centerOffsetX":
      return features.centerOffsetX;
  }
}

/**
 * Extract the immutable feature sets of every region on a page, in the page's
 * deterministic child order. `blocks` optionally enriches word counts via the
 * block density metrics; without them word counts come from the hierarchy's
 * Word descendants, so extraction works on a bare hierarchy too.
 */
export function extractPageRegionFeatures(
  hierarchy: LayoutHierarchy,
  page: HierarchyNode,
  blocks: readonly LayoutBlock[] = []
): readonly RegionFeatureSet[] {
  const regions = page.children
    .map((id) => hierarchy.get(id))
    .filter((n) => n !== undefined && n.level === NODE_LEVEL.REGION);
  if (regions.length === 0) return Object.freeze([]);

  const blocksById = new Map<string, LayoutBlock>();
  for (const block of blocks) blocksById.set(block.id, block);

  const pageBox = page.bbox;
  const pageWidth = pageBox.width > 0 ? pageBox.width : 0;
  const pageHeight = pageBox.height > 0 ? pageBox.height : 0;
  const pageArea = boxArea(pageBox);

  const regionsTyped = regions as readonly HierarchyNode[];
  const widths = regionsTyped.map((r) => r.bbox.width);
  const heights = regionsTyped.map((r) => r.bbox.height);
  const medianSize = Math.max(median(widths), median(heights));
  const alignmentTolerance = Math.max(medianSize * 0.15, FEATURE_EPS);
  const neighborRadius = Math.max(medianSize * 1.5, FEATURE_EPS);

  const boxes = regionsTyped.map((r) => r.bbox);
  const nnDistances: number[] = [];
  for (let i = 0; i < regionsTyped.length; i++) {
    let best = Infinity;
    for (let j = 0; j < regionsTyped.length; j++) {
      if (i === j) continue;
      best = Math.min(
        best,
        centerDistance(regionsTyped[i].bbox, regionsTyped[j].bbox)
      );
    }
    if (Number.isFinite(best)) nnDistances.push(best);
  }
  const medianNN = median(nnDistances);

  const out: RegionFeatureSet[] = [];
  for (let i = 0; i < regionsTyped.length; i++) {
    const region = regionsTyped[i];
    const area = boxArea(region.bbox);
    const wordCount = countWords(hierarchy, region, blocksById);
    const contentUnionArea = contentArea(hierarchy, region);
    const pos = normalizePosition(region.bbox, pageWidth, pageHeight);

    const alignmentScore = edgeMatchScore(
      boxes,
      i,
      "alignment",
      alignmentTolerance
    );
    const gridScore = edgeMatchScore(boxes, i, "grid", alignmentTolerance);

    let neighborCount = 0;
    for (let j = 0; j < regionsTyped.length; j++) {
      if (i === j) continue;
      if (centerDistance(region.bbox, regionsTyped[j].bbox) <= neighborRadius) {
        neighborCount += 1;
      }
    }

    const nn = nnDistances.length > 0 ? nnDistances[i] : undefined;
    const isolationScore =
      nn === undefined
        ? 1
        : clamp01(nn / Math.max(medianNN * 2, FEATURE_EPS));

    let containment = 0;
    for (let j = 0; j < regionsTyped.length; j++) {
      if (i === j) continue;
      containment += intersectionArea(region.bbox, regionsTyped[j].bbox);
    }
    const containmentScore = area > 0 ? clamp01(containment / area) : 0;

    out.push(
      freeze({
        regionId: region.id,
        normalizedPosition: freeze(pos),
        centerOffsetX: Math.abs(pos.centerX - 0.5),
        areaRatio: pageArea > 0 ? area / pageArea : 0,
        widthRatio: pageWidth > 0 ? region.bbox.width / pageWidth : 0,
        heightRatio: pageHeight > 0 ? region.bbox.height / pageHeight : 0,
        aspectRatio:
          region.bbox.width === 0 || region.bbox.height === 0
            ? 0
            : region.bbox.width / region.bbox.height,
        density: area > 0 ? wordCount / area : 0,
        whitespaceRatio:
          area > 0 ? clamp01(1 - contentUnionArea / area) : 1,
        alignmentScore,
        gridScore,
        neighborCount,
        isolationScore,
        containmentScore,
        pageCoverage: pageArea > 0 ? clamp01(contentUnionArea / pageArea) : 0,
        childCount: region.children.length,
        dominantBlockOrientation: dominantOrientation(hierarchy, region),
        pageArea,
        regionArea: area,
        wordCount,
      })
    );
  }
  return Object.freeze(out);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function normalizePosition(
  bbox: BBox,
  pageWidth: number,
  pageHeight: number
): NormalizedPosition {
  if (pageWidth <= 0 || pageHeight <= 0) {
    return { x: 0, y: 0, right: 0, bottom: 0, centerX: 0, centerY: 0 };
  }
  const x = bbox.x / pageWidth;
  const y = bbox.y / pageHeight;
  const width = bbox.width / pageWidth;
  const height = bbox.height / pageHeight;
  return {
    x,
    y,
    right: x + width,
    bottom: y + height,
    centerX: x + width / 2,
    centerY: y + height / 2,
  };
}

function countWords(
  hierarchy: LayoutHierarchy,
  region: HierarchyNode,
  blocksById: ReadonlyMap<string, LayoutBlock>
): number {
  let count = 0;
  for (const blockId of region.children) {
    const block = blocksById.get(blockId);
    if (block !== undefined) {
      count += block.densityMetrics.wordCount;
    } else {
      for (const descendant of hierarchy.descendantsOf(blockId)) {
        if (descendant.level === NODE_LEVEL.WORD) count += 1;
      }
    }
  }
  return count;
}

function contentArea(
  hierarchy: LayoutHierarchy,
  region: HierarchyNode
): number {
  const blockBoxes: BBox[] = [];
  for (const blockId of region.children) {
    const block = hierarchy.get(blockId);
    if (block !== undefined) blockBoxes.push(block.bbox);
  }
  if (blockBoxes.length === 0) return 0;
  const union = unionBoxes(blockBoxes);
  return union ? boxArea(union) : 0;
}

/**
 * Edge-sharing score. For "alignment", counts sibling regions sharing the
 * region's left, center or right edge; for "grid", the top or bottom edge.
 * Comparisons use the document-derived tolerance.
 */
function edgeMatchScore(
  boxes: readonly BBox[],
  index: number,
  kind: "alignment" | "grid",
  tolerance: number
): number {
  if (boxes.length <= 1) return 0;
  const self = boxes[index];
  let matches = 0;
  const compared = boxes.length - 1;
  for (let j = 0; j < boxes.length; j++) {
    if (j === index) continue;
    const other = boxes[j];
    let hit = false;
    if (kind === "alignment") {
      hit =
        Math.abs(self.x - other.x) <= tolerance ||
        Math.abs(self.x + self.width - (other.x + other.width)) <= tolerance ||
        Math.abs(
          self.x + self.width / 2 - (other.x + other.width / 2)
        ) <= tolerance;
    } else {
      hit =
        Math.abs(self.y - other.y) <= tolerance ||
        Math.abs(self.y + self.height - (other.y + other.height)) <= tolerance;
    }
    if (hit) matches += 1;
  }
  return matches / compared;
}

function dominantOrientation(
  hierarchy: LayoutHierarchy,
  region: HierarchyNode
): BlockOrientation {
  let horizontal = 0;
  let vertical = 0;
  let square = 0;
  for (const blockId of region.children) {
    const block = hierarchy.get(blockId);
    if (block === undefined) continue;
    if (Math.abs(block.bbox.width - block.bbox.height) <= FEATURE_EPS) {
      square += 1;
    } else if (block.bbox.width > block.bbox.height) {
      horizontal += 1;
    } else {
      vertical += 1;
    }
  }
  if (horizontal === 0 && vertical === 0 && square === 0) return "none";
  if (horizontal >= vertical && horizontal >= square) return "horizontal";
  if (vertical >= square) return "vertical";
  return "square";
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
