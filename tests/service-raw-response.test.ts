import type { AIClient } from "@/lib/pipeline/types";
import { PipelineService } from "@/lib/pipeline/service";
import { test, ok, equal, assert } from "./harness.ts";

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

function fakeAI(content: string): AIClient {
  return {
    chatCompletion: async () => ({ content, model: "test-model", provider: "test-provider" }),
  };
}

/* ─── Minimal in-memory supabase double ─── */

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private op:
    | { kind: "read" }
    | { kind: "insert"; payload: Row }
    | { kind: "update"; payload: Row }
    | { kind: "delete" } = { kind: "read" };
  constructor(private table: { rows: Row[] }) {}

  select(cols?: string, opts?: unknown) {
    void cols;
    void opts;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  order(col?: string, opts?: unknown) {
    void col;
    void opts;
    return this;
  }
  range(from: number, to: number) {
    void from;
    void to;
    return this;
  }
  async single() {
    if (this.op.kind === "insert") {
      return { data: this.op.payload, error: null };
    }
    const rows = this.table.rows.filter((r) =>
      this.filters.every(([c, v]) => r[c] === v)
    );
    return { data: rows[0] ?? null, error: null };
  }
  async insert(payload: Row) {
    this.op = { kind: "insert", payload };
    this.table.rows.push(payload);
    return { data: payload, error: null };
  }
  async update(payload: Row) {
    this.op = { kind: "update", payload };
    const idx = this.table.rows.findIndex((r) =>
      this.filters.every(([c, v]) => r[c] === v)
    );
    if (idx >= 0) {
      this.table.rows[idx] = { ...this.table.rows[idx], ...payload };
      return { data: this.table.rows[idx], error: null };
    }
    return { data: null, error: null };
  }
}

class FakeSupabase {
  tables = { extractions: { rows: [] as Row[] } };
  from(name: string) {
    return new FakeQuery(this.tables[name as keyof typeof this.tables]);
  }
}

function makeService(ai: AIClient) {
  return new PipelineService(new FakeSupabase() as any, ai);
}

test("service persists raw_ai_response in dynamic mode", async () => {
  const svc = makeService(fakeAI(DYNAMIC_RESPONSE));
  const { job } = await svc.run("user-1", {
    sourceText: TEST_DOC,
    profileType: "unknown",
    idempotencyKey: "test-raw-response-dynamic",
    extractionMode: "dynamic",
  });

  equal(job.status, "complete", "job should complete");
  ok(job.rawAIResponse, "job should have rawAIResponse from DTO");

  // Check the persisted row directly
  const table = (svc as any).supabase.from("extractions").table;
  const row = table.rows[0];
  ok(row.raw_ai_response, "raw_ai_response column should be populated");
  equal(row.raw_ai_response, DYNAMIC_RESPONSE, "persisted raw_ai_response must match AI response");
});

test("service persists raw_ai_response in legacy mode", async () => {
  const LEGACY_RESPONSE = JSON.stringify({
    data: {
      invoice_number: {
        raw: "INV-001",
        value: "INV-001",
        confidence: 0.9,
        evidence: "Invoice Number: INV-001",
      },
    },
  });

  const svc = makeService(fakeAI(LEGACY_RESPONSE));
  const { job } = await svc.run("user-1", {
    sourceText: TEST_DOC,
    profileType: "unknown",
    idempotencyKey: "test-raw-response-legacy",
    extractionMode: "legacy",
  });

  equal(job.status, "complete", "job should complete");

  const table = (svc as any).supabase.from("extractions").table;
  const row = table.rows[0];
  ok(row.raw_ai_response, "raw_ai_response column should be populated");
  equal(row.raw_ai_response, LEGACY_RESPONSE, "persisted raw_ai_response must match AI response");
});

test("service does not expose raw_ai_response in public JobDTO", async () => {
  const svc = makeService(fakeAI(DYNAMIC_RESPONSE));
  const { job } = await svc.run("user-1", {
    sourceText: TEST_DOC,
    profileType: "unknown",
    idempotencyKey: "test-raw-response-dto",
    extractionMode: "dynamic",
  });

  // JobDTO should not have rawAIResponse field
  const dtoKeys = Object.keys(job);
  assert(!dtoKeys.includes("rawAIResponse"), "JobDTO must not expose rawAIResponse");
  assert(!dtoKeys.includes("raw_ai_response"), "JobDTO must not expose raw_ai_response");
});