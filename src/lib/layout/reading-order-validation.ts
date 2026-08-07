/**
 * Reading order validation — the Milestone 6 contract checks.
 *
 * Every validator is mutation-free and deterministic and returns the shared
 * frozen `ValidationResult`. The checks cover the reading-order graph's DAG
 * contract: complete hierarchy coverage, per-level connectivity (one first,
 * one last, everything reachable), acyclicity with a produced sequence that is
 * a valid topological order, bidirectional NEXT/PREVIOUS mirrors, single
 * successor/predecessor, no duplicate edges, deterministic rebuilds and
 * deep-frozen output.
 */
import { validationResult } from "./validation";
import type { ValidationResult } from "./validation";
import type { LayoutHierarchy } from "./hierarchy";
import {
  READING_NEXT,
  READING_PREVIOUS,
  READING_LEVEL_SEQUENCE,
} from "./reading-order";
import type { ReadingOrderGraph } from "./reading-order";

/**
 * Per-level connectivity. Every level with nodes has exactly one first node
 * (no outgoing READING_PREVIOUS), exactly one last node (no outgoing
 * READING_NEXT) and every level node is reachable from that first node via
 * READING_NEXT edges. Together with the single-successor/single-predecessor
 * checks this pins each level to exactly one linear chain.
 */
export function validateReadingOrderConnectivity(
  graph: ReadingOrderGraph
): ValidationResult {
  const errors: string[] = [];
  // READING_PREVIOUS edges point backward (a node's previous), so the chain's
  // first node is the one no PREVIOUS edge leaves, and the last node is the one
  // no READING_NEXT edge leaves.
  const outgoingPrev = new Set(
    graph.edgesOfType(READING_PREVIOUS).map((edge) => edge.from)
  );
  const outgoingNext = new Set(
    graph.edgesOfType(READING_NEXT).map((edge) => edge.from)
  );

  for (const level of READING_LEVEL_SEQUENCE) {
    const levelNodes = graph.nodesAtLevel(level);
    if (levelNodes.length === 0) continue;

    const firsts = levelNodes.filter((node) => !outgoingPrev.has(node.id));
    const lasts = levelNodes.filter((node) => !outgoingNext.has(node.id));
    if (firsts.length === 0) {
      errors.push(`level ${level} has no first node`);
    } else if (firsts.length > 1) {
      errors.push(
        `level ${level} has ${firsts.length} first nodes: ${firsts
          .map((node) => node.id)
          .join(", ")}`
      );
    }
    if (lasts.length === 0) {
      errors.push(`level ${level} has no last node`);
    } else if (lasts.length > 1) {
      errors.push(
        `level ${level} has ${lasts.length} last nodes: ${lasts
          .map((node) => node.id)
          .join(", ")}`
      );
    }

    const first = firsts[0];
    if (first !== undefined) {
      const seen = new Set<string>();
      const queue = [first.id];
      for (let qi = 0; qi < queue.length; qi++) {
        const cur = queue[qi];
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const nextId of graph.readingNext(cur)) {
          const nextNode = graph.get(nextId);
          if (
            nextNode !== undefined &&
            nextNode.level === level &&
            !seen.has(nextId)
          ) {
            queue.push(nextId);
          }
        }
      }
      const unvisited = levelNodes.filter((node) => !seen.has(node.id));
      if (unvisited.length > 0) {
        errors.push(
          `level ${level} has nodes unreachable from its first via READING_NEXT: ${unvisited
            .map((node) => node.id)
            .join(", ")}`
        );
      }
    }
  }
  return validationResult(errors);
}

/**
 * Complete coverage. Every hierarchy node has exactly one reading-order node
 * (and vice versa), and the levels agree with the hierarchy.
 */
