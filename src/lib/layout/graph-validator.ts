/**
 * Graph validator — Milestone 8.
 *
 * The mandatory validation gate of the Layout Engine. It validates every SDG
 * invariant across the four composed structures (LayoutHierarchy,
 * SemanticGraph, ReadingOrderGraph, PropagatedConfidence) plus the source OCR,
 * and returns a deep-frozen, deterministic `GraphValidationReport` (or a
 * `GraphValidationFailure` when the four structures describe different node
 * universes and no meaningful report can be produced).
 *
 * The gate is a composition: the nine mandatory invariants are checked by
 * reusing the M2/M4/M6/M7 validators and the existing geometry helpers. Only
 * the genuinely new checks live here:
 *
 *   - invariant 1  — acyclicity via an iterative Kahn topological sort (no
 *                    recursive DFS, no recursion-depth dependence) over the
 *                    containment (CONTAINS) edges and the reading-order
 *                    (READING_NEXT) edges;
 *   - invariant 3  — duplicate OCR ownership (a word referenced by more than
 *                    one Word node), complementing the M4 coverage validator;
 *   - invariant 7  — region vocabulary membership of every REGION node;
 *   - invariant 9  — report determinism (see graph-validation-report.ts).
 *
 * Invariant 2 reuses the M4 single-parent/ownership/chain validators,
 * invariant 4 reuses the M4 containment validator (which uses `boxContains`),
 * invariant 5 reuses the M6 reading-order validators, invariant 6 reuses the
 * M7 confidence validators and invariant 8 reuses the M2/M4/M6/M7 frozenness
 * validators. Nothing here duplicates those modules.
 */
import type { OcrDocument } from "@/lib/pipeline/types";
import type { LayoutHierarchy } from "./hierarchy";
import type { SemanticGraph } from "./semantic-graph";
import type { ReadingOrderGraph } from "./reading-order";
import { READING_NEXT } from "./reading-order";
import type { PropagatedConfidence } from "./confidence-propagation";
import { NODE_LEVEL } from "./node-levels";
import { isRegionType } from "./region-types";
import { LAYOUT_EDGE_TYPE } from "./edge-types";
import type { ValidationResult } from "./validation";
import {
  validateFrozenGraph,
  validateKnownEdgeTypes,
  validateNoSelfLoops,
  validateUniqueNodeIds,
  validationResult,
} from "./validation";
import {
  validateCompleteOcrCoverage,
  validateFrozenHierarchy,
  validateHierarchyContainment,
  validateNoCycles,
  validatePageOwnership,
  validateParentChain,
  validateSingleParent,
  validateUniqueOwnership,
} from "./hierarchy-validation";
import {
  validateReadingOrderBidirectional,
  validateReadingOrderConnectivity,
  validateReadingOrderCoverage,
  validateReadingOrderFrozen,
  validateReadingOrderNoDuplicateEdges,
  validateReadingOrderSinglePredecessor,
  validateReadingOrderSingleSuccessor,
  validateReadingOrderTopology,
} from "./reading-order-validation";
import {
  validateCompleteConfidenceCoverage,
  validateConfidenceBounds,
  validateFiniteConfidenceValues,
  validateFrozenConfidenceOutput,
} from "./confidence-validation";
import {
  createGraphValidationFailure,
  createGraphValidationReport,
  createGraphValidationStatistics,
} from "./graph-validation-report";
import type { GraphValidationOutcome } from "./graph-validation-report";

/** The four graph structures plus their OCR source that the gate validates. */
export interface GraphValidationInput {
  readonly ocr: OcrDocument;
  readonly hierarchy: LayoutHierarchy;
  readonly semanticGraph: SemanticGraph;
  readonly readingOrder: ReadingOrderGraph;
  readonly confidence: PropagatedConfidence;
}

/** A directed edge view used by the iterative topological sort. */
export interface TopoSortEdge {
  readonly type: string;
  readonly from: string;
  readonly to: string;
}

export interface TopoSortResult {
  readonly acyclic: boolean;
  /** Deterministic topological order; shorter than `nodes` when cyclic. */
  readonly order: readonly string[];
  /** Nodes on cycles, in input node order (empty when acyclic). */
  readonly cycleNodes: readonly string[];
  /** Edges whose endpoints both lie on cycles, in input edge order. */
  readonly cycleEdges: readonly TopoSortEdge[];
}

/**
 * Kahn topological sort — iterative, deterministic, no recursive DFS and no
 * recursion-depth dependence. Nodes and edges are processed in input order, so
 * the order, cycle nodes and cycle edges are all reproducible.
 */
