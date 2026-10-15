import { NextResponse } from "next/server";
import { cookies } from "next/headers";

/**
 * Diagnostic: reports HOW MANY Supabase auth-token cookies the browser sent
 * with this request. Same-origin fetch sends the same cookies middleware sees,
 * so this pinpoints whether a session cookie survives the login flow.
 *
 * The response intentionally exposes only a COUNT — no cookie names, values or
 * lengths — so the endpoint cannot be used to fingerprint a session even
 * though it is public (it must run before the auth gate is guaranteed).
 */
const AUTH_COOKIE_RE = /^sb-.+-auth-token(\.[0-9]+)?$/;

export async function GET() {
  const jar = await cookies();
  const all = jar.getAll();
  const sbCookieCount = all.filter((c) => AUTH_COOKIE_RE.test(c.name)).length;

  console.log(
    `[auth-debug] total=${all.length} sbCookies=${sbCookieCount}`
  );

  return NextResponse.json({
    totalCookies: all.length,
    sbCookieCount,
  });
}
