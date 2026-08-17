import { readFileSync } from "node:fs";
import { recognizeMainThread } from "@/lib/tesseract-main";
import { runPipeline } from "@/lib/pipeline/defaults";
import type { ChatCompletionArgs } from "@/lib/pipeline/types";

for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const buffer = readFileSync("benchmarks/corpus/real-superpay.jpg");
const doc = await recognizeMainThread(buffer, "ara+eng", { verifyNumerics: true });
console.log(`OCR: lines=${doc.lines.length}`);

const out = await runPipeline(
  { sourceText: doc.text, profileType: "unknown", extractionMode: "dynamic" },
  {}
);
console.log(`status=${out.status} provider=${out.job?.extraction?.provider}`);

const clean = out.job?.extraction?.cleanFields ?? {};
const keys = Object.keys(clean);
console.log("\nFINAL FIELDS:");
for (const k of keys) console.log(`  ${k} = ${JSON.stringify(clean[k])}`);

const bad = keys.filter((k) => /mobile_number|^il$|isi_plat/.test(k));
const expected = [
  "رقم_انعمليه",
  "تاريخ_انتوقت",
  "رقم_الحساب",
  "انرقم_المرجقي",
  "رقم_العميل",
  "المبلغ_المطلوب",
];
const present = expected.filter((k) => k in clean);
const missing = expected.filter((k) => !(k in clean));
console.log(`\nfalse-positive fields present: ${bad.length ? bad.join(", ") : "NONE"}`);
console.log(`valid fields present: ${present.length}/${expected.length}`);
console.log(`valid fields missing: ${missing.length ? missing.join(", ") : "NONE"}`);
