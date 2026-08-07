/**
 * Milestone 11 — layout-aware reader.
 *
 * The single seam that replaces raw OCR-array scanning inside extraction. The
 * reader builds the immutable M9 `LayoutResult` for an OCR document through
 * the existing `LayoutPipeline` (cached, deterministic) and exposes the
 * `LayoutExtractorAdapter` when the build succeeded — never touching OCR
 * directly itself.
 *
 * The layout surface offered here is structural only (reusing the M10 reader /
 * query / evidence layers verbatim):
 *   - `documentText()`: the layout-guided document text for the extraction
 *     prompt — lines grouped by region, each region read in reading order,
 *     nothing skipped. Falls back to the OCR-only text when layout is
 *     unavailable so a layout failure changes nothing.
 *   - scope line lookup for the evidence priority ladder (explicit region →
 *     reading-order neighbors → same block → same page → whole document).
 *
 * Failure handling: when the pipeline reports a failure the reader degrades to
 * OCR-only (`isLayoutAvailable === false`) — extraction never fails because
 * layout failed, and no layout context is ever fabricated.
 */
import type { OcrDocument } from "@/lib/pipeline/types";
import {
  buildLayoutPipeline,
  createLayoutExtractorAdapter,
  isLayoutSuccess,
} from "@/lib/layout";
import type {
  HierarchyNode,
  LayoutContext,
  LayoutEvidenceEntry,
  LayoutExtractorAdapter,
  LayoutFailure,
  LayoutResult,
  RegionType,
} from "@/lib/layout";
import { NODE_LEVEL } from "@/lib/layout";

/** The distance the reading-order-neighbors scope walks beyond a region. */
export const READING_NEIGHBOR_WINDOW = 3;

/** Anything a layout provider must do for the reader (injectable for tests). */
export interface LayoutBuilder {
  build(ocr: OcrDocument): LayoutResult;
}

/** Shared deterministic pipeline — identical OCR always rebuilds identically. */
const DEFAULT_BUILDER: LayoutBuilder = buildLayoutPipeline();

/** A line node plus the structural facts the evidence ladder needs. */
export interface LayoutLineView {
  readonly node: HierarchyNode;
  /** Region type of the line's containing REGION (undefined when unknown). */
  readonly regionType: RegionType | undefined;
  /** Id of the line's containing BLOCK, or null. */
  readonly blockId: string | null;
  /** Page index of the line. */
  readonly pageIndex: number;
  /** 0-based reading-order position, or null when the order is unavailable. */
  readonly readingPosition: number | null;
  /** 0-based index in the hierarchy's pre-order (deterministic tie-break). */
  readonly preOrder: number;
}

export class LayoutAwareReader {
  /** The OCR this reader was built from (never mutated). */
  readonly ocr: OcrDocument;
  /** The full layout outcome (context + failure). */
  readonly result: LayoutResult;
  /** The immutable layout context (a broken context on failure). */
  readonly context: LayoutContext;
  /** The M10 adapter when the layout succeeded, else null. */
  readonly adapter: LayoutExtractorAdapter | null;
  /** The layout failure when the build failed, else undefined. */
  readonly failure: LayoutFailure | undefined;

  /** All line views in reading order (pre-order tie-break). */
  private readonly lineViews: readonly LayoutLineView[];

  constructor(ocr: OcrDocument, builder: LayoutBuilder = DEFAULT_BUILDER) {
    this.ocr = ocr;
    this.result = builder.build(ocr);
    this.context = this.result.context;
    this.failure = this.result.failure;
    this.adapter = isLayoutSuccess(this.result)
      ? createLayoutExtractorAdapter(this.result.context)
      : null;
    this.lineViews = this.adapter === null
      ? Object.freeze([])
      : this.buildLineViews(this.adapter);
    Object.freeze(this);
  }

  /** True when a usable layout exists; false on failure (OCR-only fallback). */
  get isLayoutAvailable(): boolean {
    return this.adapter !== null;
  }

  /** True when the layout pipeline reported a failure. */
  get isBroken(): boolean {
    return this.failure !== undefined;
  }

