import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { checkRateLimit, getClientIdentifier } from "@/lib/rate-limit";
import { PipelineService } from "@/lib/pipeline/service";
import { errorResponse } from "@/lib/pipeline/http";

/**
 * GET /api/pipeline/extractions
 * Resource list, newest first. Query: ?limit=1..100&offset=0&status=complete
 */
export async function GET(request: Request) {
  const identifier = getClientIdentifier(request);
  const rateCheck = checkRateLimit(identifier, "pipeline");
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: "Too many requests.", retryable: true } },
      { status: 429 }
    );
  }

  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const status = url.searchParams.get("status") ?? undefined;

  if (!Number.isInteger(limit) || !Number.isInteger(offset)) {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: "limit and offset must be integers", retryable: false } },
      { status: 400 }
    );
  }

  try {
    const service = new PipelineService();
    const result = await service.list(user.id, { limit, offset, status });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
