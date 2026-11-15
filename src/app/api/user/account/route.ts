import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Permanently deletes the signed-in user's account.
 *
 * Requires the literal string "DELETE" in the body so an accidental call can
 * never wipe an account. All user-owned tables reference auth.users with
 * ON DELETE CASCADE, so removing the auth user removes the data. Storage
 * objects have to be removed explicitly.
 */
export async function DELETE(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  let body: { confirm?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body?.confirm !== "DELETE") {
    return NextResponse.json(
      { error: "Type DELETE to confirm account deletion." },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();

  // Remove uploaded documents (files/<userId>/...)
  try {
    const { data: objects } = await supabase.storage
      .from("files")
      .list(user.id, { limit: 1000 });

    const paths = (objects ?? [])
      .filter((object) => Boolean(object.id))
      .map((object) => `${user.id}/${object.name}`);

    if (paths.length > 0) {
      await supabase.storage.from("files").remove(paths);
    }
  } catch (error) {
    console.warn("[Account] Failed to clear files bucket:", error);
  }

  // Remove legacy chat attachments from the public files bucket
  // (files/chat-images/<userId>/...).
  try {
    const { data: objects } = await supabase.storage
      .from("files")
      .list(`chat-images/${user.id}`, { limit: 1000 });

    const paths = (objects ?? [])
      .filter((object) => Boolean(object.id))
      .map((object) => `chat-images/${user.id}/${object.name}`);

    if (paths.length > 0) {
      await supabase.storage.from("files").remove(paths);
    }
  } catch (error) {
    console.warn("[Account] Failed to clear legacy chat images:", error);
  }

  // Remove chat attachments from the private chat-images bucket.
  try {
    const { data: objects } = await supabase.storage
      .from("chat-images")
      .list(`chat-images/${user.id}`, { limit: 1000 });

    const paths = (objects ?? [])
      .filter((object) => Boolean(object.id))
      .map((object) => `chat-images/${user.id}/${object.name}`);

    if (paths.length > 0) {
      await supabase.storage.from("chat-images").remove(paths);
    }
  } catch (error) {
    console.warn("[Account] Failed to clear chat images:", error);
  }

  // Remove avatars (avatars/<userId>-<timestamp>.jpg)
  try {
    const { data: objects } = await supabase.storage
      .from("avatars")
      .list("", { limit: 1000 });

    const paths = (objects ?? [])
      .filter(
        (object) =>
          Boolean(object.id) &&
          (object.name.startsWith(`${user.id}-`) ||
            object.name.startsWith(`model-icon-${user.id}-`))
      )
      .map((object) => object.name);

    if (paths.length > 0) {
      await supabase.storage.from("avatars").remove(paths);
    }
  } catch (error) {
    console.warn("[Account] Failed to clear avatars bucket:", error);
  }

  const { error } = await supabase.auth.admin.deleteUser(user.id);
  if (error) {
    console.error("[Account] Failed to delete user:", error);
    return NextResponse.json(
      { error: "Failed to delete account" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
