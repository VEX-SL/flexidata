import type { PipelineErrorCode, StructuredError } from "./types";

/** Error with pipeline semantics (code, retryability, stage context). */
export class PipelineError extends Error {
  readonly code: PipelineErrorCode;
  readonly retryable: boolean;
  readonly stage?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    opts: {
      code?: PipelineErrorCode;
      retryable?: boolean;
      stage?: string;
      details?: unknown;
    } = {}
  ) {
    super(message);
    this.name = "PipelineError";
    this.code = opts.code ?? "UNKNOWN_ERROR";
    this.retryable = opts.retryable ?? false;
    this.stage = opts.stage;
    this.details = opts.details;
  }
}

/**
 * Maps any thrown value to a StructuredError. Never leaks raw exceptions.
 * Provider/network/quota failures are inferred as retryable AI errors.
 */
export function toStructuredError(
  err: unknown,
  stage?: string
): StructuredError {
  if (err instanceof PipelineError) {
    return {
      stage: err.stage ?? stage,
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      details: err.details,
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  const aiish =
    /provider|quota|rate\s?limit|429|5\d\d|network|timeout|socket|api[_\s]?key|unavailable|temporar/i;
  const isRetryableAi = aiish.test(lower);

  const code: PipelineErrorCode = isRetryableAi
    ? "AI_PROVIDER_ERROR"
    : stage
      ? "STAGE_FAILED"
      : "UNKNOWN_ERROR";

  return {
    stage,
    code,
    message,
    retryable: isRetryableAi,
    details: err instanceof Error ? { name: err.name } : undefined,
  };
}
