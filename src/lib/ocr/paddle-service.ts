/**
 * PaddleOCR microservice client (server-side only).
 *
 * Bridges the Next.js backend to the Python FastAPI PaddleOCR microservice
 * pointed at by `PADDLE_OCR_URL`. Each call POSTs `multipart/form-data`
 * with a single `file` part and a `lang` selector ("auto" | "ar" | "en")
 * and returns the service's structured JSON contract verbatim:
 *
 *     { "success": true,
 *       "detected_language": "ar",
 *       "requested_language": "auto",
 *       "total_lines": 12,
 *       "data": [ { "text": "38.40", "confidence": 0.93 }, ... ] }
 *
 * Every failure path — missing env var, unsupported language, network
 * timeout, non-2xx status, malformed JSON — resolves to
 * `{ success: false, error: "..." }` instead of throwing, so callers never
 * need their own try/catch.
 */

// ─── Service contract types ─────────────────────────────────────────────────

/** One recognized text line returned by the PaddleOCR service. */
export interface OCRResultItem {
  text: string;
  /** Recognition confidence, normalized to [0, 1]. */
  confidence: number;
}

/** Full JSON response contract of the FastAPI OCR endpoint. */
export interface OCRResponse {
  success: boolean;
  detected_language: string;
  requested_language: string;
  total_lines: number;
  data: OCRResultItem[];
  error?: string;
}

// ─── Language selection ─────────────────────────────────────────────────────

/** Languages accepted by the microservice's `lang` field. */
export type OCRLanguage = "auto" | "ar" | "en";

export const OCR_LANGUAGES: readonly OCRLanguage[] = ["auto", "ar", "en"];

export const DEFAULT_OCR_LANGUAGE: OCRLanguage = "auto";

/** Narrow an arbitrary string to a supported OCR language. */
export function isOCRLanguage(value: unknown): value is OCRLanguage {
  return (
    typeof value === "string" &&
    (OCR_LANGUAGES as readonly string[]).includes(value)
  );
}

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Hard cap on the upstream request. The sidecar itself enforces a ~20s
 * inference limit; 30s leaves headroom for payload transfer + queue wait.
 */
export const PADDLE_OCR_TIMEOUT_MS = 30_000;

/**
 * Resolve the microservice base URL from the environment. Prefers the
 * server-only `PADDLE_OCR_URL`; falls back to `NEXT_PUBLIC_PADDLE_OCR_URL`
 * so deployments that only expose the public variable still work.
 * Returns null when unset/blank — callers surface a clean error.
 */
export function paddleOcrUrlFromEnv(): string | null {
  const url =
    process.env.PADDLE_OCR_URL ?? process.env.NEXT_PUBLIC_PADDLE_OCR_URL ?? "";
  const trimmed = url.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ─── Payload helpers ────────────────────────────────────────────────────────

/** Runtime guard that also narrows for TypeScript (Node-only symbol). */
function isNodeBuffer(value: unknown): value is Buffer {
  return typeof Buffer !== "undefined" && Buffer.isBuffer(value);
}

/**
 * Coerce any accepted input shape (File / Blob / Node Buffer) into a Blob so
 * `FormData.append` serializes it correctly across runtimes (Buffers are not
 * directly attachable to a spec-compliant FormData).
 */
function toBlob(file: File | Blob | Buffer): Blob {
  if (isNodeBuffer(file)) {
    return new Blob([new Uint8Array(file)]);
  }
  return file;
}

/** Best-effort filename for the multipart part (helps content sniffing). */
function fileNameOf(file: File | Blob | Buffer): string {
  if (typeof File !== "undefined" && file instanceof File && file.name) {
    return file.name;
  }
  return "upload";
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run OCR on an image via the PaddleOCR microservice.
 *
 * @param file - Image to recognize (File, Blob, or Node Buffer).
 * @param lang - Language hint: "auto" (default), "ar", or "en".
 * @returns The service's parsed `OCRResponse`; on ANY failure a resolved
 *          `{ success: false, error }` object (never throws).
 */
export async function runPaddleOCR(
  file: File | Blob | Buffer,
  lang: OCRLanguage = DEFAULT_OCR_LANGUAGE
): Promise<OCRResponse> {
  const baseUrl = paddleOcrUrlFromEnv();
  if (!baseUrl) {
    return ocrFailure("OCR service is not configured (PADDLE_OCR_URL missing)");
  }

  let form: FormData;
  try {
    form = new FormData();
    form.append("file", toBlob(file), fileNameOf(file));
    form.append("lang", lang);
  } catch {
    return ocrFailure("Failed to build OCR request payload");
  }

  let response: Response;
  try {
    response = await fetch(baseUrl, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(PADDLE_OCR_TIMEOUT_MS),
    });
  } catch (err) {
    return ocrFailure(describeNetworkError(err));
  }

  if (!response.ok) {
    return ocrFailure(
      `OCR service responded with status ${response.status}: ${await extractUpstreamError(response)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return ocrFailure("OCR service returned a non-JSON response");
  }
  if (!isOCRResponse(parsed)) {
    return ocrFailure("OCR service returned an unexpected response shape");
  }
  return parsed;
}

// ─── Failure shaping ────────────────────────────────────────────────────────

/** Uniform failure envelope — keeps the full OCRResponse contract. */
function ocrFailure(error: string): OCRResponse {
  return {
    success: false,
    detected_language: "",
    requested_language: "",
    total_lines: 0,
    data: [],
    error,
  };
}

/** Human-readable message for fetch-level failures (timeout, DNS, reset). */
function describeNetworkError(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") {
    return `OCR service timed out after ${PADDLE_OCR_TIMEOUT_MS}ms`;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return "OCR request was aborted";
  }
  return `Could not reach OCR service: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Pull a useful detail out of an upstream error body without ever letting a
 * malformed body break the error path.
 */
async function extractUpstreamError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown; detail?: unknown };
    if (typeof body?.error === "string") return body.error;
    if (typeof body?.detail === "string") return body.detail;
  } catch {
    // fall through to generic text
  }
  return "no details";
}

/** Minimal structural guard before trusting the parsed JSON. */
function isOCRResponse(value: unknown): value is OCRResponse {
  if (value === null || typeof value !== "object") return false;
  const v = value as Partial<OCRResponse>;
  return (
    typeof v.success === "boolean" &&
    Array.isArray(v.data) &&
    v.data.every(
      (item): item is OCRResultItem =>
        item !== null &&
        typeof item === "object" &&
        typeof item.text === "string" &&
        typeof item.confidence === "number"
    )
  );
}
