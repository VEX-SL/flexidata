/**
 * Semantic document graph — the typed extension of the Milestone 1 graph model.
 *
 * Milestone 1 shipped `LayoutGraph` as a structure-only directed graph with
 * idempotent nodes and repeatable edges. `SemanticGraph` is the stricter,
 * typed layer on top: every edge carries a `LayoutEdgeType`, every node a
 * `NodeLevel` (plus a `RegionType` for region nodes), duplicates are rejected,
 * and the graph freezes into an immutable, shareable form.
 *
 * The class is purely architectural: it stores edges and answers traversal
 * queries. It derives nothing — no spatial reasoning, no segmentation, no
 * reading-order inference — those are later milestones that populate it.
 *
 * Determinism: iteration follows insertion order everywhere; no randomness, no
 * timestamps, no hidden state. All query views are frozen copies.
 */
import type { LayoutEdgeType, TypedLayoutEdge } from "./edge-types";
import { isLayoutEdgeType, LAYOUT_EDGE_TYPE } from "./edge-types";
import type { NodeLevel } from "./node-levels";
import { NODE_LEVEL } from "./node-levels";
import type { RegionType } from "./region-types";
import { REGION_TYPE } from "./region-types";

/** Metadata a node must declare when added to the semantic graph. */
export interface SemanticNodeOpts {
  /** The semantic level of the node (Page, Region, Block, Line, Word). */
  readonly level: NodeLevel;
  /** Role of a Region node; ignored for other levels. Defaults to Unknown. */
  readonly regionType?: RegionType;
}

export class SemanticGraph {
  private readonly nodeOrder: string[] = [];
  private readonly nodeLevels = new Map<string, NodeLevel>();
  private readonly nodeRegionTypes = new Map<string, RegionType>();
  private readonly edgeOrder: TypedLayoutEdge[] = [];
  private readonly edgeKeys = new Set<string>();
  private readonly edgesByType = new Map<LayoutEdgeType, TypedLayoutEdge[]>();
  private readonly successors = new Map<
    string,
    Map<LayoutEdgeType, string[]>
  >();
  private readonly predecessors = new Map<
    string,
    Map<LayoutEdgeType, string[]>
  >();
  private frozen = false;

  /** Register a node. Rejects empty ids, duplicates and misplaced region types. */
  addNode(id: string, opts: SemanticNodeOpts): this {
    this.assertMutable();
    if (id.length === 0) {
      throw new Error("semantic graph node id must not be empty");
    }
    if (this.nodeLevels.has(id)) {
      throw new Error(`duplicate node id: ${id}`);
    }
    if (opts.regionType !== undefined && opts.level !== NODE_LEVEL.REGION) {
      throw new Error(`region type only applies to REGION nodes: ${id}`);
    }
    this.nodeOrder.push(id);
    this.nodeLevels.set(id, opts.level);
    if (opts.level === NODE_LEVEL.REGION) {
      this.nodeRegionTypes.set(id, opts.regionType ?? REGION_TYPE.UNKNOWN);
    }
    return this;
  }

  /**
   * Add a typed directed edge. Endpoints must already be registered. Rejects
   * self-loops, unknown edge types and exact duplicate edges.
   */
  addEdge(type: LayoutEdgeType, from: string, to: string): this {
    this.assertMutable();
    if (!isLayoutEdgeType(type)) {
      throw new Error(`unknown edge type: ${String(type)}`);
    }
    if (from === to) {
      throw new Error(`self-loop edges are not allowed: ${from}`);
    }
    if (!this.nodeLevels.has(from)) {
      throw new Error(`unknown edge source node: ${from}`);
    }
    if (!this.nodeLevels.has(to)) {
      throw new Error(`unknown edge target node: ${to}`);
    }
    const key = `${type}\u0000${from}\u0000${to}`;
    if (this.edgeKeys.has(key)) {
      throw new Error(`duplicate edge: ${type} ${from} -> ${to}`);
    }
    this.edgeKeys.add(key);
    const edge: TypedLayoutEdge = Object.freeze({ type, from, to });
    this.edgeOrder.push(edge);
    let byType = this.edgesByType.get(type);
    if (!byType) {
      byType = [];
      this.edgesByType.set(type, byType);
    }
    byType.push(edge);
    appendAdjacency(this.successors, from, type, to);
    appendAdjacency(this.predecessors, to, type, from);
    return this;
  }

