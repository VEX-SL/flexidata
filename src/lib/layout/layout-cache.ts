/**
 * Milestone 9 — deterministic layout result cache.
 *
 * The cache keys `LayoutResult`s by a hash of the canonical, normalized OCR
 * document and stores them indefinitely: identical OCR input always yields the
 * identical frozen `LayoutResult` object. Design rules:
 *
 *   - key = sha-256 of the normalized canonical OCR (single source line + the
 *     compact word order; arrays and objects are themselves canonicalized, so
 *     equal docs hash equal regardless of reference identity);
 *   - failed builds are never cached (a failure is re-derived from the live
 *     pipeline);
 *   - never evicts/expires and holds no mutable shared state between get and
 *     set — concurrent lookups are safe;
 *   - a hit returns the exact object produced by the first build (the pipeline
 *     deep-frozes results, so the shared object is immutable).
 */
import type { OcrDocument } from "@/lib/pipeline/types";
import type { LayoutResult } from "./layout-context";

/** The number of `OcrLine`/`OcrWord` (and nested object) keys the canon has. */
type CanonNode =
  | string
  | number
  | boolean
  | CanonNode[]
  | { readonly [key: string]: CanonNode };

/** Versioned prefix so cache keys never collide across canon formats. */
const CANON_PREFIX = "flexidata-layout-canon-v1:";

/** Canonicalize an `OcrDocument`: one source line, words in order. */
export function canonOcr(ocr: OcrDocument): string {
  const text = typeof ocr.text === "string" ? ocr.text : "";
  const canon: CanonNode[] = [];
  const lines: CanonNode[] = [];
  for (const line of ocr.lines) {
    const lineEntries: CanonNode[] = [];
    const lineBox: CanonNode = line.bbox
      ? ["bbox", line.bbox.x, line.bbox.y, line.bbox.width, line.bbox.height]
      : "no-bbox";
    lineEntries.push(["text", line.text]);
    lineEntries.push(lineBox);
    const words: CanonNode[] = [];
    for (const word of line.words) {
      const box: CanonNode = word.bbox
        ? ["bbox", word.bbox.x, word.bbox.y, word.bbox.width, word.bbox.height]
        : "no-bbox";
      words.push([
        "word",
        word.text,
        word.confidence === undefined ? "no-conf" : word.confidence,
        box,
      ]);
    }
    lineEntries.push(["words", ...words]);
    lines.push(["line", ...lineEntries]);
  }
  canon.push(["text", text]);
  canon.push(["lines", ...lines]);
  return JSON.stringify([CANON_PREFIX, canon]);
}

/** Deterministic string digest of the canonical OCR (sha-256 when available). */
export function hashOcr(ocr: OcrDocument): string {
  const canonical = canonOcr(ocr);
  try {
    // Node's crypto digest; browsers (via a bundler/WebCrypto) fall through.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require("node:crypto") as { createHash: unknown };
    if (crypto && typeof crypto.createHash === "function") {
      const createHash = crypto.createHash as (algo: string) => {
        update: (input: string) => { digest: (enc: string) => string };
      };
      return createHash("sha256").update(canonical).digest("hex");
    }
  } catch {
    // Fall through to the length-stable deterministic digest below.
  }
  return deterministicDigest(canonical);
}

/** Length-stable deterministic digest (non-crypto environments only). */
export function deterministicDigest(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = (h1 * 33) ^ c;
    h2 = ((h2 * 31) ^ c) >>> 0;
  }
  h1 = h1 >>> 0;
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** The layout result cache: `get(key)`/`set(key, result)`, no eviction. */
export interface LayoutCache {
  get(key: string): LayoutResult | undefined;
  set(key: string, result: LayoutResult): LayoutResult;
}

/** In-memory thread-safe store: no mutable shared state between get/set. */
export function createLayoutCache(): LayoutCache {
  const store = new Map<string, LayoutResult>();
  return {
    get(key: string): LayoutResult | undefined {
      return store.get(key);
    },
    set(key: string, result: LayoutResult): LayoutResult {
      store.set(key, result);
      return result;
    },
  };
}

/** Compute the cache key for an OCR document (the canonical hash). */
export function layoutCacheKey(ocr: OcrDocument): string {
  return `${CANON_PREFIX}${hashOcr(ocr)}`;
}

/** Get the cached result for an OCR document, if any. */
export function layoutCacheGet(
  cache: LayoutCache,
  ocr: OcrDocument
): LayoutResult | undefined {
  return cache.get(layoutCacheKey(ocr));
}

/** Store a result for an OCR document (failed results are never cached). */
export function layoutCacheSet(
  cache: LayoutCache,
  ocr: OcrDocument,
  result: LayoutResult
): LayoutResult {
  if (result.failure !== undefined) return result;
  return cache.set(layoutCacheKey(ocr), result);
}
