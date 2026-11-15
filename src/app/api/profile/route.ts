import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ALLOWED_AVATAR_IMAGE_TYPES,
  MAX_AVATAR_SIZE,
  getAllowedOAuthAvatarUrl,
  getAvatarCacheVersion,
  getAvatarContentType,
  getAvatarImageExtension,
} from "@/lib/avatar-security";

function getOwnedUserAvatarPath(
  storedValue: string | null,
  userId: string
): string | null {
  if (!storedValue) return null;

  const rawValue = storedValue.trim();
  if (!rawValue) return null;

  let objectName: string | null = null;
  const requiredPrefix = `${userId}-`;

  if (rawValue.startsWith(requiredPrefix)) {
    objectName = rawValue;
  } else {
    try {
      const url = new URL(rawValue);
      const publicMarker = "/object/public/avatars/";
      const signedMarker = "/object/sign/avatars/";
      const publicIndex = url.pathname.indexOf(publicMarker);
      const signedIndex = url.pathname.indexOf(signedMarker);

      if (publicIndex !== -1) {
        objectName = decodeURIComponent(
          url.pathname.slice(publicIndex + publicMarker.length)
        );
      } else if (signedIndex !== -1) {
        objectName = decodeURIComponent(
          url.pathname.slice(signedIndex + signedMarker.length)
        );
      }
    } catch {
      return null;
    }
  }

  if (!objectName) return null;

  const fileName = objectName.split("/").filter(Boolean).pop();
  if (!fileName || !fileName.startsWith(requiredPrefix)) return null;
  return fileName;
}

function getPlaceholderResponse(): NextResponse {
  const placeholder = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAu5A0c2V4AAAAASUVORK5CYII=",
    "base64"
  );

  return new NextResponse(placeholder, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=0, must-revalidate",
      ETag: '"profile-avatar-placeholder"',
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Serve the user's avatar without exposing its Storage URL to the browser. */
export async function GET(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const supabase = createAdminClient();
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "Failed to load profile avatar" }, { status: 500 });
  }

  const storedValue = profile?.avatar_url ?? null;
  const ownedPath = getOwnedUserAvatarPath(storedValue, user.id);
  const oauthUrl = storedValue
    ? getAllowedOAuthAvatarUrl(storedValue)
    : null;
  const hasAvatar = Boolean(ownedPath || oauthUrl);

  const { searchParams } = new URL(request.url);
  if (searchParams.get("metadata") === "1") {
    return NextResponse.json({
      hasAvatar,
      url: hasAvatar
        ? `/api/profile?v=${getAvatarCacheVersion(storedValue || "avatar")}`
        : null,
    });
  }

  if (!hasAvatar) return getPlaceholderResponse();

  const etag = `"profile-avatar-${getAvatarCacheVersion(storedValue || "avatar")}"`;
  const cacheHeaders = {
    "Cache-Control": "private, max-age=0, must-revalidate",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };

  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: cacheHeaders });
  }

  let buffer: Buffer;
  let contentType: string;

  if (ownedPath) {
    const { data: file, error: downloadError } = await supabase.storage
      .from("avatars")
      .download(ownedPath);

    if (downloadError || !file) return getPlaceholderResponse();

    buffer = Buffer.from(await file.arrayBuffer());
    contentType = file.type.startsWith("image/")
      ? file.type
      : getAvatarContentType(ownedPath);
  } else if (oauthUrl) {
    try {
      const upstream = await fetch(oauthUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      const upstreamType = upstream.headers.get("content-type") || "";
      const contentLength = Number(upstream.headers.get("content-length") || "0");

      if (
        !upstream.ok ||
        !upstreamType.toLowerCase().startsWith("image/") ||
        (contentLength > 0 && contentLength > MAX_AVATAR_SIZE)
      ) {
        return getPlaceholderResponse();
      }

      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_AVATAR_SIZE) {
        return getPlaceholderResponse();
      }

      buffer = bytes;
      contentType = upstreamType;
    } catch (error) {
      console.error("[Profile Avatar] OAuth avatar fetch failed:", error);
      return getPlaceholderResponse();
    }
  } else {
    return getPlaceholderResponse();
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      ...cacheHeaders,
      "Content-Type": contentType,
    },
  });
}

/** Upload a user avatar and remove the previous owned Storage object. */
export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No image provided" }, { status: 400 });
  }

  const contentType = file.type.toLowerCase();
  if (!ALLOWED_AVATAR_IMAGE_TYPES.has(contentType)) {
    return NextResponse.json(
      { error: "Unsupported image type" },
      { status: 415 }
    );
  }

  if (file.size <= 0 || file.size > MAX_AVATAR_SIZE) {
    return NextResponse.json(
      { error: "Image too large (max 5 MB)" },
      { status: 413 }
    );
  }

  const supabase = createAdminClient();
  const { data: currentProfile } = await supabase
    .from("profiles")
    .select("avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  const objectName = `${user.id}-${Date.now()}-${crypto.randomUUID()}.${getAvatarImageExtension(contentType)}`;
  const { error: uploadError } = await supabase.storage
    .from("avatars")
    .upload(objectName, Buffer.from(await file.arrayBuffer()), {
      contentType,
      cacheControl: "3600",
      upsert: false,
    });

  if (uploadError) {
    console.error("[Profile Avatar] Storage upload error:", uploadError);
    return NextResponse.json({ error: "Image upload failed" }, { status: 502 });
  }

  const { error: updateError } = await supabase
    .from("profiles")
    .upsert(
      { id: user.id, avatar_url: objectName },
      { onConflict: "id" }
    );

  if (updateError) {
    await supabase.storage.from("avatars").remove([objectName]);
    return NextResponse.json({ error: "Failed to save profile avatar" }, { status: 500 });
  }

  const oldPath = getOwnedUserAvatarPath(
    currentProfile?.avatar_url ?? null,
    user.id
  );
  if (oldPath && oldPath !== objectName) {
    const { error: removeError } = await supabase.storage
      .from("avatars")
      .remove([oldPath]);
    if (removeError) {
      console.warn(
        "[Profile Avatar] Failed to remove the previous avatar:",
        removeError
      );
    }
  }

  return NextResponse.json({
    success: true,
    hasAvatar: true,
    url: `/api/profile?v=${getAvatarCacheVersion(objectName)}`,
  });
}

/** Remove the user's avatar from the profile and Storage. */
export async function DELETE() {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const supabase = createAdminClient();
  const { data: currentProfile } = await supabase
    .from("profiles")
    .select("avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  const { error: updateError } = await supabase
    .from("profiles")
    .update({ avatar_url: null })
    .eq("id", user.id);

  if (updateError) {
    return NextResponse.json({ error: "Failed to remove profile avatar" }, { status: 500 });
  }

  const oldPath = getOwnedUserAvatarPath(
    currentProfile?.avatar_url ?? null,
    user.id
  );
  if (oldPath) {
    const { error: removeError } = await supabase.storage
      .from("avatars")
      .remove([oldPath]);
    if (removeError) {
      console.warn(
        "[Profile Avatar] Failed to remove the avatar object:",
        removeError
      );
    }
  }

  return NextResponse.json({ success: true, hasAvatar: false, url: null });
}

export const runtime = "nodejs";
