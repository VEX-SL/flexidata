import { readFileSync } from "node:fs";
import type { AIClient, RawExtraction } from "@/lib/pipeline/types";
import { applyDynamicSafetyGate } from "@/lib/pipeline/extractor/dynamic-gate";
import {
  candidatesFromAICall,
  extractDocument,
  parseRaw,
} from "@/lib/pipeline/extractor";
import { normalizeDynamicFields } from "@/lib/pipeline/extractor/normalizer";
import { buildDynamicPrompt } from "@/lib/pipeline/extractor/prompt-builder";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import { test, ok, equal, assert, includes } from "./harness.ts";

/**
 * M25 — dynamic safety gate. Deterministic post-AI filter for schema-free
 * extraction: drops fields that are ambiguous verbatim carve-outs of a single
 * OCR line (bidi-inverted mixed-script lines, broken fragments keyed from the
 * trailing segment) while preserving every valid dynamic field shape.
 */

const ARABIC_DOC = [
  "رقم الحساب : 391003452",
  "اسم العميل : محمد علي",
  "معلومات إضافية : Mobile Number",
  "Mobile Number : معلومات اضافيه",
  "المبلغ المطلوب : 68.38",
].join("\n");

const LATIN_DOC = [
  "Customer Name : John Smith",
  "Mobile Number : 0123456788",
  "Total : 100 SAR",
].join("\n");

function gated(fields: Record<string, unknown>, sourceText = ARABIC_DOC): Record<string, unknown> {
  const out = applyDynamicSafetyGate({ data: fields }, sourceText);
  return (out.data as Record<string, unknown>) ?? {};
}

function envelope(value: string, evidence: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    raw: value,
    value,
    type: "string",
    label: evidence.split(":")[0].trim(),
    confidence: 0.9,
    evidence,
    ...over,
  };
}

function fakeAI(content: string): AIClient {
  return {
    chatCompletion: async () => ({ content, model: "fake", provider: "test" }),
  };
}

const unknownProfile = () => getProfileManager().get("unknown")!;

/* ─── Gate unit tests ────────────────────────────────────────────────────── */

test("gate keeps a valid Arabic numeric field (label : digits)", () => {
  const out = gated({ "رقم الحساب": envelope("391003452", "رقم الحساب : 391003452") });
  ok("رقم الحساب" in out, "Arabic label with numeric value must survive");
});

test("gate keeps a valid English numeric field", () => {
  const out = gated(
    { "Mobile Number": envelope("0123456788", "Mobile Number : 0123456788") },
    LATIN_DOC
  );
  ok("Mobile Number" in out, "English label with phone value must survive");
});

test("gate keeps a valid English text field", () => {
  const out = gated(
    { "Customer Name": envelope("John Smith", "Customer Name : John Smith") },
    LATIN_DOC
  );
  ok("Customer Name" in out, "same-script leading-label line must survive");
});

test("gate keeps a valid Arabic text field", () => {
  const out = gated({ "اسم العميل": envelope("محمد علي", "اسم العميل : محمد علي") });
  ok("اسم العميل" in out, "Arabic label with Arabic name must survive");
});

test("gate keeps a valid mixed-script field with a clear relation (Arabic label)", () => {
  const out = gated({
    "معلومات إضافية": envelope("Mobile Number", "معلومات إضافية : Mobile Number"),
  });
  ok("معلومات إضافية" in out, "Arabic label + Latin value is the RTL-correct reading");
});

test("gate drops the confirmed SuperPay case A (bidi-inverted mixed line)", () => {
  const out = gated({
    "Mobile Number": envelope("معلومات اضافيه", "Mobile Number : معلومات اضافيه"),
  });
  assert(
    !("Mobile Number" in out),
    "Latin key on an Arabic-containing line with Arabic value is an unreliable carve-out"
  );
});

test("gate keeps the same carve in a Latin-dominant document (clear LTR relation)", () => {
  const out = gated(
    { "Mobile Number": envelope("معلومات اضافيه", "Mobile Number : معلومات اضافيه") },
    LATIN_DOC
  );
  ok("Mobile Number" in out, "in a Latin-dominant doc the leading label is the LTR reading");
});