  /**
   * The layout-guided document text for extraction prompts: every line,
   * grouped by its region, each region's lines read in reading order, nothing
   * skipped. `fallbackText` (the previous prompt input) is returned verbatim
   * when layout is unavailable so the OCR-only path is byte-identical.
   */
  documentText(fallbackText?: string): string {
    if (this.adapter === null || this.lineViews.length === 0) {
      return fallbackText ?? this.ocr.text;
    }
    const regionIds: string[] = [];
    const linesByRegion = new Map<string, LayoutLineView[]>();
    const orphanLines: LayoutLineView[] = [];
    const seenRegion = new Set<string>();
    for (const view of this.lineViews) {
      const regionId = this.regionIdOf(view.node);
      if (regionId === null) {
        orphanLines.push(view);
        continue;
      }
      if (!seenRegion.has(regionId)) {
        seenRegion.add(regionId);
        regionIds.push(regionId);
        linesByRegion.set(regionId, []);
      }
      linesByRegion.get(regionId)!.push(view);
    }
    const parts: string[] = [];
    for (const regionId of regionIds) {
      for (const view of linesByRegion.get(regionId)!) {
        const text = this.lineText(view.node.id);
        if (text.length > 0) parts.push(text);
      }
    }
    for (const view of orphanLines) {
      const text = this.lineText(view.node.id);
      if (text.length > 0) parts.push(text);
    }
    if (parts.length === 0) return fallbackText ?? this.ocr.text;
    return parts.join("\n");
  }

  /** All line views in reading order (frozen). */
  allLineViews(): readonly LayoutLineView[] {
    return this.lineViews;
  }

  /** Line views inside the regions of the given types, in reading order. */
  linesInRegionTypes(
    types: readonly RegionType[],
    exclude: ReadonlySet<string> = EMPTY_SET
  ): readonly LayoutLineView[] {
    const allowed = new Set(types);
    if (allowed.size === 0) return Object.freeze([]);
    return Object.freeze(
      this.lineViews.filter(
        (view) =>
          !exclude.has(view.node.id) &&
          view.regionType !== undefined &&
          allowed.has(view.regionType)
      )
    );
  }

  /**
   * The reading-order neighbors of the anchor line views: every line within
   * `READING_NEIGHBOR_WINDOW` positions before the earliest anchor and after
   * the latest anchor in the document's line reading sequence, excluding the
   * anchors themselves and anything already covered.
   */
  readingNeighborLines(
    anchors: readonly LayoutLineView[],
    exclude: ReadonlySet<string> = EMPTY_SET
  ): readonly LayoutLineView[] {
    if (anchors.length === 0) return Object.freeze([]);
    const positions = anchors
      .map((view) => view.readingPosition)
      .filter((p): p is number => p !== null);
    if (positions.length === 0) return Object.freeze([]);
    const min = Math.min(...positions);
    const max = Math.max(...positions);
    const anchorIds = new Set(anchors.map((view) => view.node.id));
    return Object.freeze(
      this.lineViews.filter(
        (view) =>
          !exclude.has(view.node.id) &&
          !anchorIds.has(view.node.id) &&
          view.readingPosition !== null &&
          view.readingPosition >= min - READING_NEIGHBOR_WINDOW &&
          view.readingPosition <= max + READING_NEIGHBOR_WINDOW
      )
    );
  }

  /** Line views of the given blocks, in reading order. */
  linesInBlocks(
    blockIds: readonly string[],
    exclude: ReadonlySet<string> = EMPTY_SET
  ): readonly LayoutLineView[] {
    const blocks = new Set(blockIds);
    if (blocks.size === 0) return Object.freeze([]);
    return Object.freeze(
      this.lineViews.filter(
        (view) =>
          !exclude.has(view.node.id) &&
          view.blockId !== null &&
          blocks.has(view.blockId)
      )
    );
  }

