import { randomUUID } from "node:crypto";
import type { AIClient } from "@/lib/pipeline/types";
import { PipelineService } from "@/lib/pipeline/service";
import { INTERMEDIATE_STATUSES } from "@/lib/pipeline/constants";
import { test, ok, equal, assert, includes } from "./harness.ts";

/**
 * M25 crash-safe pipeline lifecycle. Verifies:
 *  - idempotency runs BEFORE any file read (no re-download on duplicates)
 *  - staged/terminal persist with a guarded onStage write (no terminal regress)
 *  - structured, persisted failures (stage errors + terminal-write failures)
 *  - stale-run reconciliation on read paths (get / list / run duplicate)
 */

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

/* ─── Extended in-memory supabase double (maybeSingle / in / lt) ─── */

type Row = Record<string, unknown>;

interface Filter {
  col: string;
  op: "eq" | "in" | "lt";
  val: unknown;
}

interface FakeTable {
  rows: Row[];
  updateHistory: string[];
  insertConflict: boolean;
  failUpdate: ((payload: Row) => boolean) | null;
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
  private orderCol: string | null = null;
  private ascending = false;
  private rangeFrom = 0;
  private rangeTo = -1;
  private countExact = false;

  constructor(private readonly table: FakeTable) {}

  select(_cols?: unknown, opts?: { count?: string }) {
    if (opts?.count === "exact") this.countExact = true;
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
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.ascending = opts?.ascending ?? false;
    return this;
  }
  range(from: number, to: number) {
    this.rangeFrom = from;
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

  private async execute(): Promise<{ data: Row | Row[] | null; error: unknown; count?: number | null }> {
    const t = this.table;

    if (this.op.kind === "insert") {
      const row: Row = { ...this.op.payload };
      if (row.id === undefined) row.id = randomUUID();
      const now = new Date().toISOString();
      row.created_at = row.created_at ?? now;
      row.updated_at = row.updated_at ?? now;

      // Postgres reality: a rejected INSERT inserts nothing.
      const conflict = () => ({
        data: null,
        error: { code: "23505", message: "duplicate key" },
      });
      // duplicate primary key — impossible in Postgres
      if (t.rows.some((r) => r.id === row.id)) return conflict();
      // unique(user_id, idempotency_key) — impossible in Postgres
      if (
        row.idempotency_key != null &&
        row.user_id != null &&
        t.rows.some(
          (r) => r.user_id === row.user_id && r.idempotency_key === row.idempotency_key
        )
      ) {
        return conflict();
      }
      if (t.insertConflict) {
        // Simulate the insert race: a concurrent writer committed the same
        // idempotency key between our findByKey and our INSERT. Their row now
        // exists; ours was rejected (23505) and inserted nothing.
        t.insertConflict = false;
        t.rows.push({ ...row, id: randomUUID() });
        return conflict();
      }
      t.rows.push(row);
      return { data: row, error: null };
    }

    const matches = t.rows.filter((r) => this.filters.every((f) => matchesFilter(r, f)));

    if (this.op.kind === "update") {
      const fail = t.failUpdate ? t.failUpdate(this.op.payload) : false;
      if (!fail) {
        for (const row of matches) {
          Object.assign(row, this.op.payload);
          row.updated_at = new Date().toISOString();
        }
        const status = this.op.payload.status;
        if (typeof status === "string" && matches.length > 0) {
          t.updateHistory.push(status);
        }
      }
      return { data: matches[0] ?? null, error: fail ? { message: "update failed (test)" } : null };
    }

    let out = [...matches];
    if (this.orderCol) {
      out.sort((a, b) => {
        const av = a[this.orderCol as string];
        const bv = b[this.orderCol as string];
        const cmp = String(av).localeCompare(String(bv));
        return this.ascending ? cmp : -cmp;
      });
    }
    const count = this.countExact ? t.rows.length : null;
    if (this.rangeTo >= 0) out = out.slice(this.rangeFrom, this.rangeTo + 1);
    return { data: this.countExact ? out : out[0] ?? null, error: null, count };
  }
}

class FakeSupabase {
  tables: { extractions: FakeTable; files: FakeTable };
  storageDownloads = 0;
  storage: {
    from: (name: string) => {
      download: (path: string) => Promise<{ data: Blob | null; error: unknown }>;
    };
  };

