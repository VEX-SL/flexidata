import { randomUUID } from "node:crypto";
import type { AIClient } from "@/lib/pipeline/types";
import { PipelineService } from "@/lib/pipeline/service";
import { INTERMEDIATE_STATUSES } from "@/lib/pipeline/constants";
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

/* ─── In-memory supabase double (chained, supports the service's update flow) ─── */

type Row = Record<string, unknown>;

interface Filter {
  col: string;
  op: "eq" | "in" | "lt";
  val: unknown;
}

interface FakeTable {
  rows: Row[];
}

function matchesFilter(row: Row, f: Filter): boolean {
  if (f.op === "eq") return row[f.col] === f.val;
  if (f.op === "in") return Array.isArray(f.val) && f.val.includes(row[f.col] as never);
  if (f.op === "lt") {
    return new Date(row[f.col] as string).getTime() < new Date(f.val as string).getTime();
  }
  return false;
}

class FakeQuery {
  private op:
    | { kind: "read" }
    | { kind: "insert"; payload: Row }
    | { kind: "update"; payload: Row } = { kind: "read" };
  private filters: Filter[] = [];
  private rangeTo = -1;

  constructor(private readonly table: FakeTable) {}

  select(_cols?: unknown, opts?: unknown) {
    void opts;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, op: "eq", val });
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push({ col, op: "in", val: vals });
    return this;
  }
  lt(col: string, val: unknown) {
    this.filters.push({ col, op: "lt", val });
    return this;
  }
  order(_col: string, _opts?: unknown) {
    return this;
  }
  range(from: number, to: number) {
    void from;
    this.rangeTo = to;
    return this;
  }
  insert(payload: Row) {
    this.op = { kind: "insert", payload };
    return this;
  }
  update(payload: Row) {
    this.op = { kind: "update", payload };
    return this;
  }
  single() {
    return this;
  }
  maybeSingle() {
    return this;
  }

  then<T>(
    onfulfilled?: (v: unknown) => T | PromiseLike<T>,
    onrejected?: (r: unknown) => T | PromiseLike<T>
  ) {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<{ data: Row | Row[] | null; error: unknown }> {
    const t = this.table;

    if (this.op.kind === "insert") {
      const row: Row = { ...this.op.payload };
      if (row.id === undefined) row.id = randomUUID();
      const now = new Date().toISOString();
      row.created_at = row.created_at ?? now;
      row.updated_at = row.updated_at ?? now;
      t.rows.push(row);
      return { data: row, error: null };
    }

    const matches = t.rows.filter((r) => this.filters.every((f) => matchesFilter(r, f)));

    if (this.op.kind === "update") {
      for (const row of matches) {
        Object.assign(row, this.op.payload);
        row.updated_at = new Date().toISOString();
      }
      return { data: matches[0] ?? null, error: null };
    }

    let out = [...matches];
    if (this.rangeTo >= 0) out = out.slice(0, this.rangeTo + 1);
    return { data: out[0] ?? null, error: null };
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

async function finish(svc: PipelineService, args: Parameters<PipelineService["run"]>[1]) {
  const r = await svc.run("user-1", args);
  const p = await svc.process("user-1", r.job.id);
  return { ...r, job: p.job };
}

test("service persists raw_ai_response in dynamic mode", async () => {
  const svc = makeService(fakeAI(DYNAMIC_RESPONSE));
  const { job } = await finish(svc, {
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
  const { job } = await finish(svc, {
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
  const { job } = await finish(svc, {
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

// Kept for typing parity with the lifecycle suite; exercised implicitly above.
void INTERMEDIATE_STATUSES;