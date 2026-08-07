/**
 * Milestone 10 — layout selection.
 *
 * Deterministic candidate selection for extractors. Candidates are filtered
 * only by structure and measurement — region type, hierarchy level, reading
 * order, confidence, containment and geometry — and never by text meaning,
 * classification or entity inference. Identical criteria always yield
 * identical frozen results.
 */
import type { BBox } from "@/lib/pipeline/types";
import type { HierarchyLevel, HierarchyNode } from "./hierarchy";
import { NODE_LEVEL } from "./node-levels";
import type { RegionType } from "./region-types";
import { boxContains } from "./geometry";
import { LayoutReader } from "./layout-reader";

/** The deterministic filters and ordering a selection applies. */
export interface LayoutSelectionCriteria {
  /** Keep only candidates inside regions of this type. */
  readonly regionType?: RegionType;
  /** Candidate level; defaults to Word. */
  readonly level?: HierarchyLevel;
  /** Keep only candidates whose composite confidence mean is at least this. */
  readonly minConfidence?: number;
  /** Keep only candidates whose composite confidence mean is at most this. */
  readonly maxConfidence?: number;
  /** Node id or box that every candidate's box must be contained by. */
  readonly containedIn?: string | BBox;
  /** Box that every candidate's box must contain. */
  readonly containing?: BBox;
  /** Result order: reading order (default) or pre-order. */
  readonly order?: "reading" | "pre";
}

/** The immutable outcome of a selection. */
export interface LayoutSelectionResult {
  readonly nodeIds: readonly string[];
  readonly count: number;
}

/** Shared empty result for selections that match nothing. */
const EMPTY_NODES: readonly HierarchyNode[] = Object.freeze([]);

export class LayoutSelection {
  /** The reader this selection layer navigates (never mutated). */
  readonly reader: LayoutReader;

  constructor(reader: LayoutReader) {
    this.reader = reader;
    Object.freeze(this);
  }

  /** Select candidate node ids; always frozen and deterministic. */
  select(criteria: LayoutSelectionCriteria = {}): LayoutSelectionResult {
    const nodes = this.selectNodes(criteria);
    return Object.freeze({
      nodeIds: Object.freeze(nodes.map((node) => node.id)),
      count: nodes.length,
    });
  }

  /** Select candidate nodes; always frozen and deterministic. */
  selectNodes(criteria: LayoutSelectionCriteria = {}): readonly HierarchyNode[] {
    const level = criteria.level ?? NODE_LEVEL.WORD;
    const regionType = criteria.regionType;
    const minConfidence = criteria.minConfidence;
    const maxConfidence = criteria.maxConfidence;
    const containing = criteria.containing;

    const containedIn = this.resolveBox(criteria.containedIn);
    if (criteria.containedIn !== undefined && containedIn === undefined) {
      return EMPTY_NODES;
    }

    let candidates = this.reader
      .nodes()
      .filter((node) => node.level === level);

    if (regionType !== undefined) {
      candidates = candidates.filter(
        (node) => this.regionTypeOf(node) === regionType
      );
    }
    if (minConfidence !== undefined) {
      candidates = candidates.filter(
        (node) => node.confidence.aggregate.mean >= minConfidence
      );
    }
    if (maxConfidence !== undefined) {
      candidates = candidates.filter(
        (node) => node.confidence.aggregate.mean <= maxConfidence
      );
    }
    if (containedIn !== undefined) {
      candidates = candidates.filter((node) =>
        boxContains(containedIn, node.bbox)
      );
    }
    if (containing !== undefined) {
      candidates = candidates.filter((node) =>
        boxContains(node.bbox, containing)
      );
    }

    const ordered = [...candidates];
    if ((criteria.order ?? "reading") === "reading") {
      ordered.sort((a, b) => this.compareReadingOrder(a, b));
    }
    return Object.freeze(ordered);
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private compareReadingOrder(a: HierarchyNode, b: HierarchyNode): number {
    const pa = this.reader.readingPosition(a.id);
    const pb = this.reader.readingPosition(b.id);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  private regionTypeOf(node: HierarchyNode): RegionType | undefined {
    let current: HierarchyNode | undefined = node;
    while (current !== undefined) {
      if (current.level === NODE_LEVEL.REGION) return current.regionType;
      current = this.reader.parent(current.id) ?? undefined;
    }
    return undefined;
  }

  private resolveBox(value: string | BBox | undefined): BBox | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string") return this.reader.get(value)?.bbox;
    return value;
  }
}
