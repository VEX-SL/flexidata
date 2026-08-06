/**
 * Layout-Aware Document Model — the layout layer between OCR and extraction.
 *
 * Milestone 1: reusable foundation only. Geometry primitives, immutable
 * domain models, the mandatory spatial index, graph data structures and the
 * OCR → Layout → Extraction port contracts. No segmentation, region
 * inference, reading order or validation yet — later milestones build on this
 * base without touching either the OCR or the extraction layer.
 *
 * Milestone 2 (additive): the semantic graph layer. Edge vocabulary, region
 * roles, node levels, confidence components with deterministic propagation
 * helpers, the typed `SemanticGraph` with immutable traversal, and reusable
 * graph validation primitives. Still no segmentation, inference or integration.
 */
export * from "./types";
export * from "./models";
export * from "./geometry";
export * from "./spatial-index";
export * from "./graph";
export * from "./edge-types";
export * from "./region-types";
export * from "./node-levels";
export * from "./confidence";
export * from "./semantic-graph";
export * from "./validation";
export * from "./stats";
export * from "./blocks";
export * from "./segmentation";
export * from "./segmentation-validation";
export * from "./hierarchy";
export * from "./hierarchy-builder";
export * from "./hierarchy-validation";
export * from "./interfaces";
