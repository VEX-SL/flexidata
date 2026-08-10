/**
 * M21 live probe — dynamic extraction lifecycle end-to-end.
 *
 * Drives the REAL production service (`PipelineService.run` → classify → extract
 * → ground → clean → recover → validate → confidence) in dynamic mode with a
 * fake AI, then exercises the full lifecycle against an in-memory fake of the
 * `extractions` table:
 *   1. run()       → persists extraction_mode + per-field type/label
 *   2. get()       → reloads fields with discovered metadata intact
 *   3. exportJob() → CSV columns = discovered fields, JSON keeps AI labels
 *   4. updateFields → edit a discovered field (coerced by its persisted type),
 *                     unknown/unsafe keys rejected (no invention)
 *
 * Legacy mode is untouched (M13–M17 behaviour unchanged). Run: `npx tsx
 * tests/live/m21-dynamic-lifecycle-probe.ts`
 */
import { PipelineService } from "@/lib/pipeline/service";
import type { AIClient, JobDTO } from "@/lib/pipeline/types";

const DOC = [
  "Account Number: 12345",
  "Name: John Smith",
  "Total: 100 SAR",
  "",
].join("\n");

const DYNAMIC = JSON.stringify({
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
    chatCompletion: async () => ({ content, model: "fake", provider: "test" }),
  };
}

/* ─── Minimal in-memory supabase double (rows + insert/update/select) ── */

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
  range(a: number, b: number) {
    void a;
    void b;
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
  delete() {
    this.op = { kind: "delete" };
    return this;
  }

  async single() {
    if (this.op.kind !== "read") this.run();
    return this.read(true);
  }
  async maybeSingle() {
    if (this.op.kind !== "read") this.run();
    return this.read(true);
  }
  then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
    const value = this.run();
    return Promise.resolve(value).then(resolve, reject);
  }

  private matches(row: Row): boolean {
    return this.filters.every(([col, val]) => row[col] === val);
  }
  private read(single: boolean) {
    const rows = this.table.rows.filter((r) => this.matches(r));
    return single ? { data: rows[0] ?? null } : { data: rows };
  }
  private run() {
    if (this.op.kind === "insert") {
      const id = `00000000-0000-0000-0000-${String(
        this.table.rows.length + 1
      ).padStart(12, "0")}`;
      const row = {
        ...this.op.payload,
        id,
        created_at: new Date().toISOString(),
        completed_at: null,
      };
      this.table.rows.push(row);
      this.table.rows = [row, ...this.table.rows.slice(0, -1)];
      this.filters = [["id", id]];
      return { data: { id, created_at: row.created_at }, error: null };
    }
    if (this.op.kind === "update") {
      for (const row of this.table.rows.filter((r) => this.matches(r))) {
        Object.assign(row, this.op.payload);
      }
      return { error: null };
    }
    if (this.op.kind === "delete") {
      this.table.rows = this.table.rows.filter((r) => !this.matches(r));
      return { error: null };
    }
    return this.read(false);
  }
}

function fakeSupabase() {
  const store: Record<string, { rows: Row[] }> = {
    extractions: { rows: [] },
    files: { rows: [] },
  };
  return {
    from(name: string) {
      if (!store[name]) store[name] = { rows: [] };
      return new FakeQuery(store[name]);
    },
    storage: {
      from(bucket: string) {
        void bucket;
        return {
          download: async () => ({ error: new Error("no storage"), data: null }),
          remove: async () => ({ error: null }),
        };
      },
    },
  };
}

function fmt(job: JobDTO) {
  console.log(
    `mode=${job.extractionMode ?? "legacy"} status=${job.status} ` +
      `profile=${job.profileType} overall=${job.overallConfidence?.toFixed(3) ?? "n/a"} ` +
      `validation={ok:${job.validation?.ok ?? "n/a"}, missing:[${(job.validation?.missing ?? []).join(",")}]}`
  );
  for (const f of job.fields ?? []) {
    console.log(
      `  ${f.key}: value=${JSON.stringify(f.value)} type=${f.type ?? "(none)"} ` +
        `label="${f.label ?? "(none)"}" conf=${f.confidence} source=${f.source} status=${f.status}`
    );
  }
}

