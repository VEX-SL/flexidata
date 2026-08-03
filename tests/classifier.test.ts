import type { AIClient } from "@/lib/pipeline/types";
import { classifyDocument } from "@/lib/pipeline/classifier";
import { test, ok, equal } from "./harness.ts";
import { SUPERYPAY_RECEIPT_OCR } from "./fixtures/receipt-ocr.ts";

function fakeAI(
  type: string,
  confidence: number,
  reasons: string[] = []
): AIClient {
  return {
    chatCompletion: async () => ({
      content: JSON.stringify({ type, confidence, reasons }),
      model: "fake",
      provider: "test",
    }),
  };
}

const DOWN = {
  chatCompletion: async () => {
    throw new Error("provider down");
  },
};

test("SuperPay payment receipt is classified as 'receipt' even when a weak AI says 'invoice' at 0.8", async () => {
  const result = await classifyDocument(SUPERYPAY_RECEIPT_OCR, {
    ai: fakeAI("invoice", 0.8, ["presence of invoice number (6070218301132167)"]),
  });
  equal(result.profileType, "receipt", "payment receipt must not be classified as invoice");
  equal(result.source, "rule", "overrule must come from grounded rules");
});

test("SuperPay payment receipt is classified as 'receipt' when the AI is unavailable", async () => {
  const result = await classifyDocument(SUPERYPAY_RECEIPT_OCR, { ai: DOWN });
  equal(result.profileType, "receipt", "rule fallback must recognize the payment receipt");
});

test("AI invoice classification is kept when the document has invoice markers", async () => {
  const text = "INVOICE INV-2026-001\nفاتورة رقم ١٠٢\nSeller: Acme\nTotal: 120.00";
  const result = await classifyDocument(text, {
    ai: fakeAI("invoice", 0.9, ["contains INVOICE"]),
  });
  equal(result.profileType, "invoice");
  equal(result.source, "ai");
});

test("plain receipt with explicit receipt words stays 'receipt'", async () => {
  const text = "RECEIPT\nMerchant: Cafe\nTotal: 12.50\nشكراً لزيارتكم";
  const result = await classifyDocument(text, { ai: fakeAI("receipt", 0.95) });
  equal(result.profileType, "receipt");
});

test("unknown AI answer with no markers falls back to 'unknown'", async () => {
  const result = await classifyDocument("some random meeting notes", {
    ai: fakeAI("unknown", 0.1),
  });
  equal(result.profileType, "unknown");
});

test("rule fallback classifies an Arabic invoice when the AI is unavailable", async () => {
  const result = await classifyDocument("فاتورة تجارية رقم 45", { ai: DOWN });
  equal(result.profileType, "invoice");
  equal(result.source, "rule");
});

test("rule markers actually exist in the SuperPay OCR", () => {
  const text = SUPERYPAY_RECEIPT_OCR.toLowerCase();
  ok(text.includes("purchase"), "OCR must contain the PURCHASE marker");
  ok(text.includes("عملية ناجحة"), "OCR must contain the successful-transaction marker");
  ok(text.includes("رقم الحساب"), "OCR must contain the account-number marker");
});
