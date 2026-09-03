/**
 * Vision-LLM OCR + extraction service (server-side only).
 *
 * Replaces the external Python PaddleOCR microservice (`PADDLE_OCR_URL`). The
 * uploaded image is converted to base64 and sent DIRECTLY to a Vision LLM
 * (Gemini 1.5 Flash via the Generative Language REST API — no new npm
 * dependency, matching the raw-fetch convention of `src/lib/ai/providers`).
 * The model both reads the image and extracts structured fields for thermal
 * receipts (Fawry / SuperPay / Aman).
 *
 * The response keeps the EXACT `OCRResponse` contract the frontend pipeline
 * expects — `success`, `detected_language`, `requested_language`,
 * `total_lines`, `data` (recognized text lines) — and adds an OPTIONAL
 * `extraction` object carrying the structured fields, so existing tests and
 * UI components keep working without breaking changes.
 *
 * Every failure path — missing API key, network error, non-2xx status,
 * malformed JSON, unusable image — resolves to
 * `{ success: false, error: "..." }` instead of throwing, so callers never
 * need their own try/catch.
 */

// ─── Config ─────────────────────────────────────────────────────────────────

export const VISION_TIMEOUT_MS = 30_000;
export const VISION_MODEL = "gemini-1.5-flash";
const GENERATIVE_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Resolve the Gemini API key from the environment. Prefers the server-only
 * `GEMINI_API_KEY`; falls back to `NEXT_PUBLIC_GEMINI_API_KEY`. Returns null
 * when unset/blank — callers surface a clean error.
 */
export function geminiApiKeyFromEnv(): string | null {
  const key = process.env.GEMINI_API_KEY ?? process.env.NEXT_PUBLIC_GEMINI_API_KEY ?? "";
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** One recognized text line read by the Vision model. */
export interface OCRResultItem {
  text: string;
  /** Recognition confidence, normalized to [0, 1] (model-reported). */
  confidence: number;
}

/** Structured fields extracted from a thermal receipt. */
export interface ReceiptExtraction {
  /** Continuous 16-digit payment ID (e.g. "6070218301132157"). */
  transaction_id?: string;
  /** 10-digit reference number usually starting with "20". */
  reference_number?: string;
  /** Value under "رقم العميل" (customer ID). */
  customer_id?: string;
  /** Egyptian mobile number in 01[0125]xxxxxxxx form. */
  mobile_number?: string;
  /** Transaction amount (e.g. "68.38"). */
  amount?: string;
  /** Transaction timestamp in ISO format. */
  date?: string;
  /** Transaction status (e.g. "عملية ناجحة"). */
  status?: string;
  /** Any additional label/value pairs the model read (preserved verbatim). */
  extra?: Array<{ label: string; value: string }>;
}

/** Full JSON response contract of the Vision OCR endpoint. */
export interface OCRResponse {
  success: boolean;
  detected_language: string;
  requested_language: string;
  total_lines: number;
  data: OCRResultItem[];
  /** Structured fields extracted from the image (additive, optional). */
  extraction?: ReceiptExtraction;
  error?: string;
}

/** Languages accepted by the service's `lang` selector. */
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

// ─── Extraction prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  "You are a precise OCR + data-extraction engine for thermal payment receipts",
  "(Fawry / SuperPay / Aman) printed in Arabic and English.",
  "Analyze the attached receipt image DIRECTLY and extract every field you can",
  "read, with the highest possible precision. Never invent a value that is not",
  "legible on the image — if a field is not readable, omit it.",
  "",
  "Field rules:",
  "- transaction_id: the CONTINUOUS 16-digit payment ID (e.g. 6070218301132157).",
  "  Do NOT confuse it with a shorter hotline like 15468 or a service number.",
  "- reference_number: the 10-digit number that usually starts with 20",
  "  (e.g. 2013439351).",
  "- customer_id: the value labeled under 'رقم العميل'.",
  "- mobile_number: Egyptian format 01[0125]xxxxxxxx (e.g. 01012345678).",
  "- amount: the transaction amount (e.g. 68.38), keeping decimals.",
  "- date: the transaction timestamp, returned as an ISO-8601 string.",
  "- status: the transaction status (e.g. 'عملية ناجحة').",
  "",
  "Respond with STRICT JSON only — no markdown fences, no commentary — shaped",
  "exactly like:",
  "{",
  '  "lines": [ { "text": "<verbatim line>", "confidence": 0.98 } ],',
  '  "extraction": {',
  '    "transaction_id": "...",',
  '    "reference_number": "...",',
  '    "customer_id": "...",',
  '    "mobile_number": "...",',
  '    "amount": "...",',
  '    "date": "...",',
  '    "status": "..."',
  '  }',
  "}",
  '"lines" must contain each distinct printed line of the receipt (the raw OCR',
  "text). Every value in \"extraction\" must be grounded in a printed value you",
  "actually saw on the image.",
].join("\n");

