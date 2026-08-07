/**
 * Reading order graph — the immutable reading-sequence model of the layout
 * layer.
 *
 * Milestone 6 defines the model and its constructor only; derivation
 * (reading-order-builder.ts) and the contract validators
 * (reading-order-validation.ts) are separate modules that build on it.
 *
 * Structure: every hierarchy level forms its own linear reading chain
 * (Word → Line → Block → Region → Page → Document chains), so the graph is a
 * collection of per-level doubly-linked chains. Reading direction is carried
 * by READING_NEXT edges; the reverse direction by READING_PREVIOUS edges, and
 * the two are always mirrors of each other ("edges always bidirectional").
 *
 * The produced reading sequence is the concatenation of the level chains in
 * the milestone's ordering hierarchy (Words first, then Lines, Blocks,
 * Regions, Pages, and finally the single Document node) — see
 * `READING_LEVEL_SEQUENCE`.
 *
 * Determinism: iteration follows construction order; every query view is a
 * frozen copy. The constructor deep-freezes every node/edge it owns.
 *
 * The constructor is structural only: it validates non-empty unique node ids,
 * edge endpoints, self-loops and the reading edge vocabulary. Domain rules
 * (acyclicity, bidirectionality, single successor/predecessor, exact
 * coverage, …) are enforced by the validators in reading-order-validation.ts.
 */
import type { BBox } from "@/lib/pipeline/types";
import type {
  HierarchyLevel,
  HierarchySourceRef,
} from "./hierarchy";
import {
  HIERARCHY_ROOT_LEVEL,
  isHierarchyLevel,
} from "./hierarchy";
import { NODE_LEVEL } from "./node-levels";
import { LAYOUT_EDGE_TYPE } from "./edge-types";

/** The reading direction edge token (Milestone 2 vocabulary reuse). */
export const READING_NEXT = LAYOUT_EDGE_TYPE.READING_NEXT;
/** The reverse-direction edge token (Milestone 2 vocabulary reuse). */
export const READING_PREVIOUS = LAYOUT_EDGE_TYPE.READING_PREVIOUS;

/** The two edge types the reading-order graph understands. */
export type ReadingOrderEdgeType =
  | typeof LAYOUT_EDGE_TYPE.READING_NEXT
  | typeof LAYOUT_EDGE_TYPE.READING_PREVIOUS;

const READING_EDGE_TYPE_SET: ReadonlySet<string> = new Set([
  READING_NEXT,
  READING_PREVIOUS,
]);

/** Runtime guard for reading-order edge types. */
export function isReadingOrderEdgeType(
  value: unknown
): value is ReadingOrderEdgeType {
  return typeof value === "string" && READING_EDGE_TYPE_SET.has(value);
}

/**
 * The levels a reading-order graph covers, finest to coarsest — the exact
 * ordering hierarchy of the milestone. The produced reading sequence is the
 * concatenation of the chains in this order, so Words come first and the
 * single Document container closes the sequence.
 */
export const READING_LEVEL_SEQUENCE: readonly HierarchyLevel[] = [
  NODE_LEVEL.WORD,
  NODE_LEVEL.LINE,
  NODE_LEVEL.BLOCK,
  NODE_LEVEL.REGION,
  NODE_LEVEL.PAGE,
  HIERARCHY_ROOT_LEVEL,
];

/** A node of the reading-order graph. Deep-frozen by the factory. */
export interface ReadingOrderNode {
  readonly id: string;
  readonly level: HierarchyLevel;
  /** Page this node belongs to; -1 for the Document root. */
  readonly pageIndex: number;
  /** Visual box in page coordinates. */
  readonly bbox: BBox;
  /** The bbox mapped onto the unit square of the build's page size. */
  readonly normalizedBBox: BBox;
  /** Source OCR ordering metadata; empty for derived structural containers. */
  readonly sourceRefs: readonly HierarchySourceRef[];
  /** 0-based index in the produced reading sequence. */
  readonly position: number;
}

export interface CreateReadingOrderNodeOptions {
  readonly id: string;
  readonly level: HierarchyLevel;
  readonly pageIndex: number;
  readonly bbox: BBox;
  readonly normalizedBBox: BBox;
  readonly sourceRefs?: readonly HierarchySourceRef[];
  readonly position: number;
}

/**
 * Create an immutable reading-order node. Rejects empty ids, unknown levels,
 * out-of-range page indices, non-finite boxes and invalid positions.
 */
