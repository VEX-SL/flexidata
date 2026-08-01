import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";

/**
 * GET /api/pipeline/profiles
 * Lists available extraction profiles (stable DTOs, resource-oriented).
 */
export async function GET() {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;

  const profiles = getProfileManager().list();
  return NextResponse.json({ profiles });
}
