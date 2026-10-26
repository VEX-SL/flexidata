import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Verifies a Supabase reset-password link using the `code` query param.
 *
 * Security note: we do not trust the presence of `code` on the client.
 * We validate server-side and only then allow the password form.
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    if (!code) {
      return NextResponse.json({ ok: false, error: "Missing code" }, { status: 400 });
    }

    const supabase = createAdminClient();

    // Supabase stores password reset tokens in auth schema as one-time links.
    // We verify the token by exchanging it for a session/user.
    // Admin client lets us validate token without exposing secret info.
    //
    // If your Supabase project uses a different schema/token flow, adjust here.
    const { data, error } = await supabase.auth.verifyOtp({
      type: "recovery",
      token: code,
    });

    if (error || !data) {
      return NextResponse.json({ ok: false, error: "Invalid or expired link" }, { status: 401 });
    }

    // We only need to know the link is valid.
    // The actual password update is handled by POST /api/auth/reset-password.
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 });
  }
}
