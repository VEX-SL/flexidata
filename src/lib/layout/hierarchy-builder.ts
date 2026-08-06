/**
 * Layout hierarchy builder — bottom-up structural construction.
 *
 * Assembles the immutable hierarchy
 *
 *     Document → Page → Region (UNKNOWN) → Block → Line → Word
 *
 * from an `OcrDocument` and its segmented `LayoutBlock`s. Construction is
 * strictly bottom-up: OCR words → lines → blocks → regions → pages →
 * document. Every parent bbox is the exact union of its children's boxes
 * (never estimated), and every parent's confidence is the aggregation of its
 * children's confidence profiles via `aggregateChildConfidence`.
 *
 * Regions are temporary structural containers that group nearby blocks using
 * ONLY geometry (spacing, containment, alignment) and the document's own
 * adaptive spacing distribution (reusing `gapThreshold` from stats). No OCR
 * text, language or keywords are ever inspected, and no semantic
 * classification is performed: every region is `REGION_TYPE.UNKNOWN`.
 *
 * Determinism: identical inputs reproduce identical trees; sibling order
 * comes from `compareHierarchyNodes` and never from the input block order.
 * Words without a bbox have no position and are out of scope (mirroring the
 * spatial index and segmentation).
 */
import type { BBox, OcrDocument } from "@/lib/pipeline/types";
import { unionBoxes } from "@/lib/pipeline/geometry";
import { NODE_LEVEL } from "./node-levels";
import { REGION_TYPE } from "./region-types";
import {
  HIERARCHY_DOCUMENT_ID,
  HIERARCHY_ROOT_LEVEL,
  aggregateChildConfidence,
  createHierarchyNode,
} from "./hierarchy";
import type { HierarchyNode } from "./hierarchy";
import { LayoutHierarchy } from "./hierarchy";
import type { LayoutBlock } from "./blocks";
import { buildBlockConfidence } from "./blocks";
import { defaultCompositeScore } from "./confidence";
import type { CompositeScorePolicy } from "./confidence";
import { normalizeBox } from "./geometry";
import {
  horizontalGap,
  horizontalOverlap,
  verticalGap,
  verticalOverlap,
} from "./geometry";
import { SpatialIndex } from "./spatial-index";
import { gapThreshold, median } from "./stats";

export interface BuildHierarchyOptions {
  /**
   * Page dimensions used for the normalized bboxes. Defaults to the union of
   * the source OCR's positioned word boxes.
   */
  readonly pageSize?: { readonly width: number; readonly height: number };
  /** Composite confidence policy for the node confidence profiles. */
  readonly confidencePolicy?: CompositeScorePolicy;
}

const REGION_SEARCH_CAP_FACTOR = 10;

