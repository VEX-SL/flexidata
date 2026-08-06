/**
 * OCR → Layout → Extraction ports.
 *
 * Milestone 1 defines the contracts only — no layout algorithms live here.
 * The concrete projector (OCR → Layout) arrives with the segmentation,
 * region-inference and reading-order milestones; extraction consumers read
 * the layout through these stable seams without ever mutating it.
 */
import type { OcrDocument } from "@/lib/pipeline/types";
import type { LayoutDocument, LayoutNode, LayoutRegion } from "./types";
import type { SpatialIndex } from "./spatial-index";

/** OCR → Layout: projects a source OcrDocument into the layout domain. */
export interface OcrLayoutProjector {
  /** Analyze OCR output into an immutable structural layout. */
  project(ocr: OcrDocument): LayoutDocument;
}

/** Geometry lookup view handed to layout and extraction consumers. */
export interface LayoutLookupPort {
  readonly layout: LayoutDocument;
  /** Single geometry lookup layer over layout nodes. */
  readonly nodes: SpatialIndex<LayoutNode>;
  /** Single geometry lookup layer over layout regions. */
  readonly regions: SpatialIndex<LayoutRegion>;
}

/** Layout → Extraction: read-only structural view for extraction stages. */
export interface LayoutExtractionPort {
  readonly layout: LayoutDocument;
  readonly lookup: LayoutLookupPort;
}
