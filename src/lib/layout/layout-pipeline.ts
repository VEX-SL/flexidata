/**
 * Milestone 9 — the layout integration pipeline.
 *
 * Runs the M1–M8 layout stages over a cleaned OCR document in the strict
 * milestone order and produces the immutable `LayoutContext`:
 *
 *     Segmentation (M3) → Hierarchy (M4) → Semantic graph (M2 mirror)
 *     → Region Classification (M5) → Reading Order (M6)
 *     → Confidence Propagation (M7) → Validation/Repair gate (M8)
 *
 * Deterministic by construction: every stage is a pure deterministic function
 * of its inputs, the cleaned OCR is the single canonical document all stages
 * and the cache key derive from, and the pipeline itself holds no mutable
 * state.
 *
 * Failure handling: a build failure or an irreparable gate failure produces a
 * `LayoutResult` carrying a `LayoutFailure` — the calling extraction flow
 * keeps running exactly as before. Failed results are never cached.
 *
 * The pipeline reuses the canonical derivation of the semantic graph from the
 * M8 gate tests (every hierarchy node and its CHILD_OF/CONTAINS edges mirrored
 * into the typed graph) — structural mapping only, no new inference.
 */
import type { OcrDocument } from "@/lib/pipeline/types";
import { segmentDocument } from "./segmentation";
import { buildHierarchy } from "./hierarchy-builder";
import { classifyRegions } from "./region-classifier";
import { buildReadingOrder } from "./reading-order-builder";
import { propagateConfidence } from "./confidence-propagation";
import { validateGraphs } from "./graph-validator";
import type { GraphValidationInput } from "./graph-validator";
import { isGraphValidationFailure } from "./graph-validation-report";
import { repairGraphs } from "./graph-repair";
import { LayoutProjector } from "./layout-projector";
import type { LayoutCache } from "./layout-cache";
import { createLayoutCache, layoutCacheKey } from "./layout-cache";
import {
  brokenLayoutContext,
  createLayoutContext,
  layoutFailure,
} from "./layout-context";
import type {
  LayoutContext,
  LayoutContextInput,
  LayoutFailure,
  LayoutResult,
} from "./layout-context";
import { SemanticGraph } from "./semantic-graph";
import { LAYOUT_EDGE_TYPE } from "./edge-types";
import { HIERARCHY_DOCUMENT_ID } from "./hierarchy";
import type { LayoutHierarchy } from "./hierarchy";
import type { NodeLevel } from "./node-levels";
import type { RegionType } from "./region-types";
import type { LayoutDocument } from "./types";

export interface LayoutPipelineOptions {
  /** The result cache; defaults to a fresh in-memory cache. */
  readonly cache?: LayoutCache;
  /** The OCR → Layout projector; defaults to the built-in projector. */
  readonly projector?: LayoutProjector;
}

/**
 * Mirror a hierarchy into the typed M2 semantic graph: every hierarchy node
 * (except the document root) with its level and region type, plus the
 * structural CHILD_OF and CONTAINS edges of the tree. This is the canonical
 * derivation used by the M8 gate tests.
 */
export function deriveSemanticGraph(
  hierarchy: LayoutHierarchy
): SemanticGraph {
  const graph = new SemanticGraph();
  for (const node of hierarchy.nodes()) {
    if (node.id === HIERARCHY_DOCUMENT_ID) continue;
    graph.addNode(node.id, {
      level: node.level as NodeLevel,
      regionType: node.regionType as RegionType | undefined,
    });
  }
  for (const node of hierarchy.nodes()) {
    if (node.id === HIERARCHY_DOCUMENT_ID) continue;
    for (const childId of node.children) {
      graph.addEdge(LAYOUT_EDGE_TYPE.CHILD_OF, node.id, childId);
      graph.addEdge(LAYOUT_EDGE_TYPE.CONTAINS, node.id, childId);
    }
  }
  return graph.freeze();
}

