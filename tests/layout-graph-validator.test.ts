/**
 * Milestone 8 graph validator tests — the unified validation gate over the
 * four composed structures (LayoutHierarchy, SemanticGraph, ReadingOrderGraph,
 * PropagatedConfidence) and the source OCR.
 *
 * Covers the mandated scenarios: valid graph, containment cycle,
 * reading-order cycle, duplicate ownership, missing ownership, duplicate
 * edges, multiple parents, invalid confidence, invalid region type, unfrozen
 * graph, deterministic validation and identical reports on identical inputs.
 */
import {
  HIERARCHY_DOCUMENT_ID,
  HIERARCHY_ROOT_LEVEL,
  LAYOUT_EDGE_TYPE,
  LayoutHierarchy,
  NODE_LEVEL,
  PropagatedConfidence,
  READING_NEXT,
  READING_PREVIOUS,
  ReadingOrderGraph,
  SemanticGraph,
  buildReadingOrder,
  createConfidenceComponents,
  createConfidenceProfile,
  createHierarchyNode,
  isGraphValidationFailure,
  propagateConfidence,
  validateGraphs,
  validateReportDeterminism,
} from "@/lib/layout";
import type {
  ConfidenceComponents,
  ConfidenceProfile,
  GraphValidationInput,
  GraphValidationReport,
  HierarchyLevel,
  HierarchyNode,
  HierarchySourceRef,
  LayoutEdgeType,
  NodeLevel,
  ReadingOrderEdgeType,
  RegionType,
} from "@/lib/layout";
import type { OcrDocument, OcrLine, OcrWord } from "@/lib/pipeline/types";
import { equal, includes, ok, test } from "./harness.ts";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const FULL_BBOX = { x: 0, y: 0, width: 100, height: 100 };

function comps(values: Partial<ConfidenceComponents> = {}): ConfidenceComponents {
  return createConfidenceComponents(values);
}

function prof(samples: readonly ConfidenceComponents[]): ConfidenceProfile {
  return createConfidenceProfile(samples);
}

interface Spec {
  id: string;
  level: HierarchyLevel;
  parent: string | null;
  children?: readonly string[];
  sourceRefs?: readonly HierarchySourceRef[];
  regionType?: RegionType;
  ocr?: number;
}

function makeNode(s: Spec): HierarchyNode {
  return createHierarchyNode({
    id: s.id,
    level: s.level,
    parentId: s.parent,
    pageIndex: s.parent === null ? -1 : 0,
    bbox: FULL_BBOX,
    normalizedBBox: { x: 0, y: 0, width: 1, height: 1 },
    confidence: prof([comps(s.ocr !== undefined ? { ocr: s.ocr } : {})]),
    children: s.children ?? [],
    sourceRefs: s.sourceRefs ?? [],
    ...(s.regionType !== undefined ? { regionType: s.regionType } : {}),
  });
}

/** The default document: one line of three words with distinct confidences. */
function docSpecs(): Spec[] {
  return [
    {
      id: HIERARCHY_DOCUMENT_ID,
      level: HIERARCHY_ROOT_LEVEL,
      parent: null,
      children: ["page"],
    },
    {
      id: "page",
      level: NODE_LEVEL.PAGE,
      parent: HIERARCHY_DOCUMENT_ID,
      children: ["region"],
    },
    {
      id: "region",
      level: NODE_LEVEL.REGION,
      parent: "page",
      children: ["block"],
    },
    {
      id: "block",
      level: NODE_LEVEL.BLOCK,
      parent: "region",
      children: ["line"],
    },
    {
      id: "line",
      level: NODE_LEVEL.LINE,
      parent: "block",
      children: ["w0", "w1", "w2"],
    },
    {
      id: "w0",
      level: NODE_LEVEL.WORD,
      parent: "line",
      sourceRefs: [{ pageIndex: 0, lineIndex: 0, wordIndex: 0 }],
      ocr: 0.9,
    },
    {
      id: "w1",
      level: NODE_LEVEL.WORD,
      parent: "line",
      sourceRefs: [{ pageIndex: 0, lineIndex: 0, wordIndex: 1 }],
      ocr: 0.8,
    },
    {
      id: "w2",
      level: NODE_LEVEL.WORD,
      parent: "line",
      sourceRefs: [{ pageIndex: 0, lineIndex: 0, wordIndex: 2 }],
      ocr: 0.1,
    },
  ];
}

function positioned(text: string, x: number): OcrWord {
  return { text, bbox: { x, y: 0, width: 10, height: 10 } };
}

