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
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  console.log("DEBUG PROFILE FETCH:", { userId: user.id, profile, profileError });

  return NextResponse.json({
    success: true,
    userId: user.id,
    profile,
    profileError,
    avatarUrl: profile?.avatar_url || null,
    message: profile?.avatar_url ? "Avatar URL exists!" : "Avatar URL is missing or null in Supabase!"
  });
}