export function validateReadingOrderCoverage(
  hierarchy: LayoutHierarchy,
  graph: ReadingOrderGraph
): ValidationResult {
  const errors: string[] = [];
  const expected = new Set(hierarchy.nodes().map((node) => node.id));
  const actual = new Set<string>();
  for (const node of graph.nodes()) {
    if (!expected.has(node.id)) {
      errors.push(`reading order references unknown hierarchy node ${node.id}`);
      continue;
    }
    actual.add(node.id);
    const hierarchyNode = hierarchy.get(node.id)!;
    if (hierarchyNode.level !== node.level) {
      errors.push(
        `reading order node ${node.id} has level ${node.level} but the hierarchy has ${hierarchyNode.level}`
      );
    }
  }
  for (const id of [...expected].sort()) {
    if (!actual.has(id)) {
      errors.push(`reading order does not cover hierarchy node ${id}`);
    }
  }
  return validationResult(errors);
}

/** Two reading-order graphs of identical input reproduce identical output. */
export function validateReadingOrderDeterminism(
  first: ReadingOrderGraph,
  second: ReadingOrderGraph
): ValidationResult {
  const errors: string[] = [];
  if (
    !deepEqual(first.nodes(), second.nodes()) ||
    !deepEqual(first.edges(), second.edges())
  ) {
    errors.push("reading order graphs differ between identical builds");
  }
  return validationResult(errors);
}

/** The graph and every owned structure are deep-frozen. */
export function validateReadingOrderFrozen(
  graph: ReadingOrderGraph
): ValidationResult {
  const errors: string[] = [];
  if (!graph.isFrozen) {
    errors.push("reading order graph is not frozen");
  }
  if (!Object.isFrozen(graph)) {
    errors.push("reading order graph instance is not frozen");
  }
  const paths: string[] = [];
  collectNonFrozenPaths(graph.nodes(), "nodes", new Set(), paths);
  collectNonFrozenPaths(graph.edges(), "edges", new Set(), paths);
  for (const path of paths) {
    errors.push(`reading order output is not deep-frozen at ${path}`);
  }
  return validationResult(errors);
}

/**
 * Acyclicity of the READING_NEXT digraph (READING_PREVIOUS is its transpose,
 * so any cycle appears in both). A linear chain of N nodes has exactly N−1
 * NEXT edges and can never contain a cycle.
 */
export function validateReadingOrderAcyclic(
  graph: ReadingOrderGraph
): ValidationResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  const stack = new Set<string>();
  const visit = (id: string): void => {
    if (stack.has(id)) {
      errors.push(`cycle detected through node ${id}`);
      return;
    }
    if (seen.has(id)) return;
    stack.add(id);
    seen.add(id);
    for (const nextId of graph.readingNext(id)) visit(nextId);
    stack.delete(id);
  };
  for (const node of graph.nodes()) visit(node.id);
  return validationResult(errors);
}

/**
 * Bidirectionality. Every READING_NEXT edge u → v has a READING_PREVIOUS
 * mirror v → u and vice versa — reading order never knows one direction
 * without the other.
 */
export function validateReadingOrderBidirectional(
  graph: ReadingOrderGraph
): ValidationResult {
  const errors: string[] = [];
  const next = new Set<string>();
  const prev = new Set<string>();
  const key = (from: string, to: string): string => `${from}\u0000${to}`;
  for (const edge of graph.edgesOfType(READING_NEXT)) {
    next.add(key(edge.from, edge.to));
  }
  for (const edge of graph.edgesOfType(READING_PREVIOUS)) {
    prev.add(key(edge.from, edge.to));
  }
  for (const edge of graph.edgesOfType(READING_NEXT)) {
    if (!prev.has(key(edge.to, edge.from))) {
      errors.push(
        `READING_NEXT ${edge.from} -> ${edge.to} has no READING_PREVIOUS mirror`
      );
    }
  }
  for (const edge of graph.edgesOfType(READING_PREVIOUS)) {
    if (!next.has(key(edge.to, edge.from))) {
      errors.push(
        `READING_PREVIOUS ${edge.from} -> ${edge.to} has no READING_NEXT mirror`
      );
    }
  }
  return validationResult(errors);
}

