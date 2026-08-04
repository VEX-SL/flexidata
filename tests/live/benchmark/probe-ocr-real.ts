/**
 * Investigation probe kept for reference: preprocessed OCR on the real
 * SuperPay photo with per-line confidence. Superseded by the committed
 * runners (run-ocr-level.ts / run-pipeline-level.ts).
 */
import { readFileSync } from "node:fs";
import { recognizeMainThread } from "@/lib/tesseract-main";
import { decodeToRgba } from "@/lib/ocr/preprocess";

const bytes = readFileSync("benchmarks/real/db51e106-608b-44a9-9e0c-681bb45aeb78.jpg");
const img = await decodeToRgba(bytes);
console.log("dims:", img.width, "x", img.height);

const doc = await recognizeMainThread(bytes, "eng+ara", { preprocess: true });
console.log("page conf:", doc.confidence, "lines:", doc.lines.length);
console.log("--- TEXT ---");
console.log(doc.text.slice(0, 1200));
console.log("--- first 6 lines w/ conf ---");
for (const l of doc.lines.slice(0, 6)) console.log((l.confidence ?? 0).toFixed(2), "|", l.text);
