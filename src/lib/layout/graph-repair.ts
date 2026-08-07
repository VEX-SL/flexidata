/**
 * Graph repair — Milestone 8.
 *
 * The deterministic, immutable repair engine over the four composed graph
 * structures. Repairs never mutate their inputs: every pass rebuilds fresh
 * deep-frozen `SemanticGraph` and `ReadingOrderGraph` instances (the hierarchy
 * and the propagated confidence are already immutable and are reused
 * untouched), and every applied fix is recorded as a `RepairAction` in the
 * report.
 *
 * Repair classes (per the SDG contract):
 *
 *   - cycle        → remove the lowest-confidence edge of the cycle (reading
 *                    order and containment), breaking the DAG invariant;
 *   - duplicate    → keep the first occurrence of each edge, drop the rest;
 *   - multiple parents → keep the highest-confidence CHILD_OF parent, drop the
 *                    rest.
 *
 * Damage that repair cannot fix is never papered over: invalid or missing
 * confidence and missing OCR ownership produce a `GraphValidationFailure`, and
 * confidence is never invented anywhere in this engine.
 *
 * Determinism: all comparisons use fixed keys (edge confidence derived from
 * the propagated composite, backward-sequence preference, then construction
 * order), so identical inputs produce byte-identical repairs and reports.
 */
import type {
  ReadingOrderEdge,
} from "./reading-order";
import { ReadingOrderGraph, READING_NEXT, READING_PREVIOUS } from "./reading-order";import { SemanticGraph } from "./semantic-graph";
import type { PropagatedConfidence } from "./confidence-propagation";
import { LAYOUT_EDGE_TYPE } from "./edge-types";
import type { TypedLayoutEdge } from "./edge-types";
import type { TopoSortEdge } from "./graph-validator";
import {
  iterativeTopologicalSort,
  modelEdgeCount,
  nodeUniverseMismatch,
  validateGraphs,
} from "./graph-validator";
import type { GraphValidationInput } from "./graph-validator";
import { validateCompleteOcrCoverage } from "./hierarchy-validation";
import {
  validateConfidenceBounds,
  validateFiniteConfidenceValues,
} from "./confidence-validation";
import type { GraphValidationOutcome, RepairAction } from "./graph-validation-report";
import {
  createGraphValidationFailure,
  createGraphValidationReport,
  createGraphValidationStatistics,
} from "./graph-validation-report";

/** The outcome of one repair pass: an outcome plus the repaired model. */
export interface GraphRepairResult {
  readonly outcome: GraphValidationOutcome;
  /** The rebuilt, deep-frozen model; present when the outcome is a report. */
  readonly repairedModel?: GraphValidationInput;
}

/** A directed edge shape shared by both graph modules. */
interface DirectedEdge {
  readonly type: string;
  readonly from: string;
  readonly to: string;
}

interface RepairContext {
  readonly confidence: PropagatedConfidence;
  readonly actions: RepairAction[];
  readonly counters: {
    readingEdges: number;
    containmentEdges: number;
    duplicateEdges: number;
    parents: number;
  };
}

/** Composite score of a node, the deterministic confidence of its edges. */
function nodeScore(context: RepairContext, id: string): number {
  return context.confidence.get(id)?.aggregate.mean ?? 0;
}

function edgeScore(context: RepairContext, edge: DirectedEdge): number {
  return nodeScore(context, edge.from);
}

/** Backward edges (from >= to in the produced sequence) are cycle back-edges. */
function isBackward(
  edge: DirectedEdge,
  positions: ReadonlyMap<string, number>
): boolean {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  return from !== undefined && to !== undefined && from >= to;
}

/**
 * The core "drop lowest-confidence edge" selection. Deterministic key across
 * the cycle edges: ascending edge confidence first (the contract rule), then
 * backward-edge preference as the tie-break (a back-edge can be dropped
 * without ever breaking a forward chain), then ascending construction order.
 */
function pickCycleEdge(
  candidates: readonly DirectedEdge[],
  positions: ReadonlyMap<string, number>,
  score: (edge: DirectedEdge) => number
): number {
  let bestIndex = 0;
  let bestScore = score(candidates[0]);
  let bestBackward = isBackward(candidates[0], positions);
  for (let i = 1; i < candidates.length; i++) {
    const edge = candidates[i];
    const candidateScore = score(edge);
    const candidateBackward = isBackward(edge, positions);
    let better = false;
    if (candidateScore !== bestScore) {
      better = candidateScore < bestScore;
    } else if (candidateBackward !== bestBackward) {
      better = candidateBackward;
    }
    if (better) {
      bestIndex = i;
      bestScore = candidateScore;
      bestBackward = candidateBackward;
    }
  }
  return bestIndex;
}

function mirrorOf(edge: ReadingOrderEdge): ReadingOrderEdge {
  return Object.freeze({
    type: READING_PREVIOUS,
    from: edge.to,
    to: edge.from,
  });
}