export function iterativeTopologicalSort(
  nodes: readonly string[],
  edges: readonly TopoSortEdge[]
): TopoSortResult {
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, TopoSortEdge[]>();
  for (const id of nodes) {
    indegree.set(id, 0);
    adjacency.set(id, []);
  }
  for (const edge of edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    indegree.set(edge.to, indegree.get(edge.to)! + 1);
    adjacency.get(edge.from)!.push(edge);
  }
  const queue: string[] = [];
  for (const id of nodes) {
    if (indegree.get(id) === 0) queue.push(id);
  }
  const order: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    order.push(id);
    for (const edge of adjacency.get(id)!) {
      const next = edge.to;
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  const acyclic = order.length === nodes.length;
  const processed = new Set(order);
  const cycleNodes = nodes.filter((id) => !processed.has(id));
  const remaining = new Set(cycleNodes);
  const cycleEdges = edges.filter(
    (edge) => remaining.has(edge.from) && remaining.has(edge.to)
  );
  return Object.freeze({
    acyclic,
    order: Object.freeze(order),
    cycleNodes: Object.freeze(cycleNodes),
    cycleEdges: Object.freeze(cycleEdges),
  });
}

/** Invariant 1a — the containment graph (CONTAINS edges) must be acyclic. */
export function validateContainmentDag(
  semanticGraph: SemanticGraph
): ValidationResult {
  const edges: TopoSortEdge[] = semanticGraph
    .edgesOfType(LAYOUT_EDGE_TYPE.CONTAINS)
    .map((edge) => ({ type: edge.type, from: edge.from, to: edge.to }));
  const sort = iterativeTopologicalSort(semanticGraph.nodes(), edges);
  if (!sort.acyclic) {
    return validationResult([
      `containment graph has a cycle through nodes: ${sort.cycleNodes.join(", ")}`,
    ]);
  }
  return validationResult([]);
}

/** Invariant 1b — the reading-order graph (READING_NEXT edges) must be acyclic. */
export function validateReadingOrderDag(
  readingOrder: ReadingOrderGraph
): ValidationResult {
  const edges: TopoSortEdge[] = readingOrder
    .edgesOfType(READING_NEXT)
    .map((edge) => ({ type: edge.type, from: edge.from, to: edge.to }));
  const sort = iterativeTopologicalSort(readingOrder.readingSequence(), edges);
  if (!sort.acyclic) {
    return validationResult([
      `reading order graph has a cycle through nodes: ${sort.cycleNodes.join(", ")}`,
    ]);
  }
  return validationResult([]);
}

/** Invariant 3b — every OCR word is owned by at most one Word node. */
export function validateUniqueOcrOwnership(
  hierarchy: LayoutHierarchy
): ValidationResult {
  const errors: string[] = [];
  const owner = new Map<string, string>();
  for (const node of hierarchy.nodesAtLevel(NODE_LEVEL.WORD)) {
    const ref = node.sourceRefs[0];
    if (ref === undefined || ref.wordIndex === undefined) continue;
    const key = `${ref.pageIndex}:${ref.lineIndex}:${ref.wordIndex}`;
    const first = owner.get(key);
    if (first !== undefined) {
      errors.push(`OCR word ${key} is owned by both ${first} and ${node.id}`);
    } else {
      owner.set(key, node.id);
    }
  }
  return validationResult(errors);
}

/** Invariant 7 — every REGION node type belongs to the official vocabulary. */
export function validateRegionVocabulary(
  hierarchy: LayoutHierarchy,
  semanticGraph: SemanticGraph
): ValidationResult {
  const errors: string[] = [];
  for (const node of hierarchy.nodes()) {
    if (node.level !== NODE_LEVEL.REGION) continue;
    if (node.regionType !== undefined && !isRegionType(node.regionType)) {
      errors.push(
        `hierarchy region ${node.id} has unknown region type ${String(
          node.regionType
        )}`
      );
    }
  }
  for (const id of semanticGraph.nodes()) {
    if (semanticGraph.nodeLevel(id) !== NODE_LEVEL.REGION) continue;
    const regionType = semanticGraph.regionType(id);
    if (regionType === undefined || !isRegionType(regionType)) {
      errors.push(
        `semantic region ${id} has ${
          regionType === undefined
            ? "no region type"
            : `unknown region type ${String(regionType)}`
        }`
      );
    }
  }
  return validationResult(errors);
}

/**
 * Invariant 2b — the semantic graph mirrors the hierarchy's single-parent
 * contract: every non-page node has exactly one CHILD_OF parent and every page
 * node has none.
 */
export function validateSemanticSingleParent(
  semanticGraph: SemanticGraph
): ValidationResult {
  const errors: string[] = [];
  for (const id of semanticGraph.nodes()) {
    const parents = semanticGraph.incoming(id, LAYOUT_EDGE_TYPE.CHILD_OF);
    if (semanticGraph.nodeLevel(id) === NODE_LEVEL.PAGE) {
      if (parents.length > 0) {
        errors.push(
          `page node ${id} has ${parents.length} CHILD_OF parents, expected none`
        );
      }
    } else if (parents.length !== 1) {
      errors.push(
        `node ${id} has ${parents.length} CHILD_OF parents, expected exactly one`
      );
    }
  }
  return validationResult(errors);
}

/**
 * Coherence precondition: the four structures must agree on the node universe.
 * The semantic graph carries every hierarchy node except the Document root (it
 * has no Document level); the reading-order graph and the propagated
 * confidence carry every hierarchy node. Returns the mismatches, empty when the
 * model is coherent.
 */
export function nodeUniverseMismatch(
  hierarchyIds: readonly string[],
  rootId: string,
  semanticGraph: SemanticGraph,
  readingOrder: ReadingOrderGraph,
  confidence: PropagatedConfidence
): string[] {
  const details: string[] = [];
  const hierarchy = new Set(hierarchyIds);
  const expectedSemantic = new Set(
    hierarchyIds.filter((id) => id !== rootId)
  );
  const semantic = new Set(semanticGraph.nodes());
  if (!setEquals(semantic, expectedSemantic)) {
    details.push(
      `semantic graph node set does not match the hierarchy (excluding the ${rootId} root)`
    );
  }
  const reading = new Set(readingOrder.nodes().map((node) => node.id));
  if (!setEquals(reading, hierarchy)) {
    details.push("reading order node set does not match the hierarchy");
  }
  const propagated = new Set(confidence.ids());
  if (!setEquals(propagated, hierarchy)) {
    details.push("propagated confidence node set does not match the hierarchy");
  }
  return details;
}

/** Total edges across the hierarchy, the semantic graph and the reading order. */
export function modelEdgeCount(
  hierarchy: LayoutHierarchy,
  semanticGraph: SemanticGraph,
  readingOrder: ReadingOrderGraph
): number {
  return (
    hierarchy.nodeCount - 1 + semanticGraph.edgeCount + readingOrder.edgeCount
  );
}

/**
 * The unified validation gate. Validates the nine mandatory invariants over a
 * coherent model and returns a deterministic, deep-frozen report. Returns a
 * `GraphValidationFailure` when the four structures describe different node
 * universes.
 */
export function validateGraphs(
  input: GraphValidationInput
): GraphValidationOutcome {
  const universe = nodeUniverseMismatch(
    input.hierarchy.nodes().map((node) => node.id),
    input.hierarchy.rootId,
    input.semanticGraph,
    input.readingOrder,
    input.confidence
  );
  if (universe.length > 0) {
    return createGraphValidationFailure(
      "the input structures describe different node universes",
      universe
    );
  }

  const { hierarchy, semanticGraph, readingOrder, confidence } = input;

  const results: readonly ValidationResult[] = [
    validateUniqueNodeIds(semanticGraph.nodes()),
    validateNoSelfLoops(semanticGraph.edges()),
    validateKnownEdgeTypes(semanticGraph.edges()),
    validateSingleParent(hierarchy.nodes()),
    validateUniqueOwnership(hierarchy.nodes()),
    validateParentChain(hierarchy.nodes()),
    validatePageOwnership(hierarchy.nodes()),
    validateNoCycles(hierarchy.nodes()),
    validateHierarchyContainment(hierarchy.nodes()),
    validateCompleteOcrCoverage(input.ocr, hierarchy),
    validateUniqueOcrOwnership(hierarchy),
    validateSemanticSingleParent(semanticGraph),
    validateReadingOrderSingleSuccessor(readingOrder),
    validateReadingOrderSinglePredecessor(readingOrder),
    validateReadingOrderNoDuplicateEdges(readingOrder),
    validateReadingOrderBidirectional(readingOrder),
    validateReadingOrderConnectivity(readingOrder),
    validateReadingOrderCoverage(hierarchy, readingOrder),
    validateReadingOrderTopology(readingOrder),
    validateReadingOrderDag(readingOrder),
    validateContainmentDag(semanticGraph),
    validateConfidenceBounds(hierarchy, confidence),
    validateFiniteConfidenceValues(hierarchy, confidence),
    validateCompleteConfidenceCoverage(hierarchy, confidence),
    validateRegionVocabulary(hierarchy, semanticGraph),
    validateFrozenGraph(semanticGraph),
    validateFrozenHierarchy(hierarchy),
    validateReadingOrderFrozen(readingOrder),
    validateFrozenConfidenceOutput(hierarchy, confidence),
  ];

  const errors: string[] = [];
  for (const result of results) {
    for (const error of result.errors) {
      errors.push(error);
    }
  }

  const warnings: string[] = [];
  if (semanticGraph.edgesOfType(LAYOUT_EDGE_TYPE.CONTAINS).length === 0) {
    warnings.push(
      "semantic graph carries no CONTAINS edges; containment relies on the hierarchy only"
    );
  }

  return createGraphValidationReport({
    errors,
    warnings,
    statistics: createGraphValidationStatistics({
      nodeCount: hierarchy.nodeCount,
      edgeCount: modelEdgeCount(hierarchy, semanticGraph, readingOrder),
    }),
  });
}

function setEquals(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}
