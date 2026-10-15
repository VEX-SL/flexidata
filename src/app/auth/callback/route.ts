import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

/**
 * Only allow same-site, relative redirect targets. Rejects absolute URLs,
 * protocol-relative URLs (`//evil.com`) and backslash tricks so the `next`
 * query param can never be used as an open redirect after a successful login.
 */
function safeRedirectPath(next: string | null): string {
  const fallback = "/dashboard";
  if (!next) return fallback;
  // Must be a single-slash-prefixed path ("/foo"), not "//host" or "/\\host".
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  // Guard against encoded/embedded schemes and control chars.
  if (next.includes("://") || next.includes("\\") || /[\x00-\x1f]/.test(next)) {
    return fallback;
  }
  return next;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeRedirectPath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
