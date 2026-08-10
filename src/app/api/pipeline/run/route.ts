import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { checkRateLimit, getClientIdentifier } from "@/lib/rate-limit";
import { PipelineService } from "@/lib/pipeline/service";
import { asString, badRequest, errorResponse } from "@/lib/pipeline/http";
import type { ProfileType } from "@/lib/pipeline/types";

/**
 * POST /api/pipeline/run
 *
 * Async-by-design: returns a job DTO + status immediately. Clients poll
 * GET /api/pipeline/extractions/{id}. Phase 1 runs synchronously; switching
 * to queues later requires no frontend change.
 *
 * Idempotent: passing the same `idempotencyKey` (or the same `fileId`) twice
 * returns the existing job (200) unless `force: true` requests an in-place
 * re-run (still 200, with `rerun: true`).
 */
export async function POST(request: Request) {
  const identifier = getClientIdentifier(request);
  const rateCheck = checkRateLimit(identifier, "pipeline");
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: "Too many pipeline requests.", retryable: true } },
      {
        status: 429,
        headers: {
          "Retry-After": String(
            Math.ceil((rateCheck.resetAt - Date.now()) / 1000)
          ),
        },
      }
    );
  }

  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  if (!asString(body.sourceText) && !asString(body.fileId)) {
    return badRequest("Either sourceText or fileId is required");
  }

  const profileType = asString(body.profileType);
  if (profileType && !["invoice", "receipt", "resume", "contract", "unknown"].includes(profileType)) {
    return badRequest(`Unknown profile type: ${profileType}`);
  }

  const extractionMode = asString(body.extractionMode);
  if (extractionMode && !["legacy", "dynamic"].includes(extractionMode)) {
    return badRequest(`Unknown extraction mode: ${extractionMode}`);
  }

  try {
    const service = new PipelineService();
    const { job, created, rerun } = await service.run(user.id, {
      fileId: asString(body.fileId),
      sourceText: asString(body.sourceText),
      fileName: asString(body.fileName),
      mimeType: asString(body.mimeType),
      profileType: profileType as ProfileType,
      idempotencyKey: asString(body.idempotencyKey),
      force: body.force === true,
      extractionMode: extractionMode as "legacy" | "dynamic" | undefined,
    });

    return NextResponse.json(
      { job, created, rerun, location: job.url },
      { status: created ? 202 : 200 }
    );
  } catch (err) {
    return errorResponse(err);
  }
}
