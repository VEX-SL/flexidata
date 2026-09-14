import { NextResponse } from "next/server";
import { cookies } from "next/headers";

/**
 * Diagnostic: reports which Supabase auth-token cookies the browser actually
 * sent with this request. Same-origin fetch sends the same cookies middleware
 * sees, so this pinpoints whether a session cookie survives the login flow.
 */
const AUTH_COOKIE_RE = /^sb-.+-auth-token(\.[0-9]+)?$/;

export async function GET() {
  const jar = await cookies();
  const all = jar.getAll();
  const sb = all
    .filter((c) => AUTH_COOKIE_RE.test(c.name))
    .map((c) => ({
      name: c.name,
      length: c.value.length,
    }));

  console.log(
    `[auth-debug] total=${all.length} sbCookies=${sb.map((c) => c.name).join(",") || "none"}`
  );

  return NextResponse.json({
    totalCookies: all.length,
    sbCookies: sb,
  });
}