import type {
  PipelineState,
  PipelineStage,
  RunJobInput,
  RunJobOutput,
  TraceEvent,
} from "./types";
import { toStructuredError } from "./errors";
import { stageSummary, traceEvent } from "./trace";
import { buildOcrDocument } from "./ocr";

/**
 * Pipeline — pure coordinator. It knows nothing about specific stages:
 * it only iterates a registered stage list, feeds the shared typed state, and
 * emits a granular trace. All business logic lives in the stages.
 *
 * Replacing/adding a stage = change the stage list (see defaults.ts), never
 * this class.
 */
export interface PipelineOptions {
  /**
   * Optional hook invoked before each stage runs. Additive — callers (e.g. the
   * service, for status persistence) may observe stage execution without
   * coupling the pipeline to their storage. Callers must not throw: a failing
   * observer should never fail the pipeline.
   */
  onStage?: (stage: PipelineStage) => void | Promise<void>;
}

export class Pipeline {
  constructor(
    private readonly stages: PipelineStage[],
    private readonly opts: PipelineOptions = {}
  ) {}

  async run(input: RunJobInput): Promise<RunJobOutput> {
    const state: PipelineState = {
      input,
      sourceText: input.sourceText,
      textStats: {
        length: input.sourceText.length,
        lines: input.sourceText.split("\n").length,
      },
      // Structured OCR when the file path provided it; otherwise derive a
      // neutral (unknown-confidence) document from the text itself.
      ocr: input.ocr ?? buildOcrDocument(input.sourceText),
    };

    const trace: TraceEvent[] = [];

    for (const stage of this.stages) {
      const startedAt = Date.now();
      trace.push(traceEvent(stage.id, "start", startedAt));

      try {
        await this.opts.onStage?.(stage);
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
