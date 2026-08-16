import type { FieldDTO } from "@/lib/pipeline/dto";
import type { ExtractionResult, FieldValue, RawExtraction } from "@/lib/pipeline/types";
import { PipelineService } from "@/lib/pipeline/service";
import { validateExtraction } from "@/lib/pipeline/validator";
import { exportExtraction } from "@/lib/pipeline/exporter";
import { toJobDTO } from "@/lib/pipeline/dto";
import { getProfileManager } from "@/lib/pipeline/profiles/registry";
import { safeFieldKey } from "@/lib/pipeline/extractor/dynamic";
import { normalizeDynamicFields } from "@/lib/pipeline/extractor/normalizer";
import { candidatesFromAICall } from "@/lib/pipeline/extractor/index";
import { groundExtraction } from "@/lib/pipeline/extractor/grounding";
import { test, ok, equal, assert, includes } from "./harness.ts";

/**
 * M21 — dynamic extraction lifecycle. Verifies that dynamic mode is a
 * first-class, persisted, editable, exportable mode:
 *  - mode + field type/label survive persistence and reload;
 *  - PATCH edits discovered fields (never creates arbitrary keys);
 *  - export reflects dynamic fields (not a static column list);
 *  - replace/rerun keeps the mode;
 *  - validation/confidence stay schema-neutral for dynamic jobs;
 *  - legacy mode is byte-identical (no behavioural change).
 */

/* ─── Test doubles ───────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private op:
    | { kind: "read" }
    | { kind: "update"; payload: Record<string, unknown> }
    | { kind: "delete" } = { kind: "read" };
  private countExact = false;

  constructor(private table: { rows: Row[] }) {}

  select(_cols?: string, opts?: { count?: string }) {
    if (opts?.count === "exact") this.countExact = true;
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
  update(payload: Record<string, unknown>) {
    this.op = { kind: "update", payload };
    return this;
  }
  delete() {
    this.op = { kind: "delete" };
    return this;
  }

  async single() {
    return this.read(true);
  }
  async maybeSingle() {
    return this.read(false);
  }
  then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
    const value =
      this.op.kind === "read" ? this.read(false) : this.write();
    return Promise.resolve(value).then(resolve, reject);
  }

  private matches(row: Row): boolean {
    return this.filters.every(([col, val]) => row[col] === val);
  }
  private read(single: boolean) {
    const rows = this.table.rows.filter((r) => this.matches(r));
    if (this.countExact) return { data: rows, count: rows.length };
    return single ? { data: rows[0] ?? null } : { data: rows };
  }
  private write() {
    if (this.op.kind === "update") {
      for (const row of this.table.rows.filter((r) => this.matches(r))) {
        Object.assign(row, this.op.payload);
      }
    } else if (this.op.kind === "delete") {
      this.table.rows = this.table.rows.filter((r) => !this.matches(r));
    }
    return { error: null };
  }
}

function fakeSupabase(tables: Record<string, Row[]>) {
  const store: Record<string, { rows: Row[] }> = {};
  for (const [name, rows] of Object.entries(tables)) {
    store[name] = { rows };
  }
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

class ServiceSpy extends PipelineService {
  runCalls: Array<{ userId: string; req: Record<string, unknown> }> = [];
  constructor(supabase: ReturnType<typeof fakeSupabase>) {
    super(supabase as never);
  }
  async run(
    userId: string,
    req: Record<string, unknown>
  ): Promise<{ job: { id: string }; created: boolean; rerun: boolean }> {
    this.runCalls.push({ userId, req });
    return { job: { id: "new-job" }, created: false, rerun: true };
  }
}

/* ─── Fixtures ───────────────────────────────────────────────────────── */

const dynamicFields: FieldDTO[] = [
  {
    key: "account_number",
    value: 12345,
    raw: "12345",
    type: "number",
    label: "Account Number",
    confidence: 0.9,
    source: "ai",
    status: "extracted",
    evidence: [{ quote: "Account Number: 12345", lineIndex: 0 }],
  },
  {
    key: "customer_name",
    value: "John Smith",
    raw: "John Smith",
    type: "string",
    label: "Customer Name",
    confidence: 0.8,
    source: "ai",
    status: "extracted",
    evidence: [{ quote: "Name: John Smith", lineIndex: 1 }],
  },
  {
    key: "total",
    value: "100 SAR",
    raw: "100 SAR",
    type: "currency",
    label: "Total",
    confidence: 0.7,
    source: "ai",
    status: "extracted",
    evidence: [{ quote: "Total: 100 SAR", lineIndex: 2 }],
  },
];

