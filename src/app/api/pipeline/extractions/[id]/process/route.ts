import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { PipelineService } from "@/lib/pipeline/service";
import { errorResponse } from "@/lib/pipeline/http";

/**
 * POST /api/pipeline/extractions/{id}/process
 *
 * Advances a queued/intermediate job by one work slice and returns its current
 * state. Resumable: each slice runs inside its own function budget, progress is
 * persisted (source_text + ocr_json before the pipeline runs), and a killed
 * slice is simply re-driven by the next POST. The client drives this from its
 * poll loop.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id } = await params;

  try {
    const service = new PipelineService();
    const { job } = await service.process(user.id, id);
    return NextResponse.json({ job });
  } catch (err) {
    return errorResponse(err);
  }
}

export const runtime = "nodejs";
export const maxDuration = 60;