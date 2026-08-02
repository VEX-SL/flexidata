import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { PipelineService } from "@/lib/pipeline/service";
import { asString, badRequest, errorResponse } from "@/lib/pipeline/http";

/**
 * POST /api/pipeline/extractions/{id}/replace
 * Replaces the source file of an extraction and re-runs the pipeline in place.
 * Body: `{ fileId: "<new uploaded file id>" }`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const fileId = asString(body.fileId);
  if (!fileId) {
    return badRequest("fileId is required");
  }

  try {
    const service = new PipelineService();
    const { job, created, rerun } = await service.replace(user.id, id, fileId);
    return NextResponse.json({ job, created, rerun, location: job.url });
  } catch (err) {
    return errorResponse(err);
  }
}