/** Build the immutable structural hierarchy of a document bottom-up. */
export function buildHierarchy(
  ocr: OcrDocument,
  blocks: readonly LayoutBlock[],
  options: BuildHierarchyOptions = {}
): LayoutHierarchy {
  const policy = options.confidencePolicy ?? defaultCompositeScore;
  const pageSize = resolvePageSize(ocr, options.pageSize);
  const pageWidth = pageSize.width;
  const pageHeight = pageSize.height;

  const nodes: HierarchyNode[] = [];
  const nodeIds = new Set<string>();
  const nodeById = new Map<string, HierarchyNode>();
  const addNode = (node: HierarchyNode): void => {
    if (nodeIds.has(node.id)) {
      throw new Error(`duplicate hierarchy node id ${node.id}`);
    }
    nodeIds.add(node.id);
    nodeById.set(node.id, node);
    nodes.push(node);
  };

  // Word → block ownership (single parent guarantee for words).
  const blockOfWord = new Map<string, LayoutBlock>();
  for (const block of blocks) {
    for (const ref of block.sourceRefs) {
      const key = `${ref.pageIndex}:${ref.lineIndex}:${ref.wordIndex}`;
      const owner = blockOfWord.get(key);
      if (owner !== undefined && owner !== block) {
        throw new Error(`word ${key} is assigned to multiple blocks`);
      }
      blockOfWord.set(key, block);
    }
  }

  // Word and line nodes, grouped per block.
  const lineNodesByBlock = new Map<string, HierarchyNode[]>();
  for (const block of blocks) {
    const refs = block.sourceRefs;
    const words = block.words;
    if (refs.length !== words.length) {
      throw new Error(`block ${block.id} sourceRefs/words mismatch`);
    }
    const wordIds: string[] = [];
    const lineIndices: number[] = [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const word = words[i];
      if (!word.bbox) {
        throw new Error(
          `block ${block.id} references an unpositioned word ${ref.lineIndex}:${ref.wordIndex}`
        );
      }
      const wordId = `word-${block.page}-${ref.lineIndex}-${ref.wordIndex}`;
      addNode(
        createHierarchyNode({
          id: wordId,
          level: NODE_LEVEL.WORD,
          parentId: `line-${block.id}-${ref.lineIndex}`,
          pageIndex: block.page,
          bbox: word.bbox,
          normalizedBBox: normalizeBox(word.bbox, pageWidth, pageHeight),
          confidence: buildBlockConfidence([word], policy),
          children: [],
          sourceRefs: [
            {
              pageIndex: block.page,
              lineIndex: ref.lineIndex,
              wordIndex: ref.wordIndex,
            },
          ],
          metadata: { index: ref.wordIndex },
        })
      );
      wordIds.push(wordId);
      lineIndices.push(ref.lineIndex);
    }

    const byLine = new Map<number, string[]>();
    for (let i = 0; i < wordIds.length; i++) {
      const bucket = byLine.get(lineIndices[i]);
      if (bucket) bucket.push(wordIds[i]);
      else byLine.set(lineIndices[i], [wordIds[i]]);
    }

    const lineNodes: HierarchyNode[] = [];
    for (const [lineIndex, memberIds] of byLine) {
      const memberNodes = memberIds.map((id) => nodeById.get(id)!);
      const bbox = unionBoxes(memberNodes.map((n) => n.bbox))!;
      addNode(
        createHierarchyNode({
          id: `line-${block.id}-${lineIndex}`,
          level: NODE_LEVEL.LINE,
          parentId: block.id,
          pageIndex: block.page,
          bbox,
          normalizedBBox: normalizeBox(bbox, pageWidth, pageHeight),
          confidence: aggregateChildConfidence(memberNodes, policy),
          children: memberIds,
          sourceRefs: [{ pageIndex: block.page, lineIndex }],
          metadata: {},
        })
      );
      lineNodes.push(nodeById.get(`line-${block.id}-${lineIndex}`)!);
    }
    lineNodesByBlock.set(block.id, lineNodes);
  }

  // Region grouping — geometry only, per page.
  const regionIdOfBlock = new Map<string, string>();
  const blockIdsByPage = new Map<number, string[][]>();
  {
    const blocksByPage = new Map<number, LayoutBlock[]>();
    for (const block of blocks) {
      const bucket = blocksByPage.get(block.page);
      if (bucket) bucket.push(block);
      else blocksByPage.set(block.page, [block]);
    }
    for (const [page, pageBlocks] of blocksByPage) {
      const groups = groupBlocksIntoRegions(pageBlocks);
      blockIdsByPage.set(page, groups);
      groups.forEach((group, k) => {
        const regionId = `region-${page}-${k}`;
        for (const blockId of group) regionIdOfBlock.set(blockId, regionId);
      });
    }
  }

  // Block nodes.
  for (const block of blocks) {
    const lineNodes = lineNodesByBlock.get(block.id)!;
    const regionId = regionIdOfBlock.get(block.id)!;
    addNode(
      createHierarchyNode({
        id: block.id,
        level: NODE_LEVEL.BLOCK,
        parentId: regionId,
        pageIndex: block.page,
        bbox: block.bbox,
        normalizedBBox: normalizeBox(block.bbox, pageWidth, pageHeight),
        confidence: aggregateChildConfidence(lineNodes, policy),
        children: lineNodes.map((line) => line.id),
        sourceRefs: block.sourceRefs,
        metadata: {},
      })
    );
  }

  // Region nodes.
  const pageIndices = [...blockIdsByPage.keys()].sort((a, b) => a - b);
  for (const page of pageIndices) {
    const groups = blockIdsByPage.get(page)!;
    const regionIds: string[] = [];
    groups.forEach((group, k) => {
      const regionId = `region-${page}-${k}`;
      regionIds.push(regionId);
      const blockNodes = group.map((blockId) => nodeById.get(blockId)!);
      const bbox = unionBoxes(blockNodes.map((n) => n.bbox))!;
      addNode(
        createHierarchyNode({
          id: regionId,
          level: NODE_LEVEL.REGION,
          parentId: `page-${page}`,
          pageIndex: page,
          bbox,
          normalizedBBox: normalizeBox(bbox, pageWidth, pageHeight),
          confidence: aggregateChildConfidence(blockNodes, policy),
          children: group,
          sourceRefs: [],
          metadata: {},
          regionType: REGION_TYPE.UNKNOWN,
        })
      );
    });
  }

  // Page nodes.
  for (const page of pageIndices) {
    const regionIds = blockIdsByPage.get(page)!.map(
      (_group, k) => `region-${page}-${k}`
    );
    const regionNodes = regionIds.map((regionId) => nodeById.get(regionId)!);
    const bbox = unionBoxes(regionNodes.map((n) => n.bbox))!;
    addNode(
      createHierarchyNode({
        id: `page-${page}`,
        level: NODE_LEVEL.PAGE,
        parentId: HIERARCHY_DOCUMENT_ID,
        pageIndex: page,
        bbox,
        normalizedBBox: normalizeBox(bbox, pageWidth, pageHeight),
        confidence: aggregateChildConfidence(regionNodes, policy),
        children: regionIds,
        sourceRefs: [],
        metadata: { index: page },
      })
    );
  }

  // Document node (the root container).
  const pageNodes = pageIndices.map((page) => nodeById.get(`page-${page}`)!);
  const documentBBox =
    pageNodes.length > 0
      ? unionBoxes(pageNodes.map((n) => n.bbox))!
      : { x: 0, y: 0, width: 0, height: 0 };
  addNode(
    createHierarchyNode({
      id: HIERARCHY_DOCUMENT_ID,
      level: HIERARCHY_ROOT_LEVEL,
      parentId: null,
      pageIndex: -1,
      bbox: documentBBox,
      normalizedBBox: normalizeBox(documentBBox, pageWidth, pageHeight),
      confidence: aggregateChildConfidence(pageNodes, policy),
      children: pageNodes.map((node) => node.id),
      sourceRefs: [],
      metadata: {},
    })
  );

  return new LayoutHierarchy(nodes);
}

