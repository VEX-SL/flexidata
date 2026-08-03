"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface FieldDTO {
  key: string;
  value: unknown;
  raw?: unknown;
  evidence?: Array<{
    quote: string;
    lineIndex?: number;
    role?: string;
    confidence?: number;
    context?: string;
  }>;
  confidence: number;
  source: string;
  status: string;
  alternatives?: unknown[];
  reasons?: string[];
}

export interface JobDTO {
  id: string;
  status: string;
  fileId: string | null;
  profileType: string;
  profileVersion: number;
  pipelineVersion: number;
  provider?: string | null;
  model?: string | null;
  processingTimeMs?: number | null;
  overallConfidence?: number | null;
  createdAt: string;
  completedAt?: string | null;
  error?: {
    stage?: string;
    code: string;
    message: string;
    retryable: boolean;
  } | null;
  fields: FieldDTO[] | null;
  validation?: { ok: boolean; missing: string[] } | null;
  confidence?: {
    overall: number;
    signals: Record<string, number>;
    summary?: Array<{ label: string; score: number; detail?: string }>;
  } | null;
  sourceText?: string | null;
  fileUrl?: string | null;
  ocr?: {
    text: string;
    lines: Array<{ text: string; confidence?: number; words: Array<{ text: string; confidence?: number }> }>;
    confidence?: number;
  } | null;
  url?: string;
}

/** One document row in the inbox (extraction + its transient local state). */
export interface DocItem {
  key: string;
  job: JobDTO | null;
  fileName?: string;
  uploading?: boolean;
  replacing?: boolean;
  rerunning?: boolean;
  removing?: boolean;
  localError?: string;
}

const RUNNING = new Set(["queued", "classifying", "extracting", "validating"]);
const POLL_INTERVAL = 1600;
const MAX_POLLS = 150;

/**
 * Client-side driver for the Documents inbox:
 * loads the extraction list, uploads + runs documents, polls running jobs,
 * and exposes replace / delete / re-run / save-fields actions.
 */
