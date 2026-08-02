import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import type { ProfileSchema } from "@/lib/pipeline/types";

export interface ProfileSchemaDTO {
  id: string;
  label: string;
  version: number;
  docTypes: string[];
  enabled: boolean;
  schema?: ProfileSchema;
}

/**
 * GET /api/pipeline/profiles
 * Profile catalog with schemas — powers the type-aware review UI
 * (labels, field types, enum options, required markers, field groups).
 */
export async function GET() {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;

  const manager = getProfileManager();
  const items: ProfileSchemaDTO[] = manager.list().map((info) => {
    const profile = manager.get(info.id);
    return { ...info, schema: profile?.schema };
  });

  return NextResponse.json({ items });
}
