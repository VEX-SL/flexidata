import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAllowedOAuthAvatarUrl } from "@/lib/avatar-security";

export async function POST(request: NextRequest) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  try {
    const supabase = createAdminClient();
    const body = await request.json();
    const requestedName = typeof body.name === "string" ? body.name.trim() : "";
    const requestedAvatar =
      typeof body.avatar_url === "string" ? body.avatar_url : "";

    // The authenticated user is always the owner. Never trust a userId sent
    // by the browser and never accept an arbitrary avatar URL.
    const { data: existingProfile } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();

    if (existingProfile) {
      return NextResponse.json({
        message: "Profile already exists",
        profile: { id: existingProfile.id },
      });
    }

    const authName =
      typeof user.user_metadata?.name === "string"
        ? user.user_metadata.name.trim()
        : "";
    const oauthAvatar = getAllowedOAuthAvatarUrl(requestedAvatar);
    const name = (requestedName || authName || "").slice(0, 200) || null;

    const { data: profile, error } = await supabase
      .from("profiles")
      .insert({
        id: user.id,
        name,
        avatar_url: oauthAvatar?.toString() ?? null,
      })
      .select("id, name")
      .single();

    if (error) {
      console.error("Profile creation error:", error);
      return NextResponse.json(
        { error: "Failed to create profile" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      message: "Profile created successfully",
      profile: {
        ...profile,
        hasAvatar: Boolean(oauthAvatar),
        url: oauthAvatar ? "/api/profile" : null,
      },
    });
  } catch (error) {
    console.error("Profile API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
