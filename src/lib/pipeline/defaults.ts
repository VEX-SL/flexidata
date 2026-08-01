import type {
  AIClient,
  PipelineStage,
  RunJobInput,
  RunJobOutput,
} from "./types";
import { Pipeline } from "./orchestrator";
import { defaultPipelineStages } from "./stages";

/**
 * Wiring layer — composes the generic Pipeline with a stage list.
 * Keeping this outside orchestrator.ts guarantees the coordinator stays
 * stage-agnostic (point: replaceable without changing the orchestrator).
 */
export function createDefaultPipeline(
  opts: { ai?: AIClient; stages?: PipelineStage[] } = {}
): Pipeline {
  return new Pipeline(opts.stages ?? defaultPipelineStages({ ai: opts.ai }));
}

export async function runPipeline(
  input: RunJobInput,
  opts: { ai?: AIClient; stages?: PipelineStage[] } = {}
): Promise<RunJobOutput> {
  return createDefaultPipeline(opts).run(input);
}
