/**
 * Graph validation primitives.
 *
 * Milestone 2 ships reusable, mutation-free validation functions only — not a
 * full validator. Each function inspects a plain-data edge/node collection (or
 * a `SemanticGraph` for frozenness) and returns a structured result. Errors are
 * deterministic and insertion-ordered; empty collections are always valid.
 */
import { isLayoutEdgeType, LAYOUT_EDGE_TYPES } from "./edge-types";
import type { SemanticGraph } from "./semantic-graph";

/** Structured outcome of a validation pass. Frozen. */
export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function result(errors: readonly string[]): ValidationResult {
  return validationResult(errors);
}

/**
 * Shared outcome factory for validation passes across milestones. Every result
 * is frozen, and the error list is an immutable copy in the given order.
 */
export function validationResult(errors: readonly string[]): ValidationResult {
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze([...errors]),
  });
}

/** Reject edges whose source and target are the same node. */
export function validateNoSelfLoops(
  edges: readonly { readonly from: string; readonly to: string }[]
): ValidationResult {
  const errors: string[] = [];
  for (const edge of edges) {
    if (edge.from === edge.to) {
      errors.push(`self-loop edge on node ${edge.from}`);
    }
  }
  return result(errors);
}

/** Reject duplicate node ids in an id collection. */
export function validateUniqueNodeIds(nodes: readonly string[]): ValidationResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const id of nodes) {
    if (seen.has(id)) {
      errors.push(`duplicate node id ${id}`);
    }
    seen.add(id);
  }
  return result(errors);
}

/** Reject edges whose type is outside the layout edge vocabulary. */
export function validateKnownEdgeTypes(
  edges: readonly { readonly type: unknown }[]
): ValidationResult {
  const errors: string[] = [];
  for (const edge of edges) {
    if (!isLayoutEdgeType(edge.type)) {
      errors.push(`unknown edge type ${JSON.stringify(edge.type)}`);
    }
  }
  return result(errors);
}

/**
 * Reject a semantic graph that is not in its immutable terminal state: it must
 * be frozen, its instance must be non-extensible, and every query view
 * (nodes, edges, per-type edge collections, edge objects) must be frozen.
 */
export function validateFrozenGraph(graph: SemanticGraph): ValidationResult {
  const errors: string[] = [];
  if (!graph.isFrozen) {
    errors.push("semantic graph is not frozen");
  }
  if (!Object.isFrozen(graph)) {
    errors.push("semantic graph instance is not frozen");
  }
  const nodes = graph.nodes();
  if (!Object.isFrozen(nodes)) {
    errors.push("nodes view is not frozen");
  }
  const edges = graph.edges();
  if (!Object.isFrozen(edges)) {
    errors.push("edges view is not frozen");
  }
  for (const edge of edges) {
    if (!Object.isFrozen(edge)) {
      errors.push("edge object is not frozen");
    }
  }
  for (const type of LAYOUT_EDGE_TYPES) {
    if (!Object.isFrozen(graph.edgesOfType(type))) {
      errors.push(`edges of type ${type} are not frozen`);
    }
  }
  return result(errors);
}