export function createReadingOrderNode(
  opts: CreateReadingOrderNodeOptions
): ReadingOrderNode {
  if (opts.id.length === 0) {
    throw new Error("reading order node id must not be empty");
  }
  if (!isHierarchyLevel(opts.level)) {
    throw new Error(`unknown hierarchy level: ${String(opts.level)}`);
  }
  if (!Number.isInteger(opts.pageIndex) || opts.pageIndex < -1) {
    throw new Error(
      `node ${opts.id} has invalid page index ${opts.pageIndex}`
    );
  }
  if (!isFiniteBox(opts.bbox)) {
    throw new Error(`node ${opts.id} has a non-finite bbox`);
  }
  if (!isFiniteBox(opts.normalizedBBox)) {
    throw new Error(`node ${opts.id} has a non-finite normalized bbox`);
  }
  if (!Number.isInteger(opts.position) || opts.position < 0) {
    throw new Error(`node ${opts.id} has invalid position ${opts.position}`);
  }
  for (const ref of opts.sourceRefs ?? []) {
    if (!Number.isInteger(ref.pageIndex) || ref.pageIndex < 0) {
      throw new Error(`node ${opts.id} has an invalid source page index`);
    }
    if (!Number.isInteger(ref.lineIndex) || ref.lineIndex < 0) {
      throw new Error(`node ${opts.id} has an invalid source line index`);
    }
    if (ref.wordIndex !== undefined) {
      if (!Number.isInteger(ref.wordIndex) || ref.wordIndex < 0) {
        throw new Error(`node ${opts.id} has an invalid source word index`);
      }
    }
  }
  return Object.freeze({
    id: opts.id,
    level: opts.level,
    pageIndex: opts.pageIndex,
    bbox: Object.freeze({ ...opts.bbox }),
    normalizedBBox: Object.freeze({ ...opts.normalizedBBox }),
    sourceRefs: Object.freeze(
      (opts.sourceRefs ?? []).map((ref) => Object.freeze({ ...ref }))
    ),
    position: opts.position,
  });
}

/** A directed reading edge between two reading-order nodes. */
export interface ReadingOrderEdge {
  readonly type: ReadingOrderEdgeType;
  /** Source node id. */
  readonly from: string;
  /** Target node id. */
  readonly to: string;
}

/**
 * The immutable reading-order graph of a document.
 *
 * The constructor validates the structural shape (non-empty unique node ids,
 * known reading edge types, edges between registered distinct nodes) and then
 * deep-freezes every owned value. Duplicate edges, cross-level edges and
 * un-mirrored edges are accepted structurally — the Milestone 6 validators
 * are the layer that rejects them, so a hand-crafted graph can be probed.
 */
export class ReadingOrderGraph {
  private readonly byId: ReadonlyMap<string, ReadingOrderNode>;
  private readonly nodeOrder: readonly ReadingOrderNode[];
  private readonly edgeOrder: readonly ReadingOrderEdge[];
  private readonly edgesByType: ReadonlyMap<
    ReadingOrderEdgeType,
    readonly ReadingOrderEdge[]
  >;
  private readonly successors: ReadonlyMap<
    ReadingOrderEdgeType,
    ReadonlyMap<string, readonly string[]>
  >;
  private readonly predecessors: ReadonlyMap<
    ReadingOrderEdgeType,
    ReadonlyMap<string, readonly string[]>
  >;

  constructor(
    nodes: readonly ReadingOrderNode[],
    edges: readonly ReadingOrderEdge[]
  ) {
    if (nodes.length === 0) {
      throw new Error("reading order graph requires at least one node");
    }
    const byId = new Map<string, ReadingOrderNode>();
    for (const node of nodes) {
      if (node.id.length === 0) {
        throw new Error("reading order node id must not be empty");
      }
      if (byId.has(node.id)) {
        throw new Error(`duplicate reading order node id: ${node.id}`);
      }
      byId.set(node.id, node);
    }

    for (const edge of edges) {
      if (!isReadingOrderEdgeType(edge.type)) {
        throw new Error(`unknown reading order edge type: ${String(edge.type)}`);
      }
      if (edge.from.length === 0 || edge.to.length === 0) {
        throw new Error("reading order edge endpoints must not be empty");
      }
      if (!byId.has(edge.from)) {
        throw new Error(`reading order edge has unknown source node ${edge.from}`);
      }
      if (!byId.has(edge.to)) {
        throw new Error(`reading order edge has unknown target node ${edge.to}`);
      }
      if (edge.from === edge.to) {
        throw new Error(`self-loop reading order edge on ${edge.from}`);
      }
    }

    const edgeOrder = Object.freeze(
      edges.map((edge) =>
        Object.freeze({ type: edge.type, from: edge.from, to: edge.to })
      )
    );

    const edgesByType = new Map<
      ReadingOrderEdgeType,
      ReadingOrderEdge[]
    >();
    const successors = new Map<
      ReadingOrderEdgeType,
      Map<string, string[]>
    >();
    const predecessors = new Map<
      ReadingOrderEdgeType,
      Map<string, string[]>
    >();
    for (const edge of edgeOrder) {
      let byType = edgesByType.get(edge.type);
      if (!byType) {
        byType = [];
        edgesByType.set(edge.type, byType);
      }
      byType.push(edge);
      appendAdjacency(successors, edge.type, edge.from, edge.to);
      appendAdjacency(predecessors, edge.type, edge.to, edge.from);
    }

    this.byId = byId;
    this.nodeOrder = Object.freeze([...nodes]);
    this.edgeOrder = edgeOrder;
    this.edgesByType = freezeTypeMap(edgesByType);
    this.successors = freezeTypeMap(successors);
    this.predecessors = freezeTypeMap(predecessors);
    Object.freeze(this);
  }