  /**
   * Transition the graph into its immutable terminal state. Later mutations
   * throw; query views are frozen whether or not the graph is frozen.
   */
  freeze(): this {
    this.frozen = true;
    return Object.freeze(this);
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  hasNode(id: string): boolean {
    return this.nodeLevels.has(id);
  }

  hasEdge(type: LayoutEdgeType, from: string, to: string): boolean {
    return this.edgeKeys.has(`${type}\u0000${from}\u0000${to}`);
  }

  get nodeCount(): number {
    return this.nodeOrder.length;
  }

  get edgeCount(): number {
    return this.edgeOrder.length;
  }

  /** The declared level of a node, if present. */
  nodeLevel(id: string): NodeLevel | undefined {
    return this.nodeLevels.get(id);
  }

  /** The declared region role of a Region node, if present. */
  regionType(id: string): RegionType | undefined {
    return this.nodeRegionTypes.get(id);
  }

  /** All node ids, in insertion order. */
  nodes(): readonly string[] {
    return Object.freeze([...this.nodeOrder]);
  }

  /** All edges as frozen first-class objects, in insertion order. */
  edges(): readonly TypedLayoutEdge[] {
    return Object.freeze([...this.edgeOrder]);
  }

  /** Edges of one type, in insertion order. */
  edgesOfType(type: LayoutEdgeType): readonly TypedLayoutEdge[] {
    return Object.freeze([...(this.edgesByType.get(type) ?? [])]);
  }

  /** Targets of edges of the given type leaving a node. */
  outgoing(id: string, type: LayoutEdgeType): readonly string[] {
    const byType = this.successors.get(id);
    return Object.freeze([...(byType?.get(type) ?? [])]);
  }

  /** Sources of edges of the given type entering a node. */
  incoming(id: string, type: LayoutEdgeType): readonly string[] {
    const byType = this.predecessors.get(id);
    return Object.freeze([...(byType?.get(type) ?? [])]);
  }

  /** Structural children: targets of CHILD_OF edges leaving a node. */
  children(id: string): readonly string[] {
    return this.outgoing(id, LAYOUT_EDGE_TYPE.CHILD_OF);
  }

  /** Structural parents: sources of CHILD_OF edges entering a node. */
  parent(id: string): readonly string[] {
    return this.incoming(id, LAYOUT_EDGE_TYPE.CHILD_OF);
  }

  /** The next element in reading order, via READING_NEXT edges. */
  readingNext(id: string): readonly string[] {
    return this.outgoing(id, LAYOUT_EDGE_TYPE.READING_NEXT);
  }

  /** The previous element in reading order, via READING_PREVIOUS edges. */
  readingPrevious(id: string): readonly string[] {
    return this.outgoing(id, LAYOUT_EDGE_TYPE.READING_PREVIOUS);
  }

  /**
   * Undirected adjacency: every distinct node connected by any edge type,
   * deduplicated in first-encounter order.
   */
  neighbors(id: string): readonly string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const edge of this.edgeOrder) {
      if (edge.from === id) {
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          out.push(edge.to);
        }
      } else if (edge.to === id) {
        if (!seen.has(edge.from)) {
          seen.add(edge.from);
          out.push(edge.from);
        }
      }
    }
    return Object.freeze(out);
  }

  /** All Page-level node ids, in insertion order. */
  pages(): readonly string[] {
    return this.nodesAtLevel(NODE_LEVEL.PAGE);
  }

  /** All Region-level node ids, in insertion order. */
  regions(): readonly string[] {
    return this.nodesAtLevel(NODE_LEVEL.REGION);
  }

  /** All Block-level node ids, in insertion order. */
  blocks(): readonly string[] {
    return this.nodesAtLevel(NODE_LEVEL.BLOCK);
  }

  /** All Line-level node ids, in insertion order. */
  lines(): readonly string[] {
    return this.nodesAtLevel(NODE_LEVEL.LINE);
  }

  /** All Word-level node ids, in insertion order. */
  words(): readonly string[] {
    return this.nodesAtLevel(NODE_LEVEL.WORD);
  }

  private nodesAtLevel(level: NodeLevel): readonly string[] {
    const out: string[] = [];
    for (const id of this.nodeOrder) {
      if (this.nodeLevels.get(id) === level) out.push(id);
    }
    return Object.freeze(out);
  }

  private assertMutable(): void {
    if (this.frozen) {
      throw new Error("semantic graph is frozen");
    }
  }
}

function appendAdjacency(
  map: Map<string, Map<LayoutEdgeType, string[]>>,
  node: string,
  type: LayoutEdgeType,
  neighbor: string
): void {
  let byType = map.get(node);
  if (!byType) {
    byType = new Map();
    map.set(node, byType);
  }
  let list = byType.get(type);
  if (!list) {
    list = [];
    byType.set(type, list);
  }
  list.push(neighbor);
}