export function useDocuments() {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);

  const docsRef = useRef<DocItem[]>([]);
  useEffect(() => {
    docsRef.current = docs;
  });

  const inFlight = useRef<Set<string>>(new Set());
  const attempts = useRef<Map<string, number>>(new Map());
  const aborters = useRef<Map<string, AbortController>>(new Map());
  const nextKey = useRef(0);

  const patchDoc = useCallback((key: string, patch: Partial<DocItem>) => {
    setDocs((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/pipeline/extractions?limit=50");
      if (!res.ok) return;
      const data = await res.json();
      const items: JobDTO[] = data.items ?? [];
      setDocs(items.map((job) => ({ key: job.id, job })));
      setActiveId((cur) =>
        cur && items.some((j) => j.id === cur) ? cur : null
      );
    } catch {
      // non-critical — the inbox stays usable for uploads
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const poll = useCallback(async (id: string) => {
    if (inFlight.current.has(id)) return;
    const n = attempts.current.get(id) ?? 0;
    if (n >= MAX_POLLS) {
      attempts.current.delete(id);
      return;
    }
    attempts.current.set(id, n + 1);
    inFlight.current.add(id);
    try {
      const res = await fetch(`/api/pipeline/extractions/${id}`);
      if (res.status === 404) {
        attempts.current.delete(id);
        setDocs((prev) => prev.filter((d) => d.job?.id !== id));
        setActiveId((cur) => (cur === id ? null : cur));
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      const job = data.job as JobDTO;
      setDocs((prev) =>
        prev.map((d) => (d.job?.id === id ? { ...d, job } : d))
      );
      if (!RUNNING.has(job.status)) attempts.current.delete(id);
    } catch {
      // transient network error — retry on the next tick
    } finally {
      inFlight.current.delete(id);
    }
  }, []);

  // Poll every running job until it reaches a terminal state.
  useEffect(() => {
    const timer = setInterval(() => {
      for (const d of docsRef.current) {
        if (d.job && RUNNING.has(d.job.status)) poll(d.job.id);
      }
    }, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [poll]);

  const processFile = useCallback(
    async (file: File) => {
      const key = `tmp-${nextKey.current++}`;
      setDocs((prev) => [
        { key, job: null, fileName: file.name, uploading: true },
        ...prev,
      ]);

      const controller = new AbortController();
      aborters.current.set(key, controller);

      let fileId: string;
      try {
        const form = new FormData();
        form.append("file", file);
        const upRes = await fetch("/api/upload", {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        if (!upRes.ok) {
          const body = await upRes.json().catch(() => null);
          throw new Error(body?.error ?? "Upload failed");
        }
        const up = await upRes.json();
        fileId = up.id;
      } catch (err) {
        aborters.current.delete(key);
        const aborted =
          err instanceof DOMException && err.name === "AbortError";
        if (!aborted) {
          patchDoc(key, {
            uploading: false,
            localError: err instanceof Error ? err.message : "Upload failed",
          });
        }
        return;
      }
      aborters.current.delete(key);
      patchDoc(key, { uploading: false, fileName: file.name });

      try {
        const runRes = await fetch("/api/pipeline/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileId,
            idempotencyKey: `file:${fileId}`,
            fileName: file.name,
            mimeType: file.type,
          }),
        });
        if (!runRes.ok) {
          const body = await runRes.json().catch(() => null);
          throw new Error(body?.error?.message ?? "Pipeline run failed");
        }
        const data = await runRes.json();
        const job = data.job as JobDTO;
        setDocs((prev) =>
          prev.map((d) => (d.key === key ? { ...d, key: job.id, job } : d))
        );
        setActiveId((cur) => cur ?? job.id);
        if (RUNNING.has(job.status)) poll(job.id);
      } catch (err) {
        patchDoc(
          key,
          err instanceof Error
            ? { localError: err.message }
            : { localError: "Pipeline run failed" }
        );
      }
    },
    [patchDoc, poll]
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      for (const f of files) await processFile(f);
    },
    [processFile]
  );

  const replace = useCallback(
    async (id: string, file: File) => {
      patchDoc(id, { replacing: true, localError: undefined });
      try {
        const form = new FormData();
        form.append("file", file);
        const upRes = await fetch("/api/upload", { method: "POST", body: form });
        if (!upRes.ok) {
          const body = await upRes.json().catch(() => null);
          throw new Error(body?.error ?? "Upload failed");
        }
        const up = await upRes.json();

        const res = await fetch(`/api/pipeline/extractions/${id}/replace`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId: up.id }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message ?? "Replace failed");
        }
        const data = await res.json();
        const job = data.job as JobDTO;
        setDocs((prev) =>
          prev.map((d) =>
            d.job?.id === id ? { ...d, job, fileName: file.name } : d
          )
        );
        if (RUNNING.has(job.status)) poll(job.id);
      } catch (err) {
        patchDoc(
          id,
          err instanceof Error
            ? { localError: err.message }
            : { localError: "Replace failed" }
        );
      } finally {
        patchDoc(id, { replacing: false });
      }
    },
    [patchDoc, poll]
  );

  const rerun = useCallback(
    async (id: string) => {
      const item = docsRef.current.find((d) => d.job?.id === id);
      const fileId = item?.job?.fileId;
      if (!fileId) return;
      patchDoc(id, { rerunning: true, localError: undefined });
      try {
        const res = await fetch("/api/pipeline/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileId,
            idempotencyKey: `file:${fileId}`,
            force: true,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message ?? "Re-run failed");
        }
        const data = await res.json();
        const job = data.job as JobDTO;
        setDocs((prev) =>
          prev.map((d) => (d.job?.id === id ? { ...d, job } : d))
        );
        if (RUNNING.has(job.status)) poll(job.id);
      } catch (err) {
        patchDoc(
          id,
          err instanceof Error
            ? { localError: err.message }
            : { localError: "Re-run failed" }
        );
      } finally {
        patchDoc(id, { rerunning: false });
      }
    },
    [patchDoc, poll]
  );

  const remove = useCallback(
    async (key: string) => {
      const item = docsRef.current.find((d) => d.key === key);
      if (!item) return;

      // Still uploading — cancel the in-flight request and drop the row.
      const controller = aborters.current.get(key);
      if (controller) {
        controller.abort();
        aborters.current.delete(key);
        setDocs((prev) => prev.filter((d) => d.key !== key));
        setActiveId((cur) => (cur === key ? null : cur));
        return;
      }

      const id = item.job?.id;
      if (!id) return;
      patchDoc(key, { removing: true });
      try {
        const res = await fetch(`/api/pipeline/extractions/${id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message ?? "Delete failed");
        }
        setDocs((prev) => prev.filter((d) => d.job?.id !== id));
        setActiveId((cur) => (cur === id ? null : cur));
      } catch (err) {
        patchDoc(
          key,
          err instanceof Error
            ? { localError: err.message }
            : { localError: "Delete failed" }
        );
      } finally {
        patchDoc(key, { removing: false });
      }
    },
    [patchDoc]
  );

  const saveFields = useCallback(async (id: string, overrides: Record<string, unknown>) => {
    const res = await fetch(`/api/pipeline/extractions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: overrides }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error?.message ?? "Failed to save fields");
    }
    const data = await res.json();
    const job = data.job as JobDTO;
    setDocs((prev) =>
      prev.map((d) => (d.job?.id === id ? { ...d, job } : d))
    );
    return job;
  }, []);

  return {
    docs,
    loading,
    activeId,
    setActiveId,
    refresh,
    addFiles,
    replace,
    rerun,
    remove,
    saveFields,
  };
}