function makeOcr(wordCount = 3): OcrDocument {
  const words: OcrWord[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(positioned(String.fromCharCode(97 + i), i * 20));
  }
  const line: OcrLine = {
    text: words.map((w) => w.text).join(" "),
    words,
    bbox: { x: 0, y: 0, width: wordCount * 20, height: 10 },
  };
  return { text: line.text, lines: [line] };
}

interface BuildModelOptions {
  /** Extra typed edges added to the semantic graph after derivation. */
  readonly extraEdges?: readonly (readonly [LayoutEdgeType, string, string])[];
  /** Freeze the semantic graph (default true). */
  readonly frozen?: boolean;
  /** Override the region type of a node id (cast; vocabulary is validated). */
  readonly regionTypeOf?: ReadonlyMap<string, string>;
}

function buildSemanticGraph(
  hierarchy: LayoutHierarchy,
  options: BuildModelOptions = {}
): SemanticGraph {
  const graph = new SemanticGraph();
  for (const node of hierarchy.nodes()) {
    if (node.id === HIERARCHY_DOCUMENT_ID) continue;
    const override = options.regionTypeOf?.get(node.id);
    graph.addNode(node.id, {
      level: node.level as NodeLevel,
      ...(override !== undefined
        ? { regionType: override as RegionType }
        : { regionType: node.regionType }),
    });
  }
  for (const node of hierarchy.nodes()) {
    if (node.id === HIERARCHY_DOCUMENT_ID) continue;
    for (const childId of node.children) {
      graph.addEdge(LAYOUT_EDGE_TYPE.CHILD_OF, node.id, childId);
      graph.addEdge(LAYOUT_EDGE_TYPE.CONTAINS, node.id, childId);
    }
  }
  for (const [type, from, to] of options.extraEdges ?? []) {
    graph.addEdge(type, from, to);
  }
  if (options.frozen !== false) graph.freeze();
  return graph;
}

function buildModel(
  specs: readonly Spec[],
  ocr: OcrDocument,
  options: BuildModelOptions = {}
): GraphValidationInput {
  const hierarchy = new LayoutHierarchy(specs.map(makeNode));
  return {
    ocr,
    hierarchy,
    semanticGraph: buildSemanticGraph(hierarchy, options),
    readingOrder: buildReadingOrder(hierarchy),
    confidence: propagateConfidence(hierarchy),
  };
}

function fixture(options: BuildModelOptions = {}): GraphValidationInput {
  return buildModel(docSpecs(), makeOcr(), options);
}

function reportErrors(input: GraphValidationInput): readonly string[] {
  const outcome = validateGraphs(input);
  if (isGraphValidationFailure(outcome)) {
    throw new Error(`expected a report, got a failure: ${outcome.reason}`);
  }
  return outcome.errors;
}

function readingOrderWith(
  model: GraphValidationInput,
  extra: readonly (readonly [ReadingOrderEdgeType, string, string])[]
): ReadingOrderGraph {
  const nodes = model.readingOrder.nodes();
  const edges = model.readingOrder.edges();
  return new ReadingOrderGraph(
    nodes,
    edges.concat(
      extra.map(([type, from, to]) => ({ type, from, to }))
    )
  );
}

function asReport(
  input: GraphValidationInput
): GraphValidationReport {
  const outcome = validateGraphs(input);
  if (isGraphValidationFailure(outcome)) {
    throw new Error(`expected a report, got a failure: ${outcome.reason}`);
  }
  return outcome;
}

// ─── 1. Valid graph ──────────────────────────────────────────────────────────

test("a fully assembled model passes every M8 check", () => {
  const report = asReport(fixture());
  ok(report.valid, `errors: ${report.errors.join("; ")}`);
  equal(report.repaired, false);
  equal(report.statistics.nodeCount, 8);
});

// ─── 2. Containment cycle ────────────────────────────────────────────────────

test("a containment cycle in the semantic graph is rejected", () => {
  const input = fixture({
    extraEdges: [[LAYOUT_EDGE_TYPE.CONTAINS, "w2", "line"]],
  });
  const errors = reportErrors(input);
  includes(errors.join("; "), "containment graph has a cycle");
});

// ─── 3. Reading-order cycle ──────────────────────────────────────────────────

test("a reading-order cycle is rejected", () => {
  const input = fixture();
  const cyclic = readingOrderWith(input, [
    [READING_NEXT, "w2", "w0"],
    [READING_PREVIOUS, "w0", "w2"],
  ]);
  const errors = reportErrors({ ...input, readingOrder: cyclic });
  includes(errors.join("; "), "reading order graph has a cycle");
});

