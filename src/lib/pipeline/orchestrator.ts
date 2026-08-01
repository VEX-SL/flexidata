import type {
  PipelineState,
  PipelineStage,
  RunJobInput,
  RunJobOutput,
  TraceEvent,
} from "./types";
import { toStructuredError } from "./errors";
import { stageSummary, traceEvent } from "./trace";

/**
 * Pipeline — pure coordinator. It knows nothing about specific stages:
 * it only iterates a registered stage list, feeds the shared typed state, and
 * emits a granular trace. All business logic lives in the stages.
 *
 * Replacing/adding a stage = change the stage list (see defaults.ts), never
 * this class.
 */
export class Pipeline {
  constructor(private readonly stages: PipelineStage[]) {}

  async run(input: RunJobInput): Promise<RunJobOutput> {
    const state: PipelineState = {
      input,
      sourceText: input.sourceText,
      textStats: {
        length: input.sourceText.length,
        lines: input.sourceText.split("\n").length,
      },
    };

    const trace: TraceEvent[] = [];

    for (const stage of this.stages) {
      const startedAt = Date.now();
      trace.push(traceEvent(stage.id, "start", startedAt));

      try {
        await stage.run(state);
        trace.push(
          traceEvent(stage.id, "finish", startedAt, stageSummary(state, stage.id))
        );
      } catch (err) {
        trace.push(traceEvent(stage.id, "error", startedAt, undefined, err));
        return {
          status: "error",
          trace,
          error: toStructuredError(err, stage.id),
        };
      }
    }

    return {
      status: "complete",
      trace,
      job: {
        classification: state.classification!,
        extraction: state.extraction!,
        validation: state.validation!,
        confidence: state.confidence!,
      },
    };
  }
}
