import { NextResponse } from "next/server";
import { toErrorDTO } from "./dto";
import { PipelineError } from "./errors";

/** Map a PipelineError to the correct HTTP status. */
const STATUS_BY_CODE: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNSUPPORTED_FORMAT: 501,
  AI_PROVIDER_ERROR: 503,
  FILE_READ_ERROR: 503,
};

/** Thin, uniform error responder — structured errors only, no raw exceptions. */
export function errorResponse(err: unknown): NextResponse {
  const dto = toErrorDTO(err);
  const status = STATUS_BY_CODE[dto.code] ?? 500;
  return NextResponse.json({ error: dto }, { status });
}

export function badRequest(message: string): NextResponse {
  return errorResponse(
    new PipelineError(message, { code: "BAD_REQUEST", retryable: false })
  );
}

/** Read an optional non-empty string from a JSON body field. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
