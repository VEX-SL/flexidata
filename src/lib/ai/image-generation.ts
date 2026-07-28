const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY || "";
const TOGETHER_MODEL = "black-forest-labs/FLUX.1-schnell-Free";

interface ImageGenResult {
  url: string;
  provider: "together" | "pollinations";
}

/**
 * Generate an image using Together.ai (primary) or Pollinations.ai (fallback).
 */
export async function generateImage(prompt: string): Promise<ImageGenResult> {
  if (TOGETHER_API_KEY) {
    try {
      return await generateWithTogether(prompt);
    } catch (e: any) {
      console.warn("[ImageGen] Together.ai failed, falling back to Pollinations:", e?.message);
    }
  }

  return generateWithPollinations(prompt);
}

async function generateWithTogether(prompt: string): Promise<ImageGenResult> {
  const res = await fetch("https://api.together.xyz/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOGETHER_API_KEY}`,
    },
    body: JSON.stringify({
      model: TOGETHER_MODEL,
      prompt,
      width: 1024,
      height: 1024,
      steps: 4,
      n: 1,
      response_format: "url",
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Together.ai error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const url = data.data?.[0]?.url;
  if (!url) throw new Error("No image URL in Together.ai response");

  return { url, provider: "together" };
}

function generateWithPollinations(prompt: string): Promise<ImageGenResult> {
  const encoded = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 999999);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&model=flux&seed=${seed}&nologo=true`;
  return Promise.resolve({ url, provider: "pollinations" });
}
