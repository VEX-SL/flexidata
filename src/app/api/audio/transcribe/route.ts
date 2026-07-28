import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

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
      language: "english",
      task: "transcribe",
    });

    const text = (result as any)?.text || "";
    return NextResponse.json({ text: text.trim(), duration: audioData.length / 16000 });
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