function edgeKey(edge: DirectedEdge): string {
  return `${edge.type}\u0000${edge.from}\u0000${edge.to}`;
}

function removeFirst<E extends DirectedEdge>(
  edges: readonly E[],
  target: E
): E[] {
  const out: E[] = [];
  let removed = false;
  for (const edge of edges) {
    if (!removed && edgeKey(edge) === edgeKey(target)) {
      removed = true;
      continue;
    }
    out.push(edge);
  }
  return out;
}

/** Drop duplicate edges, keeping the deterministic first occurrence. */
function dedupeEdges<E extends DirectedEdge>(
  edges: readonly E[],
  context: RepairContext
): readonly E[] {
  const kept: E[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (seen.has(key)) {
      context.actions.push({
        kind: "DROP_DUPLICATE_EDGE",
        message: `dropped duplicate edge ${edge.type} ${edge.from} -> ${edge.to}`,
        detail: "the first occurrence of an identical edge is kept",
      });
      context.counters.duplicateEdges += 1;
      continue;
    }
    seen.add(key);
    kept.push(edge);
  }
  return kept;
}

/**
 * Break reading-order cycles. Repeatedly locates the READING_NEXT cycle and
 * removes its lowest-confidence edge plus the READING_PREVIOUS mirror, until
 * the graph is acyclic. Bounded by the number of edges.
 */
function repairReadingOrderCycles(
  graph: ReadingOrderGraph,
  edges: readonly ReadingOrderEdge[],
  context: RepairContext
): readonly ReadingOrderEdge[] {
  let kept = [...edges];
  const sequence = graph.readingSequence();
  const positions = new Map<string, number>();
  for (let i = 0; i < sequence.length; i++) {
    positions.set(sequence[i], i);
  }
  const score = (edge: DirectedEdge): number => edgeScore(context, edge);
  for (let guard = 0; guard <= kept.length; guard++) {
    const nextEdges = kept.filter((edge) => edge.type === READING_NEXT);
    const topo: TopoSortEdge[] = nextEdges.map((edge) => ({
      type: edge.type,
      from: edge.from,
      to: edge.to,
    }));
    const sort = iterativeTopologicalSort(sequence, topo);
    if (sort.acyclic) break;
    const remaining = new Set(sort.cycleNodes);
    const candidates = nextEdges.filter(
      (edge) => remaining.has(edge.from) && remaining.has(edge.to)
    );
    if (candidates.length === 0) break;
    const chosen = candidates[pickCycleEdge(candidates, positions, score)];
    kept = removeFirst(kept, chosen);
    kept = removeFirst(kept, mirrorOf(chosen));
    context.actions.push({
      kind: "REMOVE_READING_EDGE",
      message: `removed reading edge ${chosen.from} -> ${chosen.to} to break a cycle`,
      detail: "the lowest-confidence edge of the cycle is dropped along with its mirror",
    });
    context.counters.readingEdges += 1;
  }
  return kept;
}

/** Break containment cycles in the semantic graph, edge by edge. */
function repairContainmentCycles(
  semanticGraph: SemanticGraph,
  edges: readonly TypedLayoutEdge[],
  context: RepairContext
): readonly TypedLayoutEdge[] {
  let kept = [...edges];
  const nodes = semanticGraph.nodes();
  const score = (edge: DirectedEdge): number => edgeScore(context, edge);
  for (let guard = 0; guard <= kept.length; guard++) {
    const containsEdges = kept.filter(
      (edge) => edge.type === LAYOUT_EDGE_TYPE.CONTAINS
    );
    const topo: TopoSortEdge[] = containsEdges.map((edge) => ({
      type: edge.type,
      from: edge.from,
      to: edge.to,
    }));
    const sort = iterativeTopologicalSort(nodes, topo);
    if (sort.acyclic) break;
    const remaining = new Set(sort.cycleNodes);
    const candidates = containsEdges.filter(
      (edge) => remaining.has(edge.from) && remaining.has(edge.to)
    );
    if (candidates.length === 0) break;
    const chosen = candidates[pickCycleEdge(candidates, new Map(), score)];
    kept = removeFirst(kept, chosen);
    context.actions.push({
      kind: "REMOVE_CONTAINMENT_EDGE",
      message: `removed containment edge ${chosen.from} -> ${chosen.to} to break a cycle`,
      detail: "the lowest-confidence containment edge of the cycle is dropped",
    });
    context.counters.containmentEdges += 1;
  }
  return kept;
}

/**
 * Resolve multiple CHILD_OF parents. Every node keeps its highest-confidence
 * parent (ties resolve to the earlier edge) and the others are dropped.
 */
