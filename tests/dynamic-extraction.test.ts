import type { AIClient, RawExtraction } from "@/lib/pipeline/types";
import { extractDocument, candidatesFromAICall } from "@/lib/pipeline/extractor";
import { buildDynamicPrompt } from "@/lib/pipeline/extractor/prompt-builder";
import {
  normalizeDynamicFields,
} from "@/lib/pipeline/extractor/normalizer";
import { safeFieldKey } from "@/lib/pipeline/extractor/dynamic";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import { test, ok, equal, assert, includes } from "./harness.ts";

function fakeAI(content: string): AIClient {
  return {
    chatCompletion: async () => ({ content, model: "fake", provider: "test" }),
  };
}

const DOC = [
  "Account Number: 12345",
  "Name: John Smith",
  "Total: 100 SAR",
  "",
].join("\n");

const DYNAMIC = JSON.stringify({
  data: {
    "account number": {
      raw: "12345",
      value: 12345,
      type: "number",
      label: "Account Number",
      confidence: 0.9,
      evidence: "Account Number: 12345",
    },
    "customer name": {
      raw: "John Smith",
      value: "John Smith",
      type: "string",
      label: "Customer Name",
      confidence: 0.8,
      evidence: "Name: John Smith",
    },
    total: {
      raw: "100 SAR",
      value: "100 SAR",
      type: "currency",
      label: "Total",
      confidence: 0.7,
      evidence: "Total: 100 SAR",
    },
  },
});

test("dynamic prompt has no schema and no leftover {{schema}} placeholder", () => {
  const profile = getProfileManager().get("invoice");
  ok(profile, "invoice profile must be registered");
  const p = buildDynamicPrompt(DOC);

  includes(p, "Account Number: 12345");
  includes(p, "field discovery");
  assert(!p.includes("{{schema}}"), "no {{schema}} placeholder in dynamic prompt");
  assert(
    !p.includes(JSON.stringify(profile!.schema)),
    "profile schema must NOT be injected into the dynamic prompt"
  );
});

test("safeFieldKey normalizes to deterministic snake_case and blocks dangerous names", () => {
  equal(safeFieldKey("Account Number"), "account_number");
  equal(safeFieldKey("invoiceNumber"), "invoice_number");
  equal(safeFieldKey("Total"), "total");
  equal(safeFieldKey("  "), "");
  equal(safeFieldKey(""), "");
  equal(safeFieldKey("constructor"), "");
  equal(safeFieldKey("__proto__"), "");
  equal(safeFieldKey("toString"), "");
  equal(safeFieldKey("hasOwnProperty"), "");
});

test("dynamic candidates preserve every discovered field under a safe key", () => {
  const profile = getProfileManager().get("invoice");
  const result = candidatesFromAICall(
    profile!,
    { content: DYNAMIC, model: "fake", provider: "test" },
    "dynamic"
  );

  const keys = Object.keys(result.fieldsMap);
  ok(keys.includes("account_number"), "arbitrary discovered field preserved");
  ok(keys.includes("customer_name"), "camel-cased AI label safely keyed");
  ok(keys.includes("total"), "schema-like discovered key preserved");

  const account = result.fieldsMap.account_number;
  equal(account.value, 12345);
  equal(account.rawValue, "12345");
  ok(account.meta && account.meta.dynamicType === "number", "AI type kept on meta");
  ok(account.meta && account.meta.dynamicLabel === "Account Number", "AI label kept");
  equal(account.confidence, 0.9);
});

test("dynamic normalization never pollutes Object.prototype", () => {
  const profile = getProfileManager().get("invoice");
  const raw: RawExtraction = {
    data: {
      "Account Number": { raw: "1", value: "1" },
      "__proto__": { raw: "x", value: "x" },
      constructor: "y",
      "toString": "z",
    },
  };

  const map = normalizeDynamicFields(profile!, raw);

  const keys = Object.keys(map);
  equal(keys, ["account_number"]);
  equal(({} as Record<string, unknown>).polluted, undefined, "no pollution");
  equal(({}.constructor as unknown), Object, "constructor intact");
});

test("dynamic extraction end-to-end: grounded discovered fields survive", async () => {
  const profile = getProfileManager().get("invoice");
  const result = await extractDocument(
    { profile: profile!, sourceText: DOC, extractionMode: "dynamic" },
    fakeAI(DYNAMIC)
  );

  equal(result.cleanFields.account_number, 12345);
  equal(result.cleanFields.customer_name, "John Smith");
  equal(result.cleanFields.total, "100 SAR");
  ok(
    result.fieldsMap.total.evidence && result.fieldsMap.total.evidence.length > 0,
    "discovered field anchored to OCR evidence"
  );
});

test("dynamic extraction drops invented values grounding cannot anchor", async () => {
  const profile = getProfileManager().get("invoice");
  const invented = JSON.stringify({
    data: {
      balance: {
        raw: "999999",
        value: "999999",
        type: "string",
        label: "Balance",
        confidence: 0.95,
        evidence: "Account Number: 12345",
      },
    },
  });

  const result = await extractDocument(
    { profile: profile!, sourceText: DOC, extractionMode: "dynamic" },
    fakeAI(invented)
  );

  equal(result.droppedFields.balance, "not found in source text");
  assert(!("balance" in result.cleanFields), "invented value must be dropped");
});

test("dynamic extraction preserves values as-is (no meaning inferred)", async () => {
  const profile = getProfileManager().get("invoice");
  const asIs = JSON.stringify({
    data: {
      "reference date": {
        raw: "02-07-2028",
        value: "02-07-2028",
        type: "date",
        label: "Reference Date",
        confidence: 0.9,
        evidence: "Reference Date: 02-07-2028",
      },
    },
  });

  const result = await extractDocument(
    { profile: profile!, sourceText: "Reference Date: 02-07-2028", extractionMode: "dynamic" },
    fakeAI(asIs)
  );

  equal(
    result.cleanFields.reference_date,
    "02-07-2028",
    "value preserved as printed, not rewritten to ISO"
  );
});
