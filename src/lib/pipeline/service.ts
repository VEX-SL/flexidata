import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/validators";
import { parseFileBufferDetailed } from "@/lib/file-parser";
import { runPipeline } from "./defaults";
import { getProfileManager } from "./profiles/registry";
import {
  PIPELINE_VERSION,
  MAX_SOURCE_TEXT,
  INTERMEDIATE_STATUSES,
  STALE_JOB_MS,
} from "./constants";
import { PipelineError } from "./errors";
import { toJobDTO } from "./dto";
import { computeConfidence } from "./confidence";
import { validateExtraction } from "./validator";
import type {
  AIClient,
  ExtractionMode,
  ExtractionResult,
  ExportFormat,
  FieldEvidence,
  FieldSchema,
  FieldsMap,
  NormalizedField,
  OcrDocument,
  PipelineStage,
  ProfileType,
  RunJobInput,
  RunJobOutput,
  StructuredError,
} from "./types";
import type { JobDTO, ExtractionListDTO, FieldDTO } from "./dto";
import { exportExtraction } from "./exporter";
import { isEmptyValue } from "./extractor/post-processor";
import { safeFieldKey } from "./extractor/dynamic";

/**
 * PipelineService — transport-agnostic pipeline execution.
 * Called identically from HTTP routes, a cron job, a queue worker or a CLI
 * script; nothing here imports next/server, headers or cookies. Phase 1 runs
 * synchronously; callers can later switch to background execution without
 * changing the contract.
 */
export class PipelineService {
  constructor(
    private readonly supabase: SupabaseClient = createAdminClient(),
    private readonly ai?: AIClient
  ) {}