function repairMultipleParents(
  edges: readonly TypedLayoutEdge[],
  context: RepairContext
): readonly TypedLayoutEdge[] {
  const kept = [...edges];
  const incoming = new Map<string, number[]>();
  for (let i = 0; i < kept.length; i++) {
    const edge = kept[i];
    if (edge.type !== LAYOUT_EDGE_TYPE.CHILD_OF) continue;
    const list = incoming.get(edge.to);
    if (list === undefined) {
      incoming.set(edge.to, [i]);
    } else {
      list.push(i);
    }
  }
  const drop = new Set<number>();
  for (const [to, indexes] of incoming) {
    if (indexes.length < 2) continue;
    let best = indexes[0];
    let bestScore = nodeScore(context, kept[best].from);
    for (let k = 1; k < indexes.length; k++) {
      const index = indexes[k];
      const candidateScore = nodeScore(context, kept[index].from);
      // Higher confidence wins; ties keep the earlier (construction-order) edge.
      if (candidateScore > bestScore) {
        best = index;
        bestScore = candidateScore;
      }
    }
    for (const index of indexes) {
      if (index === best) continue;
      drop.add(index);
      context.actions.push({
        kind: "DROP_PARENT",
        message: `dropped parent ${kept[index].from} of node ${to}`,
        detail: `the highest-confidence parent ${kept[best].from} is kept`,
      });
      context.counters.parents += 1;
    }
  }
  return kept.filter((_, index) => !drop.has(index));
}

/**
 * The unified repair gate. Repairs every fixable defect deterministically and
 * returns a report over the repaired model, or a `GraphValidationFailure` when
 * the model cannot be repaired (incoherent structures, invalid confidence,
 * missing OCR ownership).
 */
export function repairGraphs(input: GraphValidationInput): GraphRepairResult {
  const universe = nodeUniverseMismatch(
    input.hierarchy.nodes().map((node) => node.id),
    input.hierarchy.rootId,
    input.semanticGraph,
    input.readingOrder,
    input.confidence
  );
  if (universe.length > 0) {
    return {
      outcome: createGraphValidationFailure(
        "the input structures describe different node universes",
        universe
      ),
    };
  }

  const coverage = validateCompleteOcrCoverage(input.ocr, input.hierarchy);
  if (coverage.errors.length > 0) {
    return {
      outcome: createGraphValidationFailure(
        "missing or incomplete OCR ownership",
        coverage.errors
      ),
    };
  }

  const bounds = validateConfidenceBounds(input.hierarchy, input.confidence);
  const finite = validateFiniteConfidenceValues(input.hierarchy, input.confidence);
  const confidenceErrors = [...bounds.errors, ...finite.errors];
  if (confidenceErrors.length > 0) {
    return {
      outcome: createGraphValidationFailure(
        "invalid confidence values cannot be repaired",
        confidenceErrors
      ),
    };
  }

  const context: RepairContext = {
    confidence: input.confidence,
    actions: [],
    counters: {
      readingEdges: 0,
      containmentEdges: 0,
      duplicateEdges: 0,
      parents: 0,
    },
  };

  const semanticDeduped = dedupeEdges(
    input.semanticGraph.edges(),
    context
  );
  const semanticRepaired = repairMultipleParents(
    repairContainmentCycles(input.semanticGraph, semanticDeduped, context),
    context
  );

  const readingDeduped = dedupeEdges(
    input.readingOrder.edges(),
    context
  );
  const readingRepaired = repairReadingOrderCycles(
    input.readingOrder,
    readingDeduped,
    context
  );

  const semanticGraph = new SemanticGraph();
  for (const id of input.semanticGraph.nodes()) {
    semanticGraph.addNode(id, {
      level: input.semanticGraph.nodeLevel(id)!,
      regionType: input.semanticGraph.regionType(id),
    });
  }
  for (const edge of semanticRepaired) {
    semanticGraph.addEdge(edge.type, edge.from, edge.to);
  }
  semanticGraph.freeze();

  const readingOrder = new ReadingOrderGraph(
    [...input.readingOrder.nodes()],
    readingRepaired
  );

  const repairedModel: GraphValidationInput = {
    ocr: input.ocr,
    hierarchy: input.hierarchy,
    semanticGraph,
    readingOrder,
    confidence: input.confidence,
  };

  const outcome = validateGraphs(repairedModel);
  if (outcome.kind === "failure") {
    return { outcome, repairedModel };
  }

  const report = createGraphValidationReport({
    errors: outcome.errors,
    warnings: outcome.warnings,
    repaired: context.actions.length > 0,
    repairActions: context.actions,
    statistics: createGraphValidationStatistics({
      nodeCount: repairedModel.hierarchy.nodeCount,
      edgeCount: modelEdgeCount(
        repairedModel.hierarchy,
        repairedModel.semanticGraph,
        repairedModel.readingOrder
      ),
      repairedEdgeCount:
        context.counters.readingEdges +
        context.counters.containmentEdges +
        context.counters.duplicateEdges,
      repairedParentCount: context.counters.parents,
    }),
  });

  return { outcome: report, repairedModel };
}