// ─── Region grouping ─────────────────────────────────────────────────────────

/**
 * Group a page's blocks into structural regions using ONLY geometry and the
 * page's own block spacing distribution. Mirrors the adaptive-gap BFS of the
 * segmentation milestone but over blocks: nearby blocks sharing a horizontal
 * run (same line) or a vertical run (same column) merge while the document's
 * outlier gaps stay separate.
 */
function groupBlocksIntoRegions(blocks: readonly LayoutBlock[]): string[][] {
  if (blocks.length === 0) return [];
  const index = SpatialIndex.build(
    blocks.map((block) => ({ key: block.id, bbox: block.bbox, value: block }))
  );
  const heights = blocks.map((block) => block.bbox.height);
  const cap = median(heights) * REGION_SEARCH_CAP_FACTOR;
  const hThreshold = gapThreshold(horizontalGapSamples(index, cap));
  const vThreshold = gapThreshold(verticalGapSamples(index, cap));
  const radius = Math.max(hThreshold, vThreshold);

  const visited = new Set<string>();
  const groups: string[][] = [];
  for (const start of blocks) {
    if (visited.has(start.id)) continue;
    const members: string[] = [];
    const queue: LayoutBlock[] = [start];
    visited.add(start.id);
    members.push(start.id);
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      for (const c of index.searchNearby(cur.bbox, radius)) {
        if (visited.has(c.key)) continue;
        if (c.value.page !== cur.page) continue;
        const sameLine =
          verticalOverlap(cur.bbox, c.bbox) > 0 &&
          horizontalGap(cur.bbox, c.bbox) <= hThreshold;
        const sameColumn =
          horizontalOverlap(cur.bbox, c.bbox) > 0 &&
          verticalGap(cur.bbox, c.bbox) <= vThreshold;
        if (sameLine || sameColumn) {
          visited.add(c.key);
          members.push(c.key);
          queue.push(c.value);
        }
      }
    }
    groups.push(members);
  }
  return groups;
}

