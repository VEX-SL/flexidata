import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { checkRateLimit, getClientIdentifier } from "@/lib/rate-limit";
import { isAllowedMimeType, isAllowedFileSize } from "@/lib/validators";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Sign a direct-upload request. The browser streams the file straight to
 * Supabase Storage through a signed upload URL instead of relaying a large
 * multipart body through the serverless function (whose request-body ceiling
 * silently breaks non-image uploads). The URL is scoped to one object, so the
 * bucket needs no anon upload policy; the DB row is created here so the
 * pipeline can pick the file up by id afterward.
 */
export async function POST(request: Request) {
  const identifier = getClientIdentifier(request);
  const rateCheck = checkRateLimit(identifier, "upload");
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: "Too many upload requests." },
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

  let body: { name?: string; mimeType?: string; size?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "No file name provided" }, { status: 400 });
  }
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
  if (!mimeType || !isAllowedMimeType(mimeType)) {
    return NextResponse.json(
      { error: `File type not supported: ${mimeType}` },
      { status: 400 }
    );
  }
  const size = typeof body.size === "number" ? body.size : 0;
  if (!isAllowedFileSize(size)) {
    return NextResponse.json(
      { error: "File too large (max 50 MB)" },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();
  const storagePath = `${user.id}/${Date.now()}_${name}`;

  const { data: signed, error: signError } = await supabase.storage
    .from("files")
    .createSignedUploadUrl(
      storagePath,
      // The SDK's declared options only expose `upsert`, but the storage API
      // honors `expiresIn`; the cast keeps the longer window for large files
      // while satisfying the build's type check.
      { upsert: false, expiresIn: 600 } as { upsert?: boolean; expiresIn?: number }
    );
  if (signError) {
    console.error("[Upload/start] Sign error:", signError);
    const detail =
      typeof (signError as { message?: unknown })?.message === "string"
        ? `: ${(signError as { message: string }).message}`
        : "";
    return NextResponse.json(
      { error: `Failed to prepare upload${detail}` },
      { status: 502 }
    );
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("files").getPublicUrl(storagePath);

  const { data: fileRecord, error: dbError } = await supabase
    .from("files")
    .insert({
      user_id: user.id,
      name: storagePath,
      original_name: name,
      url: publicUrl,
      mime_type: mimeType,
      size_bytes: size,
      status: "processing",
    })
    .select()
    .single();

  if (dbError) {
    console.error("[Upload/start] DB error:", dbError);
    return NextResponse.json(
      { error: "Failed to save file record" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    id: fileRecord.id,
    uploadUrl: signed.signedUrl,
    url: publicUrl,
  });
}