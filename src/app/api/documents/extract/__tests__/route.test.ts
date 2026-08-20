import { readFileSync } from "node:fs";
import { test, equal, ok } from "../../../../../../tests/harness";
import {
  createExtractHandler,
  POST,
  MAX_DOCUMENT_BYTES,
  type DocumentPipeline,
} from "../route";
import type { PipelineSchema } from "@/lib/extraction/pipeline";

const PNG_BYTES = readFileSync("benchmarks/corpus/scan-blur.png");

function makeStub() {
  const calls: Array<{ buffer: Buffer; schema: PipelineSchema }> = [];
  const pipeline: DocumentPipeline = async (buffer, schema) => {
    calls.push({ buffer, schema });
    return {
      result: {
        data: { total_amount: "38.40" },
        meta: {
          total_amount: {
            state: "VERIFIED",
            value: "38.40",
            confidence: 0.99,
            reasons: [],
          },
        },
        issues: [],
        overallConfidence: 0.99,
      },
      grounded: {} as never,
      elapsedMs: 42,
    };
  };
  return { calls, pipeline };
}

function formRequest(fields: Array<[string, string | File]>): Request {
  const fd = new FormData();
  for (const [name, value] of fields) fd.append(name, value);
  return new Request("http://localhost/api/documents/extract", { method: "POST", body: fd });
}

const schemaJson = JSON.stringify({ fields: [{ key: "total_amount", type: "currency" }] });

// ─── Success paths ──────────────────────────────────────────────────────────

test("route: PNG image with a schema returns verified fields with 200", async () => {
  const { calls, pipeline } = makeStub();
  const handler = createExtractHandler({ pipeline });
  const res = await handler(
    formRequest([
      ["file", new File([PNG_BYTES], "scan.png", { type: "image/png" })],
      ["schema", schemaJson],
    ])
  );
  equal(res.status, 200);
  const body = (await res.json()) as {
    data: Record<string, unknown>;
    meta: Record<string, unknown>;
    issues: unknown[];
    overallConfidence: number;
    elapsedMs: number;
  };
  equal(body.data.total_amount, "38.40");
  equal((body.meta.total_amount as { state: string }).state, "VERIFIED");
  equal(body.issues.length, 0);
  equal(body.overallConfidence, 0.99);
  equal(body.elapsedMs, 42);
  equal(calls.length, 1);
  ok(calls[0].buffer.equals(PNG_BYTES), "pipeline received the raw PNG bytes");
  equal(calls[0].schema.fields.length, 1);
  equal((calls[0].schema.fields[0] as { key: string }).key, "total_amount");
});

test("route: PDF input is rendered to an image before extraction", async () => {
  const { calls, pipeline } = makeStub();
  const rendered: Buffer[] = [];
  const handler = createExtractHandler({
    pipeline,
    renderPdf: async (b) => {
      rendered.push(b);
      return PNG_BYTES;
    },
  });
  const pdfBytes = Buffer.from("%PDF-1.4\n%%EOF");
  const res = await handler(
    formRequest([["file", new File([pdfBytes], "receipt.pdf", { type: "application/pdf" })]])
  );
  equal(res.status, 200);
  equal(rendered.length, 1, "renderer called exactly once");
  ok(rendered[0].equals(pdfBytes), "renderer received the PDF bytes");
  ok(calls[0].buffer.equals(PNG_BYTES), "pipeline received the rendered PNG");
});

test("route: schema is optional and defaults to an empty field set", async () => {
  const { calls, pipeline } = makeStub();
  const handler = createExtractHandler({ pipeline });
  const res = await handler(
    formRequest([["file", new File([PNG_BYTES], "scan.png", { type: "image/png" })]])
  );
  equal(res.status, 200);
  equal(calls.length, 1);
  equal(calls[0].schema.fields.length, 0);
});

test("route: opaque MIME is rescued by magic-byte sniffing", async () => {
  const { pipeline } = makeStub();
  const handler = createExtractHandler({ pipeline });
  const res = await handler(
    formRequest([
      ["file", new File([PNG_BYTES], "scan.png", { type: "application/octet-stream" })],
    ])
  );
  equal(res.status, 200);
});

test("route: POST is exported as the route handler", () => {
  ok(typeof POST === "function", "POST handler is exported");
});

// ─── Failure paths ──────────────────────────────────────────────────────────

