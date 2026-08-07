/**
 * Milestone 10 — the layout reader.
 *
 * The immutable navigation layer over the M9 `LayoutContext`. The reader is a
 * pure view: it never mutates the context, never traverses OCR directly and
 * never performs extraction. Every query answers from the frozen structural
 * components the context already owns (`hierarchy`, `readingOrder`).
 *
 * Surface:
 *   - level iteration: regions / blocks / lines / words (deterministic
 *     pre-order, from `nodesAtLevel`);
 *   - node lookup by id and by source reference;
 *   - parent / children / ancestors / descendants / siblings / depth;
 *   - reading-order navigation: `readingNext` / `readingPrevious` /
 *     `readingPosition`, plus the raw `readingNodes` sequence.
 *
 * Contract: all results are frozen; unknown lookups yield empty frozen views
 * (or `undefined` / `null`) instead of throwing; a broken context (missing
 * components) degrades to the same empty views. Source references are used
 * exactly as indices into the structural components — the reader never touches
 * OCR, and the evidence/selection layers resolve text through those refs only.
 */
import type { OcrDocument } from "@/lib/pipeline/types";
import type { LayoutContext } from "./layout-context";
import { layoutSourceOcr } from "./layout-context";
import type {
  HierarchyLevel,
  HierarchyNode,
  HierarchySourceRef,
  LayoutHierarchy,
} from "./hierarchy";
import { NODE_LEVEL } from "./node-levels";
import type { ReadingOrderNode } from "./reading-order";

/** Shared frozen empty node list for unknown/broken lookups. */
const EMPTY_NODES: readonly HierarchyNode[] = Object.freeze([]);
/** Shared frozen empty reading-order list. */
const EMPTY_READING_NODES: readonly ReadingOrderNode[] = Object.freeze([]);

/** Deterministic identity of a source reference (used exactly as an index). */
function refKey(ref: HierarchySourceRef): string {
  return `${ref.pageIndex}:${ref.lineIndex}:${ref.wordIndex ?? "-"}`;
}

export class LayoutReader {
  /** The context this reader navigates (never mutated). */
  readonly context: LayoutContext;

  /** Node ids indexed by exact source-reference key, in pre-order. */
  private readonly byRef: ReadonlyMap<string, readonly string[]>;

  constructor(context: LayoutContext) {
    this.context = context;
    this.byRef = buildRefIndex(context.hierarchy);
    Object.freeze(this);
  }

  /** True when the context carries the hierarchy needed for navigation. */
  get isAvailable(): boolean {
    return this.context.hierarchy !== null;
  }

  /** The source OCR the context was projected from, when available. */
  get sourceOcr(): OcrDocument | undefined {
    return layoutSourceOcr(this.context);
  }

  // ─── Node lookup ───────────────────────────────────────────────────────────

  /** Look up a node by id. */
  get(id: string): HierarchyNode | undefined {
    return this.context.hierarchy?.get(id);
  }

  has(id: string): boolean {
    return this.context.hierarchy?.has(id) ?? false;
  }

  /** All nodes in deterministic pre-order (frozen). */
  nodes(): readonly HierarchyNode[] {
    return this.context.hierarchy?.nodes() ?? EMPTY_NODES;
  }

  // ─── Level iteration ───────────────────────────────────────────────────────

  /** All REGION nodes in pre-order (frozen). */
  regions(): readonly HierarchyNode[] {
    return this.atLevel(NODE_LEVEL.REGION);
  }

  /** All BLOCK nodes in pre-order (frozen). */
  blocks(): readonly HierarchyNode[] {
    return this.atLevel(NODE_LEVEL.BLOCK);
  }

  /** All LINE nodes in pre-order (frozen). */
  lines(): readonly HierarchyNode[] {
    return this.atLevel(NODE_LEVEL.LINE);
  }

  /** All WORD nodes in pre-order (frozen). */
  words(): readonly HierarchyNode[] {
    return this.atLevel(NODE_LEVEL.WORD);
  }

  /** All nodes of one level in pre-order (frozen). */
  atLevel(level: HierarchyLevel): readonly HierarchyNode[] {
    return this.context.hierarchy?.nodesAtLevel(level) ?? EMPTY_NODES;
  }

