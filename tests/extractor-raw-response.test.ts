import type { AIClient, ExtractionProfile } from "@/lib/pipeline/types";
import {
  extractDocument,
  candidatesFromAICall,
} from "@/lib/pipeline/extractor";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import { test, ok, equal, assert } from "./harness.ts";

function fakeAI(content: string): AIClient {
  return {
    chatCompletion: async () => ({ content, model: "fake-model", provider: "fake-provider" }),
  };
}

const TEST_DOC = [
  "Account Number: 12345",
  "Name: John Smith",
  "Total: 100 SAR",
  "",
].join("\n");

const DYNAMIC_RESPONSE = JSON.stringify({
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

const LEGACY_RESPONSE = JSON.stringify({
  data: {
    invoice_number: {
      raw: "INV-001",
      value: "INV-001",
      confidence: 0.9,
      evidence: "Invoice Number: INV-001",
    },
    invoice_date: {
      raw: "2024-01-15",
      value: "2024-01-15",
      confidence: 0.9,
      evidence: "Date: 2024-01-15",
    },
  },
});

test("candidatesFromAICall captures raw AI response in dynamic mode", () => {
  const profile = getProfileManager().get("invoice");
  ok(profile, "invoice profile must be registered");

  const result = candidatesFromAICall(profile!, DYNAMIC_RESPONSE, "dynamic");

  ok(result.rawAIResponse, "rawAIResponse must be present");
  equal(result.rawAIResponse, DYNAMIC_RESPONSE, "rawAIResponse must equal the AI call content");
  equal(result.model, "fake-model", "model must be preserved");
  equal(result.provider, "fake-provider", "provider must be preserved");
});

test("candidatesFromAICall captures raw AI response in legacy mode", () => {
  const profile = getProfileManager().get("invoice");
  ok(profile, "invoice profile must be registered");

  const result = candidatesFromAICall(profile!, LEGACY_RESPONSE, "legacy");

  ok(result.rawAIResponse, "rawAIResponse must be present");
  equal(result.rawAIResponse, LEGACY_RESPONSE, "rawAIResponse must equal the AI call content");
  equal(result.model, "fake-model", "model must be preserved");
  equal(result.provider, "fake-provider", "provider must be preserved");
});

test("extractDocument returns raw AI response when grounded=false (dynamic)", async () => {
  const profile = getProfileManager().get("invoice");
  ok(profile, "invoice profile must be registered");

  const result = await extractDocument(
    { profile: profile!, sourceText: TEST_DOC, extractionMode: "dynamic" },
    fakeAI(DYNAMIC_RESPONSE),
    { grounded: false }
  );

  ok(result.rawAIResponse, "rawAIResponse must be present in ungrounded result");
  equal(result.rawAIResponse, DYNAMIC_RESPONSE, "rawAIResponse must equal the AI call content");
});

test("extractDocument returns raw AI response when grounded=false (legacy)", async () => {
  const profile = getProfileManager().get("invoice");
  ok(profile, "invoice profile must be registered");

  const result = await extractDocument(
    { profile: profile!, sourceText: TEST_DOC, extractionMode: "legacy" },
    fakeAI(LEGACY_RESPONSE),
    { grounded: false }
  );

  ok(result.rawAIResponse, "rawAIResponse must be present in ungrounded result");
  equal(result.rawAIResponse, LEGACY_RESPONSE, "rawAIResponse must equal the AI call content");
});

test("extractDocument returns raw AI response after grounding (dynamic)", async () => {
  const profile = getProfileManager().get("invoice");
  ok(profile, "invoice profile must be registered");

  const result = await extractDocument(
    { profile: profile!, sourceText: TEST_DOC, extractionMode: "dynamic" },
    fakeAI(DYNAMIC_RESPONSE),
    { grounded: true }
  );

  ok(result.rawAIResponse, "rawAIResponse must be present after grounding");
  equal(result.rawAIResponse, DYNAMIC_RESPONSE, "rawAIResponse must equal the AI call content");
});

test("extractDocument returns raw AI response after grounding (legacy)", async () => {
  const profile = getProfileManager().get("invoice");
  ok(profile, "invoice profile must be registered");

  const result = await extractDocument(
    { profile: profile!, sourceText: TEST_DOC, extractionMode: "legacy" },
    fakeAI(LEGACY_RESPONSE),
    { grounded: true }
  );

  ok(result.rawAIResponse, "rawAIResponse must be present after grounding");
  equal(result.rawAIResponse, LEGACY_RESPONSE, "rawAIResponse must equal the AI call content");
});