test("route: missing file returns 400", async () => {
  const { pipeline } = makeStub();
  const handler = createExtractHandler({ pipeline });
  const res = await handler(formRequest([["schema", schemaJson]]));
  equal(res.status, 400);
  equal((await res.json()).error, "No file provided");
});

test("route: empty file returns 400", async () => {
  const { pipeline } = makeStub();
  const handler = createExtractHandler({ pipeline });
  const res = await handler(
    formRequest([["file", new File([], "empty.png", { type: "image/png" })]])
  );
  equal(res.status, 400);
  equal((await res.json()).error, "Empty file");
});

test("route: unsupported file type returns 400", async () => {
  const { pipeline } = makeStub();
  const handler = createExtractHandler({ pipeline });
  const res = await handler(
    formRequest([["file", new File([Buffer.from("hello")], "note.txt", { type: "text/plain" })]])
  );
  equal(res.status, 400);
  ok(String((await res.json()).error).includes("Unsupported file type"));
});

test("route: file over 10 MB returns 400 before any processing", async () => {
  const { calls, pipeline } = makeStub();
  const handler = createExtractHandler({ pipeline });
  const res = await handler(
    formRequest([
      ["file", new File([new Uint8Array(MAX_DOCUMENT_BYTES + 1)], "big.png", { type: "image/png" })],
    ])
  );
  equal(res.status, 400);
  equal((await res.json()).error, "File too large (max 10 MB)");
  equal(calls.length, 0, "pipeline never ran");
});

test("route: invalid schema JSON returns 400", async () => {
  const { calls, pipeline } = makeStub();
  const handler = createExtractHandler({ pipeline });
  const res = await handler(
    formRequest([
      ["file", new File([PNG_BYTES], "scan.png", { type: "image/png" })],
      ["schema", "{not json"],
    ])
  );
  equal(res.status, 400);
  equal((await res.json()).error, "Invalid schema JSON");
  equal(calls.length, 0);
});

test("route: schema without a fields array returns 400", async () => {
  const { pipeline } = makeStub();
  const handler = createExtractHandler({ pipeline });
  const res = await handler(
    formRequest([
      ["file", new File([PNG_BYTES], "scan.png", { type: "image/png" })],
      ["schema", JSON.stringify({ foo: 1 })],
    ])
  );
  equal(res.status, 400);
  ok(String((await res.json()).error).includes("fields array"));
});

test("route: schema field without a string key returns 400", async () => {
  const { pipeline } = makeStub();
  const handler = createExtractHandler({ pipeline });
  const res = await handler(
    formRequest([
      ["file", new File([PNG_BYTES], "scan.png", { type: "image/png" })],
      ["schema", JSON.stringify({ fields: [{ label: "TOTAL" }] })],
    ])
  );
  equal(res.status, 400);
  equal((await res.json()).error, "each schema field must have a string key");
});

test("route: non-form body returns 400", async () => {
  const { pipeline } = makeStub();
  const handler = createExtractHandler({ pipeline });
  const res = await handler(
    new Request("http://localhost/api/documents/extract", {
      method: "POST",
      body: "not a form",
      headers: { "content-type": "text/plain" },
    })
  );
  equal(res.status, 400);
  equal((await res.json()).error, "Invalid form data");
});

// ─── Unexpected failures → safe 500 ─────────────────────────────────────────

test("route: pipeline failure returns 500 with a safe message", async () => {
  const handler = createExtractHandler({
    pipeline: (async () => {
      throw new Error("SECRET_INTERNAL_DETAIL");
    }) as DocumentPipeline,
  });
  const res = await handler(
    formRequest([["file", new File([PNG_BYTES], "scan.png", { type: "image/png" })]])
  );
  equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  equal(body.error, "Extraction failed");
  ok(!JSON.stringify(body).includes("SECRET_INTERNAL_DETAIL"), "internal error detail is not leaked");
});

test("route: PDF rendering failure returns 500 with a safe message", async () => {
  const handler = createExtractHandler({
    pipeline: (async () => ({ result: {} })) as unknown as DocumentPipeline,
    renderPdf: (async () => {
      throw new Error("SECRET_PDF_DETAIL");
    }) as never,
  });
  const res = await handler(
    formRequest([["file", new File([Buffer.from("%PDF-1.4")], "a.pdf", { type: "application/pdf" })]])
  );
  equal(res.status, 500);
  equal((await res.json()).error, "Extraction failed");
});