test("gate drops the confirmed SuperPay case B (trailing-segment key on a Latin line)", () => {
  const out = gated(
    { il: envelope("oe a", "oe a : il") },
    LATIN_DOC
  );
  assert(!("il" in out), "a trailing-segment key on a pure-Latin line is a broken fragment");
});

test("gate keeps a bilingual English-label field in an Arabic-dominant document", () => {
  const out = gated(
    { "Customer Name": envelope("أحمد", "Customer Name : أحمد") },
    ARABIC_DOC
  );
  ok(
    "Customer Name" in out,
    "a Latin-heavy line keeps its clear LTR label even inside an Arabic document"
  );
});

test("gate boundary: a balanced line (arabicRatio = 0.5) drops only in an Arabic-dominant context", () => {
  const balanced = { "Name": envelope("أحمد", "Name : أحمد") };
  const ar = gated({ ...balanced }, ARABIC_DOC);
  assert(
    !("Name" in ar),
    "an exactly balanced mixed line in an Arabic document is bidi-ambiguous"
  );
  const la = gated({ ...balanced }, LATIN_DOC);
  ok(
    "Name" in la,
    "the same balanced line in a Latin document keeps its LTR label"
  );

  const below = gated(
    { "Names": envelope("أحمد", "Names : أحمد") },
    ARABIC_DOC
  );
  ok(
    "Names" in below,
    "a Latin-heavy line (ratio below 0.5) stays clear even in an Arabic document"
  );
});

test("gate keeps fields whose key is not printed in the evidence line", () => {
  const out = gated({
    "account number": envelope("391003452", "رقم الحساب : 391003452"),
    total: envelope("68.38", "المبلغ المطلوب : 68.38"),
  });
  ok("account number" in out, "coined key not printed in the line must survive");
  ok("total" in out, "coined key must survive");
});

test("gate preserves multi-line evidence (not a single-line carve-out)", () => {
  const out = gated({
    "Mobile Number": envelope(
      "معلومات اضافيه",
      "Mobile Number : معلومات اضافيه\nرقم الحساب : 391003452"
    ),
  });
  ok("Mobile Number" in out, "multi-line evidence is never treated as a carve-out");
});

test("gate compares the raw key before safeFieldKey normalization", () => {
  const raw: RawExtraction = {
    data: { "Mobile Number": envelope("معلومات اضافيه", "Mobile Number : معلومات اضافيه") },
  };
  const out = applyDynamicSafetyGate(raw, ARABIC_DOC);
  assert(
    !("Mobile Number" in (out.data as Record<string, unknown>)),
    "the raw key ('Mobile Number', with a space) must match the evidence verbatim"
  );
});

test("gate only fires on an exact two-half carve-out", () => {
  const junkPrefix = gated({
    "transaction number": envelope("6070218301132167", "() رقم التمليه : 6070218301132167"),
  });
  ok("transaction number" in junkPrefix, "prefix junk breaks the exact carve pattern");

  const colonValue = gated(
    { time: envelope("10:30", "time : 10:30") },
    LATIN_DOC
  );
  ok("time" in colonValue, "a colon inside the value is not a carve-out");
});

test("gate passes non-string and non-envelope entries through", () => {
  const out = gated({
    items: { raw: ["a"], value: ["a"], type: "array", confidence: 0.9 },
    note: "plain string",
    bare: 42,
  });
  ok("items" in out && "note" in out && "bare" in out, "non-carve entries survive");
});

test("gate passes fields without evidence through", () => {
  const out = gated({
    "no evidence": { raw: "x", value: "x", type: "string", confidence: 0.5 },
  });
  ok("no evidence" in out, "missing evidence cannot be a carve-out");
});

test("gate returns the same object when nothing is dropped", () => {
  const raw: RawExtraction = { data: { total: envelope("68.38", "المبلغ المطلوب : 68.38") } };
  equal(applyDynamicSafetyGate(raw, ARABIC_DOC), raw, "no-op must return the input untouched");
});

/* ─── Real-fixture regression (no LLM calls) ─────────────────────────────── */