  // ─── Structural navigation ─────────────────────────────────────────────────

  /** Parent of a node, or null for the root/unknown ids. */
  parent(id: string): HierarchyNode | null {
    return this.context.hierarchy?.parentOf(id) ?? null;
  }

  /** Children of a node, in deterministic order. Empty for unknown ids. */
  children(id: string): readonly HierarchyNode[] {
    return this.context.hierarchy?.childrenOf(id) ?? EMPTY_NODES;
  }

  /** All ancestors, coarsest first. Empty for unknown ids. */
  ancestors(id: string): readonly HierarchyNode[] {
    return this.context.hierarchy?.ancestorsOf(id) ?? EMPTY_NODES;
  }

  /** All descendants, pre-order, excluding the node itself. */
  descendants(id: string): readonly HierarchyNode[] {
    return this.context.hierarchy?.descendantsOf(id) ?? EMPTY_NODES;
  }

  /** Other children of the node's parent. Empty for the root/unknown ids. */
  siblings(id: string): readonly HierarchyNode[] {
    return this.context.hierarchy?.siblingsOf(id) ?? EMPTY_NODES;
  }

  /** Depth of a node (root is 0); -1 for unknown ids. */
  depthOf(id: string): number {
    return this.context.hierarchy?.depthOf(id) ?? -1;
  }

  // ─── Source-reference lookup ───────────────────────────────────────────────

  /** Every node whose source refs contain a ref equal to `ref`, in pre-order. */
  nodesBySourceRef(ref: HierarchySourceRef): readonly HierarchyNode[] {
    const hierarchy = this.context.hierarchy;
    if (hierarchy === null) return EMPTY_NODES;
    const ids = this.byRef.get(refKey(ref));
    if (ids === undefined) return EMPTY_NODES;
    return Object.freeze(
      ids
        .map((id) => hierarchy.get(id))
        .filter((node): node is HierarchyNode => node !== undefined)
    );
  }

  /**
   * The finest node owning the primitive at `ref`: the word node when a word
   * index is given, the line node otherwise. Undefined when nothing matches.
   */
  nodeBySourceRef(ref: HierarchySourceRef): HierarchyNode | undefined {
    let best: HierarchyNode | undefined;
    let bestDepth = -1;
    for (const node of this.nodesBySourceRef(ref)) {
      const depth = this.depthOf(node.id);
      if (best === undefined || depth > bestDepth) {
        best = node;
        bestDepth = depth;
      }
    }
    return best;
  }

  // ─── Reading-order navigation ──────────────────────────────────────────────

  /** The next node in reading order, or undefined at the end/unknown ids. */
  readingNext(id: string): HierarchyNode | undefined {
    return this.mapReadingNode(this.context.readingOrder?.next(id));
  }

  /** The previous node in reading order, or undefined at the start/unknown ids. */
  readingPrevious(id: string): HierarchyNode | undefined {
    return this.mapReadingNode(this.context.readingOrder?.prev(id));
  }

  /** 0-based position of a node in the produced reading sequence. */
  readingPosition(id: string): number | undefined {
    return this.context.readingOrder?.positionOf(id);
  }

  /** All reading-order nodes, in the produced sequence (frozen). */
  readingNodes(): readonly ReadingOrderNode[] {
    return this.context.readingOrder?.nodes() ?? EMPTY_READING_NODES;
  }

  private mapReadingNode(
    node: ReadingOrderNode | undefined
  ): HierarchyNode | undefined {
    if (node === undefined) return undefined;
    return this.context.hierarchy?.get(node.id);
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function buildRefIndex(
  hierarchy: LayoutHierarchy | null
): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  if (hierarchy !== null) {
    for (const node of hierarchy.nodes()) {
      for (const ref of node.sourceRefs) {
        const key = refKey(ref);
        const list = index.get(key);
        if (list === undefined) index.set(key, [node.id]);
        else list.push(node.id);
      }
    }
  }
  const out = new Map<string, readonly string[]>();
  for (const [key, ids] of index) {
    out.set(key, Object.freeze([...ids]));
  }
  return out;
}
