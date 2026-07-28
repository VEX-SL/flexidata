import { NextRequest, NextResponse } from "next/server";
import { generateImage } from "@/lib/ai/image-generation";

export async function POST(req: NextRequest) {
  try {
    const { prompt } = await req.json();

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
    }

    const result = await generateImage(prompt);
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[/api/image/generate]", e);
    return NextResponse.json({ error: e?.message || "Generation failed" }, { status: 500 });
  }
}