  get isFrozen(): boolean {
    return Object.isFrozen(this);
  }

  get nodeCount(): number {
    return this.nodeOrder.length;
  }

  get edgeCount(): number {
    return this.edgeOrder.length;
  }

  /** Look up a node by id. */
  get(id: string): ReadingOrderNode | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** All nodes, in the produced reading-sequence order (frozen copy). */
  nodes(): readonly ReadingOrderNode[] {
    return this.nodeOrder;
  }

  /** Nodes of one hierarchy level, in reading-sequence order. */
  nodesAtLevel(level: HierarchyLevel): readonly ReadingOrderNode[] {
    return Object.freeze(
      this.nodeOrder.filter((node) => node.level === level)
    );
  }

  /** All edges, in construction order (frozen copy). */
  edges(): readonly ReadingOrderEdge[] {
    return this.edgeOrder;
  }

  /** Edges of one type, in construction order. */
  edgesOfType(type: ReadingOrderEdgeType): readonly ReadingOrderEdge[] {
    return Object.freeze([...(this.edgesByType.get(type) ?? [])]);
  }

  /**
   * The produced reading sequence: node ids in reading order (level chains
   * concatenated per `READING_LEVEL_SEQUENCE`).
   */
  readingSequence(): readonly string[] {
    return Object.freeze(this.nodeOrder.map((node) => node.id));
  }

  /** The produced position of a node, or undefined for unknown ids. */
  positionOf(id: string): number | undefined {
    return this.byId.get(id)?.position;
  }

  /** Targets of READING_NEXT edges leaving a node (in construction order). */
  readingNext(id: string): readonly string[] {
    return Object.freeze([
      ...(this.successors.get(READING_NEXT)?.get(id) ?? []),
    ]);
  }

  /** Sources of READING_NEXT edges entering a node (in construction order). */
  nextSources(id: string): readonly string[] {
    return Object.freeze([
      ...(this.predecessors.get(READING_NEXT)?.get(id) ?? []),
    ]);
  }

  /**
   * The single next node in reading order (first READING_NEXT target), or
   * undefined for the last node of its level / unknown ids.
   */
  next(id: string): ReadingOrderNode | undefined {
    const target = this.readingNext(id)[0];
    return target === undefined ? undefined : this.byId.get(target);
  }

  /** Targets of READING_PREVIOUS edges leaving a node (in construction order). */
  readingPrevious(id: string): readonly string[] {
    return Object.freeze([
      ...(this.successors.get(READING_PREVIOUS)?.get(id) ?? []),
    ]);
  }

  /** Sources of READING_PREVIOUS edges entering a node (in construction order). */
  previousSources(id: string): readonly string[] {
    return Object.freeze([
      ...(this.predecessors.get(READING_PREVIOUS)?.get(id) ?? []),
    ]);
  }

  /**
   * The single previous node in reading order (first READING_PREVIOUS target),
   * or undefined for the first node of its level / unknown ids.
   */
  prev(id: string): ReadingOrderNode | undefined {
    const target = this.readingPrevious(id)[0];
    return target === undefined ? undefined : this.byId.get(target);
  }

  /**
   * The first node of a level: the only level node no READING_PREVIOUS edge
   * enters. Undefined for unknown levels with no nodes.
   */
  first(level: HierarchyLevel): ReadingOrderNode | undefined {
    const levelNodes = this.nodesAtLevel(level);
    if (levelNodes.length === 0) return undefined;
    const incoming = new Set(
      this.edgesOfType(READING_PREVIOUS).map((edge) => edge.to)
    );
    return levelNodes.find((node) => !incoming.has(node.id));
  }

  /**
   * The last node of a level: the only level node with no outgoing
   * READING_NEXT edge. Undefined for unknown levels with no nodes.
   */
  last(level: HierarchyLevel): ReadingOrderNode | undefined {
    const levelNodes = this.nodesAtLevel(level);
    if (levelNodes.length === 0) return undefined;
    const outgoing = new Set(
      this.edgesOfType(READING_NEXT).map((edge) => edge.from)
    );
    return levelNodes.find((node) => !outgoing.has(node.id));
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function appendAdjacency(
  map: Map<ReadingOrderEdgeType, Map<string, string[]>>,
  type: ReadingOrderEdgeType,
  node: string,
  neighbor: string
): void {
  let byType = map.get(type);
  if (!byType) {
    byType = new Map();
    map.set(type, byType);
  }
  let list = byType.get(node);
  if (!list) {
    list = [];
    byType.set(node, list);
  }
  list.push(neighbor);
}

function freezeTypeMap<K extends string, V>(
  map: Map<K, V>
): ReadonlyMap<K, V> {
  for (const [key, value] of map) {
    if (Array.isArray(value)) {
      map.set(key, Object.freeze([...value]) as V);
    }
  }
  return map as ReadonlyMap<K, V>;
}

function isFiniteBox(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height)
  );
}
