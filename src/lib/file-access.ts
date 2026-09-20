import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Load the bytes of a user-owned stored file from Supabase Storage, with the
 * storage URL as a fallback when the Storage API is unavailable. Returns null
 * when the file is missing or unreadable.
 */
export async function loadOwnedFileBytes(
  userId: string,
  fileId: string
): Promise<{ buffer: Buffer; name: string; mimeType: string | null; originalName: string | null } | null> {
  const supabase = createAdminClient();
  const { data: file } = await supabase
    .from("files")
    .select("id, name, url, mime_type, original_name")
    .eq("id", fileId)
    .eq("user_id", userId)
    .single();

  if (!file) return null;

  let buffer: Buffer | null = null;
  try {
    const { data, error } = await supabase.storage.from("files").download(file.name);
    if (error || !data) throw new Error(error?.message ?? "no data");
    buffer = Buffer.from(await data.arrayBuffer());
  } catch {
    if (file.url) {
      const res = await fetch(file.url);
      if (res.ok) buffer = Buffer.from(await res.arrayBuffer());
    }
  }

  if (!buffer) return null;

  return {
    buffer,
    name: file.name,
    mimeType: file.mime_type || null,
    originalName: file.original_name || null,
  };
}