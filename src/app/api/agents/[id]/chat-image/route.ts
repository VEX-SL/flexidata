import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { checkRateLimit, getClientIdentifier } from "@/lib/rate-limit";
import { buildStorageKey, isValidUUID } from "@/lib/validators";
import { createAdminClient } from "@/lib/supabase/admin";

// ✅ Chat image attachments (Gemini-style): images attached in the chat
// composer are NOT agent documents (no OCR/RAG ingestion — the agent files
// endpoint would even reject photos whose OCR reads nothing). They are
// uploaded to storage and an authenticated API URL is embedded in the user
// message via the [IMAGE_ATTACHMENT: url] marker, so the thumbnail survives
// reloads without exposing the underlying public Storage URL.
const MAX_IMAGE_SIZE = 8 * 1024 * 1024; // 8 MB
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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

  const { id: agentId } = await params;
  if (!isValidUUID(agentId)) {
    return NextResponse.json({ error: "Invalid agent ID" }, { status: 400 });
  }

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

  // Images ONLY — this endpoint exists for chat image attachments. Keep the
  // accepted types aligned with the private bucket's MIME allowlist.
  const contentType = file.type.toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    return NextResponse.json(
      { error: "Unsupported image type" },
      { status: 415 }
    );
  }

  if (file.size <= 0 || file.size > MAX_IMAGE_SIZE) {
    return NextResponse.json(
      { error: "Image too large (max 8 MB)" },
      { status: 413 }
    );
  }

  const supabase = createAdminClient();

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const storagePath = `chat-images/${buildStorageKey(user.id, file.name)}`;

  const { error: uploadError } = await supabase.storage
    .from("chat-images")
    .upload(storagePath, fileBuffer, {
      contentType,
      upsert: false,
    });

  if (uploadError) {
    console.error("[Chat Image] Storage error:", uploadError);
    return NextResponse.json({ error: "Image upload failed" }, { status: 502 });
  }

  // Return an authenticated proxy URL instead of the public Storage URL. The
  // API verifies that the requested object belongs to the signed-in user.
  const apiUrl = `/api/chat-image?path=${encodeURIComponent(storagePath)}`;

  return NextResponse.json({ success: true, url: apiUrl });
}

export const runtime = "nodejs";
