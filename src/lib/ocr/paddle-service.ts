/**
 * OCR + extraction service — Vision LLM backend (server-only).
 *
 * This module is the RE-EXPORT shim that used to bridge to the external Python
 * PaddleOCR microservice pointed at by `PADDLE_OCR_URL`. The Python sidecar has
 * been removed: OCR now runs directly through a Vision LLM (Gemini 1.5 Flash).
 *
 * The `runPaddleOCR` name is preserved purely as a backward-compatible alias so
 * existing callers (`src/app/api/ocr/route.ts` and any downstream code) keep
 * compiling. New code should import from `@/lib/ocr/vision-service` directly.
 *
 * The `OCRResponse` contract — `success`, `detected_language`,
 * `requested_language`, `total_lines`, `data` — is unchanged, and now carries
 * an OPTIONAL `extraction` object with the structured receipt fields.
 */
import {
  runVisionOCR,
  type OCRLanguage,
} from "./vision-service";

export {
  DEFAULT_OCR_LANGUAGE,
  OCR_LANGUAGES,
  VISION_MODEL,
  VISION_TIMEOUT_MS,
  geminiApiKeyFromEnv,
  isOCRLanguage,
  runVisionOCR,
} from "./vision-service";

export type {
  OCRResultItem,
  OCRResponse,
  ReceiptExtraction,
} from "./vision-service";

/**
 * Backward-compatible alias for the Vision-powered OCR/extraction call. See
 * `runVisionOCR` in `@/lib/ocr/vision-service`.
 */
export async function runPaddleOCR(
  file: File | Blob | Buffer,
  lang: OCRLanguage = "auto"
): Promise<Awaited<ReturnType<typeof runVisionOCR>>> {
  return runVisionOCR(file, lang);
}
