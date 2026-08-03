import { readFileSync } from "node:fs";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { getProviderManager } from "@/lib/ai/manager";
import { SUPERYPAY_RECEIPT_OCR } from "../fixtures/receipt-ocr.ts";

const envPath = new URL("../../.env", import.meta.url);
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const systemPrompt =
  buildSystemPrompt("agent") +
  "\n\n## Attached Files:\n- photo_2026-08-02_12-59-10.jpg" +
  "\n\n## Provided Context:\n### photo_2026-08-02_12-59-10.jpg\n" +
  SUPERYPAY_RECEIPT_OCR;

const response = await getProviderManager().chatCompletion({
  messages: [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: "What document is this? Summarize it, listing every value you can read.",
    },
  ],
  maxTokens: 800,
  temperature: 0,
});

console.log("== model ==", response.model);
console.log("== reply ==");
console.log(response.content);
