/**
 * READ-ONLY diagnostic: trace the real extraction pipeline end-to-end for the
 * receipt the user re-tested, WITHOUT persisting anything and WITHOUT calling
 * the LLM twice (the instrumented client captures the exact request/response
 * the pipeline actually makes).
 *
 * Dumps:
 *  1. the stored source_text (the exact OCR the extractor received)
 *  2. a fresh OCR pass on the same uploaded file for comparison
 *  3. the exact classifier prompt + raw JSON answer
 *  4. the exact extraction prompt + raw JSON answer
 *  5. the parsed raw extraction, the normalized candidates, and the
 *     total_amount candidate specifically
 *  6. an exact re-implementation of the grounding evidence search for
 *     total_amount (same normalizeText needles / derived variants)
 *  7. the final grounded fields, dropped fields, validation, confidence
 *  8. the date line analysis (raw printed value vs normalized value)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseFileBufferDetailed } from "@/lib/file-parser";
import { runPipeline } from "@/lib/pipeline/defaults";
import { getProviderManager } from "@/lib/ai/manager";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import { parseRaw } from "@/lib/pipeline/extractor";
import { normalizeFields } from "@/lib/pipeline/extractor/normalizer";
import { groundExtraction } from "@/lib/pipeline/extractor/grounding";
import { normalizeText, unifyDigits } from "@/lib/pipeline/ocr";
import {
  detectLabelGroup,
  labelGroupForField,
} from "@/lib/pipeline/extractor/label-lexicon";
import type { AIClient } from "@/lib/pipeline/types";
import type { AIRequest, AIResponse } from "@/types";
import type { ExtractionProfile } from "@/lib/pipeline/types";

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

const userId = "5fa261e2-b639-4b61-9d51-a7ebeea04f8b";
const supabase = createAdminClient();

const section = (t: string) => console.log(`\n${"=".repeat(72)}\n${t}\n${"=".repeat(72)}`);
const report: Record<string, unknown> = {};
const save = (key: string, value: unknown) => {
  report[key] = value;
  console.log("\n--- " + key + " ---");
  console.log(JSON.stringify(value, null, 2));
};

// ── 0. Locate the document the user re-tested ─────────────────────────────
section("STEP 0 — RECENT EXTRACTIONS (identify the current runtime result)");
const { data: recent } = await supabase
  .from("extractions")
  .select("id, file_id, profile_type, status, overall_confidence, model, provider, created_at")
  .eq("user_id", userId)
  .order("created_at", { ascending: false })
  .limit(10);
save("recent_extractions", recent ?? []);

const target = (recent ?? []).find(
  (r) => r.status === "complete" && r.file_id && r.profile_type === "receipt"
);
if (!target) throw new Error("No completed receipt extraction found");
console.log("target extraction:", JSON.stringify(target));

const { data: full } = await supabase
  .from("extractions")
  .select("*")
  .eq("id", target.id)
  .eq("user_id", userId)
  .single();
save("stored_extraction_row", {
  id: full.id,
  file_id: full.file_id,
  profile_type: full.profile_type,
  overall_confidence: full.overall_confidence,
  model: full.model,
  provider: full.provider,
  validation: full.validation_json,
  confidence: full.confidence_json,
  fields: full.fields_json,
  pipeline_version: full.pipeline_version,
  completed_at: full.completed_at,
});

// ── 1. Exact OCR the extractor received (stored source_text) ──────────────
section("STEP 1 — STORED source_text (the exact OCR the extractor received)");
const sourceText: string = full.source_text ?? "";
save("stored_source_text_verbatim", sourceText);
const linesOf = sourceText.split("\n");
console.log("\n-- stored source_text with line numbers --");
linesOf.forEach((l, i) => console.log(`${String(i).padStart(2)}| ${l}`));

// ── 2. Fresh OCR of the same uploaded file (comparison) ───────────────────
section("STEP 2 — FRESH OCR PASS ON THE UPLOADED FILE");
const { data: file } = await supabase
  .from("files")
  .select("id, name, url, mime_type, original_name")
  .eq("id", target.file_id)
  .eq("user_id", userId)
  .single();
console.log("file row:", JSON.stringify(file));
const { data: blob } = await supabase.storage.from("files").download(file.name);
const buffer = Buffer.from(await blob.arrayBuffer());
console.log("downloaded bytes:", buffer.length);
const parsed = await parseFileBufferDetailed(buffer, file.mime_type, file.original_name);
save("fresh_ocr", {
  text: parsed.text,
  pageConfidence: parsed.ocr?.confidence ?? null,
  language: parsed.ocr?.language ?? null,
  lineCount: parsed.ocr?.lines.length ?? null,
});
console.log("\n-- fresh OCR text --\n" + parsed.text + "\n-- end --");

// The pipeline run below uses the STORED source_text (matches the user's run).
const ocrDoc = parsed.ocr;

// ── 3. Instrumented pipeline run ──────────────────────────────────────────
section("STEP 3 — INSTRUMENTED PIPELINE RUN (captures every LLM call)");
interface CapturedCall {
  stage: string;
  request: AIRequest;
  response: AIResponse;
}
const calls: CapturedCall[] = [];
const wrapped: AIClient = {
  async chatCompletion(request: AIRequest): Promise<AIResponse> {
    const response = await getProviderManager().chatCompletion(request);
    calls.push({ stage: "?", request, response });
    return response;
  },
};

const out = await runPipeline(
  { sourceText, ocr: ocrDoc, fileName: file.original_name, mimeType: file.mime_type },
  { ai: wrapped }
);

// Tag each captured call by its prompt shape.
for (const c of calls) {
  const userMsg = c.request.messages.find((m) => m.role === "user")?.content ?? "";
  c.stage = userMsg.includes("Classify this document into exactly one type")
    ? "classify"
    : userMsg.includes("STRICT OUTPUT FORMAT")
      ? "extract"
      : "other";
}

for (const c of calls) {
  section(`STEP 3.${calls.indexOf(c) + 1} — CAPTURED LLM CALL: ${c.stage}`);
  save(`llm_call_${c.stage}_request`, {
    provider: c.response.provider,
    model: c.response.model,
    messages: c.request.messages,
    maxTokens: c.request.maxTokens,
    temperature: c.request.temperature,
  });
  save(`llm_call_${c.stage}_raw_response`, c.response.content);
}

const extractCall = calls.find((c) => c.stage === "extract");
const classifyCall = calls.find((c) => c.stage === "classify");
if (!extractCall) throw new Error("extraction call not captured");

// ── 4. Raw extraction parse + candidates ──────────────────────────────────
section("STEP 4 — RAW LLM EXTRACTION → PARSED → NORMALIZED CANDIDATES");
const raw: ReturnType<typeof parseRaw> = parseRaw(extractCall.response.content ?? "");
save("parsed_raw_extraction", raw);

const classification = out.job!.classification;
const profile = getProfileManager().getOrFallback(classification.profileType);
const candidates = normalizeFields(profile, raw);
save("normalized_candidates_all_fields", candidates);

section("STEP 4.1 — total_amount candidate");
const totalField = profile.schema.fields.find((f) => f.key === "total_amount")!;
const totalCandidate = candidates.total_amount;
save("total_amount_candidate", totalCandidate ?? { present: false, reason: "model did not return total_amount (absent or null)" });

section("STEP 4.2 — receipt_date candidate");
const dateCandidate = candidates.receipt_date;
save("receipt_date_candidate", dateCandidate ?? { present: false });

// ── 5. Grounding evidence mirror for total_amount ─────────────────────────
section("STEP 5 — GROUNDING EVIDENCE SEARCH FOR total_amount (exact mirror of grounding.ts)");
// Mirror of grounding.ts valueNeedles/findEvidence/findDerivedEvidence.
function valueNeedles(field: { type: string }, fv: { rawValue?: unknown; value: unknown }): string[] {
  const r = fv.rawValue !== undefined && fv.rawValue !== null ? fv.rawValue : fv.value;
  if (typeof r === "string") return r.trim() ? [r] : [];
  if (typeof r === "number") return [String(r)];
  return [];
}
function findEvidenceMirror(
  lines: Array<{ text: string }>,
  needles: string[]
): Array<{ lineIndex: number; line: string; role: string }> {
  const out: Array<{ lineIndex: number; line: string; role: string }> = [];
  const seen = new Set<string>();
  for (const needle of needles) {
    const norm = normalizeText(needle);
    if (!norm) continue;
    for (let i = 0; i < lines.length; i++) {
      if (normalizeText(lines[i].text).includes(norm)) {
        const key = `${i}:value-match`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ lineIndex: i, line: lines[i].text, role: "value-match" });
        }
      }
    }
  }
  return out;
}
function dateVariants(iso: string): string[] {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [];
  const [, y, mo, d] = m;
  const out = new Set<string>();
  for (const sep of ["-", "/", "."]) {
    out.add(`${d}${sep}${mo}${sep}${y}`);
    out.add(`${Number(d)}${sep}${Number(mo)}${sep}${y}`);
  }
  out.add(`${d}${mo}${y}`);
  return Array.from(out);
}
const ocrLines = ocrDoc?.lines ?? linesOf.map((text) => ({ text }));

if (totalCandidate) {
  const needles = valueNeedles(totalField, totalCandidate);
  const ev = findEvidenceMirror(ocrLines, needles);
  save("total_amount_evidence_value_match", { needles, matches: ev });
  const derived: string[] = [];
  if (typeof totalCandidate.value === "number") {
    derived.push(normalizeText(Number(totalCandidate.value).toLocaleString("en-US")));
  }
  const derEv = findEvidenceMirror(ocrLines, derived.filter(Boolean));
  save("total_amount_evidence_derived", { derived, matches: derEv });
  for (const e of ev) {
    const g = detectLabelGroup(e.line);
    console.log(`  line ${e.lineIndex} [${e.role}] labelGroup=${g} :: ${e.line}`);
  }
} else {
  console.log("  (no candidate — evidence search skipped; see STEP 4.1)");
}

section("STEP 5.1 — what the grounding STAGE decided (from the real pipeline run)");
save("grounded_final_fields", out.job!.extraction.fields.map((f) => ({
  key: f.field.key,
  value: f.value.value,
  raw: f.value.rawValue,
  confidence: f.value.confidence,
  source: f.value.source,
  status: f.value.status,
  evidence: f.value.evidence,
})));
save("grounded_dropped_fields", out.job!.extraction.droppedFields);

// ── 6. Grounding pass 3 reason for total_amount specifically ──────────────
section("STEP 6 — WHY total_amount IS ABSENT (replaying groundExtraction)");
const candidatesResult = {
  profileType: profile.id,
  profileVersion: profile.version,
  fields: profile.schema.fields
    .filter((f) => candidates[f.key])
    .map((f) => ({ field: f, value: candidates[f.key] })),
  fieldsMap: candidates,
  cleanFields: Object.fromEntries(
    Object.entries(candidates)
      .filter(([, v]) => v && !isEmpty(v.value))
      .map(([k, v]) => [k, v.value])
  ),
  droppedFields: {},
};
const grounded = groundExtraction(profile, candidatesResult as never, sourceText, ocrDoc);
save("grounded_extraction_total_amount", {
  inCandidates: Boolean(candidates.total_amount),
  candidateValue: candidates.total_amount?.value ?? null,
  groundedValue: grounded.fieldsMap.total_amount?.value ?? null,
  droppedReason: grounded.droppedFields.total_amount ?? "not dropped (present)",
});
console.log("  droppedFields (full):", JSON.stringify(grounded.droppedFields));

// ── 7. Validation + confidence ────────────────────────────────────────────
section("STEP 7 — VALIDATION + OVERALL CONFIDENCE");
save("validation", out.job!.validation);
save("confidence", out.job!.confidence);
save("stage_trace", out.trace);

// ── 8. Date analysis ──────────────────────────────────────────────────────
section("STEP 8 — DATE LINE ANALYSIS");
const dateLike = linesOf
  .map((l, i) => ({ i, l }))
  .filter(({ l }) => /\d{1,2}[\/-]\d{1,2}[\/-]\d{4}/.test(l));
save("date_lines_in_stored_text", dateLike.map((d) => ({ lineIndex: d.i, line: d.l, normalized: normalizeText(d.l), labelGroup: detectLabelGroup(d.l) })));

if (dateCandidate) {
  const rawDate = dateCandidate.rawValue;
  const valueDate = dateCandidate.value;
  save("receipt_date_normalization", {
    rawFromModel: rawDate,
    valueFromModel: valueDate,
    variantsThatWouldMatch: typeof valueDate === "string" ? dateVariants(valueDate) : [],
  });
}

save("provider_order", getProviderManager()
  // @ts-expect-error introspection of provider order for the report
  .providers.map((p) => p.name));

const outPath = resolve("C:/Users/dell/AppData/Local/Temp/opencode/trace-extraction-e2e.json");
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
console.log(`\n[done] full report written to ${outPath}`);

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}
