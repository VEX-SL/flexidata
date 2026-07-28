import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { checkRateLimit, getClientIdentifier } from "@/lib/rate-limit";
import { isAllowedMimeType, isAllowedFileSize } from "@/lib/validators";
import { parseFileBuffer } from "@/lib/file-parser";
import { createAdminClient } from "@/lib/supabase/admin";

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

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (!isAllowedMimeType(file.type)) {
    return NextResponse.json(
      { error: `File type not supported: ${file.type}` },
      { status: 400 }
    );
  }

  if (!isAllowedFileSize(file.size)) {
    return NextResponse.json(
      { error: "File too large (max 50 MB)" },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();

  // Upload to Supabase Storage
  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const storagePath = `${user.id}/${Date.now()}_${file.name}`;

  const { error: uploadError } = await supabase.storage
    .from("files")
    .upload(storagePath, fileBuffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    console.error("[Upload] Storage error:", uploadError);
    return NextResponse.json({ error: "File upload failed" }, { status: 502 });
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("files").getPublicUrl(storagePath);

  // Save file record in DB
  const { data: fileRecord, error: dbError } = await supabase
    .from("files")
    .insert({
      user_id: user.id,
      name: storagePath,
      original_name: file.name,
      url: publicUrl,
      mime_type: file.type,
      size_bytes: file.size,
      status: "processing",
    })
    .select()
    .single();

  if (dbError) {
    console.error("[Upload] DB error:", dbError);
    return NextResponse.json(
      { error: "Failed to save file record" },
      { status: 500 }
    );
  }

  // Parse file content in background
  (async () => {
    try {
      console.log(`[Upload] Parsing file: ${file.name} (type: ${file.type}, size: ${file.size})`);
      const extractedText = await parseFileBuffer(fileBuffer, file.type, file.name);
      console.log(`[Upload] Extracted ${extractedText.length} chars from ${file.name}`);
      await supabase
        .from("files")
        .update({
          extracted_text: extractedText.slice(0, 1_000_000),
          status: "ready",
        })
        .eq("id", fileRecord.id);
      console.log(
        `[Upload] File ${fileRecord.id} ready (${extractedText.length} chars)`
      );
    } catch (parseErr) {
      console.error(`[Upload] Parse error for ${file.name}:`, parseErr);
      await supabase
        .from("files")
        .update({
          status: "error",
          error_message:
            parseErr instanceof Error ? parseErr.message : "Parse failed",
        })
        .eq("id", fileRecord.id);
    }
  })();

  return NextResponse.json({
    id: fileRecord.id,
    url: publicUrl,
    name: file.name,
    mime_type: file.type,
    size_bytes: file.size,
    status: "processing",
  });
}
