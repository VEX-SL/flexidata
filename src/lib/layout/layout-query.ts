/**
 * Milestone 10 — the layout query layer.
 *
 * Deterministic navigation queries over the `LayoutReader`. The query layer
 * filters ONLY by structure — region type, hierarchy level, membership,
 * geometry and reading order. It never inspects OCR text, never classifies
 * and never infers entities, so it is safe for extractors to build on.
 *
 * All results are frozen copies; unknown targets yield empty views or
 * `undefined`. Ordering is deterministic everywhere: pre-order by default,
 * reading order for the reading-order query, and id for geometry ties.
 */
import type { HierarchyLevel, HierarchyNode } from "./hierarchy";
import { NODE_LEVEL } from "./node-levels";
import type { RegionType } from "./region-types";
import { boxContains, centerDistance } from "./geometry";
import { LayoutReader } from "./layout-reader";

/** Shared frozen empty node list for unknown lookups. */
const EMPTY: readonly HierarchyNode[] = Object.freeze([]);

/** Result of `findNearest`: the nearest node and its center distance. */
export interface NearestResult {
  readonly node: HierarchyNode;
  readonly distance: number;
}

export class LayoutQuery {
  /** The reader this query navigates (never mutated). */
  readonly reader: LayoutReader;

  constructor(reader: LayoutReader) {
    this.reader = reader;
    Object.freeze(this);
  }

  /** Regions, optionally filtered by region type, in pre-order. */
  findRegions(type?: RegionType): readonly HierarchyNode[] {
    const regions = this.reader.regions();
    if (type === undefined) return regions;
    return Object.freeze(
      regions.filter((region) => region.regionType === type)
    );
  }

  /** BLOCK descendants of a region, in pre-order. Empty for unknown ids. */
  findBlocks(region: string | HierarchyNode): readonly HierarchyNode[] {
    const target = this.resolve(region);
    if (target === undefined) return EMPTY;
    return this.descendantsAt(target.id, NODE_LEVEL.BLOCK);
  }

  /** LINE descendants of a block, in pre-order. Empty for unknown ids. */
  findLines(block: string | HierarchyNode): readonly HierarchyNode[] {
    const target = this.resolve(block);
    if (target === undefined) return EMPTY;
    return this.descendantsAt(target.id, NODE_LEVEL.LINE);
  }

  /** WORD descendants of a line, in pre-order. Empty for unknown ids. */
  findWords(line: string | HierarchyNode): readonly HierarchyNode[] {
    const target = this.resolve(line);
    if (target === undefined) return EMPTY;
    return this.descendantsAt(target.id, NODE_LEVEL.WORD);
  }

  /** Every word inside regions (optionally of one type), in pre-order. */
  findWordsInRegion(type?: RegionType): readonly HierarchyNode[] {
    const out: HierarchyNode[] = [];
    for (const region of this.findRegions(type)) {
      for (const node of this.reader.descendants(region.id)) {
        if (node.level === NODE_LEVEL.WORD) out.push(node);
      }
    }
    return Object.freeze(out);
  }

  /** Every WORD descendant of a block, in pre-order. Empty for unknown ids. */
  findWordsInBlock(id: string): readonly HierarchyNode[] {
    return this.descendantsAt(id, NODE_LEVEL.WORD);
  }

  /**
   * Every word in reading order. Falls back to pre-order when the context
   * carries no reading-order graph (deterministic either way).
   */
  findWordsInReadingOrder(): readonly HierarchyNode[] {
    const inOrder = this.reader
      .readingNodes()
      .filter((node) => node.level === NODE_LEVEL.WORD);
    if (inOrder.length === 0) return this.reader.words();
    return Object.freeze(
      inOrder
        .map((node) => this.reader.get(node.id))
        .filter((node): node is HierarchyNode => node !== undefined)
    );
  }

  /**
   * The single nearest other node by center distance. Ties break on id, so
   * the result is always deterministic. Undefined for unknown ids.
   */
  findNearest(node: string | HierarchyNode): NearestResult | undefined {
    const target = this.resolve(node);
    if (target === undefined) return undefined;
    let best: NearestResult | undefined;
    for (const candidate of this.reader.nodes()) {
      if (candidate.id === target.id) continue;
      const distance = centerDistance(target.bbox, candidate.bbox);
      if (
        best === undefined ||
        distance < best.distance ||
        (distance === best.distance && candidate.id < best.node.id)
      ) {
        best = { node: candidate, distance };
      }
    }
    return best;
  }

  /** Every other node whose box fully contains the target's box, in pre-order. */
  findContaining(node: string | HierarchyNode): readonly HierarchyNode[] {
    const target = this.resolve(node);
    if (target === undefined) return EMPTY;
    return Object.freeze(
      this.reader
        .nodes()
        .filter(
          (candidate) =>
            candidate.id !== target.id &&
            boxContains(candidate.bbox, target.bbox)
        )
    );
  }

  /** Every other node whose box is fully contained by the target's box, in pre-order. */
  findContained(node: string | HierarchyNode): readonly HierarchyNode[] {
    const target = this.resolve(node);
    if (target === undefined) return EMPTY;
    return Object.freeze(
      this.reader
        .nodes()
        .filter(
          (candidate) =>
            candidate.id !== target.id &&
            boxContains(target.bbox, candidate.bbox)
        )
    );
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private descendantsAt(
    id: string,
    level: HierarchyLevel
  ): readonly HierarchyNode[] {
    return Object.freeze(
      this.reader.descendants(id).filter((node) => node.level === level)
    );
  }

  private resolve(node: string | HierarchyNode): HierarchyNode | undefined {
    if (typeof node === "string") return this.reader.get(node);
    return node;
  }
}
