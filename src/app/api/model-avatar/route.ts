import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);
const PRESET_ICONS = new Set([
  "sparkles",
  "zap",
  "crown",
  "heart",
  "star",
  "feather",
  "bot",
  "brain",
]);

interface AvatarProfile {
  model_icon: string | null;
  model_icon_type: string | null;
  model_color: string | null;
  model_shape: string | null;
}

function normalizeModelIconType(
  value: unknown
): "preset" | "custom" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "preset" || normalized === "custom" ? normalized : null;
}

/**
 * Resolve a custom model avatar to its object name in the avatars bucket.
 * New records store only the object name; older records may still contain a
 * Supabase public URL, so both formats are supported during the transition.
 */
function getOwnedModelAvatarPath(
  storedValue: string | null,
  userId: string
): string | null {
  if (!storedValue) return null;

  const rawValue = storedValue.trim();
  if (!rawValue) return null;

  let objectName: string | null = null;

  if (rawValue.startsWith("model-icon-")) {
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
      // The value is not a URL; it may still be a plain storage object name.
    }
  }

  if (!objectName) return null;

  const fileName = objectName.split("/").filter(Boolean).pop();
  if (!fileName || !fileName.startsWith(`model-icon-${userId}-`)) {
    return null;
  }

  return fileName;
}

function getImageExtension(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    default:
      return "jpg";
  }
}

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