// ─── 4. Duplicate OCR ownership ──────────────────────────────────────────────

test("duplicate OCR ownership is rejected", () => {
  const specs = docSpecs();
  const line = specs.find((s) => s.id === "line")!;
  specs.push({
    id: "w1b",
    level: NODE_LEVEL.WORD,
    parent: "line",
    sourceRefs: [{ pageIndex: 0, lineIndex: 0, wordIndex: 1 }],
    ocr: 0.5,
  });
  line.children = [...(line.children ?? []), "w1b"];
  const input = buildModel(specs, makeOcr());
  const errors = reportErrors(input);
  includes(errors.join("; "), "OCR word 0:0:1 is owned by both");
});

// ─── 5. Missing ownership ────────────────────────────────────────────────────

test("a source word the hierarchy does not own is rejected", () => {
  const input = buildModel(docSpecs(), makeOcr(4));
  const errors = reportErrors(input);
  includes(errors.join("; "), "word 0:0:3 is not covered");
});

// ─── 6. Duplicate edges ──────────────────────────────────────────────────────

test("duplicate reading edges are rejected", () => {
  const input = fixture();
  const dup = readingOrderWith(input, [[READING_NEXT, "w0", "w1"]]);
  const errors = reportErrors({ ...input, readingOrder: dup });
  includes(errors.join("; "), "duplicate edge: READING_NEXT w0 -> w1");
});

// ─── 7. Multiple parents ─────────────────────────────────────────────────────

test("multiple CHILD_OF parents in the semantic graph are rejected", () => {
  const input = fixture({
    extraEdges: [[LAYOUT_EDGE_TYPE.CHILD_OF, "block", "w1"]],
  });
  const errors = reportErrors(input);
  includes(errors.join("; "), "node w1 has 2 CHILD_OF parents");
});

// ─── 8. Invalid confidence ───────────────────────────────────────────────────

test("out-of-range propagated confidence is rejected", () => {
  const input = fixture();
  const map = new Map<string, ConfidenceProfile>();
  for (const id of input.confidence.ids()) {
    map.set(id, input.confidence.get(id)!);
  }
  const w2 = map.get("w2")!;
  map.set(
    "w2",
    Object.freeze({
      ...w2,
      aggregate: Object.freeze({
        count: 1,
        mean: 1.5,
        variance: 0,
        min: 1.5,
        max: 1.5,
      }),
    })
  );
  const bad = {
    ...input,
    confidence: new PropagatedConfidence(input.hierarchy, map),
  };
  const errors = reportErrors(bad);
  includes(errors.join("; "), "outside the confidence range");
});

// ─── 9. Invalid region type ──────────────────────────────────────────────────

test("a region outside the official vocabulary is rejected", () => {
  const input = fixture({
    regionTypeOf: new Map([["region", "Bogus"]]),
  });
  const errors = reportErrors(input);
  includes(errors.join("; "), "unknown region type Bogus");
});

// ─── 10. Unfrozen graph ──────────────────────────────────────────────────────

test("an unfrozen semantic graph is rejected", () => {
  const input = fixture({ frozen: false });
  const errors = reportErrors(input);
  includes(errors.join("; "), "semantic graph is not frozen");
});

// ─── 11. Deterministic validation ────────────────────────────────────────────

test("identical inputs produce byte-identical reports", () => {
  const input = fixture();
  const first = asReport(input);
  const second = asReport(input);
  equal(JSON.stringify(first), JSON.stringify(second));
  ok(validateReportDeterminism(first, second).valid);
});

test("deterministic validation holds over identical error sets", () => {
  const input = fixture({
    extraEdges: [[LAYOUT_EDGE_TYPE.CHILD_OF, "block", "w1"]],
  });
  const first = asReport(input);
  const second = asReport(input);
  ok(validateReportDeterminism(first, second).valid);
});

// ─── 12. Failure paths ───────────────────────────────────────────────────────

test("incoherent node universes yield a validation failure", () => {
  const input = fixture();
  const missing = new ReadingOrderGraph(
    input.readingOrder.nodes().filter((n) => n.id !== "w2"),
    input.readingOrder
      .edges()
      .filter((e) => e.from !== "w2" && e.to !== "w2")
  );
  const outcome = validateGraphs({ ...input, readingOrder: missing });
  ok(isGraphValidationFailure(outcome));
  if (isGraphValidationFailure(outcome)) {
    includes(outcome.reason, "different node universes");
  }
});
