import { readFileSync } from "node:fs";
import { classifyDocument } from "@/lib/pipeline/classifier";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import { scoreByAliases } from "@/lib/pipeline/classifier";

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

const FRESH_OCR = `i م 0 5 ل 1 3 : = : ب"
له SuperPay 60
LL 15468
Zahra Aman =
3 قوري باي
() رقم التمليه : 6070218301132167
تبيخ الوقت : 02-07-2028 18:30:12
| رقم الحساب : 391803452
B انرقم المرجقي : 2013438351
[ عملية ناجحة
8[ رقم العميل : 9840833767
§ معلومات إضافية : Mobile Number
Hostinger;Description © ;)0123456788(
F- 1 :
X PURCHASE 8
gla المطلوب : 68.38 ;
glad | العلى : 68.38
: 3 عند لفطل EAN قد يستفرق a se BA`;

console.log("== rule scores per profile (head 3000) ==");
for (const p of getProfileManager().candidates()) {
  console.log(`  ${p.id}: score=${scoreByAliases(FRESH_OCR, p.id)}`);
}

console.log("\n== classifier decision (real AI, NEW code) ==");
const classification = await classifyDocument(FRESH_OCR);
console.log(
  JSON.stringify(
    {
      profileType: classification.profileType,
      confidence: classification.confidence,
      source: classification.source,
      reasons: classification.reasons,
      candidates: classification.candidates,
    },
    null,
    2
  )
);

const invoiceHit = FRESH_OCR.slice(0, 3000).toLowerCase().includes("invoice");
console.log("\nfresh OCR head contains literal 'invoice'? ", invoiceHit);
