/**
 * Investigation probe kept for reference: raw-vs-preprocessed OCR on the real
 * SuperPay photo. Superseded by the committed runners (run-ocr-level.ts /
 * run-pipeline-level.ts) which serialize results into benchmarks/results/.
 */
import { readFileSync } from "node:fs";
import { recognizeMainThread } from "@/lib/tesseract-main";
import { preprocessBuffer, canvasFromImage, decodeToRgba } from "@/lib/ocr/preprocess";

const bytes = readFileSync("benchmarks/real/db51e106-608b-44a9-9e0c-681bb45aeb78.jpg");

for (const [label, pre] of [["raw", false], ["pre", true]] as const) {
  const doc = await recognizeMainThread(bytes, "eng+ara", { preprocess: pre });
  console.log(`\n===== ${label} =====`);
  console.log("page conf:", doc.confidence, "| lines:", doc.lines.length, "| chars:", doc.text.replace(/\s+/g, "").length);
  console.log(doc.text);
  console.log("--- per-line confs:", doc.lines.map((l) => (l.confidence ?? 0).toFixed(2)).join(", "));
}

// Inspect the preprocessed image stats
const img = await decodeToRgba(bytes);
const pre = await preprocessBuffer(bytes, "photo");
console.log("\npre dims:", pre.width, "x", pre.height, "orig:", img.width, "x", img.height);
