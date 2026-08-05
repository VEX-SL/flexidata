/**
 * READ-ONLY probe: what does the DB row actually store for the OCR Preview,
 * and does that match what the UI renders?
 *
 * Reads the exact extraction the user re-tested and reports:
 *   - pipeline_version (contract version of the row)
 *   - whether ocr_json (the structured preview source) exists and what its
 *     first line looks like
 *   - whether source_text (the fallback preview source) carries RTL/bidi
 *     artifacts (raw) or is bidi-free (repaired)
 *   - the bidi-marker and fragment presence of both columns
 */
import { readFileSync } from "node:fs";
import { createAdminClient } from "@/lib/supabase/admin";

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

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

const { data } = await createAdminClient()
  .from("extractions")
  .select("id, pipeline_version, source_text, ocr_json, created_at")
  .eq("id", "356a6586-9ccc-4b4d-9ebd-43cd0d717fa7")
  .eq("user_id", "5fa261e2-b639-4b61-9d51-a7ebeea04f8b")
  .single();

const row = data;
const src = String(row.source_text ?? "");
const ocr = row.ocr_json as { lines?: Array<{ text: string }> } | null;
const ocrLines = Array.isArray(ocr?.lines) ? ocr.lines : [];

console.log("row:", JSON.stringify({
  pipeline_version: row.pipeline_version,
  created_at: row.created_at,
  ocr_json_lines: ocrLines.length,
  source_text_chars: src.length,
}));

if (ocrLines.length > 0) {
  console.log("ocr_json.lines[0..3]:", JSON.stringify(ocrLines.slice(0, 4).map((l) => l.text), null, 1));
  const firstBidi = ocrLines.findIndex((l) => BIDI.test(l.text));
  console.log("ocr_json first line with bidi marks:", firstBidi);
  console.log("ocr_json has merged 'gh \\u200f\\u0642...' artifact:", ocrLines.some((l) => /gh/.test(l.text) && /[\u0600-\u06ff]/.test(l.text) && BIDI.test(l.text)));
} else {
  console.log("ocr_json: ABSENT (no structured preview; UI falls back to source_text)");
}

console.log("source_text bidi markers present (raw):", BIDI.test(src));
console.log("source_text line0:", JSON.stringify(src.split("\n")[0]));
console.log("source_text contains 'ذا 15468':", src.includes("\u0630\u0627 15468"));
console.log("source_text contains merged gh+arabic line:", /gh/.test(src) && BIDI.test(src));

// What the UI renders, exactly, for this row (mirror of OCRPreview logic):
const hasLines = ocrLines.length > 0;
const preview = hasLines
  ? ocrLines.map((l) => l.text)
  : String(row.source_text ?? "").split("\n");
console.log("\nUI OCRPreview for this row ->", hasLines ? "structured ocr.lines" : "fallback source_text");
console.log("preview line 0:", JSON.stringify(preview[0]));
console.log("preview lines 1..3:", JSON.stringify(preview.slice(1, 4)));