function loadFixture(name: string): { rawAiContent: string; ocrText: string } {
  return JSON.parse(readFileSync(`tests/fixtures/${name}.json`, "utf8"));
}

const POSITIVE = loadFixture("superpay-dynamic");
const GARBAGE = loadFixture("superpay-dynamic-garbage");

const VALID_KEYS = [
  "رقم_انعمليه",
  "تاريخ_انتوقت",
  "رقم_الحساب",
  "انرقم_المرجقي",
  "رقم_العميل",
  "المبلغ_المطلوب",
];

test("fixture: real raw response keeps every valid field and drops the bidi-garbage duplicate", () => {
  const result = candidatesFromAICall(
    unknownProfile(),
    { content: POSITIVE.rawAiContent, model: "fixture", provider: "fixture" },
    "dynamic",
    POSITIVE.ocrText
  );

  for (const key of VALID_KEYS) {
    ok(key in result.fieldsMap, `valid field '${key}' must survive the gate`);
  }
  assert(
    !("isi_plat" in result.fieldsMap),
    "the bidi-garbage duplicate field 'ISI plat' (trailing Latin key) must be dropped"
  );
});

test("fixture: confirmed false-positive fields are dropped end-to-end with grounding", async () => {
  const result = await extractDocument(
    { profile: unknownProfile(), sourceText: GARBAGE.ocrText, extractionMode: "dynamic" },
    fakeAI(GARBAGE.rawAiContent)
  );

  for (const key of VALID_KEYS) {
    equal(
      key in result.cleanFields,
      true,
      `valid field '${key}' must survive grounding`
    );
  }
  assert(
    !("mobile_number" in result.cleanFields),
    "'Mobile Number' field must be dropped by the gate, never committed"
  );
  assert(
    !("il" in result.cleanFields),
    "'il' field must be dropped by the gate, never committed"
  );
  assert(
    !("isi_plat" in result.cleanFields),
    "'ISI plat' garbage duplicate must be dropped"
  );
});

test("fixture: without the gate the false-positive fields would have been committed", () => {
  const raw = parseRaw(GARBAGE.rawAiContent);
  const ungated = normalizeDynamicFields(unknownProfile(), raw);
  ok(
    "mobile_number" in ungated && "il" in ungated,
    "precondition: the garbage members normalize cleanly — grounding alone would anchor them, so the drop is the gate's work"
  );
});

test("recover/retry path runs the same gate on its candidates", () => {
  // Dynamic mode skips the recover stage entirely (recover.ts skips discovery
  // mode), so the retry arm's candidate construction (recover.ts) shares this
  // exact call shape: candidatesFromAICall(profile, aiCall, mode, documentText).
  // A garbage-bearing retry response must be filtered the same way as the
  // main extraction response.
  const retryPayload = JSON.stringify({
    data: {
      "رقم العميل": envelope("0640833767", "رقم العميل : 0640833767"),
      "Mobile Number": envelope("معلومات اضافيه", "Mobile Number : معلومات اضافيه"),
      il: envelope("oe a", "oe a : il"),
    },
  });

  const retryCandidates = candidatesFromAICall(
    unknownProfile(),
    { content: retryPayload, model: "m2", provider: "cerebras" },
    "dynamic",
    POSITIVE.ocrText
  );

  ok(
    "رقم_العميل" in retryCandidates.fieldsMap,
    "valid field from the retry response survives"
  );
  assert(
    !("mobile_number" in retryCandidates.fieldsMap),
    "gate drops 'Mobile Number' from the retry response"
  );
  assert(
    !("il" in retryCandidates.fieldsMap),
    "gate drops 'il' from the retry response"
  );
});

/* ─── Layer 1 prompt hardening ───────────────────────────────────────────── */

test("dynamic prompt carries the Layer 1 label/ambiguity rules", () => {
  const p = buildDynamicPrompt(LATIN_DOC);
  includes(p, "semantic category");
  includes(p, "RTL bidi");
  includes(p, "plausibly compatible");
  includes(p, "broken or garbled OCR snippets");
  includes(p, "field discovery");
  assert(!p.includes("{{schema}}"), "no {{schema}} placeholder in the dynamic prompt");
});
