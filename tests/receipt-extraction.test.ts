import type { AIClient } from "@/lib/pipeline/types";
import { extractDocument } from "@/lib/pipeline/extractor";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import { test, ok, equal } from "./harness.ts";
import { SUPERYPAY_RECEIPT_OCR } from "./fixtures/receipt-ocr.ts";

function fakeAI(content: string): AIClient {
  return {
    chatCompletion: async () => ({ content, model: "fake", provider: "test" }),
  };
}

const GROUNDED = JSON.stringify({
  receipt_number: "2013438351",
  receipt_date: "2026-07-02",
  merchant_name: "SuperPay",
  merchant_tax_id: null,
  customer_name: "Zahra Aman",
  currency: null,
  subtotal: null,
  tax_amount: null,
  discount_amount: null,
  total_amount: 68.38,
  payment_method: null,
  cashier_name: null,
  pos_number: null,
  notes: "عملية ناجحة",
  line_items: [
    {
      description: "Hostinger",
      quantity: 1,
      unit_price: 68.38,
      amount: 68.38,
    },
  ],
});

test("receipt extraction keeps grounded fields from the SuperPay OCR", async () => {
  const profile = getProfileManager().get("receipt");
  ok(profile, "receipt profile must be registered");

  const result = await extractDocument(
    { profile: profile!, sourceText: SUPERYPAY_RECEIPT_OCR },
    fakeAI(GROUNDED)
  );

  equal(result.profileType, "receipt");
  equal(result.cleanFields.receipt_number, "2013438351");
  equal(result.cleanFields.receipt_date, "2026-07-02");
  equal(result.cleanFields.merchant_name, "SuperPay");
  equal(result.cleanFields.customer_name, "Zahra Aman");
  equal(result.cleanFields.total_amount, 68.38);
  ok(!result.droppedFields.merchant_name, "merchant_name must survive post-processing");
  ok(!result.droppedFields.total_amount, "total_amount must survive post-processing");
});
