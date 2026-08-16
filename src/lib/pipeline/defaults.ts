import type {
  AIClient,
  PipelineStage,
  RunJobInput,
  RunJobOutput,
} from "./types";
import { Pipeline, type PipelineOptions } from "./orchestrator";
import { defaultPipelineStages } from "./stages";

/**
 * Wiring layer — composes the generic Pipeline with a stage list.
 * Keeping this outside orchestrator.ts guarantees the coordinator stays
 * stage-agnostic (point: replaceable without changing the orchestrator).
 */
export interface DefaultPipelineOptions extends PipelineOptions {
  ai?: AIClient;
  stages?: PipelineStage[];
}

export function createDefaultPipeline(
  opts: DefaultPipelineOptions = {}
): Pipeline {
  return new Pipeline(opts.stages ?? defaultPipelineStages({ ai: opts.ai }), {
    onStage: opts.onStage,
  });
}

export async function runPipeline(
  input: RunJobInput,
  opts: DefaultPipelineOptions = {}
): Promise<RunJobOutput> {
  return createDefaultPipeline(opts).run(input);
}
