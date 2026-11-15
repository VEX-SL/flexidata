import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

function getContentType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    default:
      return "image/jpeg";
  }
}

function isOwnedChatImagePath(path: string, userId: string): boolean {
  const prefix = `chat-images/${userId}/`;
  return (
    path.startsWith(prefix) &&
    path.length > prefix.length &&
    !path.split("/").some((segment) => segment === "." || segment === "..") &&
    !path.includes("\\") &&
    !path.includes("\0")
  );
}

/**
 * Proxy a user-owned chat attachment through an authenticated API route.
 * The browser never receives the underlying Supabase Storage URL.
 */
export async function GET(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { searchParams } = new URL(request.url);
  const path = searchParams.get("path");

  if (!path || !isOwnedChatImagePath(path, user.id)) {
    return NextResponse.json({ error: "Chat image not found" }, { status: 404 });
  }

  const supabase = createAdminClient();
  let file: Blob | null = null;

  const privateBucketFile = await supabase.storage
    .from("chat-images")
    .download(path);
  if (privateBucketFile.data) {
    file = privateBucketFile.data;
  } else {
    // Legacy attachments were stored in the public files bucket. Keep them
    // readable through the same API while new uploads use the private bucket.
    const legacyFile = await supabase.storage.from("files").download(path);
    if (legacyFile.data) file = legacyFile.data;
  }

  if (!file) {
    return NextResponse.json({ error: "Chat image not found" }, { status: 404 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": file.type.startsWith("image/")
        ? file.type
        : getContentType(path),
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const runtime = "nodejs";
