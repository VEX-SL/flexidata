import { NextResponse, type NextRequest } from "next/server";

const PROTECTED_ROUTES = ["/dashboard", "/chat", "/agents", "/settings"];
const AUTH_ROUTES = ["/login", "/signup"];

/**
 * Allow a clock-skew window (s) around the JWT `exp` claim before we treat a
 * session as expired — tokens are issued with a small expiry margin already,
 * so this only absorbs NTP skew between the client and Supabase.
 */
const CLOCK_SKEW_SECONDS = 60;

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip middleware for API routes and static assets to avoid crashing API handlers
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Local, zero-network session check. Middleware runs on the Edge runtime
  // where every millisecond counts and external calls are the top cause of
  // MIDDLEWARE_INVOCATION_TIMEOUT. We deliberately do NOT call
  // supabase.auth.getUser() here (it is a blocking request to Supabase Auth);
  // we decode the session cookie's JWT locally and check its expiry.
  const loggedIn = await hasValidSession(request);

  const isProtected = PROTECTED_ROUTES.some((route) =>
    pathname.startsWith(route)
  );
  if (!loggedIn.ok && isProtected) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("redirectTo", pathname);
    const response = NextResponse.redirect(redirectUrl);
    response.headers.set("X-Auth-Gate", loggedIn.reason);
    return response;
  }

  const isAuthRoute = AUTH_ROUTES.some((route) =>
    pathname.startsWith(route)
  );
  if (loggedIn.ok && isAuthRoute) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/dashboard";
    redirectUrl.searchParams.delete("redirectTo");
    return NextResponse.redirect(redirectUrl);
  }

  const response = NextResponse.next();
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );
  return response;
}

interface SessionCookieValue {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

interface SessionVerdict {
  ok: boolean;
  reason: string;
}

/**
 * True when the request carries a Supabase session whose access token is
 * structurally valid and not expired. Runs fully locally (no network).
 *
 * - The session cookie (`sb-<ref>-auth-token`) holds a JSON blob with the
 *   access token. When the JSON is large — e.g. OAuth provider tokens in the
 *   session — @supabase/ssr splits it into chunked cookies named
 *   `sb-<ref>-auth-token.0`, `.1`, ... (MAX chunk ~3180 chars each); we
 *   recombine them before parsing. We decode it all without contacting
 *   Supabase.
 * - The JWT payload is base64-decoded and its `exp` claim is checked against
 *   the current time (with a small clock-skew window).
 * - We do NOT verify the JWT signature here: a locally-configured secret can
 *   diverge from the token-issuing project and silently lock users out for an
 *   edge-runtime UX gate. Real authorization happens server-side in API
 *   routes / pages via supabase.auth.getUser(), which always revalidates
 *   against Supabase. This gate only decides where to point the browser.
 */
async function hasValidSession(
  request: NextRequest
): Promise<SessionVerdict> {
  const { pathname } = request.nextUrl;

  const rawValue = collectSessionCookieValue(request);
  if (!rawValue) {
    console.warn(`[auth-gate] no session cookie for ${pathname}`);
    return { ok: false, reason: "no_cookie" };
  }

  const session = parseSessionValue(rawValue);
  if (!session) {
    console.warn(`[auth-gate] session cookie unparseable for ${pathname}`);
    return { ok: false, reason: "unparseable" };
  }

  const token = session.access_token;
  if (typeof token !== "string" || token.split(".").length !== 3) {
    console.warn(`[auth-gate] malformed access token for ${pathname}`);
    return { ok: false, reason: "malformed" };
  }

  const [header, payload] = token.split(".");
  if (!header || !payload) return { ok: false, reason: "malformed" };

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(base64UrlDecode(payload));
  } catch {
    console.warn(`[auth-gate] undecodable token payload for ${pathname}`);
    return { ok: false, reason: "unparseable" };
  }

  if (
    typeof claims.exp !== "number" ||
    claims.exp * 1000 < Date.now() - CLOCK_SKEW_SECONDS * 1000
  ) {
    console.warn(`[auth-gate] expired or missing exp for ${pathname}`);
    return { ok: false, reason: "expired" };
  }

  return { ok: true, reason: "ok" };
}

/** Matches `sb-<ref>-auth-token` and its chunked variants `…-auth-token.N`. */
const SESSION_COOKIE_RE = /^sb-.+-auth-token(\.[0-9]+)?$/;

/**
 * Recombines the Supabase session cookie across its possible chunks.
 * @supabase/ssr stores the session JSON in a single cookie, but once the
 * encoded value exceeds ~3180 chars it writes `sb-<ref>-auth-token.N` chunks
 * (no base cookie). Without this, large sessions look logged-out here.
 */
function collectSessionCookieValue(request: NextRequest): string | null {
  let baseValue: string | null = null;
  const chunks: { index: number; value: string }[] = [];

  for (const c of request.cookies.getAll()) {
    if (!SESSION_COOKIE_RE.test(c.name)) continue;
    const chunkSeparator = c.name.lastIndexOf(".");
    if (chunkSeparator === -1) {
      baseValue = c.value;
      continue;
    }
    const index = Number(c.name.slice(chunkSeparator + 1));
    if (!Number.isNaN(index)) chunks.push({ index, value: c.value });
  }

  if (baseValue !== null) return baseValue;
  if (chunks.length === 0) return null;
  chunks.sort((a, b) => a.index - b.index);
  return chunks.map((c) => c.value).join("");
}

/** Decodes a (possibly percent-encoded) cookie value into the session blob. */
function parseSessionValue(value: string): SessionCookieValue | null {
  let decoded = value;
  if (decoded.includes("%")) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(decoded) as SessionCookieValue;
  } catch {
    return null;
  }
}

/** base64url → UTF-8 string (binary JWT segments decode to ASCII JSON). */
function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return atob(padded);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};