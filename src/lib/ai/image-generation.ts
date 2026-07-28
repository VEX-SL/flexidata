const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY || "";
const TOGETHER_MODEL = "black-forest-labs/FLUX.1-schnell-Free";

interface ImageGenResult {
  url: string;
  provider: "together" | "pollinations";
}

/**
 * Generate an image using Together.ai (primary) or Pollinations.ai (fallback).
 * If imageUrl is provided, generates a new image based on it (img2img).
 */
export async function generateImage(prompt: string, imageUrl?: string): Promise<ImageGenResult> {
  if (TOGETHER_API_KEY) {
    try {
      return await generateWithTogether(prompt, imageUrl);
    } catch (e: any) {
      console.warn("[ImageGen] Together.ai failed, falling back to Pollinations:", e?.message);
    }
  }

  return generateWithPollinations(prompt, imageUrl);
}

async function generateWithTogether(prompt: string, imageUrl?: string): Promise<ImageGenResult> {
  const model = imageUrl ? "stabilityai/stable-diffusion-xl-base-1.0" : TOGETHER_MODEL;
  const steps = imageUrl ? 30 : 4;
  
  const res = await fetch("https://api.together.xyz/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOGETHER_API_KEY}`,
    },
    body: JSON.stringify({
      model: model,
      prompt,
      width: 1024,
      height: 1024,
      steps: steps,
      n: 1,
      response_format: "url",
      ...(imageUrl ? { image_url: imageUrl } : {}),
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

function generateWithPollinations(prompt: string, imageUrl?: string): Promise<ImageGenResult> {
  const encoded = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 999999);
  // For img2img, Pollinations requires the "kontext" model, not "flux"
  const model = imageUrl ? "kontext" : "flux";
  let url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&model=${model}&seed=${seed}&nologo=true`;

  if (imageUrl) {
    url += `&image=${encodeURIComponent(imageUrl)}`;
  }

  // Pollinations returns the image directly at the URL.
  // We just return the URL — the client will fetch it.
  return Promise.resolve({ url, provider: "pollinations" });
}