// ─── Payload helpers ────────────────────────────────────────────────────────

/** Runtime guard that also narrows for TypeScript (Node-only symbol). */
function isNodeBuffer(value: unknown): value is Buffer {
  return typeof Buffer !== "undefined" && Buffer.isBuffer(value);
}

/**
 * Coerce any accepted input shape (File / Blob / Node Buffer) into a Uint8Array
 * so it can be base64-encoded consistently across runtimes.
 */
async function toBytes(file: File | Blob | Buffer): Promise<Uint8Array> {
  if (isNodeBuffer(file)) return new Uint8Array(file);
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

/** Best-effort MIME type from the input (helps the model's content parse). */
function mimeTypeOf(file: File | Blob | Buffer): string {
  if (typeof File !== "undefined" && file instanceof File) {
    return file.type || "image/jpeg";
  }
  if (typeof Blob !== "undefined" && file instanceof Blob && file.type) {
    return file.type;
  }
  return "image/jpeg";
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run OCR + structured extraction on an image via a Vision LLM.
 *
 * @param file - Image to analyze (File, Blob, or Node Buffer).
 * @param lang - Language hint: "auto" (default), "ar", or "en".
 * @returns A resolved `OCRResponse`; on ANY failure a resolved
 *          `{ success: false, error }` object (never throws).
 */
export async function runVisionOCR(
  file: File | Blob | Buffer,
  lang: OCRLanguage = DEFAULT_OCR_LANGUAGE
): Promise<OCRResponse> {
  const apiKey = geminiApiKeyFromEnv();
  if (!apiKey) {
    return ocrFailure("Vision service is not configured (GEMINI_API_KEY missing)");
  }

  let base64: string;
  let mimeType: string;
  try {
    const bytes = await toBytes(file);
    base64 = Buffer.from(bytes).toString("base64");
    mimeType = mimeTypeOf(file);
  } catch {
    return ocrFailure("Failed to encode image for the Vision service");
  }

  const prompt =
    lang === "en"
      ? SYSTEM_PROMPT
      : `${SYSTEM_PROMPT}\nThe receipt is in Arabic; keep Arabic values verbatim.`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: base64 } },
          { text: "Extract the receipt fields per the instructions." },
        ],
      },
    ],
    systemInstruction: { parts: [{ text: prompt }] },
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
    },
  };

  let response: Response;
  try {
    response = await fetch(
      `${GENERATIVE_ENDPOINT}/${VISION_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      }
    );
  } catch (err) {
    return ocrFailure(describeNetworkError(err));
  }

  if (!response.ok) {
    const detail = await extractUpstreamError(response);
    return ocrFailure(`Vision service responded with status ${response.status}: ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return ocrFailure("Vision service returned a non-JSON response");
  }
  return mapModelResult(parsed, lang);
}

// ─── Response shaping ───────────────────────────────────────────────────────

