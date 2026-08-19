/**
 * HTTP client for the external PaddleOCR rescue service.
 *
 * The rescue layer re-reads image regions with a dedicated PaddleOCR service
 * (never inline — models are ~500MB and need Python). This client is the ONLY
 * piece of the rescue that talks to the network, and it is strictly additive:
 *  - the URL comes exclusively from `PADDLE_OCR_URL` (env) — no defaults, no
 *    hardcoded endpoints, no secrets;
 *  - a missing URL, timeout, unreachable host, or malformed response NEVER
 *    throws: it returns a result carrying `error`, and callers record the
 *    graceful skip;
 *  - the request is aborted after `timeoutMs` so the OCR budget is honored.
 *
 * Wire contract (JSON POST):
 *   { "image": "<base64 png>", "engine": "paddleocr-en" }
 *   → { "engine": "paddleocr-en",
 *       "texts": [ { "text": "TOTAL 38.40", "bbox": {x,y,width,height},
 *                    "confidence": 0.99 } ],
 *       "latency_ms": 412 }
 * Confidence is 0..1 (0..100 tolerated, normalized). Items missing text, a
 * sane confidence, or a usable box are dropped by the parser — never trusted:
 * geometry is required for safe region/attribution decisions downstream.
 */
import type { BBox } from "@/lib/pipeline/types";

/** Hard timeout for one region request (part of the documented budget). */
export const PADDLE_REGION_TIMEOUT_MS = 5000;

export interface PaddleTextItem {
  text: string;
  /** Line box in the sent-image coordinate space (processed-image space). */
  bbox?: BBox;
  /** 0..1 line confidence. */
  confidence: number;
}

export interface PaddleRescueResult {
  engine: "paddleocr-en" | "paddleocr-ar";
  texts: PaddleTextItem[];
  /** Wall time of the HTTP round trip (0 when the request was never made). */
  latencyMs: number;
  /** Non-empty exactly when the request failed gracefully. */
  error?: string;
}

export interface PaddleClientOptions {
  /** Override for PADDLE_OCR_URL (tests / benchmark inject the mock). */
  url?: string;
  timeoutMs?: number;
  engine?: "paddleocr-en" | "paddleocr-ar";
}

/** The rescue service URL from the environment; undefined when absent/invalid. */
export function paddleUrlFromEnv(): string | undefined {
  const url = process.env.PADDLE_OCR_URL;
  if (!url || !/^https?:\/\//.test(url)) return undefined;
  return url;
}

function toBBox(value: unknown): BBox | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const x = Number(v.x);
  const y = Number(v.y);
  const width = Number(v.width);
  const height = Number(v.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function parseTexts(data: unknown): PaddleTextItem[] {
  if (!data || typeof data !== "object") return [];
  const raw = (data as Record<string, unknown>).texts;
  if (!Array.isArray(raw)) return [];
  const out: PaddleTextItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const text = typeof it.text === "string" ? it.text.trim() : "";
    if (!text) continue;
    let confidence = Number(it.confidence);
    if (!Number.isFinite(confidence)) continue;
    if (confidence > 1) confidence = confidence / 100; // tolerate 0..100
    confidence = Math.max(0, Math.min(1, confidence));
    const bbox = toBBox(it.bbox);
    if (bbox === undefined) continue;
    out.push({ text, confidence, bbox });
  }
  return out;
}

/**
 * One rescue request: POST the region PNG to the service and parse the
 * reading. Never throws — transport failures become `error` on the result.
 */
export async function requestPaddleRescue(
  imagePng: Buffer,
  opts: PaddleClientOptions = {}
): Promise<PaddleRescueResult> {
  const engine = opts.engine ?? "paddleocr-en";
  const url = opts.url ?? paddleUrlFromEnv();
  const started = Date.now();
  if (!url) {
    return { engine, texts: [], latencyMs: 0, error: "paddle_url_missing" };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? PADDLE_REGION_TIMEOUT_MS
  );
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: imagePng.toString("base64"), engine }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        engine,
        texts: [],
        latencyMs,
        error: `paddle_http_${res.status}`,
      };
    }
    const data = (await res.json()) as unknown;
    return { engine, texts: parseTexts(data), latencyMs };
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    return {
      engine,
      texts: [],
      latencyMs: Date.now() - started,
      error: aborted ? "paddle_timeout" : "paddle_unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}