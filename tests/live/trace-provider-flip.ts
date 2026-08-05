/**
 * READ-ONLY corroboration: same exact extraction prompt, but with groq
 * removed from the provider chain (cerebras answers first). Proves whether
 * the total_amount null is provider-dependent or prompt-dependent.
 */
import { readFileSync } from "node:fs";
import { getProviderManager } from "@/lib/ai/manager";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import { buildExtractionPrompt } from "@/lib/pipeline/extractor/prompt-builder";
import { parseRaw } from "@/lib/pipeline/extractor";

const envPath = new URL("../../.env", import.meta.url);
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (m[1] === "GROQ_API_KEY") {
    console.log("[corroboration] GROQ_API_KEY intentionally removed from provider chain");
    continue;
  }
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const sourceText = `‎i‏ م 0 5 ل 1 3 : = : ب"
له ‎SuperPay‏ 60
‎LL 15468‏
‎Zahra Aman =‏
3 قوري باي
() رقم التمليه : 6070218301132167
تبيخ الوقت : 02-07-2028 18:30:12
| رقم الحساب : 391803452
‎B‏ انرقم المرجقي : 2013438351
[ عملية ناجحة
8[ رقم العميل : 9840833767
§ معلومات إضافية : ‎Mobile Number‏
‎Hostinger;Description ©‏ ;)0123456788(
‎F-‏ 1 :
‎X PURCHASE 8‏
‎gla‏ المطلوب : 68.38 ;
‎glad |‏ العلى : 68.38
: 3 عند لفطل ‎EAN‏ قد يستفرق ‎a se BA‏`;

const profile = getProfileManager().getOrFallback("receipt");
const prompt = buildExtractionPrompt(profile, sourceText);
const response = await getProviderManager().chatCompletion({
  messages: [
    { role: "system", content: "You are a data extraction engine. Reply with ONLY a single valid JSON object. No markdown, no explanation, no commentary outside the JSON." },
    { role: "user", content: prompt },
  ],
  maxTokens: 4096,
  temperature: 0,
});

console.log("\nprovider/model:", response.provider, "/", response.model);
const raw = parseRaw(response.content ?? "");
console.log("\ntotal_amount entry from raw LLM response:");
console.log(JSON.stringify(raw.data.total_amount ?? null, null, 2));
console.log("\nreceipt_date entry from raw LLM response:");
console.log(JSON.stringify(raw.data.receipt_date ?? null, null, 2));
console.log("\nline_items entry from raw LLM response:");
console.log(JSON.stringify(raw.data.line_items ?? null, null, 2));