function dynamicRow(overrides: Row = {}): Row {
  return {
    id: "row-dyn",
    user_id: "user-1",
    status: "complete",
    profile_type: "invoice",
    profile_version: 1,
    extraction_mode: "dynamic",
    fields_json: dynamicFields,
    overall_confidence: 0.83,
    confidence_json: { overall: 0.83, signals: {}, summary: [] },
    validation_json: { ok: true, missing: [] },
    completed_at: "2026-08-10T00:00:00.000Z",
    source_text: "Account Number: 12345\nName: John Smith\nTotal: 100 SAR",
    ...overrides,
  };
}

/* ─── Persistence / reload (export path) ─────────────────────────────── */

test("exportJob JSON preserves AI-discovered labels for dynamic fields", async () => {
  const svc = new PipelineService(fakeSupabase({ extractions: [dynamicRow()] }));
  const res = await svc.exportJob("user-1", "row-dyn", "json");
  const content = res.content;
  includes(content, '"Account Number"');
  includes(content, '"Customer Name"');
  includes(content, '"Total"');
  includes(content, "12345");
  assert(
    !content.includes('"label": "account_number"'),
    "dynamic labels must not fall back to the snake_case key"
  );
});

test("exportJob CSV for a dynamic job uses the extracted fields as columns", async () => {
  const svc = new PipelineService(fakeSupabase({ extractions: [dynamicRow()] }));
  const res = await svc.exportJob("user-1", "row-dyn", "csv");
  const [header, ...rows] = res.content.trim().split("\n");
  equal(header, "account_number,customer_name,total");
  equal(rows.length, 1);
  includes(rows[0], "12345");
  includes(rows[0], "John Smith");
  includes(rows[0], "100 SAR");
});

test("toJobDTO surfaces the extraction mode", async () => {
  const dto = toJobDTO(dynamicRow() as never);
  equal(dto.extractionMode, "dynamic");
  const legacy = toJobDTO(dynamicRow({ extraction_mode: null }) as never);
  equal(legacy.extractionMode, "legacy");
});

/* ─── PATCH / updateFields ───────────────────────────────────────────── */

test("updateFields edits a persisted dynamic field and coerces by its type", async () => {
  const rows = [dynamicRow()];
  const svc = new PipelineService(fakeSupabase({ extractions: rows }));
  const job = await svc.updateFields("user-1", "row-dyn", { account_number: "200" });

  const field = job.fields?.find((f) => f.key === "account_number");
  ok(field, "edited dynamic field present in result");
  equal(field?.value, 200, "string input coerced by persisted number type");
  equal(field?.confidence, 1);
  equal(field?.source, "verified");
  equal(field?.status, "edited");
  equal(field?.type, "number", "persisted type survives the edit");
  equal(field?.label, "Account Number", "persisted label survives the edit");
  equal(job.validation?.ok, true);
  equal(job.validation?.missing?.length, 0);
  const persisted = rows[0].fields_json as FieldDTO[];
  const stored = persisted.find((f) => f.key === "account_number");
  equal(stored?.value, 200, "edited value persisted to fields_json");
  equal(stored?.label, "Account Number");
});

test("updateFields rejects unknown keys in dynamic mode (no invention)", async () => {
  const svc = new PipelineService(fakeSupabase({ extractions: [dynamicRow()] }));
  let threw = false;
  try {
    await svc.updateFields("user-1", "row-dyn", { balance: 5 });
  } catch (e) {
    threw = true;
    includes(String((e as Error).message), "balance");
  }
  ok(threw, "unknown dynamic key must be rejected");
});

test("updateFields rejects prototype-pollution keys in dynamic mode", async () => {
  const svc = new PipelineService(fakeSupabase({ extractions: [dynamicRow()] }));
  const evil = JSON.parse('{"__proto__": 5}');
  equal(safeFieldKey("__proto__"), "", "precondition: __proto__ is blocked by safeFieldKey");
  let threw = false;
  try {
    await svc.updateFields("user-1", "row-dyn", evil);
  } catch {
    threw = true;
  }
  ok(threw, "unsafe dynamic key must be rejected");
});

test("updateFields legacy mode still rejects non-schema keys", async () => {
  const row = dynamicRow({ extraction_mode: "legacy" });
  const svc = new PipelineService(fakeSupabase({ extractions: [row] }));
  let threw = false;
  try {
    await svc.updateFields("user-1", "row-dyn", { bogus_key: 1 });
  } catch {
    threw = true;
  }
  ok(threw, "legacy mode must not accept arbitrary keys");
});

