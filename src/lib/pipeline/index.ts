/**
 * FlexiData AI — Document Intelligence Pipeline.
 * Entry barrel: types, profile plugin system, injectable stages, generic
 * coordinator, and trace helpers.
 *
 * Server-side usage:
 *   const result = await runPipeline({ sourceText, fileName });
 *
 * Custom pipelines (add/replace stages without touching the coordinator):
 *   const pipeline = new Pipeline([classifyStage(), myVisionStage(), extractStage(), validateStage(), confidenceStage()]);
 */
export * from "./types";
export * from "./profiles";
export { defaultAIClient } from "./ai";
export { PIPELINE_VERSION, MAX_SOURCE_TEXT } from "./constants";
export { PipelineError, toStructuredError } from "./errors";
export { toJobDTO, toErrorDTO } from "./dto";
export type { JobDTO, ExtractionListDTO, ProfileDTO, FieldDTO, ErrorDTO } from "./dto";
export { PipelineService } from "./service";
export { Pipeline } from "./orchestrator";
export { createDefaultPipeline, runPipeline } from "./defaults";
export {
  defaultPipelineStages,
  classifyStage,
  extractStage,
  groundStage,
  cleanStage,
  recoverStage,
  validateStage,
  confidenceStage,
} from "./stages";
export { traceEvent, describeTrace, stageSummary } from "./trace";
export { classifyDocument, scoreByAliases } from "./classifier";
export { validateExtraction } from "./validator";
export { computeConfidence } from "./confidence";
export { exportExtraction } from "./exporter";
export { extractDocument, parseRaw } from "./extractor";
export { buildExtractionPrompt, truncateMiddle } from "./extractor/prompt-builder";
export { extractJSON, stripCodeFences } from "./extractor/json-repair";
export { normalizeFields, coerce } from "./extractor/normalizer";
export { postProcessFields } from "./extractor/post-processor";
export { cleanExtraction } from "./entity-cleaner";
