import type { AIClient, PipelineStage } from "../types";
import { classifyStage } from "./classify";
import { extractStage } from "./extract";
import { validateStage } from "./validate";
import { confidenceStage } from "./confidence";

/**
 * Default stage registration for a standard extraction run.
 * Future stages (layout, tables, vision, multi-doc) are appended here —
 * the orchestrator and existing stages don't change.
 */
export function defaultPipelineStages(
  opts: { ai?: AIClient } = {}
): PipelineStage[] {
  return [
    classifyStage(opts),
    extractStage(opts),
    validateStage(),
    confidenceStage(),
  ];
}

export { classifyStage, extractStage, validateStage, confidenceStage };