test("updateFields legacy mode still accepts and coerces schema keys", async () => {
  const rows = [
    dynamicRow({
      id: "row-leg",
      extraction_mode: "legacy",
      fields_json: [
        {
          key: "invoice_number",
          value: "INV-1",
          confidence: 0.9,
          source: "ai",
          status: "extracted",
        },
      ],
    }),
  ];
  const svc = new PipelineService(fakeSupabase({ extractions: rows }));
  const job = await svc.updateFields("user-1", "row-leg", { invoice_number: "INV-2" });
  const field = job.fields?.find((f) => f.key === "invoice_number");
  equal(field?.value, "INV-2");
  equal(field?.status, "edited");
  equal(field?.label, "Invoice number", "schema label attached on legacy edit");
});

/* ─── Replace / rerun keeps the mode ─────────────────────────────────── */

test("replace passes the stored extraction mode to run", async () => {
  const spy = new ServiceSpy(
    fakeSupabase({
      extractions: [
        dynamicRow({
          id: "row-rep",
          file_id: "00000000-0000-0000-0000-000000000001",
        }),
      ],
      files: [
        {
          id: "00000000-0000-0000-0000-000000000002",
          user_id: "user-1",
          name: "new.pdf",
        },
      ],
    })
  );
  await spy.replace("user-1", "row-rep", "00000000-0000-0000-0000-000000000002");
  equal(spy.runCalls.length, 1);
  equal(spy.runCalls[0].req.extractionMode, "dynamic");
});

test("replace defaults legacy rows to legacy mode", async () => {
  const spy = new ServiceSpy(
    fakeSupabase({
      extractions: [
        dynamicRow({
          id: "row-leg2",
          file_id: "00000000-0000-0000-0000-000000000003",
          extraction_mode: null,
        }),
      ],
      files: [
        {
          id: "00000000-0000-0000-0000-000000000004",
          user_id: "user-1",
          name: "new.pdf",
        },
      ],
    })
  );
  await spy.replace("user-1", "row-leg2", "00000000-0000-0000-0000-000000000004");
  equal(spy.runCalls.length, 1);
  equal(spy.runCalls[0].req.extractionMode, "legacy");
});

/* ─── Validator neutrality ───────────────────────────────────────────── */

function fv(value: unknown, confidence = 0.9): FieldValue {
  return { value, confidence, source: "ai", status: "extracted" };
}

test("validateExtraction is schema-neutral for dynamic mode", () => {
  const profile = getProfileManager().get("invoice")!;
  const fields = dynamicFields.map((f) => ({
    field: {
      key: f.key,
      type: (f.type ?? "string") as "string",
      label: f.label ?? f.key,
    },
    value: fv(f.value),
  }));
  const extraction: ExtractionResult = {
    profileType: "invoice",
    profileVersion: 1,
    extractionMode: "dynamic",
    fields,
    fieldsMap: Object.fromEntries(fields.map((x) => [x.field.key, x.value])),
    cleanFields: Object.fromEntries(fields.map((x) => [x.field.key, x.value.value])),
    droppedFields: {},
  };

  const result = validateExtraction(extraction);
  equal(result.ok, true);
  equal(result.missing.length, 0, "no schema-required keys can be 'missing'");
  equal(result.results.length, 0, "no profile rules apply to dynamic fields");
  assert(
    profile.validationRules.some((r) => r.required && r.key === "invoice_number"),
    "precondition: invoice has required rules that would flag a dynamic result"
  );
});

test("exportCsv dynamic columns differ from the profile's configured columns", () => {
  const profile = getProfileManager().get("invoice")!;
  const fields = dynamicFields.map((f) => ({
    field: {
      key: f.key,
      type: (f.type ?? "string") as "string",
      label: f.label ?? f.key,
    },
    value: fv(f.value),
  }));
  const extraction: ExtractionResult = {
    profileType: "invoice",
    profileVersion: 1,
    extractionMode: "dynamic",
    fields,
    fieldsMap: Object.fromEntries(fields.map((x) => [x.field.key, x.value])),
    cleanFields: Object.fromEntries(fields.map((x) => [x.field.key, x.value.value])),
    droppedFields: {},
  };

  const dynamicCsv = exportExtraction(extraction, { format: "csv" });
  const header = dynamicCsv.content?.split("\n")[0] ?? "";
  equal(header, "account_number,customer_name,total");

  const legacyColumns = profile.exportConfig.csvColumns ?? [];
  assert(
    legacyColumns.length > 0 && legacyColumns[0] === "invoice_number",
    "precondition: invoice profile has static csv columns"
  );
  assert(
    !legacyColumns.includes("account_number"),
    "dynamic columns must not come from the profile column list"
  );
});

