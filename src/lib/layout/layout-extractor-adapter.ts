/**
 * Milestone 10 — the extractor adapter.
 *
 * The gradual-migration seam between the extraction layer and the M9 layout
 * context. The adapter exposes the layout through the same interface existing
 * extractors already expect — the immutable `OcrDocument` — plus the four M10
 * navigation layers (reader, query, evidence, selection) and the raw context
 * surface (including the repair report).
 *
 * Migration path: OCR → LayoutContext → Adapter → Extractor. When the source
 * OCR is supplied, `ocr` is that exact immutable object (identical behavior);
 * otherwise it falls back to the cleaned OCR the context was projected from.
 * The adapter never mutates, never copies the OCR and never performs any
 * extraction itself.
 */
import type { OcrDocument } from "@/lib/pipeline/types";
import type { LayoutContext } from "./layout-context";
import { layoutSourceOcr } from "./layout-context";
import type { LayoutDocument } from "./types";
import type { GraphValidationReport } from "./graph-validation-report";
import { LayoutReader } from "./layout-reader";
import { LayoutQuery } from "./layout-query";
import { LayoutEvidence } from "./layout-evidence";
import { LayoutSelection } from "./layout-selection";

export class LayoutExtractorAdapter {
  /** The context being exposed (never mutated). */
  readonly context: LayoutContext;
  /** The immutable source OCR through the interface extractors expect. */
  readonly ocr: OcrDocument | undefined;
  /** Structural navigation over the context. */
  readonly reader: LayoutReader;
  /** Deterministic navigation queries over the context. */
  readonly query: LayoutQuery;
  /** Evidence records for extracted nodes. */
  readonly evidence: LayoutEvidence;
  /** Deterministic candidate selection. */
  readonly selection: LayoutSelection;

  constructor(context: LayoutContext, source?: OcrDocument) {
    this.context = context;
    this.ocr = source ?? layoutSourceOcr(context);
    this.reader = new LayoutReader(context);
    this.query = new LayoutQuery(this.reader);
    this.evidence = new LayoutEvidence(this.reader);
    this.selection = new LayoutSelection(this.reader);
    Object.freeze(this);
  }

  /** The M1 structural projection of the context. */
  get layoutDocument(): LayoutDocument | null {
    return this.context.layoutDocument;
  }

  /** The final M8 gate report: validation, the repair report, or null. */
  get validationReport(): GraphValidationReport | null {
    return this.context.validationReport;
  }
}

/** Build a default adapter over a layout context. */
export function createLayoutExtractorAdapter(
  context: LayoutContext,
  source?: OcrDocument
): LayoutExtractorAdapter {
  return new LayoutExtractorAdapter(context, source);
}
