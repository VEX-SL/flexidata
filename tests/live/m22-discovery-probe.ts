/**
 * M22 live probe — schema-free DISCOVERY end-to-end.
 *
 * Drives the REAL production service (`PipelineService.run`) in dynamic mode
 * against the real SuperPay OCR fixture, with a fake AI that "discovers" the
 * transaction number, account number, reference number, customer number and
 * total (all verbatim in the OCR). Verifies the discovery contract:
 *   1. every accepted field is anchored to a verbatim OCR quote (per line);
 *   2. OCR garbage is never accepted as a receipt number;
 *   3. independent identifiers are discovered separately, never merged;
 *   4. no schema keys are injected and the dynamic prompt carries no schema;
 *   5. validation is schema-neutral (ok, no missing) on a discovery result.
 *
 * Legacy mode is untouched (M13–M21 behaviour unchanged). Run: `npx tsx
 * tests/live/m22-discovery-probe.ts`
 */
import { PipelineService } from "@/lib/pipeline/service";
import { buildDynamicPrompt } from "@/lib/pipeline/extractor/prompt-builder";
import { normalizeText } from "@/lib/pipeline/ocr";
import type { AIClient, JobDTO } from "@/lib/pipeline/types";
import { SUPERYPAY_RECEIPT_OCR as RECEIPT_OCR } from "../fixtures/receipt-ocr.ts";

const DISCOVERED = JSON.stringify({
  data: {
    "transaction number": {
      raw: "6070218301132167",
      value: "6070218301132167",
      type: "string",
      label: "رقم التمليه",
      confidence: 0.9,
      evidence: "() رقم التمليه : 6070218301132167",
    },
    "account number": {
      raw: "391803452",
      value: "391803452",
      type: "string",
      label: "رقم الحساب",
      confidence: 0.9,
      evidence: "| رقم الحساب : 391803452",
    },
    "reference number": {
      raw: "2013438351",
      value: "2013438351",
      type: "string",
      label: "انرقم المرجقي",
      confidence: 0.9,
      evidence: "B انرقم المرجقي : 2013438351",
    },
    "customer number": {
      raw: "9840833767",
      value: "9840833767",
      type: "string",
      label: "رقم العميل",
      confidence: 0.9,
      evidence: "8[ رقم العميل : 9840833767",
    },
    total: {
      raw: "68.38",
      value: 68.38,
      type: "currency",
      label: "المطلوب",
      confidence: 0.9,
      evidence: "gla المطلوب : 68.38 ;",
    },
  },
});

const GARBAGE = JSON.stringify({
  data: {
    "receipt number": {
      raw: "$ 60 SuperPay e&",
      value: "$ 60 SuperPay e&",
      type: "string",
      label: "رقم التمليه",
      confidence: 0.99,
      evidence: "$ 60 SuperPay e&",
    },
  },
});

function fakeAI(content: string): AIClient {
  return {
    chatCompletion: async () => ({ content, model: "fake", provider: "test" }),
  };
}

/* ─── Minimal in-memory supabase double (same as the M21 probe) ── */

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
  const failures: string[] = [];
  const check = (cond: boolean, label: string) => {
    console.log(`  ${cond ? "ok" : "FAIL"} — ${label}`);
    if (!cond) failures.push(label);
  };

  console.log("=== 1. run() discovers the SuperPay OCR in dynamic mode ===");
  const svc = new PipelineService(fakeSupabase() as never, fakeAI(DISCOVERED));
  const { job } = await svc.run("user-1", {
    sourceText: RECEIPT_OCR,
    profileType: "unknown",
    idempotencyKey: "probe-m22",
    extractionMode: "dynamic",
  });
  fmt(job);

  check(job.extractionMode === "dynamic", "extraction_mode is dynamic");
  check(job.status === "complete", "job completed");
  check(job.validation?.ok === true, "validation is schema-neutral (ok, no missing)");
  check((job.validation?.missing.length ?? 0) === 0, "no schema-required missing fields");

  const fields = job.fields ?? [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const EXPECTED: Record<string, unknown> = {
    transaction_number: "6070218301132167",
    account_number: "391803452",
    reference_number: "2013438351",
    customer_number: "9840833767",
    total: 68.38,
  };
  for (const [key, value] of Object.entries(EXPECTED)) {
    const f = byKey.get(key);
    check(
      f !== undefined && f.value === value,
      `discovered field '${key}' = ${JSON.stringify(value)}`
    );
  }

  console.log("\n=== 2. every accepted value is anchored to a verbatim OCR quote ===");
  const lines = RECEIPT_OCR.split("\n");
  for (const f of fields) {
    const anchors = (f.evidence ?? []).filter((e: { role?: string }) => e.role !== "meta");
    const good = anchors.filter((e: { quote?: string; lineIndex?: number }) => {
      const line = lines[e.lineIndex ?? -1] ?? "";
      return (
        typeof e.quote === "string" &&
        normalizeText(line).includes(normalizeText(e.quote))
      );
    }).length;
    check(good === anchors.length, `'${f.key}' evidence is verbatim (${good}/${anchors.length})`);
  }

  const tx = byKey.get("transaction_number");
  const txQuotes = (tx?.evidence ?? []).map((e: { quote?: string }) => e.quote).join(" ");
  check(txQuotes.includes("رقم التمليه"), "transaction number anchored to its own label line");
  const totalQuotes = (byKey.get("total")?.evidence ?? [])
    .map((e: { quote?: string }) => e.quote)
    .join(" ");
  check(totalQuotes.includes("المطلوب"), "total anchored to its own label line");
  check(
    !txQuotes.includes("391803452") && !txQuotes.includes("2013438351"),
    "identifiers are never merged across lines"
  );

  console.log("\n=== 3. OCR garbage is never accepted as a receipt number ===");
  const svc2 = new PipelineService(fakeSupabase() as never, fakeAI(GARBAGE));
  const { job: j2 } = await svc2.run("user-1", {
    sourceText: RECEIPT_OCR,
    profileType: "unknown",
    idempotencyKey: "probe-m22-garbage",
    extractionMode: "dynamic",
  });
  const keys2 = (j2.fields ?? []).map((f) => f.key);
  check(!keys2.includes("receipt_number"), "garbage never becomes receipt_number");
  check(!keys2.includes("transaction_number"), "no fabricated transaction number either");

  console.log("\n=== 4. the dynamic prompt carries no schema ===");
  const prompt = buildDynamicPrompt(RECEIPT_OCR);
  check(!prompt.includes("{{schema}}"), "no {{schema}} placeholder");
  check(!prompt.includes("receipt_number"), "no legacy schema key");
  check(!prompt.includes('"required"'), "no schema shape at all");

  if (failures.length > 0) {
    console.error(`\nPROBE FAILED: ${failures.length} check(s)`);
    process.exit(1);
  }
  console.log("\nPROBE PASSED — discovery mode is grounded, schema-free and end-to-end.");
}

await main();