/** Produce a non-sensitive cache version from the Storage object name. */
function getAvatarVersion(objectName: string): string {
  let hash = 0;
  for (let index = 0; index < objectName.length; index += 1) {
    hash = (hash * 31 + objectName.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

async function removeOwnedCustomAvatar(
  profile: AvatarProfile | null,
  userId: string
): Promise<void> {
  if (!profile || normalizeModelIconType(profile.model_icon_type) !== "custom") {
    return;
  }

  const objectName = getOwnedModelAvatarPath(profile.model_icon, userId);
  if (!objectName) return;

  const supabase = createAdminClient();
  const { error } = await supabase.storage.from("avatars").remove([objectName]);
  if (error) {
    // The database update already succeeded. Keep the new avatar usable and
    // only report the orphaned old object in the server logs.
    console.warn("[Model Avatar] Failed to remove the previous avatar:", error);
  }
}

/**
 * Serve the signed-in user's custom model avatar without exposing its
 * Supabase Storage URL to the browser.
 */
export async function GET(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("model_icon, model_icon_type, model_color, model_shape")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "Failed to load model avatar" }, { status: 500 });
  }

  const profile = data as AvatarProfile | null;

  // Metadata mode is used by the chat UI. It deliberately never returns the
  // custom avatar's Storage object name or public URL.
  const { searchParams } = new URL(request.url);
  if (searchParams.get("metadata") === "1") {
    const normalizedType = normalizeModelIconType(profile?.model_icon_type);
    const customPath =
      normalizedType === "custom"
        ? getOwnedModelAvatarPath(profile?.model_icon ?? null, user.id)
        : null;
    const presetIcon =
      normalizedType === "preset" &&
      profile?.model_icon &&
      PRESET_ICONS.has(profile.model_icon)
        ? profile.model_icon
        : null;

    return NextResponse.json({
      type: normalizedType,
      icon: presetIcon,
      url: customPath
        ? `/api/model-avatar?v=${getAvatarVersion(customPath)}`
        : null,
      color: profile?.model_color ?? null,
      shape: profile?.model_shape ?? "rounded",
    });
  }

  if (normalizeModelIconType(profile?.model_icon_type) !== "custom") {
    return NextResponse.json({ error: "Custom model avatar not found" }, { status: 404 });
  }

  const objectName = getOwnedModelAvatarPath(profile?.model_icon ?? null, user.id);
  if (!objectName) {
    return NextResponse.json({ error: "Custom model avatar not found" }, { status: 404 });
  }

  const { data: file, error: downloadError } = await supabase.storage
    .from("avatars")
    .download(objectName);

  if (downloadError || !file) {
    return NextResponse.json({ error: "Custom model avatar not found" }, { status: 404 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": file.type.startsWith("image/")
        ? file.type
        : getContentType(objectName),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Upload a new custom model avatar. The Storage object name is persisted in
 * profiles (never its public URL), and the previous custom avatar is removed
 * after the database update succeeds.
 */
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
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
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

  const color = formData.get("color");
  const shape = formData.get("shape");
  const objectName = `model-icon-${user.id}-${Date.now()}-${crypto.randomUUID()}.${getImageExtension(contentType)}`;
  const supabase = createAdminClient();

  const { error: uploadError } = await supabase.storage
    .from("avatars")
    .upload(objectName, Buffer.from(await file.arrayBuffer()), {
      contentType,
      cacheControl: "3600",
      upsert: false,
    });

  if (uploadError) {
    console.error("[Model Avatar] Storage upload error:", uploadError);
    return NextResponse.json({ error: "Image upload failed" }, { status: 502 });
  }

  const { data: currentProfile, error: profileError } = await supabase
    .from("profiles")
    .select("model_icon, model_icon_type, model_color, model_shape")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    await supabase.storage.from("avatars").remove([objectName]);
    return NextResponse.json({ error: "Failed to load profile" }, { status: 500 });
  }

  const updatePayload: Record<string, unknown> = {
    model_icon: objectName,
    model_icon_type: "custom",
  };
  if (typeof color === "string" && color.length <= 100) {
    updatePayload.model_color = color;
  }
  if (typeof shape === "string" && shape.length <= 50) {
    updatePayload.model_shape = shape;
  }

  const { error: updateError } = await supabase
    .from("profiles")
    .update(updatePayload)
    .eq("id", user.id);

  if (updateError) {
    await supabase.storage.from("avatars").remove([objectName]);
    return NextResponse.json({ error: "Failed to save model avatar" }, { status: 500 });
  }

  await removeOwnedCustomAvatar(currentProfile as AvatarProfile | null, user.id);

  return NextResponse.json({
    success: true,
    url: `/api/model-avatar?v=${getAvatarVersion(objectName)}`,
    type: "custom",
  });
}

/**
 * Update preset/custom avatar metadata. Switching from a custom image to a
 * preset icon removes the old custom image from Storage.
 */
export async function PATCH(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  let body: {
    type?: "preset" | "custom";
    icon?: string;
    color?: string;
    shape?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const requestedType =
    typeof body.type === "string" ? body.type.trim().toLowerCase() : "";
  if (requestedType !== "preset" && requestedType !== "custom") {
    return NextResponse.json({ error: "Invalid avatar type" }, { status: 400 });
  }

  if (
    requestedType === "preset" &&
    (!body.icon || !PRESET_ICONS.has(body.icon))
  ) {
    return NextResponse.json({ error: "Invalid preset icon" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: currentProfile, error: profileError } = await supabase
    .from("profiles")
    .select("model_icon, model_icon_type, model_color, model_shape")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError || !currentProfile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const current = currentProfile as AvatarProfile;
  if (
    requestedType === "custom" &&
    normalizeModelIconType(current.model_icon_type) !== "custom"
  ) {
    return NextResponse.json(
      { error: "Custom model avatar not found" },
      { status: 404 }
    );
  }

  const updatePayload: Record<string, unknown> = {
    model_icon_type: requestedType,
  };

  if (requestedType === "preset") {
    updatePayload.model_icon = body.icon;
  }
  if (typeof body.color === "string" && body.color.length <= 100) {
    updatePayload.model_color = body.color;
  }
  if (typeof body.shape === "string" && body.shape.length <= 50) {
    updatePayload.model_shape = body.shape;
  }

  const { error: updateError } = await supabase
    .from("profiles")
    .update(updatePayload)
    .eq("id", user.id);

  if (updateError) {
    return NextResponse.json({ error: "Failed to update model avatar" }, { status: 500 });
  }

  if (requestedType === "preset") {
    await removeOwnedCustomAvatar(current, user.id);
  }

  const currentCustomPath =
    requestedType === "custom"
      ? getOwnedModelAvatarPath(current.model_icon, user.id)
      : null;
  const customVersion = currentCustomPath
    ? getAvatarVersion(currentCustomPath)
    : Date.now().toString(36);

  return NextResponse.json({
    success: true,
    ...(requestedType === "preset"
      ? { icon: body.icon, type: "preset" }
      : { url: `/api/model-avatar?v=${customVersion}`, type: "custom" }),
  });
}

export const runtime = "nodejs";
