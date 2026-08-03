import type { AIClient } from "@/lib/pipeline/types";
import { runPipeline } from "@/lib/pipeline/defaults";
import { test, ok, equal, assert } from "./harness.ts";
import { SUPERYPAY_RECEIPT_OCR } from "./fixtures/receipt-ocr.ts";

interface FakeAI extends AIClient {
  chatCalls: number;
  retryCalls: Array<{ skip: string[] }>;
}

/** Fake AIClient: returns `model1` for the main call, `retry` when rotated. */
function makeAI(model1: string, retry?: string): FakeAI {
  const ai: FakeAI = {
    chatCalls: 0,
    retryCalls: [],
    async chatCompletion() {
      ai.chatCalls += 1;
      return { content: model1, model: "m1", provider: "groq" };
    },
    async retryProviders(_request, skip) {
      ai.retryCalls.push({ skip: [...skip] });
      if (!retry) throw new Error("retryProviders called but no retry payload");
      return { content: retry, model: "m2", provider: "cerebras" };
    },
  };
  return ai;
}

async function runReceipt(ai: AIClient, sourceText: string) {
  const out = await runPipeline({ sourceText, profileType: "receipt" }, { ai });
  ok(out.status === "complete", `pipeline must complete: ${JSON.stringify(out.error)}`);
  return out.job!;
}

const EMPTY = JSON.stringify({ data: {} });

/** Retry payload resolving merchant_name against the SuperPay OCR (grounded). */
const MERCHANT_RETRY = JSON.stringify({
  data: {
    merchant_name: {
      raw: "SuperPay",
      value: "SuperPay",
      confidence: 0.9,
      evidence: "SuperPay",
    },
  },
});

test("recovery stage is part of the default pipeline", async () => {
  const ai = makeAI(EMPTY, MERCHANT_RETRY);
  const out = await runPipeline(
    { sourceText: SUPERYPAY_RECEIPT_OCR, profileType: "receipt" },
    { ai }
  );
  ok(out.trace.some((t) => t.stage === "recover"), "recover stage must run");
});

test("single grounded candidate → total_amount flagged from OCR", async () => {
  const ai = makeAI(EMPTY, MERCHANT_RETRY);
  const job = await runReceipt(ai, SUPERYPAY_RECEIPT_OCR);

  const total = job.extraction.fieldsMap.total_amount;
  ok(total, "total_amount must be recovered");
  equal(total!.value, 68.38);
  equal(total!.source, "ocr");
  equal(total!.status, "flagged");
  ok(total!.confidence < 0.5, "flagged confidence must stay low");
  ok(total!.confidence > 0.3, "flagged confidence must stay above the drop threshold");
  ok(
    total!.evidence!.some((e) => e.lineIndex === 16),
    "evidence must anchor the العلى total line"
  );
  ok(
    !job.validation.missing.includes("total_amount"),
    "flagged total_amount must not be reported missing"
  );
  // The retry (for other unresolved required fields) must never overwrite a
  // recovery-flagged value.
  equal(ai.retryCalls.length, 1, "retry runs once for the merchant field");
  equal(job.extraction.fieldsMap.total_amount.status, "flagged");
});

test("several distinct candidates → ambiguous with alternatives, never retried", async () => {
  const doc = "Receipt\nTotal: 68.38\nGrand total: 55.00\n";
  // Retry would resolve total_amount if it were retried — it must not be.
  const retryPayload = JSON.stringify({
    data: {
      total_amount: {
        raw: "68.38",
        value: 68.38,
        confidence: 0.9,
        evidence: "Total: 68.38",
      },
    },
  });
  const ai = makeAI(EMPTY, retryPayload);
  const job = await runReceipt(ai, doc);

  const total = job.extraction.fieldsMap.total_amount;
  ok(total, "total_amount must be present as ambiguous");
  equal(total!.status, "ambiguous");
  equal(total!.value, null);
  equal(total!.alternatives, [68.38, 55]);
  ok(
    job.validation.missing.includes("total_amount"),
    "ambiguous total_amount stays unresolved for the reviewer"
  );
  equal(ai.retryCalls.length, 1, "retry runs once for the other missing fields");
});

