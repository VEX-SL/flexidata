import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated", userError }, { status: 401 });
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.avatar_url) {
    try {
      const res = await fetch(profile.avatar_url);
      if (res.ok) {
        const buffer = await res.arrayBuffer();
        const contentType = res.headers.get("content-type") || "image/jpeg";
        return new NextResponse(Buffer.from(buffer), {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000",
          },
        });
      }
    } catch (e) {
      console.error("Avatar fetch error:", e);
    }
  }

  const placeholder = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAu5A0c2V4AAAAASUVORK5CYII=",
    "base64"
  );

  return new NextResponse(placeholder, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000",
    },
  });
}