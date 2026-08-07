/**
 * Milestone 9 — layout integration surface.
 *
 * The single public entry point for consumers (extraction flows) and tests.
 * Re-exports the M9 pipeline surface only — zero new behavior lives here; the
 * implementation lives in the pipeline, projector, context and cache modules.
 */
export { LayoutPipeline, buildLayoutPipeline, deriveSemanticGraph } from "./layout-pipeline";
export type { LayoutPipelineOptions } from "./layout-pipeline";
export { LayoutProjector, buildProjector, cleanOcr, isFiniteBBox } from "./layout-projector";
export type { ProjectionInput, ProjectionSkipSummary } from "./layout-projector";
export {
  brokenLayoutContext,
  createLayoutContext,
  isLayoutFailure,
  isLayoutSuccess,
  layoutFailure,
  layoutSourceOcr,
} from "./layout-context";
export type {
  LayoutContext,
  LayoutContextInput,
  LayoutFailure,
  LayoutResult,
} from "./layout-context";
export {
  canonOcr,
  createLayoutCache,
  deterministicDigest,
  hashOcr,
  layoutCacheGet,
  layoutCacheKey,
  layoutCacheSet,
} from "./layout-cache";
export type { LayoutCache } from "./layout-cache";
