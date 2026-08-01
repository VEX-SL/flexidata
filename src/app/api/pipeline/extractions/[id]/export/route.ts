import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { PipelineService } from "@/lib/pipeline/service";
import { errorResponse } from "@/lib/pipeline/http";

const FORMATS = ["json", "csv", "xlsx", "pdf"] as const;

/**
 * GET /api/pipeline/extractions/{id}/export?format=json|csv
 * Exports a completed extraction as a downloadable file.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id } = await params;

  const url = new URL(request.url);
  const formatParam = url.searchParams.get("format") ?? "json";
  const format = (FORMATS as readonly string[]).includes(formatParam)
    ? (formatParam as (typeof FORMATS)[number])
    : null;
  if (!format) {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: `Unsupported format: ${formatParam}`, retryable: false } },
      { status: 400 }
    );
  }

  try {
    const service = new PipelineService();
    const { content, fileName, mimeType } = await service.exportJob(
      user.id,
      id,
      format
    );

    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