/**
 * Per block, the gap to its nearest horizontally-adjacent block sharing
 * vertical extent. Candidates come from the spatial index; a block contributes
 * at most one sample (its nearest neighbor).
 */
function horizontalGapSamples(
  index: SpatialIndex<LayoutBlock>,
  cap: number
): number[] {
  const gaps: number[] = [];
  for (const entry of index.entries()) {
    let best: number | undefined;
    for (const candidate of index.searchNearby(entry.bbox, cap)) {
      if (candidate.key === entry.key) continue;
      if (candidate.value.page !== entry.value.page) continue;
      if (verticalOverlap(entry.bbox, candidate.bbox) > 0) {
        const gap = horizontalGap(entry.bbox, candidate.bbox);
        if (gap > 0 && (best === undefined || gap < best)) best = gap;
      }
    }
    if (best !== undefined) gaps.push(best);
  }
  return gaps;
}

/**
 * Per block, the gap to its nearest vertically-adjacent block sharing
 * horizontal extent.
 */
function verticalGapSamples(
  index: SpatialIndex<LayoutBlock>,
  cap: number
): number[] {
  const gaps: number[] = [];
  for (const entry of index.entries()) {
    let best: number | undefined;
    for (const candidate of index.searchNearby(entry.bbox, cap)) {
      if (candidate.key === entry.key) continue;
      if (candidate.value.page !== entry.value.page) continue;
      if (horizontalOverlap(entry.bbox, candidate.bbox) > 0) {
        const gap = verticalGap(entry.bbox, candidate.bbox);
        if (gap > 0 && (best === undefined || gap < best)) best = gap;
      }
    }
    if (best !== undefined) gaps.push(best);
  }
  return gaps;
}

function resolvePageSize(
  ocr: OcrDocument,
  option?: { readonly width: number; readonly height: number }
): { width: number; height: number } {
  if (option !== undefined) {
    if (!Number.isFinite(option.width) || option.width <= 0) {
      throw new RangeError("pageSize.width must be a positive finite number");
    }
    if (!Number.isFinite(option.height) || option.height <= 0) {
      throw new RangeError("pageSize.height must be a positive finite number");
    }
    return { width: option.width, height: option.height };
  }
  const positioned: BBox[] = [];
  for (const line of ocr.lines) {
    for (const word of line.words) {
      if (word.bbox) positioned.push(word.bbox);
    }
  }
  const union =
    positioned.length > 0 ? unionBoxes(positioned) : undefined;
  if (union === undefined) return { width: 1, height: 1 };
  return {
    width: union.width > 0 ? union.width : 1,
    height: union.height > 0 ? union.height : 1,
  };
}
