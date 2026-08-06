/**
 * Layout domain models — the structural vocabulary of the layout layer.
 *
 * Milestone 1 defines the models only: identity, geometry, source links back
 * into OCR, and confidence summaries. Roles, region membership semantics and
 * reading-order live in later milestones and extend these models additively.
 *
 * Immutability: all fields are readonly; the constructor module (models.ts)
 * additionally deep-freezes every produced value.
 */
import type { BBox } from "@/lib/pipeline/types";
import type { OcrDocument } from "@/lib/pipeline/types";

/** The layout contract version. Bumped only when the layout model changes. */
export const LAYOUT_VERSION = 1;

/** Re-exported box model — the layout layer reuses it, never duplicates it. */
export type { BBox };

/** Stable identity of a layout node (word-, line- or block-level element). */
export type LayoutNodeId = string;

/** Stable identity of a layout region (a spatial group of nodes). */
export type LayoutRegionId = string;

/** 0-based page index. */
export type LayoutPageIndex = number;

/**
 * Link back to the source OCR primitive that produced a layout element, so
 * evidence/layout consumers can resolve layout elements into OCR spans.
 */
export interface LayoutSourceRef {
  /** 0-based line index into the source OcrDocument. */
  readonly lineIndex: number;
  /** 0-based word index within the line, when the element is a word. */
  readonly wordIndex?: number;
}

/**
 * Summary statistics of a confidence signal over a set of tokens. The raw
 * values live on the source OCR tokens; the layout layer carries the
 * distribution (propagation algorithms are a later milestone).
 */
export interface ConfidenceDistribution {
  /** Number of tokens summarized. */
  readonly count: number;
  /** Arithmetic mean over the tokens. */
  readonly mean: number;
  /** Population variance over the tokens. */
  readonly variance: number;
  /** Minimum token value. */
  readonly min: number;
  /** Maximum token value. */
  readonly max: number;
}

/** A positioned layout element (a word, a line, or later a composite block). */
export interface LayoutNode {
  readonly id: LayoutNodeId;
  /** Page this node belongs to. */
  readonly page: LayoutPageIndex;
  /** Visual box in page coordinates (pixels or normalized space). */
  readonly bbox: BBox;
  /** Confidence distribution over this element's tokens. */
  readonly confidence: ConfidenceDistribution;
  /** Link back to the source OCR primitive, when available. */
  readonly source?: LayoutSourceRef;
}

/** A spatial grouping of nodes (block/zone). Roles arrive with region inference. */
export interface LayoutRegion {
  readonly id: LayoutRegionId;
  readonly page: LayoutPageIndex;
  /** Union box of the region's content. */
  readonly bbox: BBox;
  /** Nodes contained by this region, in source order. */
  readonly nodeIds: readonly LayoutNodeId[];
}

/** One page of the document. */
export interface LayoutPage {
  readonly index: LayoutPageIndex;
  /** Page bounds in page coordinates. */
  readonly bounds: BBox;
  /** Nodes on this page, in source order. */
  readonly nodeIds: readonly LayoutNodeId[];
  /** Regions on this page, in source order. */
  readonly regionIds: readonly LayoutRegionId[];
}

/** Structural layout of a document: pages, nodes, regions and confidence. */
export interface LayoutDocument {
  readonly version: number;
  readonly pages: readonly LayoutPage[];
  readonly nodes: readonly LayoutNode[];
  readonly regions: readonly LayoutRegion[];
  /**
   * Document-level confidence aggregate (unweighted until the confidence
   * propagation milestone supplies the defined propagation algorithm).
   */
  readonly confidence: ConfidenceDistribution;
  /** Source OCR the layout derives from, when available. */
  readonly source?: OcrDocument;
}