test("Unicode dynamic fields are preserved throughout the pipeline", () => {
  const unicodeFields: FieldDTO[] = [
    {
      key: "رقم_الحساب",
      value: "12345",
      raw: "12345",
      type: "string",
      label: "رقم الحساب",
      confidence: 0.9,
      source: "ai",
      status: "extracted",
      evidence: [{ quote: "رقم الحساب: 12345", lineIndex: 0 }],
    },
    {
      key: "المرجعي",
      value: "REF123",
      raw: "REF123",
      type: "string",
      label: "المرجعي",
      confidence: 0.8,
      source: "ai",
      status: "extracted",
      evidence: [{ quote: "المرجعي: REF123", lineIndex: 1 }],
    },
  ];

  const extraction: ExtractionResult = {
    profileType: "invoice",
    profileVersion: 1,
    extractionMode: "dynamic",
    fields: unicodeFields.map((f) => ({
      field: {
        key: f.key,
        type: (f.type ?? "string") as "string",
        label: f.label ?? f.key,
      },
      value: fv(f.value),
    })),
    fieldsMap: Object.fromEntries(unicodeFields.map((f) => [f.key, fv(f.value)])),
    cleanFields: Object.fromEntries(unicodeFields.map((f) => [f.key, f.value])),
    droppedFields: {},
  };

  // Test that Unicode fields are not dropped
  equal(extraction.droppedFields["رقم_الحساب"], undefined);
  equal(extraction.droppedFields["المرجعي"], undefined);

  // Test that Unicode fields are in cleanFields
  equal(extraction.cleanFields["رقم_الحساب"], "12345");
  equal(extraction.cleanFields["المرجعي"], "REF123");

  // Test validation is schema-neutral for Unicode dynamic fields
  const result = validateExtraction(extraction);
  equal(result.ok, true);
  equal(result.missing.length, 0);
});

test("Unicode dynamic fields enter FieldsMap and survive field enumeration", () => {
  const profile = getProfileManager().get("invoice")!;
  const raw: RawExtraction = {
    data: {
      "رقم الحساب": { raw: "12345", value: "12345", type: "string", label: "رقم الحساب" },
      "المرجعي": { raw: "REF123", value: "REF123", type: "string", label: "المرجعي" },
      "Account Number": { raw: "67890", value: "67890", type: "string", label: "Account Number" },
    },
  };

  const map = normalizeDynamicFields(profile!, raw);

  // Test that Unicode fields are in FieldsMap
  ok("رقم_الحساب" in map, "Unicode field enters FieldsMap");
  ok("المرجعي" in map, "Unicode field enters FieldsMap");
  ok("account_number" in map, "ASCII field still works");

  // Test that values are preserved
  equal(map["رقم_الحساب"].value, "12345");
  equal(map["المرجعي"].value, "REF123");
  equal(map["account_number"].value, "67890");

  // Test that metadata is preserved
  ok(map["رقم_الحساب"].meta?.dynamicLabel === "رقم الحساب");
  ok(map["المرجعي"].meta?.dynamicLabel === "المرجعي");
  ok(map["account_number"].meta?.dynamicLabel === "Account Number");
});

test("Unicode dynamic fields reach grounding stage", () => {
  // Real production path: candidatesFromAICall (parseRaw → parseDynamicExtraction
  // → safeFieldKey → normalizeDynamicFields) then groundExtraction, exactly as
  // extractDocument composes them (extractor/index.ts). Arabic field names and
  // Arabic source text flow through without ASCII assumptions.
  const profile = getProfileManager().get("invoice")!;
  const content = JSON.stringify({
    data: {
      "رقم الحساب": { value: "12345", raw: "12345" },
      "المرجعي": { value: "REF123", raw: "REF123" },
    },
  });
  const sourceText = "رقم الحساب: 12345\nالمرجعي: REF123";

  const candidates = candidatesFromAICall(profile, { content }, "dynamic");
  const result = groundExtraction(profile, candidates, sourceText);

  const grounded = (key: string) =>
    result.fields.some((f) => f.field.key === key) ||
    key in result.cleanFields;

  ok(grounded("رقم_الحساب"), "رقم_الحساب survives grounding");
  ok(grounded("المرجعي"), "المرجعي survives grounding");

  for (const key of ["رقم_الحساب", "المرجعي"]) {
    const fv = result.fieldsMap[key];
    ok(fv, `${key} present in fieldsMap`);
    ok((fv?.evidence?.length ?? 0) > 0, `${key} carries OCR evidence`);
    ok(!(key in result.droppedFields), `${key} is not dropped`);
  }
});
