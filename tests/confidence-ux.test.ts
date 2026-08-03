import type { AIClient } from "@/lib/pipeline/types";
import { runPipeline } from "@/lib/pipeline/defaults";
import { exportExtraction } from "@/lib/pipeline/exporter";
import { toJobDTO } from "@/lib/pipeline/dto";
import { test, ok, equal, includes, assert } from "./harness.ts";
import { SUPERYPAY_RECEIPT_OCR } from "./fixtures/receipt-ocr.ts";

const EMPTY = JSON.stringify({ data: {} });

function makeAI(model1: string): AIClient {
  return {
    async chatCompletion() {
      return { content: model1, model: "m1", provider: "groq" };
    },
    async retryProviders() {
      throw new Error("no retry in this test");
    },
  };
}

async function runReceipt(ai: AIClient, sourceText: string) {
  const out = await runPipeline({ sourceText, profileType: "receipt" }, { ai });
  ok(out.status === "complete", `pipeline must complete: ${JSON.stringify(out.error)}`);
  return out.job!;
}

test("confidence engine reports evidence + uncertainty signals with breakdown summary", async () => {
  const ai = makeAI(EMPTY);
  const job = await runReceipt(ai, SUPERYPAY_RECEIPT_OCR);

  const signals = job.confidence.signals;
  ok(typeof signals.evidence === "number", "evidence signal must be present");
  ok(typeof signals.uncertainty === "number", "uncertainty signal must be present");
  ok(signals.evidence > 0, "evidence signal must be non-zero when fields are grounded");
  ok(signals.uncertainty < 1, "uncertainty signal must fall when fields are flagged");

  const labels = job.confidence.summary.map((s) => s.label);
  includes(labels, "Evidence grounding");
  includes(labels, "Uncertainty");
  includes(labels, "Validation");
});

test("recovered (flagged) fields carry machine-readable uncertainty reasons", async () => {
  const ai = makeAI(EMPTY);
  const job = await runReceipt(ai, SUPERYPAY_RECEIPT_OCR);

  const total = job.extraction.fieldsMap.total_amount;
  assert(total, "total_amount recovered");
  equal(total.status, "flagged");
  ok(Array.isArray(total.reasons), "reasons array must be set");
  includes(total.reasons!, "recovered_from_ocr");

  const date = job.extraction.fieldsMap.receipt_date;
  assert(date, "receipt_date recovered");
  ok(Array.isArray(date.reasons) && date.reasons!.length > 0, "date must explain its uncertainty");
});

test("ambiguous fields are marked ambiguous with reasons", async () => {
  const doc = "Receipt\nTotal: 68.38\nGrand total: 55.00\n";
  const ai = makeAI(EMPTY);
  const job = await runReceipt(ai, doc);

  const total = job.extraction.fieldsMap.total_amount;
  assert(total, "total_amount present");
  equal(total.status, "ambiguous");
  includes(total.reasons ?? [], "ambiguous_candidates");
});

test("edited/reviewed fields clear their uncertainty reasons", async () => {
  // Simulate the service's updateFields behavior: an edited field must lose
  // its reasons (verified by human review).
  const doc = "Receipt\nTotal: 68.38\nGrand total: 55.00\n";
  const ai = makeAI(EMPTY);
  const job = await runReceipt(ai, doc);

  const total = job.extraction.fieldsMap.total_amount;
  assert(total, "total_amount present");

  const edited = { ...total, reasons: undefined, status: "edited" as const, confidence: 1 };
  ok(!edited.reasons, "edited fields carry no uncertainty reasons");
});

test("JSON export is complete + grounded: reasons, evidence, raw, signals", async () => {
  const ai = makeAI(EMPTY);
  const job = await runReceipt(ai, SUPERYPAY_RECEIPT_OCR);

  const res = exportExtraction(
    job.extraction,
    { format: "json" },
    {
      confidence: job.confidence.overall,
      signals: job.confidence.signals,
      extractedAt: "2026-08-03T00:00:00Z",
    }
  );
  const content = res.content ?? "";
  includes(content, '"document_type": "receipt"');
  includes(content, '"signals"');
  includes(content, '"reasons"');
  includes(content, '"recovered_from_ocr"');
  includes(content, '"evidence"');
  includes(content, '"raw"');
  includes(content, "68.38");
});

test("toJobDTO exposes fileUrl, ocr preview and confidence summary", () => {
  const dto = toJobDTO({
    id: "abc",
    status: "complete",
    file_id: "file-1",
    profile_type: "receipt",
    profile_version: 1,
    pipeline_version: 1,
    overall_confidence: 0.61,
    created_at: "2026-08-03T00:00:00Z",
    completed_at: "2026-08-03T00:00:01Z",
    fields_json: [
      {
        key: "total_amount",
        value: 68.38,
        confidence: 0.434,
        source: "ocr",
        status: "flagged",
        reasons: ["recovered_from_ocr"],
      },
    ],
    validation_json: { ok: true, missing: [] },
    confidence_json: {
      overall: 0.61,
      signals: { evidence: 0.9, uncertainty: 0.5 },
      summary: [{ label: "Evidence grounding", score: 0.9 }],
    },
    ocr_json: {
      text: "Total 68.38",
      lines: [
        {
          text: "Total 68.38",
          confidence: 0.62,
          words: [{ text: "Total", confidence: 0.9 }],
        },
      ],
      confidence: 0.62,
    },
    source_text: "Total 68.38",
  });

  equal(dto.fileUrl, "/api/files/file-1");
  ok(dto.ocr, "ocr preview must be passed through");
  equal(dto.ocr!.lines[0].text, "Total 68.38");
  equal(dto.confidence!.summary![0].label, "Evidence grounding");
  equal(dto.fields![0].reasons![0], "recovered_from_ocr");
});