/**
 * Convert the model's JSON output into the `OCRResponse` contract, degrading
 * gracefully (the structured fields are optional) while never throwing.
 */
function mapModelResult(parsed: unknown, lang: OCRLanguage): OCRResponse {
  const text = extractModelText(parsed);
  if (text === null) {
    return ocrFailure("Vision service returned no usable content");
  }

  let structured: unknown = null;
  try {
    structured = JSON.parse(stripCodeFences(text));
  } catch {
    structured = null;
  }

  const lines = isStructured(structured)
    ? parseLines((structured as { lines?: unknown }).lines)
    : [];

  return {
    success: true,
    detected_language: lang,
    requested_language: lang,
    total_lines: lines.length,
    data: lines,
    ...(isStructured(structured) && (structured as { extraction?: unknown }).extraction !== undefined
      ? { extraction: sanitizeExtraction((structured as { extraction?: unknown }).extraction) }
      : {}),
  };
}

function parseLines(value: unknown): OCRResultItem[] {
  if (!Array.isArray(value)) return [];
  const out: OCRResultItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const text = typeof it.text === "string" ? it.text : "";
    if (!text.trim()) continue;
    const confidence = Number(it.confidence);
    out.push({
      text,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 1,
    });
  }
  return out;
}

function sanitizeExtraction(value: unknown): ReceiptExtraction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof v[k] === "string" && (v[k] as string).trim().length > 0
      ? (v[k] as string).trim()
      : undefined;
  const extra: ReceiptExtraction["extra"] = Array.isArray(v.extra)
    ? (v.extra as Array<Record<string, unknown>>)
        .filter((e) => e && typeof e === "object")
        .map((e) => ({
          label: typeof e.label === "string" ? e.label : "",
          value: typeof e.value === "string" ? e.value : "",
        }))
        .filter((e) => e.label.length > 0)
    : undefined;
  return {
    ...(str("transaction_id") !== undefined ? { transaction_id: str("transaction_id") } : {}),
    ...(str("reference_number") !== undefined ? { reference_number: str("reference_number") } : {}),
    ...(str("customer_id") !== undefined ? { customer_id: str("customer_id") } : {}),
    ...(str("mobile_number") !== undefined ? { mobile_number: str("mobile_number") } : {}),
    ...(str("amount") !== undefined ? { amount: str("amount") } : {}),
    ...(str("date") !== undefined ? { date: str("date") } : {}),
    ...(str("status") !== undefined ? { status: str("status") } : {}),
    ...(extra !== undefined && extra.length > 0 ? { extra } : {}),
  };
}

function isStructured(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * Pull the model's text output out of the Gemini response envelope
 * (`candidates[0].content.parts[*].text`). Returns null when absent.
 */
function extractModelText(parsed: unknown): string | null {
  if (!isStructured(parsed)) return null;
  const candidates = parsed.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const content = (candidates[0] as Record<string, unknown>)?.content;
  const parts =
    content !== null && typeof content === "object"
      ? (content as Record<string, unknown>).parts
      : undefined;
  if (!Array.isArray(parts)) return null;
  const texts: string[] = [];
  for (const p of parts) {
    if (p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string") {
      texts.push((p as Record<string, unknown>).text as string);
    }
  }
  const joined = texts.join("").trim();
  return joined.length > 0 ? joined : null;
}

/** Strip markdown code fences that some models wrap JSON in. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return match ? match[1] : trimmed;
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
    return `Vision service timed out after ${VISION_TIMEOUT_MS}ms`;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return "Vision request was aborted";
  }
  return `Could not reach Vision service: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Pull a useful detail out of an upstream error body without ever letting a
 * malformed body break the error path.
 */
async function extractUpstreamError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } | string };
    if (body?.error && typeof body.error === "object" && typeof body.error.message === "string") {
      return body.error.message;
    }
    if (typeof body?.error === "string") return body.error;
  } catch {
    // fall through
  }
  return "no details";
}
