import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import {
  toStructuredDocument,
  extractStructuredDocument,
  type StructuredDocument,
} from "@/lib/pipeline/structured-document";
import {
  buildAgentDocumentContext,
  renderStructuredDocument,
} from "@/lib/agent/document-context";
import type {
  ExtractionResult,
  FieldValue,
  RunJobOutput,
} from "@/lib/pipeline/types";
import { test, ok, equal, includes, assert } from "./harness.ts";

function sampleOutput(): RunJobOutput {
  const profile = getProfileManager().get("receipt")!;
  assert(profile, "receipt profile must be registered");

  const fieldByKey = new Map(profile.schema.fields.map((f) => [f.key, f]));
  const mk = (
    key: string,
    value: unknown,
    rawValue: unknown,
    confidence: number,
    evidence?: FieldValue["evidence"]
  ) => ({
    field: fieldByKey.get(key)!,
    value: {
      value,
      rawValue,
      confidence,
      source: "ai" as const,
      status: "extracted" as const,
      evidence,
    } as FieldValue,
  });

  const fields = [
    mk("receipt_number", "2013438351", "2013438351", 0.99, [
      { quote: "انرقم المرجقي : 2013438351", role: "value-match" },
    ]),
    mk("receipt_date", "2028-07-02", "02-07-2028 18:30:12", 0.97, [
      { quote: "تبيخ الوقت : 02-07-2028 18:30:12", role: "value-match" },
    ]),
    mk("total_amount", 68.38, "68.38", 0.91, [
      { quote: "العلى : 68.38", role: "value-match" },
    ]),
  ];

  const extraction: ExtractionResult = {
    profileType: "receipt",
    profileVersion: 1,
    fields,
    fieldsMap: {},
    cleanFields: {},
    droppedFields: {
      currency: "currency not stated in document",
      merchant_tax_id: "not found in source text",
    },
    model: "fake",
    provider: "test",
  };

  return {
    status: "complete",
    trace: [],
    job: {
      classification: {
        profileType: "receipt",
        confidence: 0.99,
        source: "ai",
        reasons: [],
        candidates: [],
      },
      extraction,
      validation: { ok: true, results: [], missing: [] },
      confidence: { overall: 0.88, signals: {}, summary: [] },
    },
  };
}

test("toStructuredDocument serializes a completed run (fields, raw, evidence, drops)", () => {
  const doc = toStructuredDocument(sampleOutput());
  ok(doc, "structured document must be produced");

  equal(doc!.profileType, "receipt");
  equal(doc!.profileLabel, getProfileManager().get("receipt")!.label);
  equal(doc!.overallConfidence, 0.88);

  const byKey = new Map(doc!.fields.map((f) => [f.key, f]));
  equal(byKey.get("receipt_number")!.value, "2013438351");
  equal(byKey.get("receipt_number")!.confidence, 0.99);
  equal(byKey.get("receipt_date")!.rawValue, "02-07-2028 18:30:12");
  equal(byKey.get("total_amount")!.value, 68.38);
  equal(
    byKey.get("total_amount")!.evidence![0].quote,
    "العلى : 68.38"
  );

  const dropped = doc!.dropped.map((d) => d.key).sort();
  equal(dropped, ["currency", "merchant_tax_id"]);
});

test("toStructuredDocument returns null for non-complete runs", () => {
  const out: RunJobOutput = {
    status: "error",
    trace: [],
    error: {
      stage: "extract",
      code: "EXTRACTION_FAILED",
      message: "boom",
      retryable: true,
    },
  };
  equal(toStructuredDocument(out), null);
});

test("extractStructuredDocument skips short / stub non-document content", async () => {
  equal(await extractStructuredDocument({ sourceText: "tiny" }), null);
  equal(
    await extractStructuredDocument({
      sourceText:
        "[Audio file: song.mp3 (1.2MB). Transcription requires the file to be uploaded through the chat interface.]",
    }),
    null
  );
});

test("buildAgentDocumentContext renders verified fields + evidence first, raw as supporting", () => {
  const doc = toStructuredDocument(sampleOutput())!;
  const built = buildAgentDocumentContext([
    { title: "receipt.jpg", parsed_content: "SOME RAW OCR BODY", structured_content: doc },
  ]);

  includes(built.context, "### Document: receipt.jpg");
  includes(built.context, "Verified fields");
  includes(built.context, "`receipt_number` (Receipt number) = `2013438351`");
  includes(built.context, "OCR \"انرقم المرجقي : 2013438351\"");
  includes(
    built.context,
    "`receipt_date` (Receipt date) = `2028-07-02` (raw: `02-07-2028 18:30:12`)"
  );
  includes(built.context, "Could not be confirmed");
  includes(built.context, "`currency` — currency not stated in document");
  includes(built.context, "Supporting raw OCR text");
  includes(built.context, "SOME RAW OCR BODY");

  equal(built.structuredCount, 1);
  equal(built.rawCount, 0);
});

test("buildAgentDocumentContext falls back to raw text for documents without structured content", () => {
  const built = buildAgentDocumentContext([
    { title: "legacy.txt", parsed_content: "raw legacy body" },
  ]);

  includes(built.context, "### Document: legacy.txt");
  includes(built.context, "Raw text only");
  includes(built.context, "raw legacy body");
  equal(built.structuredCount, 0);
  equal(built.rawCount, 1);
});

test("buildAgentDocumentContext mixes structured and raw documents", () => {
  const doc = toStructuredDocument(sampleOutput())!;
  const built = buildAgentDocumentContext([
    { title: "a.jpg", parsed_content: "aaa", structured_content: doc },
    { title: "b.txt", parsed_content: "bbb" },
  ]);

  const blocks = built.context.split("\n\n---\n\n");
  equal(blocks.length, 2);
  includes(blocks[0], "### Document: a.jpg");
  includes(blocks[1], "### Document: b.txt");
  equal(built.structuredCount, 1);
  equal(built.rawCount, 1);
});

test("buildAgentDocumentContext with no documents returns empty context", () => {
  equal(buildAgentDocumentContext([]).context, "");
});

test("renderStructuredDocument truncates long raw evidence", () => {
  const out = sampleOutput();
  const extraction = out.job!.extraction;
  const longQuote = "0".repeat(200) + "UNIQUE-TAIL-MARKER" + "1".repeat(280);
  extraction.fields[0].value.evidence = [{ quote: longQuote, role: "value-match" }];

  const rendered = renderStructuredDocument("t", toStructuredDocument(out)!);
  includes(rendered, `"${"0".repeat(200)}…"`);
  ok(
    !rendered.includes("UNIQUE-TAIL-MARKER"),
    "raw evidence must be truncated"
  );
});