  /** Line views on the given pages, in reading order. */
  linesOnPage(
    pageIndices: readonly number[],
    exclude: ReadonlySet<string> = EMPTY_SET
  ): readonly LayoutLineView[] {
    const pages = new Set(pageIndices);
    if (pages.size === 0) return Object.freeze([]);
    return Object.freeze(
      this.lineViews.filter(
        (view) => !exclude.has(view.node.id) && pages.has(view.pageIndex)
      )
    );
  }

  /** The block ids containing the given line views (deterministic order). */
  blockIdsOf(lines: readonly LayoutLineView[]): readonly string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const view of lines) {
      if (view.blockId === null || seen.has(view.blockId)) continue;
      seen.add(view.blockId);
      out.push(view.blockId);
    }
    return Object.freeze(out);
  }

  /** The page indices containing the given line views (deterministic order). */
  pageIndicesOf(lines: readonly LayoutLineView[]): readonly number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    for (const view of lines) {
      if (seen.has(view.pageIndex)) continue;
      seen.add(view.pageIndex);
      out.push(view.pageIndex);
    }
    return Object.freeze(out);
  }

  /** Verbatim OCR text of a line (through the M10 evidence layer). */
  lineText(lineId: string): string {
    return this.adapter?.evidence.for(lineId)?.text ?? "";
  }

  /** Word descendant nodes of a line, in pre-order (empty for unknown ids). */
  wordsOfLine(lineId: string): readonly HierarchyNode[] {
    return (
      this.adapter?.reader
        .children(lineId)
        .filter((node) => node.level === NODE_LEVEL.WORD) ?? EMPTY_NODES
    );
  }

  /** The M10 evidence entry for a node, or undefined for unknown ids. */
  evidenceFor(nodeId: string): LayoutEvidenceEntry | undefined {
    return this.adapter?.evidence.for(nodeId);
  }

  /** Verbatim OCR text of a word node (through the M10 evidence layer). */
  wordText(wordId: string): string {
    return this.adapter?.evidence.for(wordId)?.text ?? "";
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private buildLineViews(adapter: LayoutExtractorAdapter): readonly LayoutLineView[] {
    const preOrder = new Map(
      adapter.reader.lines().map((node, index) => [node.id, index])
    );
    const views: LayoutLineView[] = [];
    for (const node of adapter.reader.lines()) {
      const regionId = this.regionIdOf(node);
      const region = regionId === null ? null : adapter.reader.get(regionId);
      const blockId = this.blockIdOf(node);
      const readingPosition = adapter.reader.readingPosition(node.id);
      views.push(
        Object.freeze({
          node,
          regionType: region?.level === NODE_LEVEL.REGION
            ? region.regionType
            : undefined,
          blockId,
          pageIndex: node.pageIndex,
          readingPosition: readingPosition === undefined ? null : readingPosition,
          preOrder: preOrder.get(node.id) ?? 0,
        })
      );
    }
    views.sort(compareLineViews);
    return Object.freeze(views.map((view) => Object.freeze(view)));
  }

  private regionIdOf(node: HierarchyNode): string | null {
    if (this.adapter === null) return null;
    let current = this.adapter.reader.parent(node.id);
    while (current !== null) {
      if (current.level === NODE_LEVEL.REGION) return current.id;
      current = this.adapter.reader.parent(current.id);
    }
    return null;
  }

  private blockIdOf(node: HierarchyNode): string | null {
    if (this.adapter === null) return null;
    let current = this.adapter.reader.parent(node.id);
    while (current !== null) {
      if (current.level === NODE_LEVEL.BLOCK) return current.id;
      current = this.adapter.reader.parent(current.id);
    }
    return null;
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_NODES: readonly HierarchyNode[] = Object.freeze([]);

/** Deterministic line order: reading position, then pre-order index. */
function compareLineViews(a: LayoutLineView, b: LayoutLineView): number {
  const ap = a.readingPosition;
  const bp = b.readingPosition;
  if (ap !== null && bp !== null && ap !== bp) return ap - bp;
  if (ap === null && bp !== null) return 1;
  if (ap !== null && bp === null) return -1;
  if (a.preOrder !== b.preOrder) return a.preOrder - b.preOrder;
  return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
}