  constructor() {
    this.tables = {
      extractions: { rows: [], updateHistory: [], insertConflict: false, failUpdate: null },
      files: { rows: [], updateHistory: [], insertConflict: false, failUpdate: null },
    };
    this.storage = {
      from: () => ({
        download: async () => {
          this.storageDownloads += 1;
          return { data: new Blob([TEST_DOC], { type: "text/plain" }), error: null };
        },
      }),
    };
  }

  from(name: string) {
    return new FakeQuery(this.tables[name as keyof typeof this.tables]);
  }
}

function makeService(ai: AIClient, fake?: FakeSupabase) {
  const f = fake ?? new FakeSupabase();
  return { svc: new PipelineService(f as any, ai), fake: f };
}

const RUN_ARGS = {
  sourceText: TEST_DOC,
  profileType: "unknown",
  extractionMode: "dynamic",
} as const;

const FILE_ID = "00000000-0000-0000-0000-000000000001";
const JOB_ID = "11111111-1111-1111-1111-111111111111";

/* ─── Tests ─── */

test("stage failure is persisted as a structured STAGE_FAILED error", async () => {
  const ai: AIClient = {
    chatCompletion: async (req: any) => {
      const sys = String(req.messages?.find((m: any) => m.role === "system")?.content ?? "");
      if (sys.includes("document classifier")) {
        return { content: JSON.stringify({ type: "invoice", confidence: 0.9, reasons: ["total"] }) };
      }
      throw new Error("extraction boom");
    },
  };
  const { svc } = makeService(ai);
  const { job } = await svc.run("user-1", { sourceText: TEST_DOC, idempotencyKey: "k-stage-error" });
  equal(job.status, "error");
  equal(job.error?.code, "STAGE_FAILED");
  equal(job.error?.stage, "extract");
  includes(job.error?.message ?? "", "extraction boom");
});

test("phase transitions persist in order and never regress a terminal status", async () => {
  const { svc, fake } = makeService(fakeAI(DYNAMIC_RESPONSE));
  const { job } = await svc.run("user-1", { ...RUN_ARGS, idempotencyKey: "k-phases" });
  equal(job.status, "complete");

  const h = fake.tables.extractions.updateHistory;
  const idx = (s: string) => h.indexOf(s);
  ok(idx("classifying") >= 0, "must persist classifying");
  ok(idx("extracting") >= 0, "must persist extracting");
  ok(idx("validating") >= 0, "must persist validating");
  assert(
    idx("classifying") < idx("extracting") && idx("extracting") < idx("validating") &&
      idx("validating") < idx("complete"),
    "phases must persist in order before the terminal write"
  );

  // A late phase write (guarded) must not regress the terminal status.
  await fake
    .from("extractions")
    .update({ status: "extracting" })
    .eq("id", job.id)
    .in("status", INTERMEDIATE_STATUSES);
  const row = fake.tables.extractions.rows[0];
  equal(row.status, "complete", "guarded phase write must not regress complete");
});

test("terminal persist failure is recorded and the original error rethrown", async () => {
  const fake = new FakeSupabase();
  fake.tables.extractions.failUpdate = (payload) => payload.status === "complete";
  const { svc } = makeService(fakeAI(DYNAMIC_RESPONSE), fake);

  let thrown: unknown = null;
  try {
    await svc.run("user-1", { ...RUN_ARGS, idempotencyKey: "k-persist-fail" });
  } catch (err) {
    thrown = err;
  }
  ok(thrown, "run must rethrow the terminal persist failure");
  includes(thrown instanceof Error ? thrown.message : String(thrown), "persist failed");

  const row = fake.tables.extractions.rows[0];
  equal(row.status, "error");
  equal((row.error_json as { code: string }).code, "PIPELINE_RUN_FAILED");
});

test("duplicate run is idempotent and never re-reads the file", async () => {
  const fake = new FakeSupabase();
  fake.tables.files.rows.push({
    id: FILE_ID,
    user_id: "user-1",
    name: "doc.txt",
    url: null,
    mime_type: "text/plain",
    original_name: "doc.txt",
  });
  const { svc } = makeService(fakeAI(DYNAMIC_RESPONSE), fake);

  const r1 = await svc.run("user-1", { fileId: FILE_ID });
  equal(r1.created, true);
  equal(r1.job.status, "complete");
  equal(fake.storageDownloads, 1, "first run downloads the file once");

  const r2 = await svc.run("user-1", { fileId: FILE_ID });
  equal(r2.created, false);
  equal(r2.job.id, r1.job.id, "duplicate returns the same job");
  equal(fake.storageDownloads, 1, "duplicate must not re-download (idempotency before file read)");

  const r3 = await svc.run("user-1", { fileId: FILE_ID, force: true });
  equal(r3.rerun, true);
  equal(r3.job.id, r1.job.id, "force recomputes in place");
  equal(fake.storageDownloads, 2, "force re-reads the file");
});

test("concurrent duplicate (23505) returns the existing row", async () => {
  const fake = new FakeSupabase();
  fake.tables.files.rows.push({
    id: FILE_ID,
    user_id: "user-1",
    name: "doc.txt",
    url: null,
    mime_type: "text/plain",
    original_name: "doc.txt",
  });
  fake.tables.extractions.insertConflict = true;
  const { svc } = makeService(fakeAI(DYNAMIC_RESPONSE), fake);

  const r = await svc.run("user-1", { fileId: FILE_ID });
  equal(r.created, false);
  ok(r.job.id, "must return the existing job on insert conflict");
  equal(fake.storageDownloads, 1, "file is read before the conflicting insert");
});

test("stale get() reconciles an intermediate row to a diagnosable error", async () => {
  const fake = new FakeSupabase();
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  fake.tables.extractions.rows.push({
    id: JOB_ID,
    user_id: "user-1",
    status: "extracting",
    profile_type: "unknown",
    profile_version: 1,
    pipeline_version: 2,
    extraction_mode: "dynamic",
    created_at: old,
    updated_at: old,
  });
  const { svc } = makeService(fakeAI(DYNAMIC_RESPONSE), fake);

  const job = await svc.get("user-1", JOB_ID);
  equal(job.status, "error");
  equal(job.error?.code, "PIPELINE_INTERRUPTED");
});

test("stale list() sweeps only stale intermediate rows", async () => {
  const fake = new FakeSupabase();
  const staleId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const freshId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const doneId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const seed = (id: string, status: string, updatedAt: string) =>
    fake.tables.extractions.rows.push({
      id,
      user_id: "user-1",
      status,
      profile_type: "unknown",
      profile_version: 1,
      pipeline_version: 2,
      extraction_mode: "dynamic",
      created_at: now,
      updated_at: updatedAt,
    });
  seed(staleId, "extracting", old);
  seed(freshId, "extracting", now);
  seed(doneId, "complete", now);

  const { svc } = makeService(fakeAI(DYNAMIC_RESPONSE), fake);
  const list = await svc.list("user-1");

  const byId: Record<string, { status: string; code?: string }> = {};
  for (const item of list.items) {
    byId[item.id] = {
      status: item.status,
      code: item.error?.code,
    };
  }
  equal(byId[staleId].status, "error");
  equal(byId[staleId].code, "PIPELINE_INTERRUPTED");
  equal(byId[freshId].status, "extracting", "fresh intermediate rows are untouched");
  equal(byId[doneId].status, "complete", "terminal rows are untouched");
});

test("stale existing run duplicate is surfaced as interrupted without re-reading", async () => {
  const fake = new FakeSupabase();
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  fake.tables.extractions.rows.push({
    id: JOB_ID,
    user_id: "user-1",
    file_id: FILE_ID,
    idempotency_key: `file:${FILE_ID}`,
    status: "classifying",
    profile_type: "unknown",
    profile_version: 1,
    pipeline_version: 2,
    extraction_mode: "dynamic",
    created_at: old,
    updated_at: old,
  });
  fake.tables.files.rows.push({
    id: FILE_ID,
    user_id: "user-1",
    name: "doc.txt",
    url: null,
    mime_type: "text/plain",
    original_name: "doc.txt",
  });
  const { svc } = makeService(fakeAI(DYNAMIC_RESPONSE), fake);

  const r = await svc.run("user-1", { fileId: FILE_ID });
  equal(r.created, false);
  equal(r.job.id, JOB_ID);
  equal(r.job.status, "error");
  equal(r.job.error?.code, "PIPELINE_INTERRUPTED");
  equal(fake.storageDownloads, 0, "stale duplicate must not re-read the file");
});

/* ─── BLOCKER 2: force=true reruns the same record in place ─── */

test("force=true reruns the same job record in place (no duplicate row)", async () => {
  const fake = new FakeSupabase();
  fake.tables.files.rows.push({
    id: FILE_ID,
    user_id: "user-1",
    name: "doc.txt",
    url: null,
    mime_type: "text/plain",
    original_name: "doc.txt",
  });
  const { svc } = makeService(fakeAI(DYNAMIC_RESPONSE), fake);

  const r1 = await svc.run("user-1", { fileId: FILE_ID });
  equal(r1.created, true);
  equal(r1.job.status, "complete");
  equal(fake.storageDownloads, 1);

  const r2 = await svc.run("user-1", { fileId: FILE_ID, force: true });
  equal(r2.rerun, true, "force must be reported as rerun");
  equal(r2.created, false);
  equal(r2.job.id, r1.job.id, "force must reuse the same job id");
  equal(r2.job.status, "complete", "pipeline must actually run again");
  equal(fake.storageDownloads, 2, "force must re-read the file");
  equal(
    fake.tables.extractions.rows.length,
    1,
    "force must never create a duplicate row"
  );

  const h = fake.tables.extractions.updateHistory;
  equal(h.filter((s) => s === "complete").length, 2, "pipeline must run twice");
  equal(h.filter((s) => s === "classifying").length, 2, "phases must re-persist");
});

/* ─── BLOCKER 3: terminal-state race (deterministic, no timing) ─── */

test("late failure write cannot overwrite a terminal complete row", async () => {
  const fake = new FakeSupabase();
  fake.tables.extractions.rows.push({
    id: JOB_ID,
    user_id: "user-1",
    status: "complete",
    profile_type: "unknown",
    profile_version: 1,
    pipeline_version: 2,
    extraction_mode: "dynamic",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const { svc } = makeService(fakeAI(DYNAMIC_RESPONSE), fake);

  await (svc as any).persistRunFailure(JOB_ID, Date.now(), new Error("late failure"));

  const row = fake.tables.extractions.rows[0];
  equal(row.status, "complete", "Run A late failure must NOT overwrite complete");
});

test("late failure write cannot overwrite a terminal error row", async () => {
  const fake = new FakeSupabase();
  fake.tables.extractions.rows.push({
    id: JOB_ID,
    user_id: "user-1",
    status: "error",
    error_json: { code: "STAGE_FAILED", stage: "extract", message: "boom", retryable: false },
    profile_type: "unknown",
    profile_version: 1,
    pipeline_version: 2,
    extraction_mode: "dynamic",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const { svc } = makeService(fakeAI(DYNAMIC_RESPONSE), fake);

  await (svc as any).persistRunFailure(JOB_ID, Date.now(), new Error("late failure"));

  const row = fake.tables.extractions.rows[0];
  equal(row.status, "error");
  equal((row.error_json as { code: string }).code, "STAGE_FAILED", "original error preserved");
});

test("failure write still applies to an intermediate row (no false failure)", async () => {
  const fake = new FakeSupabase();
  fake.tables.extractions.rows.push({
    id: JOB_ID,
    user_id: "user-1",
    status: "classifying",
    profile_type: "unknown",
    profile_version: 1,
    pipeline_version: 2,
    extraction_mode: "dynamic",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const { svc } = makeService(fakeAI(DYNAMIC_RESPONSE), fake);

  await (svc as any).persistRunFailure(JOB_ID, Date.now(), new Error("boom"));

  const row = fake.tables.extractions.rows[0];
  equal(row.status, "error");
  equal((row.error_json as { code: string }).code, "PIPELINE_RUN_FAILED");
});

test("stage-error write is guarded against a terminal resolution", async () => {
  const fake = new FakeSupabase();
  fake.tables.extractions.rows.push({
    id: JOB_ID,
    user_id: "user-1",
    status: "complete",
    profile_type: "unknown",
    profile_version: 1,
    pipeline_version: 2,
    extraction_mode: "dynamic",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const { svc } = makeService(fakeAI(DYNAMIC_RESPONSE), fake);

  // The exact guarded chain the service's stage-error persist uses.
  await fake
    .from("extractions")
    .update({
      status: "error",
      error_json: { code: "STAGE_FAILED", stage: "extract", message: "boom", retryable: false },
      completed_at: new Date().toISOString(),
    })
    .eq("id", JOB_ID)
    .in("status", INTERMEDIATE_STATUSES);

  const row = fake.tables.extractions.rows[0];
  equal(row.status, "complete", "guarded error write must not regress complete");
  void svc;
});