  /**
   * Run the pipeline for a document. Idempotent: a repeat run for the same
   * document (same idempotency key) returns the existing job instead of
   * creating a duplicate, unless `force: true` explicitly requests a re-run.
   */
  async run(
    userId: string,
    req: {
      fileId?: string;
      sourceText?: string;
      fileName?: string;
      mimeType?: string;
      profileType?: ProfileType;
      idempotencyKey?: string;
      force?: boolean;
      ocr?: OcrDocument;
      extractionMode?: ExtractionMode;
    }
  ): Promise<{ job: JobDTO; created: boolean; rerun: boolean }> {
    // ── Resolve + validate input ─────────────────────────────────────
    let sourceText = req.sourceText?.trim() ?? "";
    let fileName = req.fileName;
    let mimeType = req.mimeType;
    let ocr = req.ocr;
    const fileId = req.fileId;

    if (req.profileType) {
      const manager = getProfileManager();
      if (!manager.has(req.profileType)) {
        throw new PipelineError(
          `Unknown profile type: ${req.profileType}`,
          { code: "BAD_REQUEST", retryable: false }
        );
      }
    }

    // ── Idempotency (checked BEFORE any file read so a duplicate request
    // never re-downloads / re-parses / re-OCRs the source) ────────────
    const idempotencyKey =
      req.idempotencyKey?.trim() || (fileId ? `file:${fileId}` : undefined);

    let jobId: string | null = null;
    let created = false;
    let rerun = false;

    if (idempotencyKey) {
      const existing = await this.findByKey(userId, idempotencyKey);
      if (existing && !req.force) {
        // A previously interrupted run is surfaced as a diagnosable error
        // (never a stuck intermediate status) so the caller can force-retry.
        const row = this.isStalePhase(existing)
          ? await this.markRowInterrupted(userId, existing.id)
          : existing;
        return { job: toJobDTO(row), created: false, rerun: false };
      }
      if (existing && req.force) {
        // Explicit re-run: recompute in place — same record, results wiped,
        // completion metadata rewritten. Never duplicates the record.
        await this.supabase
          .from("extractions")
          .update({
            status: "queued",
            overall_confidence: null,
            fields_json: null,
            validation_json: null,
            confidence_json: null,
            trace_json: null,
            error_json: null,
            provider: null,
            model: null,
            processing_time_ms: null,
            completed_at: null,
          })
          .eq("id", existing.id);
        jobId = existing.id;
        rerun = true;
      }
    }

    if (!sourceText && fileId) {
      const resolved = await this.readFileText(userId, fileId);
      sourceText = resolved.text;
      fileName = resolved.fileName;
      mimeType = resolved.mimeType;
      ocr = resolved.ocr;
    }

    if (!sourceText) {
      throw new PipelineError(
        "Either sourceText or a readable fileId is required",
        { code: "BAD_REQUEST", retryable: false }
      );
    }
    if (sourceText.length > MAX_SOURCE_TEXT) {
      throw new PipelineError(
        `sourceText too long (max ${MAX_SOURCE_TEXT} characters)`,
        { code: "BAD_REQUEST", retryable: false }
      );
    }

    // ── Create job (queued) ──────────────────────────────────────────
    const startedAt = Date.now();
    if (!jobId) {
      const { data: row, error: insertError } = await this.supabase
        .from("extractions")
        .insert({
          user_id: userId,
          file_id: fileId ?? null,
          idempotency_key: idempotencyKey ?? null,
          pipeline_version: PIPELINE_VERSION,
          status: "queued",
          source_text: sourceText.slice(0, 200_000),
        })
        .select("id, created_at")
        .single();

      // Concurrent duplicate: unique(user_id, idempotency_key) → return existing.
      if (insertError && idempotencyKey && String(insertError.code) === "23505") {
        const existing = await this.findByKey(userId, idempotencyKey);
        if (existing) {
          const row = this.isStalePhase(existing)
            ? await this.markRowInterrupted(userId, existing.id)
            : existing;
          return { job: toJobDTO(row), created: false, rerun: false };
        }
      }
      if (insertError || !row) {
        throw new PipelineError(
          insertError?.message ?? "Failed to create extraction",
          { code: "UNKNOWN_ERROR", retryable: true }
        );
      }
      jobId = row.id;
      created = true;
    }
    if (!jobId) {
      throw new PipelineError("Missing job id", {
        code: "UNKNOWN_ERROR",
        retryable: false,
      });
    }

    // ── Run (synchronous in phase 1; later: enqueue + poll) ──────────
    const input: RunJobInput = {
      sourceText,
      fileName,
      mimeType,
      fileId,
      profileType: req.profileType,
      ocr,
      extractionMode: req.extractionMode,
    };

    let out: RunJobOutput;
    try {
      out = await runPipeline(input, { ai: this.ai, onStage: this.buildOnStage(jobId) });
    } catch (err) {
      // In-process exception outside the stage loop (e.g. provider bootstrap,
      // unexpected wiring failure): persist a diagnosable structured error,
      // then rethrow the ORIGINAL error — never hide it.
      await this.persistRunFailure(jobId, startedAt, err);
      throw err;
    }
    const processingTimeMs = Date.now() - startedAt;

    // ── Persist result (source_text is refresh-on-completion, never stale) ──
    if (out.status === "complete" && out.job) {
      const { classification, extraction, validation, confidence } = out.job;
      const fields = serializeFields(extraction);
      const payload = {
        status: "complete",
        source_text: sourceText.slice(0, 200_000),
        profile_type: classification.profileType,
        profile_version: extraction.profileVersion,
        extraction_mode: extraction.extractionMode ?? "legacy",
        provider: extraction.provider ?? null,
        model: extraction.model ?? null,
        raw_ai_response: extraction.rawAIResponse ?? null,
        processing_time_ms: processingTimeMs,
        overall_confidence: round4(confidence.overall),
        fields_json: fields,
        validation_json: { ok: validation.ok, missing: validation.missing },
        confidence_json: {
          overall: confidence.overall,
          signals: confidence.signals,
          summary: confidence.summary,
        },
        trace_json: out.trace,
        completed_at: new Date().toISOString(),
      } as Record<string, unknown>;

      try {
        const result = await this.supabase
          .from("extractions")
          .update({ ...payload, ocr_json: ocr ?? null })
          .eq("id", jobId);
        if (result.error) {
          throw new Error(`persist failed: ${result.error.message}`);
        }
      } catch (err) {
        // The run completed but the terminal write failed: leave a structured,
        // recoverable error behind and surface the original failure.
        await this.persistRunFailure(jobId, startedAt, err, out.trace);
        throw err;
      }

      const finalRow = await this.getRow(userId, jobId);
      return { job: toJobDTO(finalRow), created, rerun };
    }

    // Structured stage error (never a raw exception). Guarded against terminal
    // statuses: if a NEWER run already resolved this row (complete/error), the
    // late failure write must not regress that resolution.
    const structured: StructuredError = out.error ?? {
      code: "UNKNOWN_ERROR",
      message: "Pipeline failed",
      retryable: false,
    };
    await this.supabase
      .from("extractions")
      .update({
        status: "error",
        error_json: structured,
        trace_json: out.trace,
        processing_time_ms: processingTimeMs,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .in("status", INTERMEDIATE_STATUSES);

    const finalRow = await this.getRow(userId, jobId);
    return { job: toJobDTO(finalRow), created, rerun };
  }

  /** Persist a real phase transition, guarded so it can never regress a terminal status. */
  private buildOnStage(jobId: string): (stage: PipelineStage) => Promise<void> {
    return async (stage: PipelineStage) => {
      const status = stageToStatus(stage.id);
      if (!status) return;
      try {
        await this.supabase
          .from("extractions")
          .update({ status })
          .eq("id", jobId)
          .in("status", INTERMEDIATE_STATUSES);
      } catch (err) {
        // Best-effort observability: a phase write failure must never fail the
        // pipeline. The terminal persist + stale reconciliation still
        // guarantee a diagnosable row.
        console.error(
          `[Pipeline] phase status persist failed (${stage.id} → ${status}):`,
          err
        );
      }
    };
  }

  /**
   * Best-effort structured failure record; the original error is rethrown by
   * the caller. Guarded against terminal statuses: this run's failure may
   * arrive AFTER a newer run resolved the same row — the late failure write
   * must not regress that resolution.
   */
  private async persistRunFailure(
    jobId: string,
    startedAt: number,
    err: unknown,
    trace?: unknown
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await this.supabase
        .from("extractions")
        .update({
          status: "error",
          error_json: {
            stage: "run",
            code: "PIPELINE_RUN_FAILED",
            message,
            retryable: true,
            details: err instanceof Error ? { name: err.name } : undefined,
          },
          trace_json: trace ?? null,
          processing_time_ms: Date.now() - startedAt,
          completed_at: new Date().toISOString(),
        })
        .eq("id", jobId)
        .in("status", INTERMEDIATE_STATUSES);
    } catch (persistErr) {
      // If even the failure cannot be persisted the row stays intermediate and
      // the stale reconciliation (read paths) will mark it later.
      console.error("[Pipeline] failed to persist run failure:", persistErr);
    }
  }

  /** GET /pipeline/extractions/{id} — single job (poll target). */
  async get(userId: string, id: string): Promise<JobDTO> {
    if (!isValidUUID(id)) {
      throw new PipelineError("Invalid extraction id", {
        code: "BAD_REQUEST",
        retryable: false,
      });
    }
    let row = await this.getRow(userId, id);
    if (this.isStalePhase(row)) {
      row = await this.markRowInterrupted(userId, id);
    }
    return toJobDTO(row);
  }

  /** GET /pipeline/extractions — list, newest first, optional status filter. */
  async list(
    userId: string,
    opts: { limit?: number; offset?: number; status?: string } = {}
  ): Promise<ExtractionListDTO> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);