test("no candidate + model null → cross-provider retry fills the field", async () => {
  const doc = "RECEIPT\nالمبلغ : 55.00\n";
  const retryPayload = JSON.stringify({
    data: {
      total_amount: {
        raw: "55.00",
        value: 55,
        confidence: 0.9,
        evidence: "المبلغ : 55.00",
      },
    },
  });
  const ai = makeAI(EMPTY, retryPayload);
  const job = await runReceipt(ai, doc);

  equal(ai.retryCalls.length, 1, "retry must run once");
  ok(ai.retryCalls[0].skip.includes("groq"), "retry must skip the first provider");
  equal(job.extraction.provider, "cerebras");

  const total = job.extraction.fieldsMap.total_amount;
  ok(total, "total_amount must be committed by the retry");
  equal(total!.value, 55);
  equal(total!.source, "ai");
  ok(!job.validation.missing.includes("total_amount"), "retried field no longer missing");
});

test("model value dropped by strict grounding → never retried for that field", async () => {
  // Model1 invents total 9.99 (dropped: not in the document). The retry would
  // commit a grounded 8.88 if the field were retried — it must not be, because
  // the strict-grounding verdict ("not in document") is final.
  const doc = "RECEIPT\nMerchant: ACME\n8.88\n";
  const model1 = JSON.stringify({
    data: {
      total_amount: {
        raw: "9.99",
        value: 9.99,
        confidence: 0.9,
        evidence: "Total: 9.99",
      },
    },
  });
  const retryPayload = JSON.stringify({
    data: {
      total_amount: {
        raw: "8.88",
        value: 8.88,
        confidence: 0.9,
        evidence: "8.88",
      },
    },
  });
  const ai = makeAI(model1, retryPayload);
  const job = await runReceipt(ai, doc);

  equal(ai.retryCalls.length, 1, "retry fires only for the other missing fields");
  ok(!job.extraction.fieldsMap.total_amount, "grounding-dropped total_amount stays dropped");
  ok(
    /not found in source text/.test(job.extraction.droppedFields.total_amount ?? ""),
    "drop reason must be preserved"
  );
  ok(job.validation.missing.includes("total_amount"));
});

test("date recovery flags the printed value — never auto-corrects 2028 to 2026", async () => {
  const ai = makeAI(EMPTY, EMPTY);
  const job = await runReceipt(ai, SUPERYPAY_RECEIPT_OCR);

  const date = job.extraction.fieldsMap.receipt_date;
  ok(date, "receipt_date must be recovered from the OCR");
  equal(date!.rawValue, "02-07-2028");
  equal(date!.value, "2028-07-02");
  equal(date!.source, "ocr");
  equal(date!.status, "flagged");
});

test("string fields recover via label + value-after-label", async () => {
  const doc = "Receipt\nMerchant: ACME Trading\n";
  const ai = makeAI(EMPTY, EMPTY);
  const job = await runReceipt(ai, doc);

  const merchant = job.extraction.fieldsMap.merchant_name;
  ok(merchant, "merchant_name must be recovered");
  equal(merchant!.value, "ACME Trading");
  equal(merchant!.status, "flagged");
});

test("no total anywhere → field stays missing even after recovery", async () => {
  const doc = "Receipt\nMerchant: ACME\n";
  const ai = makeAI(EMPTY, EMPTY);
  const job = await runReceipt(ai, doc);

  ok(!job.extraction.fieldsMap.total_amount, "nothing to recover → keep null");
  ok(job.validation.missing.includes("total_amount"));
});

test("recovered fields survive export DTO serialization with alternatives", async () => {
  const doc = "Receipt\nTotal: 68.38\nGrand total: 55.00\n";
  const ai = makeAI(EMPTY, EMPTY);
  const job = await runReceipt(ai, doc);

  const total = job.extraction.fieldsMap.total_amount;
  assert(total, "total_amount present");
  equal(total.status, "ambiguous");
  ok(Array.isArray(total.alternatives), "alternatives array must be serializable");
  equal(total.alternatives, [68.38, 55]);
});
