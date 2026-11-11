/* eslint-disable no-console */
/**
 * Gemini Diagnostic Script
 * -------------------------
 * Lists all models available to this API key and tests generateContent
 * against each, so you can see exactly which models work.
 *
 * Run:
 *   npx tsx scripts/test-gemini.ts
 */

import "dotenv/config";

const API_KEY = process.env.GEMINI_API_KEY;

interface ModelInfo {
  name: string;
  supportedMethods?: string[];
}

async function listModels(): Promise<ModelInfo[]> {
  console.log("=".repeat(72));
  console.log("STEP 1: List models available to this API key");
  console.log("=".repeat(72));

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`
  );
  console.log(`List models HTTP status: ${res.status}`);

  if (!res.ok) {
    const err = await res.text();
    console.error(`Failed to list models: ${err}`);
    console.log("\n👉 This usually means:");
    console.log("   • The 'Generative Language API' is not enabled for your Google Cloud project");
    console.log("   • OR the API key is restricted to other APIs");
    console.log("   → Go to: https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com");
    return [];
  }

  const data = await res.json();
  const models: ModelInfo[] = (data.models || []).map((m: any) => ({
    name: (m.name || "").replace("models/", ""),
    supportedMethods: m.supportedGenerationMethods || [],
  }));
  console.log(`Found ${models.length} models:`);
  for (const m of models.slice(0, 30)) {
    const methods = (m.supportedMethods || []).join(",");
    console.log(`  • ${m.name}  [${methods}]`);
  }
  if (models.length > 30) console.log(`  ... and ${models.length - 30} more`);
  return models;
}

async function testGenerate(model: string, isAvailable: boolean): Promise<void> {
  const tag = isAvailable ? "[LISTED] " : "[NOT IN LIST]";

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Reply with the single word: OK" }] }],
          generationConfig: { maxOutputTokens: 200, temperature: 0 },
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "(empty)";
      console.log(`✓ ${tag} ${model}: ${res.status} — "${text.trim().slice(0, 30)}"`);
    } else {
      const err = await res.text();
      const reason = err.slice(0, 120).replace(/\s+/g, " ");
      console.log(`✗ ${tag} ${model}: ${res.status} — ${reason}`);
    }
  } catch (err) {
    console.log(`✗ ${tag} ${model}: NETWORK — ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("GEMINI_API_KEY not set in .env");
    process.exit(1);
  }

  console.log(`Using key: ${API_KEY.slice(0, 4)}...${API_KEY.slice(-4)} (${API_KEY.length} chars)\n`);

  const availableModels = await listModels();
  const availableNames = availableModels.map((m) => m.name);

  console.log("\n" + "=".repeat(72));
  console.log("STEP 2: Test generateContent against specific models");
  console.log("=".repeat(72));

  const testModels = [
    "gemini-3.8-flash",
    "gemini-flash-latest",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-flash-lite",
    // Old models for reference — should all return 404
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
  ];

  for (const model of testModels) {
    await testGenerate(model, availableNames.includes(model));
  }

  console.log("\n" + "=".repeat(72));
  console.log("INTERPRETATION");
  console.log("=".repeat(72));
  console.log("• LISTED + 200 → model works, add to GEMINI_MODELS list");
  console.log("• LISTED + 503 → model exists but overloaded, retry later");
  console.log("• LISTED + 403 → API key not authorized for this model");
  console.log("• NOT IN LIST + 404 → model is shut down / deprecated");
  console.log("• STEP 1 returned 403/404 → enable Generative Language API in Google Cloud");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
