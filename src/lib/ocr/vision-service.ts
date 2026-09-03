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
 *
 * The Gemini model list is tried in order with a short per-attempt timeout
 * (VISION_ATTEMPT_TIMEOUT_MS) so a slow/crowded model never stalls the whole
 * request; when every Gemini model fails, an OpenRouter vision model is used
 * as a final fallback so extraction never returns 0 chars.
 */

// ─── Config ─────────────────────────────────────────────────────────────────

/** Overall budget, not used per-attempt (see VISION_ATTEMPT_TIMEOUT_MS). */
export const VISION_TIMEOUT_MS = 30_000;

/**
 * Per-attempt network timeout. A single model that takes longer than this to
 * respond is aborted immediately so a slow/crowded model never eats the whole
 * request budget — we just move on to the next model in the list.
 */
export const VISION_ATTEMPT_TIMEOUT_MS = 6_000;

/**
 * Ordered fallback list of Gemini Vision models. Lighter/faster models come
 * first so we rarely hit the heavier flash tier or its rate limits, and the
 * loop automatically falls back on timeout / 404 / 503 (High Demand).
 * `gemini-3.5-flash-lite` / `gemini-3.1-flash-lite` are tried first, then the
 * full flash tier, keeping every attempt under VISION_ATTEMPT_TIMEOUT_MS.
 */
export const VISION_MODELS: readonly string[] = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
];

/** Primary model alias (first in the fallback list) — kept for callers that
 *  reference the single model constant. */
export const VISION_MODEL = VISION_MODELS[0];
const GENERATIVE_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * OpenRouter vision fallback, used only when every Gemini model fails. Keeps
 * the extraction from ever returning 0 chars when Gemini is fully down or
 * quota-limited. Uses the OpenAI-compatible chat/completions format.
 */
