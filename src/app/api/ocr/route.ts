/**
 * POST /api/ocr — run OCR + structured extraction on an image via a Vision LLM
 * (Gemini 1.5 Flash). Replaces the former PaddleOCR microservice proxy.
 *
 * Accepts `multipart/form-data`:
 *   - `file` (required): the image to recognize.
 *   - `lang` (optional): "auto" | "ar" | "en" — defaults to "auto".
 *
 * Returns the service's JSON contract verbatim on success
 * (`{ success, detected_language, requested_language, total_lines, data,
 *    extraction }`)
 * or a uniform `{ success: false, error }` body otherwise. Status codes map
 * failure classes: 400 bad input, 401 unauthenticated, 503 service not
 * configured, 502 upstream failure.
 *
 * The heavy lifting lives in @/lib/ocr/vision-service so server actions can
 * reuse it without going through HTTP.
 */

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import {
  DEFAULT_OCR_LANGUAGE,
  isOCRLanguage,
  runVisionOCR,
} from "@/lib/ocr/vision-service";

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid form data" },
      { status: 400 }
    );
  }

  const file = formData.get("file");
  if (file === null || typeof file === "string") {
    return NextResponse.json(
      { success: false, error: "No file provided" },
      { status: 400 }
    );
  }

  const rawLang = formData.get("lang") ?? DEFAULT_OCR_LANGUAGE;
  if (!isOCRLanguage(rawLang)) {
    return NextResponse.json(
      { success: false, error: 'Unsupported lang — use "auto", "ar", or "en"' },
      { status: 400 }
    );
  }

  const result = await runVisionOCR(file, rawLang);
  if (!result.success && result.error?.includes("not configured")) {
    return NextResponse.json(result, { status: 503 });
  }
  return NextResponse.json(result, { status: result.success ? 200 : 502 });
}

export const runtime = "nodejs";
export const maxDuration = 60;
