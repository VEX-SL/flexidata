/**
 * Milestone 9 — the immutable `LayoutContext` container.
 *
 * The single immutable outcome of the layout pipeline. The context references
 * the already-frozen structural components it is assembled from — it never
 * copies or duplicates them, and it carries no mutable state, setters or lazy
 * mutation. The exact surface is fixed:
 *
 *     layoutDocument | hierarchy | semanticGraph | readingOrder
 *     | propagatedConfidence | validationReport
 *
 * `validationReport` is the final gate outcome: the M8 validation report when
 * the model was clean, the M8 repair report (which is itself a
 * `GraphValidationReport` carrying `repaired` and `repairActions`) when the
 * pipeline repaired the model, and `null` on a broken/failed build.
 *
 * A `LayoutFailure` (reason + details) travels on the `LayoutResult`, never on
 * the context, so a failed layout is still reported to extraction without ever
 * stopping it.
 */
import type { OcrDocument } from "@/lib/pipeline/types";
import type { LayoutDocument } from "./types";
import type { LayoutHierarchy } from "./hierarchy";
import type { SemanticGraph } from "./semantic-graph";
import type { ReadingOrderGraph } from "./reading-order";
import type { PropagatedConfidence } from "./confidence-propagation";
import type { GraphValidationReport } from "./graph-validation-report";

/** A structured layout failure. Extraction continues exactly as before. */
export interface LayoutFailure {
  readonly reason: string;
  readonly details: readonly string[];
}

/**
 * The immutable layout outcome of a document. `failure` is present exactly
 * when the layout could not be built or validated; the context is always
 * present (a broken context when the build failed).
 */
export interface LayoutResult {
  /** The layout context: fully populated on success, broken on failure. */
  readonly context: LayoutContext;
  /** Present when the layout could not be built or validated. */
  readonly failure?: LayoutFailure;
}

/**
 * The six-field immutable layout container. Component fields are null only on
 * a broken build that never produced them; a successful build carries all of
 * them non-null, referencing the exact objects the pipeline built.
 */
export interface LayoutContext {
  /** The M1 structural projection of the source OCR. */
  readonly layoutDocument: LayoutDocument | null;
  /** The M4 structural hierarchy (Document → Page → Region → Block → Line → Word). */
  readonly hierarchy: LayoutHierarchy | null;
  /** The M2 typed semantic graph mirroring the hierarchy (classification-aware). */
  readonly semanticGraph: SemanticGraph | null;
  /** The M6 reading-order graph over the hierarchy. */
  readonly readingOrder: ReadingOrderGraph | null;
  /** The M7 propagated confidence over the hierarchy. */
  readonly propagatedConfidence: PropagatedConfidence | null;
  /**
   * The final M8 gate report: validation when clean, the repair report when
   * repair ran, or null when the gate failed.
   */
  readonly validationReport: GraphValidationReport | null;
}

/** The components `createLayoutContext` assembles (all nullable for breaks). */
export interface LayoutContextInput {
  readonly layoutDocument: LayoutDocument | null;
  readonly hierarchy: LayoutHierarchy | null;
  readonly semanticGraph: SemanticGraph | null;
  readonly readingOrder: ReadingOrderGraph | null;
  readonly propagatedConfidence: PropagatedConfidence | null;
  readonly validationReport: GraphValidationReport | null;
}

/**
 * Assemble an immutable context from already-built components. The context
 * reuses the exact component objects (no duplication) and is deep-frozen; the
 * components are already frozen by their own constructors and are never
 * mutated here.
 */
export function createLayoutContext(input: LayoutContextInput): LayoutContext {
  return Object.freeze({
    layoutDocument: input.layoutDocument,
    hierarchy: input.hierarchy,
    semanticGraph: input.semanticGraph,
    readingOrder: input.readingOrder,
    propagatedConfidence: input.propagatedConfidence,
    validationReport: input.validationReport,
  });
}

/**
 * Build a broken failure context: the components that exist plus a nullish
 * working/validation report. Missing components stay null — nothing is
 * fabricated.
 */
export function brokenLayoutContext(
  partial: Partial<LayoutContextInput> = {}
): LayoutContext {
  return createLayoutContext({
    layoutDocument: partial.layoutDocument ?? null,
    hierarchy: partial.hierarchy ?? null,
    semanticGraph: partial.semanticGraph ?? null,
    readingOrder: partial.readingOrder ?? null,
    propagatedConfidence: partial.propagatedConfidence ?? null,
    validationReport: null,
  });
}

/** Create an immutable layout failure. */
export function layoutFailure(
  reason: string,
  details: readonly string[] = []
): LayoutFailure {
  return Object.freeze({
    reason,
    details: Object.freeze([...details]),
  });
}

/** Narrow a result to the failure case. */
export function isLayoutFailure(
  result: LayoutResult
): result is LayoutResult & { readonly failure: LayoutFailure } {
  return result.failure !== undefined;
}

/** Narrow a result to the success case. */
export function isLayoutSuccess(result: LayoutResult): boolean {
  return result.failure === undefined;
}

/** The OCR document a layout context was projected from, when available. */
export function layoutSourceOcr(
  context: LayoutContext
): OcrDocument | undefined {
  return context.layoutDocument?.source;
}
