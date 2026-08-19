/**
 * Minimal `next/server` stand-in for the unit-test loader (tests/loader.mjs).
 * Next's package exports map does not expose "./server", so plain Node ESM
 * cannot import the real module. Only the surface the codebase's routes use
 * is implemented: `NextResponse.json` backed by the global Response.
 */
export class NextResponse extends Response {
  static json(body: unknown, init?: ResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    return new NextResponse(
      JSON.stringify(body),
      typeof init === "number" ? { status: init } : { ...init, headers }
    );
  }
}