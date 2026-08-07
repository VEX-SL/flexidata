/**
 * Shared helpers for Milestone 5 region tests — build manual hierarchies with
 * exact region geometry so classification scenarios are fully controlled.
 */
import {
  HIERARCHY_DOCUMENT_ID,
  HIERARCHY_ROOT_LEVEL,
  NODE_LEVEL,
  REGION_TYPE,
  LayoutHierarchy,
  createConfidenceProfile,
  createHierarchyNode,
  normalizeBox,
} from "@/lib/layout";
import type { HierarchyNode } from "@/lib/layout";
import type { BBox } from "@/lib/pipeline/types";

export interface BlockSpec {
  id: string;
  bbox: BBox;
  wordCount: number;
}

export interface RegionSpec {
  id: string;
  bbox: BBox;
  blocks: readonly BlockSpec[];
}

export interface PageSpec {
  id: string;
  bbox: BBox;
  regions: readonly RegionSpec[];
}

const neutral = createConfidenceProfile([]);

export function buildRegionHierarchy(page: PageSpec): LayoutHierarchy {
  const nodes: HierarchyNode[] = [];
  const add = (node: HierarchyNode): void => {
    nodes.push(node);
  };

  const doc = createHierarchyNode({
    id: HIERARCHY_DOCUMENT_ID,
    level: HIERARCHY_ROOT_LEVEL,
    parentId: null,
    pageIndex: -1,
    bbox: page.bbox,
    normalizedBBox: normalizeBox(page.bbox, page.bbox.width, page.bbox.height),
    confidence: neutral,
    children: [page.id],
    sourceRefs: [],
    metadata: {},
  });
  add(doc);

  const regionIds = page.regions.map((r) => r.id);
  add(
    createHierarchyNode({
      id: page.id,
      level: NODE_LEVEL.PAGE,
      parentId: HIERARCHY_DOCUMENT_ID,
      pageIndex: 0,
      bbox: page.bbox,
      normalizedBBox: normalizeBox(page.bbox, page.bbox.width, page.bbox.height),
      confidence: neutral,
      children: regionIds,
      sourceRefs: [],
      metadata: { index: 0 },
    })
  );

  for (const region of page.regions) {
    const blockIds = region.blocks.map((b) => b.id);
    add(
      createHierarchyNode({
        id: region.id,
        level: NODE_LEVEL.REGION,
        parentId: page.id,
        pageIndex: 0,
        bbox: region.bbox,
        normalizedBBox: normalizeBox(
          region.bbox,
          page.bbox.width,
          page.bbox.height
        ),
        confidence: neutral,
        children: blockIds,
        sourceRefs: [],
        metadata: {},
        regionType: REGION_TYPE.UNKNOWN,
      })
    );

    for (const block of region.blocks) {
      const lineId = `${block.id}-line`;
      add(
        createHierarchyNode({
          id: block.id,
          level: NODE_LEVEL.BLOCK,
          parentId: region.id,
          pageIndex: 0,
          bbox: block.bbox,
          normalizedBBox: normalizeBox(
            block.bbox,
            page.bbox.width,
            page.bbox.height
          ),
          confidence: neutral,
          children: [lineId],
          sourceRefs: [],
          metadata: {},
        })
      );

      const wordIds: string[] = [];
      for (let i = 0; i < block.wordCount; i++) {
        const wordId = `${block.id}-w${i}`;
        wordIds.push(wordId);
        const perCol = 6;
        const col = i % perCol;
        const r = Math.floor(i / perCol);
        const ww = block.bbox.width / perCol;
        const wh = block.bbox.height / Math.max(1, Math.ceil(block.wordCount / perCol));
        add(
          createHierarchyNode({
            id: wordId,
            level: NODE_LEVEL.WORD,
            parentId: lineId,
            pageIndex: 0,
            bbox: {
              x: block.bbox.x + col * ww,
              y: block.bbox.y + r * wh,
              width: ww,
              height: wh,
            },
            normalizedBBox: normalizeBox(
              {
                x: block.bbox.x + col * ww,
                y: block.bbox.y + r * wh,
                width: ww,
                height: wh,
              },
              page.bbox.width,
              page.bbox.height
            ),
            confidence: neutral,
            children: [],
            sourceRefs: [],
            metadata: { index: i },
          })
        );
      }

      add(
        createHierarchyNode({
          id: lineId,
          level: NODE_LEVEL.LINE,
          parentId: block.id,
          pageIndex: 0,
          bbox: block.bbox,
          normalizedBBox: normalizeBox(
            block.bbox,
            page.bbox.width,
            page.bbox.height
          ),
          confidence: neutral,
          children: wordIds,
          sourceRefs: [],
          metadata: {},
        })
      );
    }
  }

  return new LayoutHierarchy(nodes);
}

/** A box literal helper. */
export function box(x: number, y: number, w: number, h: number): BBox {
  return { x, y, width: w, height: h };
}