/**
 * The M9 layout pipeline: a deterministic, cache-backed build of the full
 * immutable layout context from an OCR document.
 */
export class LayoutPipeline {
  private readonly cache: LayoutCache;
  private readonly projector: LayoutProjector;

  constructor(options: LayoutPipelineOptions = {}) {
    this.cache = options.cache ?? createLayoutCache();
    this.projector = options.projector ?? new LayoutProjector();
  }

  /** The cache backing this pipeline. */
  get resultCache(): LayoutCache {
    return this.cache;
  }

  /**
   * Build the layout context for an OCR document. Identical OCR always yields
   * the identical cached `LayoutResult` object; a failure never stops the
   * caller and is never cached.
   */
  build(ocr: OcrDocument): LayoutResult {
    try {
      const projection = this.projector.project(ocr);
      const ocrForLayout = projection.source ?? ocr;
      const key = layoutCacheKey(ocrForLayout);
      const cached = this.cache.get(key);
      if (cached !== undefined) return cached;

      const result = this.run(projection, ocrForLayout);
      if (result.failure === undefined) {
        this.cache.set(key, result);
      }
      return result;
    } catch (error) {
      return this.failure("layout build failed", [messageOf(error)]);
    }
  }

  private run(
    projection: LayoutDocument,
    ocr: OcrDocument
  ): LayoutResult {
    try {
      const segmentation = segmentDocument(ocr);
      const blocks = segmentation.blocks;
      const hierarchy = buildHierarchy(ocr, blocks);
      const semanticGraph = deriveSemanticGraph(hierarchy);
      classifyRegions(hierarchy, blocks);
      const readingOrder = buildReadingOrder(hierarchy);
      const propagatedConfidence = propagateConfidence(hierarchy);

      const input: GraphValidationInput = {
        ocr,
        hierarchy,
        semanticGraph,
        readingOrder,
        confidence: propagatedConfidence,
      };
      const validation = validateGraphs(input);
      if (isGraphValidationFailure(validation)) {
        return this.failure(
          "layout graph validation failed",
          [validation.reason, ...validation.details],
          { layoutDocument: projection, hierarchy, semanticGraph, readingOrder, propagatedConfidence }
        );
      }

      if (validation.valid) {
        const context = createLayoutContext({
          layoutDocument: projection,
          hierarchy,
          semanticGraph,
          readingOrder,
          propagatedConfidence,
          validationReport: validation,
        });
        return Object.freeze({ context });
      }

      // The model is coherent but the gate found violations — repair it and
      // expose the repair report (which is itself a validation report).
      const repair = repairGraphs(input);
      if (isGraphValidationFailure(repair.outcome) || repair.repairedModel === undefined) {
        return this.failure(
          "layout graph validation failed and repair could not restore the model",
          repair.outcome.kind === "failure"
            ? [repair.outcome.reason, ...repair.outcome.details]
            : [...validation.errors],
          { layoutDocument: projection, hierarchy, semanticGraph, readingOrder, propagatedConfidence }
        );
      }
      const repaired: GraphValidationInput = repair.repairedModel;
      const context = createLayoutContext({
        layoutDocument: projection,
        hierarchy: repaired.hierarchy,
        semanticGraph: repaired.semanticGraph,
        readingOrder: repaired.readingOrder,
        propagatedConfidence: repaired.confidence ?? propagatedConfidence,
        validationReport: repair.outcome,
      });
      return Object.freeze({ context });
    } catch (error) {
      return this.failure("layout build failed", [messageOf(error)]);
    }
  }

  private failure(
    reason: string,
    details: readonly string[],
    partial: Partial<LayoutContextInput> = {}
  ): LayoutResult {
    const context: LayoutContext = brokenLayoutContext(partial);
    const failure: LayoutFailure = layoutFailure(reason, details);
    return Object.freeze({ context, failure });
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Build a default layout pipeline. */
export function buildLayoutPipeline(options: LayoutPipelineOptions = {}): LayoutPipeline {
  return new LayoutPipeline(options);
}