    await this.sweepStale(userId);

    let query = this.supabase
      .from("extractions")
      .select("*", { count: "exact" })
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (opts.status) query = query.eq("status", opts.status);

    const { data, count } = await query;
    const rows = (data ?? []) as unknown as Parameters<typeof toJobDTO>[0][];
    return { items: rows.map(toJobDTO), total: count ?? 0 };
  }

  /** GET /pipeline/extractions/{id}/export — export a completed job. */
  async exportJob(
    userId: string,
    id: string,
    format: ExportFormat
  ): Promise<{ content: string; fileName: string; mimeType: string }> {
    const row = await this.getRow(userId, id);

    if (row.status !== "complete") {
      throw new PipelineError(
        `Extraction not ready for export (status: ${row.status})`,
        { code: "BAD_REQUEST", retryable: false }
      );
    }

    const profile = getProfileManager().getOrFallback(
      String(row.profile_type)
    );
    const extraction = rebuildExtraction(row, profile);

    let result;
    try {
      result = exportExtraction(extraction, { format }, {
        confidence: Number(row.overall_confidence ?? 0),
        signals:
          row.confidence_json && typeof row.confidence_json === "object"
            ? row.confidence_json.signals
            : undefined,
        extractedAt: row.completed_at ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/phase 2/i.test(message)) {
        throw new PipelineError(message, {
          code: "UNSUPPORTED_FORMAT",
          retryable: false,
        });
      }
      throw new PipelineError(message, {
        code: "EXTRACTION_FAILED",
        retryable: false,
      });
    }

    return {
      content: result.content ?? "",
      fileName: result.fileName,
      mimeType: result.mimeType,
    };
  }

  /**
   * PATCH /pipeline/extractions/{id} — persist user field corrections.
   * Accepts a `fields` map (key → value). Edited values are marked with
   * status "edited" / source "verified" and confidence 1; the overall
   * confidence and validation snapshot are recomputed to match. Immutable
   * metadata (status, provider, model, trace) is never touched.
   */
  async updateFields(
    userId: string,
    id: string,
    overrides: Record<string, unknown>
  ): Promise<JobDTO> {
    const row = await this.getRow(userId, id);

    if (row.status !== "complete") {
      throw new PipelineError(
        `Extraction not ready for editing (status: ${row.status})`,
        { code: "BAD_REQUEST", retryable: false }
      );
    }

    const profile = getProfileManager().getOrFallback(String(row.profile_type));
    const mode: ExtractionMode = (row.extraction_mode as ExtractionMode) ?? "legacy";
    const schemaKeys = new Set(profile.schema.fields.map((f) => f.key));

    const stored = (Array.isArray(row.fields_json)
      ? row.fields_json
      : []) as FieldDTO[];
    const byKey = new Map(stored.map((f) => [f.key, f] as const));

    // Which keys may be corrected depends on the extraction mode:
    // - legacy: only profile-schema keys (unchanged behaviour).
    // - dynamic: only fields the extraction actually produced AND that are
    //   structurally safe keys. Editing a dynamic field never creates new
    //   fields, so the no-invention contract (nothing beyond what the document
    //   produced) is preserved — the user can fix a discovered value but
    //   cannot inject arbitrary keys.
    const allowedKey = (k: string): boolean => {
      if (mode === "legacy") return schemaKeys.has(k);
      return stored.some((f) => f.key === k) && safeFieldKey(k) === k;
    };
    const unknown = Object.keys(overrides).filter((k) => !allowedKey(k));
    if (unknown.length > 0) {
      throw new PipelineError(`Unknown field(s): ${unknown.join(", ")}`, {
        code: "BAD_REQUEST",
        retryable: false,
      });
    }

    for (const [key, rawValue] of Object.entries(overrides)) {
      const schema = profile.schema.fields.find((f) => f.key === key);
      const existing = byKey.get(key);
      // Dynamic fields carry their persisted type/label; legacy fields resolve
      // to their profile schema. Either way the type is known before coercion.
      const type =
        schema?.type ?? (existing?.type as FieldSchema["type"]) ?? "string";
      const value = coerceValue(rawValue, type);
      const label = schema?.label ?? existing?.label ?? key;
      if (existing) {
        existing.value = value;
        existing.type = type;
        existing.label = label;
        existing.confidence = 1;
        existing.source = "verified";
        existing.status = "edited";
        existing.alternatives = undefined;
        existing.reasons = undefined;
      } else {
        byKey.set(key, {
          key,
          value,
          type,
          label,
          confidence: 1,
          source: "verified",
          status: "edited",
        });
      }
    }

    const fields = Array.from(byKey.values());

    // Recompute validation + confidence from the edited snapshot using the
    // SAME engine as the pipeline (single source of truth for confidence).
    const extraction = rebuildExtraction(
      { ...row, fields_json: fields },
      profile
    );
    const validation = validateExtraction(extraction);
    const confidence = computeConfidence(extraction, validation, {
      sourceText: row.source_text ?? "",
      ocr: row.ocr_json ?? undefined,
    });

    await this.supabase
      .from("extractions")
      .update({
        fields_json: fields,
        overall_confidence: round4(confidence.overall),
        confidence_json: {
          overall: confidence.overall,
          signals: confidence.signals,
          summary: confidence.summary,
        },
        validation_json: { ok: validation.ok, missing: validation.missing },
      })
      .eq("id", id);

    const fresh = await this.getRow(userId, id);
    return toJobDTO(fresh);
  }

  /**
   * POST /pipeline/extractions/{id}/replace — swap the source file of an
   * existing extraction and re-run the pipeline in place. The old file (row +
   * storage object) is deleted; reviewed edits for the previous document are
   * intentionally discarded (they belong to the replaced file).
   */
  async replace(
    userId: string,
    id: string,
    newFileId: string
  ): Promise<{ job: JobDTO; created: boolean; rerun: boolean }> {
    const row = await this.getRow(userId, id);

    if (!isValidUUID(newFileId)) {
      throw new PipelineError("Invalid file id", {
        code: "BAD_REQUEST",
        retryable: false,
      });
    }

    const { data: newFile } = await this.supabase
      .from("files")
      .select("id")
      .eq("id", newFileId)
      .eq("user_id", userId)
      .single();
    if (!newFile) {
      throw new PipelineError("File not found", {
        code: "NOT_FOUND",
        retryable: false,
      });
    }

    // Delete the replaced file (row + storage object) once the extraction no
    // longer references it.
    const oldFileId = row.file_id;
    await this.supabase
      .from("extractions")
      .update({
        file_id: newFileId,
        idempotency_key: `file:${newFileId}`,
      })
      .eq("id", id);
    if (oldFileId && oldFileId !== newFileId) {
      await this.deleteFileRecord(userId, oldFileId);
    }

    return this.run(userId, {
      fileId: newFileId,
      idempotencyKey: `file:${newFileId}`,
      force: true,
      extractionMode: (row.extraction_mode as "legacy" | "dynamic") ?? "legacy",
    });
  }

  /** DELETE /pipeline/extractions/{id} — remove an extraction and its file. */
  async delete(userId: string, id: string): Promise<{ deleted: boolean }> {
    const row = await this.getRow(userId, id);

    if (row.file_id) {
      await this.deleteFileRecord(userId, row.file_id);
    }

    await this.supabase.from("extractions").delete().eq("id", id).eq("user_id", userId);
    return { deleted: true };
  }

  // ── internals ─────────────────────────────────────────────────────

  /** Delete a file record and its storage object (best-effort on storage). */
  private async deleteFileRecord(userId: string, fileId: string): Promise<void> {
    const { data: file } = await this.supabase
      .from("files")
      .select("id, name")
      .eq("id", fileId)
      .eq("user_id", userId)
      .single();
    if (!file) return;

    try {
      if (file.name) {
        await this.supabase.storage.from("files").remove([file.name]);
      }
    } catch (err) {
      console.error("[Pipeline] Storage cleanup failed:", err);
    }

    await this.supabase.from("files").delete().eq("id", fileId).eq("user_id", userId);
  }

  private async readFileText(
    userId: string,
    fileId: string
  ): Promise<{ text: string; ocr?: OcrDocument; fileName?: string; mimeType?: string }> {
    if (!isValidUUID(fileId)) {
      throw new PipelineError("Invalid file id", {
        code: "BAD_REQUEST",
        retryable: false,
      });
    }

    const { data: file } = await this.supabase
      .from("files")
      .select("id, name, url, mime_type, original_name")
      .eq("id", fileId)
      .eq("user_id", userId)
      .single();

    if (!file) {
      throw new PipelineError("File not found", {
        code: "NOT_FOUND",
        retryable: false,
      });
    }

    let buffer: Buffer | null = null;
    try {
      // Service-role storage download (path = file.name) is primary.
      const { data, error } = await this.supabase.storage
        .from("files")
        .download(file.name);
      if (error || !data) throw new Error(error?.message ?? "no data");
      buffer = Buffer.from(await data.arrayBuffer());
    } catch {
      // Fallback: public URL.
      if (file.url) {
        const res = await fetch(file.url);
        if (res.ok) buffer = Buffer.from(await res.arrayBuffer());
      }
    }

    if (!buffer) {
      throw new PipelineError("Failed to read file from storage", {
        code: "FILE_READ_ERROR",
        retryable: true,
      });
    }

    const parsed = await parseFileBufferDetailed(buffer, file.mime_type, file.original_name);
    if (!parsed.text.trim()) {
      throw new PipelineError("No text could be extracted from the file", {
        code: "EMPTY_DOCUMENT",
        retryable: false,
      });
    }

    return {
      text: parsed.text.slice(0, MAX_SOURCE_TEXT),
      ocr: parsed.ocr,
      fileName: file.original_name,
      mimeType: file.mime_type,
    };
  }

  private async findByKey(
    userId: string,
    idempotencyKey: string
  ): Promise<Row | null> {
    const { data } = await this.supabase
      .from("extractions")
      .select("*")
      .eq("user_id", userId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    return (data as Row | null) ?? null;
  }

  private async getRow(userId: string, id: string): Promise<Row> {
    const { data } = await this.supabase
      .from("extractions")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (!data) {
      throw new PipelineError("Extraction not found", {
        code: "NOT_FOUND",
        retryable: false,
      });
    }
    return data as unknown as Row;
  }

  // ── Stale-run reconciliation ────────────────────────────────────────
  //
  // `finally` cannot cover process death / platform timeout / DB outage, so a
  // row can be left in an intermediate status forever. Read paths
  // opportunistically reconcile such rows to a diagnosable `error`. The stale
  // mark is non-destructive: terminal writes (complete/error) are unguarded
  // and always win over it.

  /** True when the row is stuck in an intermediate status past the threshold. */
  private isStalePhase(row: Row): boolean {
    if (!INTERMEDIATE_STATUSES.includes(String(row.status ?? ""))) return false;
    const updated = new Date(row.updated_at as string).getTime();
    if (Number.isNaN(updated)) return false;
    return updated < Date.now() - STALE_JOB_MS;
  }

  private interruptedError(): StructuredError {
    return {
      stage: "run",
      code: "PIPELINE_INTERRUPTED",
      message:
        "Pipeline run interrupted before completion (process died or the run stalled). Re-run with force:true.",
      retryable: true,
    };
  }

  /** Mark one stale intermediate row as interrupted, guarded against terminals. */
  private async markRowInterrupted(userId: string, id: string): Promise<Row> {
    await this.supabase
      .from("extractions")
      .update({
        status: "error",
        error_json: this.interruptedError(),
        completed_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", userId)
      .in("status", INTERMEDIATE_STATUSES);
    return this.getRow(userId, id);
  }

  /** Sweep the user's stale intermediate rows (list endpoint). */
  private async sweepStale(userId: string): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_JOB_MS).toISOString();
    try {
      const { error } = await this.supabase
        .from("extractions")
        .update({
          status: "error",
          error_json: this.interruptedError(),
          completed_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .in("status", INTERMEDIATE_STATUSES)
        .lt("updated_at", cutoff);
      if (error) {
        console.error("[Pipeline] stale reconciliation failed:", error);
      }
    } catch (err) {
      console.error("[Pipeline] stale reconciliation failed:", err);
    }
  }
}

/** Map a stage id to the persisted phase status (or null for unknown stages). */
function stageToStatus(stageId: string): string | null {
  switch (stageId) {
    case "classify":
      return "classifying";
    case "extract":
    case "ground":
    case "clean":
    case "recover":
      return "extracting";
    case "validate":
    case "confidence":
      return "validating";
    default:
      return null;
  }
}

/** Rebuild an ExtractionResult from stored fields for export/DTO needs. */
function rebuildExtraction(
  row: Row,
  profile: ReturnType<ReturnType<typeof getProfileManager>["getOrFallback"]>
): ExtractionResult {
  const mode: ExtractionMode = (row.extraction_mode as ExtractionMode) ?? "legacy";
  const stored = (Array.isArray(row.fields_json) ? row.fields_json : []) as FieldDTO[];
  const fields: NormalizedField[] = stored.map((s) => {
    const schemaField = profile.schema.fields.find((f) => f.key === s.key);
    // Fields that belong to the profile schema are reconstructed from that
    // schema (legacy byte-identical). Dynamic fields keep their persisted
    // discovered type/label instead of degrading to an untyped string.
    const fieldSchema =
      schemaField ??
      (s.type
        ? {
            key: s.key,
            type: s.type as FieldSchema["type"],
            label: s.label ?? s.key,
          }
        : { key: s.key, type: "string" as const, label: s.key });
    return {
      field: fieldSchema,
      value: {
        value: s.value,
        rawValue: s.raw,
        confidence: s.confidence,
        source: s.source as never,
        status: s.status as never,
        evidence: s.evidence as FieldEvidence[] | undefined,
        alternatives: s.alternatives,
        reasons: s.reasons,
      },
    };
  });

  const fieldsMap: FieldsMap = {};
  const cleanFields: Record<string, unknown> = {};
  for (const f of fields) {
    fieldsMap[f.field.key] = f.value;
    if (!isEmptyValue(f.value.value)) {
      cleanFields[f.field.key] = f.value.value;
    }
  }

  return {
    profileType: String(row.profile_type) as ProfileType,
    profileVersion: row.profile_version,
    extractionMode: mode,
    fields,
    fieldsMap,
    cleanFields,
    droppedFields: {},
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
  };
}

function serializeFields(extraction: ExtractionResult): FieldDTO[] {
  return extraction.fields.map((f) => ({
    key: f.field.key,
    value: f.value.value,
    raw: f.value.rawValue,
    type: f.field.type,
    label: f.field.label ?? f.field.key,
    evidence: f.value.evidence,
    confidence: round4(f.value.confidence),
    source: f.value.source,
    status: f.value.status,
    alternatives: f.value.alternatives,
    reasons: f.value.reasons,
  }));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Coerce an edited value to the field schema type (light validation). */
function coerceValue(raw: unknown, type: FieldSchema["type"]): unknown {
  if (raw === null || raw === undefined || raw === "") {
    return type === "string" || type === "text" ? "" : null;
  }
  if (type === "number" || type === "currency") {
    const n = typeof raw === "number" ? raw : Number(String(raw));
    if (!Number.isFinite(n)) {
      throw new PipelineError(`'${String(raw)}' is not a number`, {
        code: "BAD_REQUEST",
        retryable: false,
      });
    }
    return n;
  }
  if (type === "boolean") {
    if (typeof raw === "boolean") return raw;
    const s = String(raw).toLowerCase();
    if (["true", "1", "yes"].includes(s)) return true;
    if (["false", "0", "no"].includes(s)) return false;
    throw new PipelineError(`'${String(raw)}' is not a boolean`, {
      code: "BAD_REQUEST",
      retryable: false,
    });
  }
  return raw;
}

// Row type is intentionally loose: it mirrors the DB row for DTO mapping.
type Row = Parameters<typeof toJobDTO>[0];

export type { StructuredError };