/** Every node has at most one READING_NEXT successor. */
export function validateReadingOrderSingleSuccessor(
  graph: ReadingOrderGraph
): ValidationResult {
  const errors: string[] = [];
  for (const node of graph.nodes()) {
    const targets = graph.readingNext(node.id);
    if (targets.length > 1) {
      errors.push(
        `node ${node.id} has ${targets.length} READING_NEXT successors`
      );
    }
  }
  return validationResult(errors);
}

/** Every node has at most one READING_PREVIOUS predecessor. */
export function validateReadingOrderSinglePredecessor(
  graph: ReadingOrderGraph
): ValidationResult {
  const errors: string[] = [];
  for (const node of graph.nodes()) {
    const targets = graph.readingPrevious(node.id);
    if (targets.length > 1) {
      errors.push(
        `node ${node.id} has ${targets.length} READING_PREVIOUS predecessors`
      );
    }
  }
  return validationResult(errors);
}

/** No two edges share the same (type, from, to) triple. */
export function validateReadingOrderNoDuplicateEdges(
  graph: ReadingOrderGraph
): ValidationResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges()) {
    const key = `${edge.type}\u0000${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) {
      errors.push(`duplicate edge: ${edge.type} ${edge.from} -> ${edge.to}`);
    }
    seen.add(key);
  }
  return validationResult(errors);
}

/**
 * The produced reading sequence is a valid topological ordering of the graph:
 * every READING_NEXT edge runs forward in the sequence and every
 * READING_PREVIOUS edge runs backward, and the sequence covers every node
 * exactly once.
 */
export function validateReadingOrderTopology(
  graph: ReadingOrderGraph
): ValidationResult {
  const errors: string[] = [];
  const sequence = graph.readingSequence();
  const pos = new Map<string, number>();
  for (let i = 0; i < sequence.length; i++) {
    if (pos.has(sequence[i])) {
      errors.push(`reading sequence contains node ${sequence[i]} more than once`);
    }
    pos.set(sequence[i], i);
  }
  if (sequence.length !== graph.nodeCount) {
    errors.push(
      `reading sequence has ${sequence.length} entries for ${graph.nodeCount} nodes`
    );
  }
  for (const edge of graph.edgesOfType(READING_NEXT)) {
    const from = pos.get(edge.from);
    const to = pos.get(edge.to);
    if (from === undefined || to === undefined) {
      if (from === undefined) {
        errors.push(`READING_NEXT source ${edge.from} is not in the reading sequence`);
      }
      if (to === undefined) {
        errors.push(`READING_NEXT target ${edge.to} is not in the reading sequence`);
      }
      continue;
    }
    if (from >= to) {
      errors.push(
        `READING_NEXT ${edge.from} -> ${edge.to} violates the reading sequence order (position ${from} >= ${to})`
      );
    }
  }
  for (const edge of graph.edgesOfType(READING_PREVIOUS)) {
    const from = pos.get(edge.from);
    const to = pos.get(edge.to);
    if (from === undefined || to === undefined) continue;
    if (from <= to) {
      errors.push(
        `READING_PREVIOUS ${edge.from} -> ${edge.to} violates the reading sequence order (position ${from} <= ${to})`
      );
    }
  }
  return validationResult(errors);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function collectNonFrozenPaths(
  value: unknown,
  path: string,
  seen: Set<object>,
  out: string[]
): void {
  if (value === null || typeof value !== "object") return;
  const obj = value as object;
  if (seen.has(obj)) return;
  seen.add(obj);
  if (!Object.isFrozen(obj)) {
    out.push(path);
  }
  for (const key of Object.keys(obj)) {
    collectNonFrozenPaths(
      (obj as Record<string, unknown>)[key],
      `${path}.${key}`,
      seen,
      out
    );
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a !== null && b !== null && typeof a === "object") {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
      if (
        !deepEqual(
          (a as Record<string, unknown>)[aKeys[i]],
          (b as Record<string, unknown>)[bKeys[i]]
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return a === b;
}
