import type { PipelineState, TraceEvent } from "./types";

/**
 * Trace helpers — produce the granular execution trace (start/finish/error per
 * stage) that the orchestrator emits. JSON-safe, later usable for debugging,
 * monitoring and analytics.
 */

export function traceEvent(
  stage: string,
  event: TraceEvent["event"],
  startedAt: number,
  data?: unknown,
  error?: unknown
): TraceEvent {
  if (event === "start") {
    return {
      stage,
      event,
      ts: new Date().toISOString(),
      message: `${stage} started`,
    };
  }
  if (event === "error") {
    return {
      stage,
      event,
      ts: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      message: `${stage} failed`,
      data: error instanceof Error ? { error: error.message } : { error: String(error) },
    };
  }
  return {
    stage,
    event,
    ts: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    message: `${stage} finished`,
    data,
  };
}

/** Human-readable trace lines, e.g. "[2026-08-01T10:00:00Z] classify finished (42ms)". */
export function describeTrace(trace: TraceEvent[]): string[] {
  return trace.map((t) => {
    const dur = t.durationMs !== undefined ? ` (${t.durationMs}ms)` : "";
    return `[${t.ts}] ${t.message}${dur}`;
  });
}

/** JSON-safe summary of what a stage produced (for the trace payload). */
export function stageSummary(ctx: PipelineState, stageId: string): unknown {
  switch (stageId) {
    case "classify":
      return ctx.classification
        ? {
            profileType: ctx.classification.profileType,
            confidence: ctx.classification.confidence,
            source: ctx.classification.source,
            reasons: ctx.classification.reasons,
          }
        : undefined;
    case "extract":
      return ctx.extraction
        ? {
            profile: ctx.extraction.profileType,
            profileVersion: ctx.extraction.profileVersion,
            model: ctx.extraction.model,
            fields: ctx.extraction.fields.length,
            dropped: Object.keys(ctx.extraction.droppedFields).length,
          }
        : undefined;
    case "validate":
      return ctx.validation
        ? { ok: ctx.validation.ok, missing: ctx.validation.missing }
        : undefined;
    case "confidence":
      return ctx.confidence
        ? { overall: ctx.confidence.overall, signals: ctx.confidence.signals }
        : undefined;
    default:
      return undefined;
  }
}
