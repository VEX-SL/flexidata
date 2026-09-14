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
  // we decode the session cookie's JWT locally and verify expiry + signature.
  const loggedIn = await hasValidSession(request);

  const isProtected = PROTECTED_ROUTES.some((route) =>
    pathname.startsWith(route)
  );
  if (!loggedIn && isProtected) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("redirectTo", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  const isAuthRoute = AUTH_ROUTES.some((route) =>
    pathname.startsWith(route)
  );
  if (loggedIn && isAuthRoute) {
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

/**
 * True when the request carries a Supabase session whose access token is
 * structurally valid and not expired. Runs fully locally (no network).
 *
 * - The session cookie (`sb-<ref>-auth-token`) holds a JSON blob with the
 *   access token; we decode it without contacting Supabase.
 * - The JWT payload is base64-decoded and its `exp` claim is checked against
 *   the current time.
 * - When SUPERBASE_JWT_SECRET is present in the environment we additionally
 *   verify the HS256 signature with Web Crypto, which makes the check
 *   cryptographically sound even against hand-crafted cookies. Without the
 *   secret we still perform the expiry check — page gating stays a UX guard;
 *   real authorization happens server-side in API routes / pages via
 *   supabase.auth.getUser().
 */
async function hasValidSession(request: NextRequest): Promise<boolean> {
  const cookie = request.cookies
    .getAll()
    .find((c) => c.name.startsWith("sb-") && c.name.endsWith("-auth-token"));
  if (!cookie) return false;

  let session: SessionCookieValue;
  try {
    session = JSON.parse(decodeURIComponent(cookie.value));
  } catch {
    return false;
  }

  const token = session.access_token;
  if (typeof token !== "string" || token.split(".").length !== 3) return false;

  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return false;

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(base64UrlDecode(payload));
  } catch {
    return false;
  }

  if (
    typeof claims.exp !== "number" ||
    claims.exp * 1000 < Date.now() - CLOCK_SKEW_SECONDS * 1000
  ) {
    return false;
  }

  const secret = process.env.SUPABASE_JWT_SECRET;
  if (secret) {
    const valid = await verifyJwtSignature(header, payload, signature, secret);
    if (!valid) return false;
  }

  return true;
}

/** base64url → UTF-8 string (binary JWT segments decode to ASCII JSON). */
function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return atob(padded);
}

/** base64url → raw bytes (for signature comparison). */
function base64UrlToBytes(input: string): Uint8Array {
  const binary = base64UrlDecode(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Constant-time comparison so signature timing never leaks byte equality. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Verify the HS256 JWT signature with Web Crypto (off-band, no network). */
async function verifyJwtSignature(
  header: string,
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );
    const data = new TextEncoder().encode(`${header}.${payload}`);
    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, data)
    );
    return timingSafeEqual(expected, base64UrlToBytes(signature));
  } catch (err) {
    console.error("[Middleware] JWT signature verification failed:", err);
    return false;
  }
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};