async function main() {
  const svc = new PipelineService(fakeSupabase() as never, fakeAI(DYNAMIC));

  console.log("=== 1. run() in dynamic mode ===");
  const { job } = await svc.run("user-1", {
    sourceText: DOC,
    profileType: "unknown",
    idempotencyKey: "probe-m21",
    extractionMode: "dynamic",
  });
  fmt(job);

  const failures: string[] = [];
  const check = (cond: boolean, label: string) => {
    console.log(`  ${cond ? "ok" : "FAIL"} — ${label}`);
    if (!cond) failures.push(label);
  };

  check(job.extractionMode === "dynamic", "extraction_mode persisted as dynamic");
  check(job.status === "complete", "job completed");
  check(job.validation?.ok === true, "validation is schema-neutral (ok, no missing)");
  const keys = (job.fields ?? []).map((f) => f.key);
  for (const k of ["account_number", "customer_name", "total"]) {
    check(keys.includes(k), `discovered field '${k}' persisted`);
  }
  const acct = job.fields?.find((f) => f.key === "account_number");
  check(acct?.type === "number", "AI-discovered type persisted");
  check(acct?.label === "Account Number", "AI-discovered label persisted");
  check(
    (job.fields ?? []).every((f) => typeof f.type === "string" && f.label),
    "every field carries persisted type + label"
  );

  console.log("\n=== 2. exportJob() ===");
  const csv = await svc.exportJob("user-1", job.id, "csv");
  console.log(csv.content);
  check(
    csv.content.split("\n")[0] === "account_number,customer_name,total",
    "CSV columns are the discovered fields, not a static profile list"
  );
  const json = await svc.exportJob("user-1", job.id, "json");
  check(json.content.includes('"Account Number"'), "JSON keeps AI-discovered labels");
  check(json.content.includes("12345"), "JSON carries the discovered value");

  console.log("\n=== 3. updateFields() — edit a discovered field ===");
  const edited = await svc.updateFields("user-1", job.id, { account_number: "200" });
  const editedAcct = edited.fields?.find((f) => f.key === "account_number");
  check(editedAcct?.value === 200, "edit coerced to the persisted number type");
  check(editedAcct?.status === "edited" && editedAcct?.source === "verified", "edit flagged");
  check(editedAcct?.type === "number", "type survives the edit");
  check(editedAcct?.label === "Account Number", "label survives the edit");

  console.log("\n=== 4. updateFields() — unknown / unsafe keys rejected ===");
  for (const [label, payload] of [
    ["unknown key 'balance' (no invention)", { balance: 5 }],
    ["prototype key '__proto__'", JSON.parse('{"__proto__": 5}')],
  ] as Array<[string, Record<string, unknown>]>) {
    try {
      await svc.updateFields("user-1", job.id, payload);
      check(false, `${label} was NOT rejected`);
    } catch (e) {
      check(true, `${label} rejected (${String((e as Error).message).slice(0, 60)})`);
    }
  }

  console.log("\n=== 5. get() — reload preserves the lifecycle ===");
  const reloaded = await svc.get("user-1", job.id);
  fmt(reloaded);
  check(reloaded.extractionMode === "dynamic", "reload keeps extraction_mode");
  check(
    reloaded.fields?.find((f) => f.key === "account_number")?.value === 200,
    "edited value survives reload"
  );

  if (failures.length > 0) {
    console.error(`\nPROBE FAILED: ${failures.length} check(s)`);
    process.exit(1);
  }
  console.log("\nPROBE PASSED — dynamic mode is first-class through run/export/edit/reload.");
}

await main();
