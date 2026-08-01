import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { PipelineService } from "@/lib/pipeline/service";
import { errorResponse } from "@/lib/pipeline/http";

/**
 * GET /api/pipeline/extractions/{id}
 * Single job — the client poll target for async runs.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id } = await params;

  try {
    const service = new PipelineService();
    const job = await service.get(user.id, id);
    return NextResponse.json({ job });
  } catch (err) {
    return errorResponse(err);
  }
}
