import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

/**
 * Language handling for Whisper.
 *
 * `auto` (the default) omits the `language` option entirely so the model
 * auto-detects the spoken language — the correct default for a multilingual
 * product (Arabic, English, French, …) instead of the previous hardcoded
 * "english".
 *
 * Accepted values: "auto" | a BCP-47 code ("en", "ar", "fr", …) | a Whisper
 * language name ("english", "arabic", …). Codes are mapped to the names the
 * Whisper tokenizer expects; unknown values are rejected so we never silently
 * transcribe in the wrong language.
 */
const CODE_TO_WHISPER_NAME: Record<string, string> = {
  en: "english",
  ar: "arabic",
  fr: "french",
  es: "spanish",
  de: "german",
  it: "italian",
  pt: "portuguese",
  ru: "russian",
  tr: "turkish",
  nl: "dutch",
  pl: "polish",
  uk: "ukrainian",
  fa: "persian",
  ur: "urdu",
  hi: "hindi",
  zh: "chinese",
  ja: "japanese",
  ko: "korean",
  he: "hebrew",
  id: "indonesian",
  sv: "swedish",
  cs: "czech",
  el: "greek",
  ro: "romanian",
  hu: "hungarian",
  da: "danish",
  fi: "finnish",
  no: "norwegian",
  th: "thai",
  vi: "vietnamese",
};

const WHISPER_NAMES = new Set(Object.values(CODE_TO_WHISPER_NAME));

/**
 * Resolve the requested transcription language to a Whisper language name, or
 * `null` to let Whisper auto-detect. Returns `undefined` for an unsupported
 * value (caller responds 400).
 */
function resolveWhisperLanguage(raw: string | null): string | null | undefined {
  const value = (raw ?? "auto").trim().toLowerCase();
  if (!value || value === "auto" || value === "detect") return null;
  const base = value.split(/[-_]/)[0];
  if (CODE_TO_WHISPER_NAME[base]) return CODE_TO_WHISPER_NAME[base];
  if (WHISPER_NAMES.has(value)) return value;
  return undefined;
}

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const rawLanguage = formData.get("language") ?? formData.get("lang");
  const language = resolveWhisperLanguage(
    typeof rawLanguage === "string" ? rawLanguage : null
  );
  if (language === undefined) {
    return NextResponse.json(
      { error: "Unsupported language" },
      { status: 400 }
    );
  }

  const allowedTypes = [
    "audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg", "audio/webm",
    "audio/flac", "audio/aac", "audio/m4a", "audio/x-m4a",
  ];
  if (!allowedTypes.includes(file.type) && !file.name.match(/\.(mp3|wav|ogg|webm|flac|aac|m4a)$/i)) {
    return NextResponse.json({ error: "Unsupported audio format" }, { status: 400 });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());

    // Lazy import to prevent crash on Vercel
    const { pipeline } = await import("@xenova/transformers");

    const transcriber = await pipeline("automatic-speech-recognition", "Xenova/whisper-small");

    // Convert to Float32Array (Whisper expects 16kHz mono float32)
    const audioData = convertAudio(buffer);

    const result = await transcriber(audioData, {
      task: "transcribe",
      // `language: null` (auto) lets Whisper detect the language itself.
      ...(language ? { language } : {}),
    });

    const text = (result as any)?.text || "";
    return NextResponse.json({
      text: text.trim(),
      language: language ?? "auto",
      duration: audioData.length / 16000,
    });
  } catch (err: any) {
    console.error("[AudioTranscribe] Error:", err);
    return NextResponse.json({ error: err.message || "Transcription failed" }, { status: 500 });
  }
}

function convertAudio(buffer: Buffer): Float32Array {
  // Convert raw buffer to Float32Array for Whisper (16kHz mono)
  const numSamples = Math.floor(buffer.length / 2);
  const float32 = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const val = buffer.readInt16LE(i * 2);
    float32[i] = val / 32768.0;
  }
  return float32;
}

export const runtime = "nodejs";
export const maxDuration = 60;
