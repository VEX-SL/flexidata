"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface FieldDTO {
  key: string;
  value: unknown;
  confidence: number;
  source: string;
  status: string;
}

export interface JobDTO {
  id: string;
  status: string;
  profileType: string;
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
  sourceText?: string | null;
}

export type PipelinePhase =
  | "idle"
  | "uploading"
  | "queued"
  | "classifying"
  | "extracting"
  | "validating"
  | "complete"
  | "error";

const RUNNING_STAGES = ["queued", "classifying", "extracting", "validating"] as const;
type RunningStage = (typeof RUNNING_STAGES)[number];

const TERMINAL = new Set(["complete", "error"]);
const POLL_INTERVAL = 1600;
const MAX_POLLS = 150;

/**
 * Client-side driver for the document pipeline:
 * upload → run → (poll) → review. Exposes phase, the job DTO, and actions.
 */
export function usePipeline() {
  const [phase, setPhase] = useState<PipelinePhase>("idle");
  const [job, setJob] = useState<JobDTO | null>(null);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [activeFileName, setActiveFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stageIndex, setStageIndex] = useState(0);

  const pollTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const timers = pollTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  // Animate through the running stages while the pipeline is in flight.
  useEffect(() => {
    if (!RUNNING_STAGES.includes(phase as RunningStage)) return;
    const t = setInterval(() => {
      setStageIndex((i) => (i + 1) % RUNNING_STAGES.length);
    }, 1500);
    return () => clearInterval(t);
  }, [phase]);

  const extractError = useCallback(
    async (res: Response, fallback: string): Promise<string> => {
      try {
        const body = await res.json();
        return body?.error?.message ?? body?.error ?? fallback;
      } catch {
        return fallback;
      }
    },
    []
  );

  const pollUntilTerminal = useCallback((id: string) => {
    return new Promise<JobDTO>((resolve, reject) => {
      let attempts = 0;
      const tick = () => {
        if (attempts++ >= MAX_POLLS) {
          reject(new Error("Timed out waiting for extraction"));
          return;
        }
        const t = setTimeout(async () => {
          try {
            const res = await fetch(`/api/pipeline/extractions/${id}`);
            if (!res.ok) throw new Error("Poll failed");
            const data = await res.json();
            const j = data.job as JobDTO;
            setJob(j);
            if (j.status === "complete") {
              setPhase("complete");
              resolve(j);
              return;
            }
            if (j.status === "error") {
              setPhase("error");
              setError(j.error?.message ?? "Extraction failed");
              reject(new Error(j.error?.message ?? "Extraction failed"));
              return;
            }
            setPhase(j.status as PipelinePhase);
            tick();
          } catch {
            tick();
          }
        }, POLL_INTERVAL);
        pollTimers.current.push(t);
      };
      tick();
    });
  }, []);

  const applyJob = useCallback((j: JobDTO) => {
    setJob(j);
    if (TERMINAL.has(j.status)) {
      setPhase(j.status as PipelinePhase);
      if (j.status === "error") setError(j.error?.message ?? "Extraction failed");
    } else {
      setPhase(j.status as PipelinePhase);
    }
  }, []);

  const runPipeline = useCallback(
    async (file: File) => {
      setPhase("uploading");
      setError(null);
      setJob(null);
      setActiveFileName(file.name);

      let fileId: string;
      try {
        const form = new FormData();
        form.append("file", file);
        const upRes = await fetch("/api/upload", { method: "POST", body: form });
        if (!upRes.ok) {
          setPhase("error");
          setError(await extractError(upRes, "Upload failed"));
          return;
        }
        const up = await upRes.json();
        fileId = up.id;
        setActiveFileId(fileId);
      } catch {
        setPhase("error");
        setError("Upload failed");
        return;
      }

      setPhase("queued");
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
          setPhase("error");
          setError(
            await extractError(runRes, `Pipeline run failed (${runRes.status})`)
          );
          return;
        }
        const data = await runRes.json();
        applyJob(data.job as JobDTO);
        if (!TERMINAL.has((data.job as JobDTO).status)) {
          await pollUntilTerminal((data.job as JobDTO).id).catch(() => {});
        }
      } catch {
        setPhase("error");
        setError("Pipeline run failed");
      }
    },
    [applyJob, extractError, pollUntilTerminal]
  );

  const rerun = useCallback(async () => {
    const id = job?.id;
    if (!id || !activeFileId) return;
    setPhase("queued");
    setError(null);
    try {
      const runRes = await fetch("/api/pipeline/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: activeFileId,
          idempotencyKey: `file:${activeFileId}`,
          force: true,
        }),
      });
      if (!runRes.ok) {
        setPhase("error");
        setError(await extractError(runRes, "Re-run failed"));
        return;
      }
      const data = await runRes.json();
      applyJob(data.job as JobDTO);
      if (!TERMINAL.has((data.job as JobDTO).status)) {
        await pollUntilTerminal((data.job as JobDTO).id).catch(() => {});
      }
    } catch {
      setPhase("error");
      setError("Re-run failed");
    }
  }, [activeFileId, job, applyJob, extractError, pollUntilTerminal]);

  const loadJob = useCallback(
    async (id: string) => {
      setActiveFileId(null);
      setActiveFileName(null);
      setError(null);
      try {
        const res = await fetch(`/api/pipeline/extractions/${id}`);
        if (!res.ok) throw new Error("Failed to load extraction");
        const data = await res.json();
        applyJob(data.job as JobDTO);
        if (!TERMINAL.has((data.job as JobDTO).status)) {
          await pollUntilTerminal((data.job as JobDTO).id).catch(() => {});
        }
      } catch {
        setPhase("error");
        setError("Failed to load extraction");
      }
    },
    [applyJob, pollUntilTerminal]
  );

  const saveFields = useCallback(
    async (overrides: Record<string, unknown>): Promise<JobDTO> => {
      const id = job?.id;
      if (!id) throw new Error("No active extraction");
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
      setJob(data.job as JobDTO);
      return data.job as JobDTO;
    },
    [job]
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setJob(null);
    setError(null);
    setActiveFileId(null);
    setActiveFileName(null);
    setStageIndex(0);
  }, []);

  return {
    phase,
    job,
    error,
    activeFileName,
    stageIndex,
    runPipeline,
    rerun,
    loadJob,
    saveFields,
    reset,
  };
}
