import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { PipelineService } from "@/lib/pipeline/service";
import { badRequest, errorResponse } from "@/lib/pipeline/http";

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

/**
 * PATCH /api/pipeline/extractions/{id}
 * Persist user field corrections: body `{ fields: { key: value } }`.
 * Only values for keys defined by the job's profile schema are accepted.
 */
export async function PATCH(
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

  const rawFields = body.fields;
  if (!rawFields || typeof rawFields !== "object" || Array.isArray(rawFields)) {
    return badRequest("fields must be an object of key → value");
  }

  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawFields as Record<string, unknown>)) {
    if (value === null || value === undefined) {
      overrides[key] = null;
    } else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      overrides[key] = value;
    } else if (Array.isArray(value)) {
      overrides[key] = value.filter(
        (item) => item !== null && item !== undefined
      );
    }
  }

  if (Object.keys(overrides).length === 0) {
    return badRequest("No valid field values to update");
  }

  try {
    const service = new PipelineService();
    const job = await service.updateFields(user.id, id, overrides);
    return NextResponse.json({ job });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/pipeline/extractions/{id}
 * Permanently removes an extraction and its source file (row + storage).
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { id } = await params;

  try {
    const service = new PipelineService();
    const result = await service.delete(user.id, id);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