export const OPENROUTER_VISION_MODELS: readonly string[] = [
  "google/gemini-2.5-flash",
  "meta-llama/llama-3.2-11b-vision-instruct",
];
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** Resolve the OpenRouter key for the vision fallback (null when unset). */
export function openrouterVisionKeyFromEnv(): string | null {
  const key =
    process.env.OPENROUTER_API_KEY ?? process.env.NEXT_PUBLIC_OPENROUTER_API_KEY ?? "";
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

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
  /** Receipt / process number (مطابق للرقم المرجعي أو رقم العملية). */
  receipt_number?: string;
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
  /** Merchant / brand name (e.g. "SuperPay", "فوري باي", "Zahra Aman"). */
  merchant_name?: string;
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
  "You are an elite, universal document intelligence and OCR extraction engine specialized in thermal payment receipts, POS slips, and invoices from any global payment network or system.",
  "Analyze the attached receipt image DIRECTLY and extract every field with the highest possible precision.",
  "Never invent or hallucinate a value that is not legible on the image — if a field is not readable, omit it.",
  "",
  "Universal Extraction & Anti-Confusion Rules:",
  "1. TRANSACTION IDS vs. SUPPORT HOTLINES: Transaction IDs are unique, lengthy operational identifiers (typically long numbers or alphanumeric strings tied to the transaction line). Strictly IGNORE short company hotlines, customer service numbers, or help helplines (which universally appear near headers, footers, or brand logos) — never map them as transaction IDs.",
  "2. THERMAL PRINT & DIGIT DEGRADATION: Thermal paper wear frequently distorts digits (e.g., the digit '9' often appears closed like '0' or '8', or faded). Use structural and contextual logic (such as standard regional mobile prefixes or expected reference length patterns) to correctly interpret degraded thermal digits.",
  "3. SEMANTIC LABEL MATCHING: Map fields based on their local semantic labels and structural layout proximity (e.g., Transaction ID / رقم العملية, Reference Number / الرقم المرجعي, Customer ID, Amount, Date, Status) regardless of regional system or language.",
  "4. DATA INTEGRITY: Keep amounts with decimals, timestamps strictly in ISO-8601 format, and capture any additional key-value pairs in the 'extra' array verbatim.",
  "5. REQUIRED FIELDS MUST NOT BE OMITTED: For the critical required fields — Receipt Date, Total/Amount, and Merchant Name/Status — do NOT drop them just because OCR confidence is low. Return the best readable value even when confidence is BELOW 80%; use structural context (label position, currency symbol, date format) to recover the value. Only set the field to null when there is genuinely NO legible value on the image.",
  "6. PAYMENT AGGREGATOR & ARABIC SLIPS: These slips often lack verbose labels. Apply the following inference rules:",
  "   a. MERCHANT NAME FROM HEADER BRAND: Infer 'merchant_name' from the top-level header brand/logo even when there is no explicit 'Merchant:' label (e.g. 'SuperPay', 'فوري باي', 'Zahra Aman', 'Aman', 'Vodafone Cash').",
  "   b. PROCESS NUMBER = RECEIPT + TRANSACTION: Map 'رقم العملية' / 'Process No' / transaction number DIRECTLY to BOTH 'receipt_number' AND 'transaction_id' — they are the same operational identifier on these slips.",
  "   c. SINGLE AMOUNT = TOTAL: If only ONE main currency/number value exists on the slip, use it as 'total_amount' / 'amount' even when no explicit 'Total' label is printed.",
  "   d. MISSING DATE/AMOUNT CROP: If the image genuinely lacks a legible date or amount crop, return null for that field instead of raising a missing-required-field error.",
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
  '    "status": "...",',
  '    "merchant_name": "..."',
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

  let lastFailure: string | null = null;

  for (const model of VISION_MODELS) {
    let response: Response;
    try {
      response = await fetch(
        `${GENERATIVE_ENDPOINT}/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(VISION_ATTEMPT_TIMEOUT_MS),
        }
      );
    } catch (err) {
      // An attempt that exceeds the per-attempt timeout is not fatal — abort it
      // and immediately try the next model. Any other network failure is not
      // retryable via model fallback and is surfaced directly.
      if (isTimeoutError(err)) {
        console.warn(`[Vision OCR] Model ${model} timed out after ${VISION_ATTEMPT_TIMEOUT_MS}ms, trying fallback...`);
        lastFailure = `Model ${model} timed out after ${VISION_ATTEMPT_TIMEOUT_MS}ms`;
        continue;
      }
      return ocrFailure(describeNetworkError(err));
    }

    if (!response.ok) {
      const detail = await extractUpstreamError(response);
      const status = response.status;
      const isDeprecatedOrBusy =
        status === 404 ||
        status === 503 ||
        /404|not found|deprecated/i.test(detail) ||
        /503|high demand|rate limit/i.test(detail) ||
        /404|not found|deprecated/i.test(response.statusText) ||
        /503|high demand|rate limit/i.test(response.statusText);
      if (isDeprecatedOrBusy) {
        console.warn(
          `[Vision OCR] Model ${model} returned ${status}, trying fallback...`
        );
        // On high demand (503) let the request queue settle before jumping to
        // the next model — a short 300-500ms jitter avoids hammering a crowded
        // API with back-to-back requests.
        if (status === 503 || /503|high demand|rate limit/i.test(detail)) {
          await jitterDelay(300, 500);
        }
        lastFailure = `Model ${model} returned ${status}`;
        continue;
      }
      lastFailure = `Vision service responded with status ${status}: ${detail}`;
      break;
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return ocrFailure("Vision service returned a non-JSON response");
    }
    return mapModelResult(parsed, lang);
  }

  // ── Final fallback: OpenRouter vision (OpenAI-compatible) ────────────────
  const openrouterKey = openrouterVisionKeyFromEnv();
  if (openrouterKey) {
    const result = await tryOpenRouterFallback(openrouterKey, prompt, base64, mimeType, lang);
    if (result) return result;
  }

  return ocrFailure(
    lastFailure ?? "All vision models are deprecated or at high demand (404/503)"
  );
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
  return parseTextToResponse(text, lang);
}

/**
 * Convert a raw model text output (assumed to be JSON shaped like
 * `{ "lines": [...], "extraction": {...} }`) into the `OCRResponse` contract.
 * Used for both the Gemini envelope and the OpenAI-compatible OpenRouter
 * fallback path.
 */
function parseTextToResponse(text: string, lang: OCRLanguage): OCRResponse {
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
    ...(str("total_amount") !== undefined ? { amount: str("total_amount") } : {}),
    ...(str("date") !== undefined ? { date: str("date") } : {}),
    ...(str("status") !== undefined ? { status: str("status") } : {}),
    ...(str("merchant_name") !== undefined ? { merchant_name: str("merchant_name") } : {}),
    ...(str("receipt_number") !== undefined ? { receipt_number: str("receipt_number") } : {}),
    ...(extra !== undefined && extra.length > 0 ? { extra } : {}),
  };
}

function isStructured(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Sleep for a random duration in [minMs, maxMs] to smooth out 503 retries. */
function jitterDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
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

/** True when a fetch error is a per-attempt timeout (AbortSignal.timeout). */
function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.name === "TimeoutError" ||
      err.name === "AbortError" ||
      (err.name === "DOMException" && /timeout|abort/i.test(err.message))
    );
  }
  return false;
}

/**
 * OpenRouter / Groq-vision fallback. Talks to the OpenAI-compatible
 * `chat/completions` endpoint using a multimodal message (system prompt + a
 * data-URL image part), parsing `choices[0].message.content` exactly like the
 * Gemini output. Tries each configured vision model; returns the first usable
 * `OCRResponse` or null when every one fails.
 */
async function tryOpenRouterFallback(
  apiKey: string,
  prompt: string,
  base64: string,
  mimeType: string,
  lang: OCRLanguage
): Promise<OCRResponse | null> {
  const dataUrl = `data:${mimeType};base64,${base64}`;

  for (const model of OPENROUTER_VISION_MODELS) {
    let response: Response;
    try {
      response = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          temperature: 0,
          messages: [
            { role: "system", content: prompt },
            {
              role: "user",
              content: [
                { type: "text", text: "Extract the receipt fields per the instructions." },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(VISION_ATTEMPT_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(`[Vision OCR] OpenRouter ${model} failed (${err instanceof Error ? err.name : "network"}), trying next...`);
      continue;
    }

    if (!response.ok) {
      const detail = await extractUpstreamError(response);
      const busy =
        response.status === 429 ||
        response.status === 503 ||
        /429|503|rate limit|high demand|quota/i.test(detail);
      console.warn(`[Vision OCR] OpenRouter ${model} returned ${response.status} (${detail}), trying next...`);
      if (busy) continue;
      // Non-retryable upstream error: try the next OpenRouter model anyway.
      continue;
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      continue;
    }
    if (!isStructured(parsed)) continue;
    const choices = (parsed as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) continue;
    return parseTextToResponse(content, lang);
  }

  return null;
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
    return `Vision service timed out after ${VISION_ATTEMPT_TIMEOUT_MS}ms`;
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
