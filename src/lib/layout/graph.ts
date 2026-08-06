/**
 * Layout graph — the directed graph data structure of the layout layer.
 *
 * Milestone 1 ships the structure only: node/edge bookkeeping and adjacency
 * queries. Graph *construction* (block segmentation, region containment,
 * reading order) and graph *validation* are separate later milestones that
 * build on this class without changing its contract.
 *
 * Semantics: nodes are identified by opaque string ids (layout node or region
 * ids). Edges are directed and may repeat. Query results are frozen copies;
 * the graph itself is mutable until construction finishes.
 */

/** A directed edge between two layout element ids. */
export interface LayoutEdge {
  /** Source node id. */
  readonly from: string;
  /** Target node id. */
  readonly to: string;
}

export class LayoutGraph {
  private readonly ids = new Set<string>();
  private readonly successorsMap = new Map<string, string[]>();
  private readonly predecessorsMap = new Map<string, string[]>();
  private readonly edgeList: LayoutEdge[] = [];

  /** Add a node. Idempotent for an already-present id. */
  addNode(id: string): this {
    if (id.length === 0) {
      throw new Error("graph node id must not be empty");
    }
    this.ids.add(id);
    return this;
  }

  /** Add a directed edge, auto-registering its endpoint nodes. */
  addEdge(from: string, to: string): this {
    if (from === to) {
      throw new Error(`self-loop edges are not allowed: ${from}`);
    }
    this.addNode(from);
    this.addNode(to);
    this.edgeList.push({ from, to });
    let successors = this.successorsMap.get(from);
    if (!successors) {
      successors = [];
      this.successorsMap.set(from, successors);
    }
    successors.push(to);
    let predecessors = this.predecessorsMap.get(to);
    if (!predecessors) {
      predecessors = [];
      this.predecessorsMap.set(to, predecessors);
    }
    predecessors.push(from);
    return this;
  }

  hasNode(id: string): boolean {
    return this.ids.has(id);
  }

  hasEdge(from: string, to: string): boolean {
    return (this.successorsMap.get(from) ?? []).includes(to);
  }

  get nodeCount(): number {
    return this.ids.size;
  }

  get edgeCount(): number {
    return this.edgeList.length;
  }

  /** Outgoing neighbors of a node, in insertion order. */
  successors(id: string): readonly string[] {
    return Object.freeze([...(this.successorsMap.get(id) ?? [])]);
  }

  /** Incoming neighbors of a node, in insertion order. */
  predecessors(id: string): readonly string[] {
    return Object.freeze([...(this.predecessorsMap.get(id) ?? [])]);
  }

  /** All edges, in insertion order. */
  edges(): readonly LayoutEdge[] {
    return Object.freeze([...this.edgeList]);
  }

  /** All node ids, in insertion order. */
  nodes(): readonly string[] {
    return Object.freeze(Array.from(this.ids));
  }
}
