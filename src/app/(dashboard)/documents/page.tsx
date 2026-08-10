"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Upload,
  FileText,
  Loader2,
  Check,
  AlertTriangle,
  X,
  Pencil,
  CheckCircle2,
  Download,
  RefreshCw,
  Trash2,
  History,
  ScanText,
  Sparkles,
  ShieldCheck,
  Clipboard,
  FileClock,
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import {
  useDocuments,
  type DocItem,
  type JobDTO,
  type FieldDTO,
} from "@/lib/hooks/use-documents";
import { downloadBlob } from "@/lib/download";

const RUNNING = new Set(["queued", "classifying", "extracting", "validating"]);
const EXPORT_FORMATS = ["json", "csv"] as const;
const ACCEPT =
  ".pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.json,.jpg,.jpeg,.png,.gif,.webp";

/* ─── Client-side schema DTO (mirrors GET /api/pipeline/profiles) ─────── */

interface FieldSchemaDTO {
  key: string;
  type: string;
  itemsType?: string;
  enum?: string[];
  label?: string;
  description?: string;
  required?: boolean;
}

interface ProfileSchemaDTO {
  id: string;
  label: string;
  version: number;
  docTypes: string[];
  schema?: {
    version: number;
    fields: FieldSchemaDTO[];
    groups?: Array<{ id: string; label: string; keys: string[] }>;
  };
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function humanize(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * M22 — a discovery job's title is never a raw OCR slice (that would
 * concatenate garbled OCR lines into an invented title). Prefer a discovered
 * title-ish grounded field (label/key mentioning title, merchant, store,
 * description or name) when one exists; otherwise return undefined so the
 * caller shows a neutral label. Legacy jobs are untouched.
 */
function discoveryTitle(job: JobDTO | null): string | undefined {
  if (!job || job.extractionMode !== "dynamic") return undefined;
  const fields = job.fields ?? [];
  const haystack = (f: FieldDTO) =>
    `${f.label ?? ""} ${f.key}`.toLowerCase();
  const pick = (needle: string) =>
    fields.find((f) => haystack(f).includes(needle));
  const titleLike =
    pick("title") ??
    pick("merchant") ??
    pick("store") ??
    pick("vendor") ??
    pick("description") ??
    pick("name");
  const v = titleLike?.value;
  const s =
    typeof v === "string"
      ? v
      : v === null || v === undefined
        ? ""
        : JSON.stringify(v);
  return s.trim().slice(0, 60) || undefined;
}

function displayValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (Array.isArray(v)) return v.length ? JSON.stringify(v, null, 2) : "";
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}

function confidenceColor(c: number): string {
  if (c >= 0.9) return "#22C55E";
  if (c >= 0.7) return "#F59E0B";
  return "#EF4444";
}

const BREAKDOWN_KEY: Record<string, string> = {
  Validation: "validation",
  "Cross-field consistency": "consistency",
  "OCR / text quality": "ocrQuality",
  "Extraction confidence": "extraction",
  "Evidence grounding": "evidence",
  Uncertainty: "uncertainty",
  "Missing required fields": "missing",
};

function parseDraft(def: FieldSchemaDTO | undefined, draft: string): unknown {
  const type = def?.type ?? "string";
  switch (type) {
    case "number":
    case "currency": {
      if (!draft.trim()) return null;
      const n = Number(draft.trim());
      if (!Number.isFinite(n)) throw new Error("Value must be a number");
      return n;
    }
    case "boolean": {
      if (draft === "") return null;
      return draft === "true" || draft === "1";
    }
    case "array": {
      if (!draft.trim()) return [];
      const v = JSON.parse(draft.trim());
      if (!Array.isArray(v)) throw new Error("Value must be a JSON array");
      return v;
    }
    case "object": {
      if (!draft.trim()) return null;
      const v = JSON.parse(draft.trim());
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        throw new Error("Value must be a JSON object");
      }
      return v;
    }
    default:
      return draft;
  }
}

/* ─── Page ────────────────────────────────────────────────────────────── */

export default function DocumentsPage() {
  const { t } = useTranslation();
  const {
    docs,
    loading,
    activeId,
    setActiveId,
    addFiles,
    replace,
    rerun,
    remove,
    saveFields,
  } = useDocuments();

  const [profiles, setProfiles] = useState<ProfileSchemaDTO[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exportFormat, setExportFormat] =
    useState<(typeof EXPORT_FORMATS)[number]>("json");
  const [exporting, setExporting] = useState(false);
  const [editing, setEditing] = useState<{ key: string; draft: string } | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [replaceFor, setReplaceFor] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const dropInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/pipeline/profiles")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setProfiles(data?.items ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  const profileLabel = useCallback(
    (id: string): string => {
      const p = profiles.find((x) => x.id === id);
      return p?.label ?? t(`documents.profile.${id}`);
    },
    [profiles, t]
  );

  const activeDoc = activeId ? docs.find((d) => d.key === activeId) : null;
  const activeJob = activeDoc?.job ?? null;
  const activeSchema =
    activeJob && activeJob.status === "complete"
      ? profiles.find((p) => p.id === activeJob.profileType)?.schema
      : undefined;

  async function handleDropFiles(files: File[]) {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setBusy(true);
    try {
      await addFiles(list);
    } finally {
      setBusy(false);
    }
  }

  async function handleExport(job: JobDTO) {
    setExporting(true);
    try {
      const res = await fetch(
        `/api/pipeline/extractions/${job.id}/export?format=${exportFormat}`
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setToast(body?.error?.message ?? "Export failed");
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const match = cd.match(/filename="?([^"]+)"?/);
      downloadBlob(blob, match?.[1] ?? `${job.id}.${exportFormat}`);
    } finally {
      setExporting(false);
    }
  }

  function handleRowSelect(item: DocItem) {
    setEditing(null);
    setFieldError(null);
    if (item.job) setActiveId(item.job.id);
  }

  async function handleFieldSave(job: JobDTO, key: string) {
    if (!editing) return;
    const persisted = job.fields?.find((f) => f.key === key);
    const def =
      activeSchema?.fields.find((f) => f.key === key) ??
      (persisted
        ? {
            key,
            type: persisted.type ?? "string",
            label: persisted.label ?? key,
          }
        : undefined);
    setSavingKey(key);
    setFieldError(null);
    try {
      const parsed = parseDraft(def, editing.draft);
      await saveFields(job.id, { [key]: parsed });
      setEditing(null);
      setToast(t("documents.saved"));
    } catch (e) {
      setFieldError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingKey(null);
    }
  }

  const runningDocs = docs.filter(
    (d) => d.job && RUNNING.has(d.job.status)
  ).length;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&display=swap');
        .fd-doc-root { font-family: 'Sora', system-ui, sans-serif; }
        .fd-doc-hero {
          position: relative; overflow: hidden;
          border-radius: 20px; padding: 1.8rem 1.75rem;
          background: linear-gradient(135deg, rgba(16,185,129,.1) 0%, rgba(99,102,241,.08) 50%, rgba(59,130,246,.06) 100%);
          border: 1px solid rgba(129,140,248,.12);
        }
        [data-theme="light"] .fd-doc-hero {
          background: linear-gradient(135deg, rgba(16,185,129,.05) 0%, rgba(99,102,241,.04) 50%, rgba(59,130,246,.03) 100%);
          border-color: rgba(99,102,241,.1);
        }
        .fd-doc-hero-orb {
          position: absolute; width: 380px; height: 380px; border-radius: 50%;
          background: radial-gradient(circle, rgba(16,185,129,.14) 0%, transparent 70%);
          filter: blur(60px); top: -130px; right: -90px; pointer-events: none;
        }
        .fd-doc-card {
          border-radius: 16px; border: 1px solid var(--color-border);
          background: var(--color-card); overflow: hidden;
        }
        .fd-doc-card-pad { padding: 1.3rem 1.3rem; }
        .fd-doc-btn {
          display: inline-flex; align-items: center; gap: .45rem;
          padding: .55rem .95rem; border-radius: 11px;
          font-size: .8rem; font-weight: 600; font-family: inherit;
          border: none; cursor: pointer; transition: all .2s;
        }
        .fd-doc-btn:disabled { opacity: .5; cursor: not-allowed; }
        .fd-doc-btn-primary {
          background: linear-gradient(135deg, #10B981, #059669);
          color: #fff; box-shadow: 0 4px 14px rgba(16,185,129,.22);
        }
        .fd-doc-btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(16,185,129,.32); }
        .fd-doc-btn-indigo {
          background: linear-gradient(135deg, #6366F1, #8B5CF6);
          color: #fff; box-shadow: 0 4px 14px rgba(99,102,241,.25);
        }
        .fd-doc-btn-indigo:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(99,102,241,.35); }
        .fd-doc-btn-secondary {
          background: var(--color-card); color: var(--color-foreground);
          border: 1px solid var(--color-border);
        }
        .fd-doc-btn-secondary:hover:not(:disabled) { border-color: rgba(99,102,241,.3); background: var(--color-accent); }
        .fd-doc-btn-danger {
          background: rgba(239,68,68,.12); color: #EF4444;
          border: 1px solid rgba(239,68,68,.3);
        }
        .fd-doc-btn-danger:hover:not(:disabled) { background: rgba(239,68,68,.18); }
        .fd-doc-chip {
          display: inline-flex; align-items: center; gap: .35rem;
          padding: .28rem .6rem; border-radius: 999px;
          font-size: .72rem; font-weight: 600; white-space: nowrap;
        }
        .fd-doc-upload {
          position: relative; border-radius: 16px; padding: 2rem 1.5rem;
          border: 2px dashed var(--color-border); text-align: center;
          transition: border-color .25s, background .25s; cursor: pointer;
        }
        .fd-doc-upload:hover { border-color: rgba(16,185,129,.4); background: rgba(16,185,129,.03); }
        .fd-doc-upload.dragging { border-color: rgba(16,185,129,.55); background: rgba(16,185,129,.06); }
        .fd-doc-upload-icon {
          width: 54px; height: 54px; border-radius: 16px; margin: 0 auto .85rem;
          background: linear-gradient(135deg, rgba(16,185,129,.12), rgba(99,102,241,.08));
          display: flex; align-items: center; justify-content: center;
        }
        .fd-doc-row {
          display: flex; align-items: center; gap: .85rem;
          padding: .8rem .95rem; border-radius: 14px;
          border: 1px solid var(--color-border); background: var(--color-card);
          cursor: pointer; transition: background .15s, border-color .15s;
        }
        .fd-doc-row:hover { background: var(--color-accent); border-color: rgba(129,140,248,.25); }
        .fd-doc-row.active { border-color: rgba(99,102,241,.45); background: rgba(99,102,241,.05); }
        .fd-doc-row-icon {
          width: 40px; height: 40px; border-radius: 11px; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center;
        }
        .fd-doc-field-row {
          display: flex; align-items: center; gap: .9rem;
          padding: .8rem .95rem; border-radius: 12px;
          border: 1px solid transparent; transition: background .15s, border-color .15s;
        }
        .fd-doc-field-row:hover { background: var(--color-accent); }
        .fd-doc-field-row.editing { border-color: rgba(99,102,241,.3); background: rgba(99,102,241,.05); }
        .fd-doc-field-value {
          font-size: .88rem; font-weight: 600; color: var(--color-foreground);
          word-break: break-word; margin: 0;
        }
        .fd-doc-field-value.empty { color: var(--color-muted-foreground); font-weight: 400; font-style: italic; }
        .fd-doc-field-pre {
          font-size: .78rem; color: var(--color-foreground);
          background: var(--color-muted); border-radius: 8px;
          padding: .5rem .65rem; overflow-x: auto; max-height: 160px;
          white-space: pre-wrap; word-break: break-word; margin: 0;
          font-family: 'SF Mono', ui-monospace, Consolas, monospace;
        }
        .fd-doc-input {
          width: 100%; padding: .55rem .7rem; border-radius: 10px;
          font-size: .85rem; font-family: inherit;
          background: var(--color-background); border: 1px solid var(--color-border);
          color: var(--color-foreground); outline: none; box-sizing: border-box;
          transition: border-color .2s, box-shadow .2s;
        }
        .fd-doc-input:focus { border-color: rgba(99,102,241,.45); box-shadow: 0 0 0 3px rgba(99,102,241,.08); }
        .fd-doc-select {
          padding: .55rem .7rem; border-radius: 10px;
          font-size: .85rem; font-family: inherit;
          background: var(--color-background); border: 1px solid var(--color-border);
          color: var(--color-foreground); outline: none; cursor: pointer;
        }
        .fd-doc-banner {
          display: flex; align-items: center; gap: .6rem;
          padding: .7rem .9rem; border-radius: 12px; font-size: .8rem;
        }
        .fd-doc-banner.warn { background: rgba(245,158,11,.08); border: 1px solid rgba(245,158,11,.25); color: var(--color-foreground); }
        .fd-doc-banner.ok { background: rgba(34,197,94,.08); border: 1px solid rgba(34,197,94,.25); color: var(--color-foreground); }
        .fd-doc-toast {
          position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
          background: rgba(17,24,39,.92); color: #fff; padding: .65rem 1.1rem;
          border-radius: 12px; font-size: .82rem; font-weight: 600; z-index: 60;
          box-shadow: 0 8px 30px rgba(0,0,0,.25); animation: fd-doc-rise .25s ease both;
        }
        @keyframes fd-doc-rise {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .fd-doc-enter { animation: fd-doc-rise .5s cubic-bezier(.16,1,.3,1) both; }
        .fd-doc-enter-d1 { animation-delay: .1s; }
        .fd-doc-tabs { display: inline-flex; gap: .25rem; padding: .25rem; border-radius: 10px; background: var(--color-muted); }
        .fd-doc-tab {
          padding: .4rem .9rem; border-radius: 8px; font-size: .78rem; font-weight: 600;
          color: var(--color-muted-foreground); border: none; background: transparent; cursor: pointer;
        }
        .fd-doc-tab.active { background: var(--color-card); color: var(--color-foreground); box-shadow: 0 1px 4px rgba(0,0,0,.08); }
        .fd-doc-ocr-lines {
          display: flex; flex-direction: column; gap: .1rem;
          font-family: 'SF Mono', ui-monospace, Consolas, monospace; font-size: .78rem;
          max-height: 420px; overflow: auto;
        }
        .fd-doc-ocr-line { display: flex; align-items: baseline; gap: .6rem; padding: .14rem .5rem; border-radius: 6px; }
        .fd-doc-ocr-line.uncertain { background: rgba(239,68,68,.08); }
        .fd-doc-ocr-line.evidence { background: rgba(16,185,129,.1); box-shadow: inset 2px 0 0 rgba(16,185,129,.65); }
        .fd-doc-ocr-line-no { flex-shrink: 0; width: 2.2rem; text-align: right; color: var(--color-muted-foreground); font-size: .68rem; }
        .fd-doc-ocr-line-text { flex: 1; word-break: break-word; }
        .fd-doc-ocr-word { padding: 0 .1rem; border-radius: 3px; cursor: default; }
        .fd-doc-ocr-word.uncertain { text-decoration: underline dotted rgba(239,68,68,.8); text-underline-offset: 2px; }
        .fd-doc-ocr-line-conf { flex-shrink: 0; font-size: .66rem; color: var(--color-muted-foreground); }
        .fd-doc-ocr-legend { display: flex; flex-wrap: wrap; gap: .9rem; font-size: .68rem; color: var(--color-muted-foreground); margin-top: .5rem; }
        .fd-doc-ocr-legend i { display: inline-block; width: .6rem; height: .6rem; border-radius: 3px; margin-right: .3rem; vertical-align: middle; }
        .fd-doc-ocr-legend .lg-evidence { background: rgba(16,185,129,.35); }
        .fd-doc-ocr-legend .lg-uncertain { background: rgba(239,68,68,.25); }
        .fd-doc-preview-img { max-width: 100%; border-radius: 12px; border: 1px solid var(--color-border); }
        .fd-doc-preview-label {
          font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
          color: var(--color-muted-foreground); margin-bottom: .5rem;
        }
      `}</style>

      <div className="fd-doc-root h-full overflow-auto p-6" suppressHydrationWarning>
        <div className="max-w-5xl mx-auto space-y-5">
          {toast && <div className="fd-doc-toast">{toast}</div>}

          {/* Hero */}
          <div className="fd-doc-hero fd-doc-enter">
            <div className="fd-doc-hero-orb" />
            <div className="flex flex-wrap items-center gap-3 relative z-[2]">
              <h1 className="text-2xl font-extrabold tracking-tight text-foreground m-0">
                {t("documents.title")}{" "}
                <ScanText size={22} style={{ color: "#10B981", verticalAlign: "middle" }} />
              </h1>
              <div className="flex-1" />
              {docs.length > 0 && (
                <span className="fd-doc-chip" style={{ background: "rgba(99,102,241,.1)", color: "#6366F1" }}>
                  <FileClock size={13} />
                  {docs.length} · {runningDocs} {t("documents.running").toLowerCase()}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground m-0 mt-1 relative z-[2]">
              {t("documents.subtitle")}
            </p>
          </div>

          {/* Upload — always available */}
          <div
            className={`fd-doc-upload fd-doc-enter ${dragging ? "dragging" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); handleDropFiles(Array.from(e.dataTransfer.files)); }}
            onClick={() => dropInputRef.current?.click()}
          >
            <input
              ref={dropInputRef}
              type="file"
              multiple
              className="hidden"
              accept={ACCEPT}
              onChange={(e) => { const f = Array.from(e.target.files ?? []); if (f.length) handleDropFiles(f); e.target.value = ""; }}
            />
            <div className="fd-doc-upload-icon">
              {busy ? (
                <Loader2 size={24} className="animate-spin" style={{ color: "#10B981" }} />
              ) : (
                <Upload size={24} style={{ color: "#10B981" }} />
              )}
            </div>
            <p className="text-[.95rem] font-bold text-foreground m-0 mb-1">
              {busy ? t("documents.uploading") : t("documents.uploadTitle")}
            </p>
            <p className="text-[.8rem] text-muted-foreground m-0 mb-4">{t("documents.uploadSub")}</p>
            <span
              className="fd-doc-btn fd-doc-btn-primary"
              onClick={(e) => { e.stopPropagation(); dropInputRef.current?.click(); }}
            >
              <Upload size={15} />
              {t("documents.browse")}
            </span>
          </div>

          {/* Documents list */}
          <div className="space-y-2 fd-doc-enter fd-doc-enter-d1">
            <div className="flex items-center gap-2 px-1">
              <History size={15} style={{ color: "var(--color-muted-foreground)" }} />
              <span className="text-[.78rem] font-bold uppercase tracking-wider text-muted-foreground">
                {t("documents.history")}
              </span>
            </div>

            {loading ? (
              <div className="fd-doc-card fd-doc-card-pad flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={15} className="animate-spin" />
                {t("documents.loadingHistory")}
              </div>
            ) : docs.length === 0 ? (
              <div className="fd-doc-card fd-doc-card-pad text-center py-10">
                <div className="w-12 h-12 rounded-xl mx-auto mb-3 flex items-center justify-center" style={{ background: "rgba(99,102,241,.08)" }}>
                  <Clipboard size={20} style={{ color: "#6366F1" }} />
                </div>
                <p className="text-sm font-bold text-foreground m-0 mb-1">{t("documents.noHistory")}</p>
                <p className="text-xs text-muted-foreground m-0">{t("documents.noHistorySub")}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {docs.map((item) => (
                  <DocRow
                    key={item.key}
                    item={item}
                    active={activeId === item.job?.id}
                    profileLabel={profileLabel}
                    t={t}
                    exporting={exporting}
                    exportFormat={exportFormat}
                    confirmKey={confirmKey}
                    onSelect={() => handleRowSelect(item)}
                    onExport={(job) => handleExport(job)}
                    onReplace={(id) => { setReplaceFor(id); replaceInputRef.current?.click(); }}
                    onRerun={(id) => rerun(id)}
                    onDelete={(id) => {
                      if (confirmKey === id) { setConfirmKey(null); remove(id); }
                      else setConfirmKey(id);
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Replace file picker (shared) */}
          <input
            ref={replaceInputRef}
            type="file"
            className="hidden"
            accept={ACCEPT}
            onChange={(e) => {
              const target = replaceFor;
              const file = e.target.files?.[0];
              e.target.value = "";
              setReplaceFor(null);
              if (target && file) replace(target, file);
            }}
          />

          {/* Review workspace */}
          {activeJob && activeJob.status === "complete" && (
            <ReviewWorkspace
              job={activeJob}
              profileLabel={profileLabel}
              schema={activeSchema}
              t={t}
              editing={editing}
              savingKey={savingKey}
              fieldError={fieldError}
              exportFormat={exportFormat}
              setExportFormat={setExportFormat}
              exporting={exporting}
              onExport={() => handleExport(activeJob)}
              onRerun={() => rerun(activeJob.id)}
              onDelete={() => remove(activeJob.id)}
              onStartEdit={(key) => {
                setFieldError(null);
                const def = activeSchema?.fields.find((f) => f.key === key);
                const fv = activeJob.fields?.find((f) => f.key === key);
                const type = def?.type ?? "string";
                const value = fv?.value;
                let draft = displayValue(value);
                if (type === "boolean" && typeof value === "boolean") draft = String(value);
                if ((type === "array" || type === "object") && value !== null && value !== undefined) {
                  draft = JSON.stringify(value, null, 2);
                }
                setEditing({ key, draft });
              }}
              onDraft={(draft) => setEditing((prev) => (prev ? { ...prev, draft } : prev))}
              onSave={(key) => handleFieldSave(activeJob, key)}
              onCancel={() => { setEditing(null); setFieldError(null); }}
            />
          )}

          {/* Running / error state for the active document */}
          {activeDoc && activeJob && RUNNING.has(activeJob.status) && (
            <div className="fd-doc-card fd-doc-card-pad fd-doc-enter">
              <div className="flex items-center gap-3">
                <div className="fd-doc-row-icon" style={{ background: "rgba(99,102,241,.12)" }}>
                  <Loader2 size={18} className="animate-spin" style={{ color: "#6366F1" }} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-foreground m-0 truncate">{activeDoc.fileName}</p>
                  <p className="text-xs text-muted-foreground m-0 mt-0.5">
                    {t(`documents.stage.${activeJob.status}`)}…
                  </p>
                </div>
              </div>
            </div>
          )}
          {activeDoc && activeJob && activeJob.status === "error" && (
            <div className="fd-doc-card fd-doc-card-pad fd-doc-enter">
              <div className="flex items-center gap-3 mb-3">
                <div className="fd-doc-row-icon" style={{ background: "rgba(239,68,68,.12)" }}>
                  <AlertTriangle size={18} style={{ color: "#EF4444" }} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-foreground m-0 truncate">{activeDoc.fileName}</p>
                  <p className="text-xs text-muted-foreground m-0 mt-0.5">{t("documents.errorTitle")}</p>
                </div>
              </div>
              <div className="fd-doc-banner warn mb-4">
                <AlertTriangle size={14} style={{ color: "#F59E0B", flexShrink: 0 }} />
                <span>{activeJob.error?.message ?? t("common.error")}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => rerun(activeJob.id)} className="fd-doc-btn fd-doc-btn-secondary">
                  <RefreshCw size={15} />
                  {t("documents.rerun")}
                </button>
                <button onClick={() => remove(activeJob.id)} className="fd-doc-btn fd-doc-btn-danger">
                  <Trash2 size={15} />
                  {t("documents.delete")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ─── Document row ────────────────────────────────────────────────────── */

interface DocRowProps {
  item: DocItem;
  active: boolean;
  profileLabel: (id: string) => string;
  t: (key: string, params?: Record<string, string | number>) => string;
  exporting: boolean;
  exportFormat: string;
  confirmKey: string | null;
  onSelect: () => void;
  onExport: (job: JobDTO) => void;
  onReplace: (id: string) => void;
  onRerun: (id: string) => void;
  onDelete: (id: string) => void;
}

function DocRow({
  item,
  active,
  profileLabel,
  t,
  exporting,
  exportFormat,
  confirmKey,
  onSelect,
  onExport,
  onReplace,
  onRerun,
  onDelete,
}: DocRowProps) {
  const { job, fileName, uploading, replacing, rerunning, removing, localError } = item;
  const id = job?.id ?? item.key;
  const running = !!job && RUNNING.has(job.status);
  const complete = job?.status === "complete";
  const error = job?.status === "error";
  const busy = replacing || rerunning || removing;

  const iconBg = error
    ? "rgba(239,68,68,.12)"
    : complete
      ? "rgba(16,185,129,.12)"
      : "rgba(245,158,11,.12)";
  const iconColor = error ? "#EF4444" : complete ? "#10B981" : "#F59E0B";

  const subtitle = job
    ? `${profileLabel(job.profileType)} · ${new Date(job.createdAt).toLocaleString()}`
    : new Date().toLocaleString();

  return (
    <div className={`fd-doc-row ${active ? "active" : ""}`} onClick={onSelect}>
      <div className="fd-doc-row-icon" style={{ background: iconBg }}>
        {uploading ? (
          <Loader2 size={18} className="animate-spin" style={{ color: "#6366F1" }} />
        ) : running ? (
          <Loader2 size={18} className="animate-spin" style={{ color: iconColor }} />
        ) : error ? (
          <X size={18} style={{ color: iconColor }} />
        ) : (
          <FileText size={18} style={{ color: iconColor }} />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-[.85rem] font-bold text-foreground m-0 truncate">
            {fileName ??
              discoveryTitle(job) ??
              (job?.extractionMode === "dynamic"
                ? profileLabel(job.profileType)
                : job?.sourceText?.slice(0, 40)) ??
              t("documents.title")}
          </p>
          {complete && (
            <span className="fd-doc-chip flex-shrink-0" style={{ background: "rgba(16,185,129,.1)", color: "#10B981" }}>
              <ShieldCheck size={12} />
              {Math.round((job.overallConfidence ?? 0) * 100)}%
            </span>
          )}
        </div>
        <p className="text-[.72rem] text-muted-foreground m-0 mt-0.5 truncate">{subtitle}</p>
        {localError && (
          <p className="text-[.72rem] m-0 mt-0.5 truncate" style={{ color: "#EF4444" }}>{localError}</p>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0">
        {complete && (
          <button
            onClick={(e) => { e.stopPropagation(); onExport(job); }}
            disabled={exporting}
            className="fd-doc-btn fd-doc-btn-secondary"
            style={{ padding: ".45rem .7rem" }}
            title={`Export ${exportFormat.toUpperCase()}`}
          >
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          </button>
        )}
        {complete && (
          <button
            onClick={(e) => { e.stopPropagation(); onRerun(id); }}
            disabled={busy}
            className="fd-doc-btn fd-doc-btn-secondary"
            style={{ padding: ".45rem .7rem" }}
            title={t("documents.rerun")}
          >
            {rerunning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
        )}
        {!uploading && (
          <button
            onClick={(e) => { e.stopPropagation(); onReplace(id); }}
            disabled={busy}
            className="fd-doc-btn fd-doc-btn-secondary"
            style={{ padding: ".45rem .7rem" }}
            title={t("documents.replace")}
          >
            {replacing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
        )}
        {uploading ? (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(id); }}
            className="fd-doc-btn fd-doc-btn-danger"
            style={{ padding: ".45rem .7rem" }}
            title={t("documents.removeFile")}
          >
            <X size={14} />
          </button>
        ) : confirmKey === id ? (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(id); }}
            className="fd-doc-btn fd-doc-btn-danger"
            style={{ padding: ".45rem .7rem" }}
          >
            <Check size={14} />
            {t("documents.confirm")}
          </button>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(id); }}
            disabled={busy}
            className="fd-doc-btn fd-doc-btn-secondary"
            style={{ padding: ".45rem .7rem", color: "#EF4444" }}
            title={t("documents.delete")}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Review workspace ────────────────────────────────────────────────── */

interface ReviewProps {
  job: JobDTO;
  profileLabel: (id: string) => string;
  schema?: ProfileSchemaDTO["schema"];
  t: (key: string, params?: Record<string, string | number>) => string;
  editing: { key: string; draft: string } | null;
  savingKey: string | null;
  fieldError: string | null;
  exportFormat: string;
  setExportFormat: (f: (typeof EXPORT_FORMATS)[number]) => void;
  exporting: boolean;
  onExport: () => void;
  onRerun: () => void;
  onDelete: () => void;
  onStartEdit: (key: string) => void;
  onDraft: (draft: string) => void;
  onSave: (key: string) => void;
  onCancel: () => void;
}

function ReviewWorkspace(props: ReviewProps) {
  const {
    job,
    profileLabel,
    schema,
    t,
    editing,
    savingKey,
    fieldError,
    exportFormat,
    setExportFormat,
    exporting,
    onExport,
    onRerun,
    onDelete,
    onStartEdit,
    onDraft,
    onSave,
    onCancel,
  } = props;

  const fields = job.fields ?? [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const missing = job.validation?.missing ?? [];
  const fieldLabel = (key: string) =>
    schema?.fields.find((f) => f.key === key)?.label ??
    byKey.get(key)?.label ??
    humanize(key);
  const [view, setView] = useState<"fields" | "preview">("fields");

  const groups: Array<{ label: string; fields: FieldDTO[] }> = [];
  if (schema?.groups?.length) {
    const used = new Set<string>();
    for (const g of schema.groups) {
      const gf = g.keys.map((k) => byKey.get(k)).filter((f): f is FieldDTO => Boolean(f));
      if (gf.length) {
        groups.push({ label: g.label, fields: gf });
        gf.forEach((f) => used.add(f.key));
      }
    }
    const other = fields.filter((f) => !used.has(f.key));
    if (other.length) groups.push({ label: t("documents.other"), fields: other });
  } else if (fields.length) {
    groups.push({ label: "", fields });
  }

  return (
    <div className="space-y-4 fd-doc-enter">
      {/* Header */}
      <div className="fd-doc-card fd-doc-card-pad">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="fd-doc-row-icon" style={{ background: "rgba(16,185,129,.12)" }}>
              <FileText size={16} style={{ color: "#10B981" }} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-foreground m-0 truncate">
                {discoveryTitle(job) ??
                  (job.extractionMode === "dynamic"
                    ? profileLabel(job.profileType)
                    : (job.sourceText?.slice(0, 60) ||
                        profileLabel(job.profileType)))}
              </p>
              <p className="text-xs text-muted-foreground m-0 mt-0.5">
                {profileLabel(job.profileType)} · {t("documents.reviewTitle")}
              </p>
            </div>
          </div>
          <div className="flex-1" />
          <span className="fd-doc-chip" style={{ background: "rgba(16,185,129,.1)", color: "#10B981" }}>
            <ShieldCheck size={13} />
            {Math.round((job.overallConfidence ?? 0) * 100)}% {t("documents.confidence").toLowerCase()}
          </span>
          {job.model && (
            <span className="fd-doc-chip" style={{ background: "rgba(99,102,241,.08)", color: "#6366F1" }}>
              <Sparkles size={12} />
              {job.model}
            </span>
          )}
        </div>

        {/* View tabs */}
        <div className="fd-doc-tabs mb-4">
          <button
            className={`fd-doc-tab ${view === "fields" ? "active" : ""}`}
            onClick={() => setView("fields")}
          >
            <FileText size={13} style={{ verticalAlign: "text-bottom", marginRight: 4 }} />
            {t("documents.reviewTitle")}
          </button>
          <button
            className={`fd-doc-tab ${view === "preview" ? "active" : ""}`}
            onClick={() => setView("preview")}
          >
            <ScanText size={13} style={{ verticalAlign: "text-bottom", marginRight: 4 }} />
            {t("documents.preview.title")}
          </button>
        </div>

        {/* Validation banner */}
        {view === "fields" && (missing.length > 0 ? (
          <div className="fd-doc-banner warn mb-4">
            <AlertTriangle size={14} style={{ color: "#F59E0B", flexShrink: 0 }} />
            <span>{t("documents.missingFields", { fields: missing.map(fieldLabel).join(", ") })}</span>
          </div>
        ) : (
          <div className="fd-doc-banner ok mb-4">
            <CheckCircle2 size={14} style={{ color: "#22C55E", flexShrink: 0 }} />
            <span>{t("documents.allFieldsOk")}</span>
          </div>
        ))}

        {/* Confidence breakdown */}
        {view === "fields" && !!job.confidence?.summary?.length && (
          <div className="fd-doc-banner mb-4" style={{ display: "block" }}>
            <p className="text-[.7rem] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
              {t("documents.confidenceBreakdown.title")}
            </p>
            <div className="space-y-1">
              {job.confidence.summary.map((s) => (
                <div key={s.label} className="flex items-center gap-2">
                  <span className="text-[.68rem] text-muted-foreground flex-1 truncate">
                    {t(`documents.confidenceBreakdown.${BREAKDOWN_KEY[s.label] ?? s.label}`) || s.label}
                  </span>
                  <div
                    className="w-28 h-1.5 rounded-full overflow-hidden flex-shrink-0"
                    style={{ background: "var(--color-muted)" }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.round(s.score * 100)}%`,
                        background: confidenceColor(s.score),
                      }}
                    />
                  </div>
                  <span className="text-[.68rem] font-bold" style={{ color: confidenceColor(s.score) }}>
                    {Math.round(s.score * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Field groups / OCR preview */}
        {view === "preview" ? (
          <OcrPreview job={job} t={t} />
        ) : groups.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground">{t("common.error")}</div>
        ) : (
          <div className="space-y-5">
            {groups.map((g) => (
              <div key={g.label || "root"}>
                {g.label && (
                  <p className="text-[.72rem] font-bold uppercase tracking-wider text-muted-foreground mb-2 px-1">
                    {g.label}
                  </p>
                )}
                <div className="space-y-1">
                  {g.fields.map((field) => (
                    <FieldRow
                      key={field.key}
                      field={field}
                      label={fieldLabel(field.key)}
                      def={
                        schema?.fields.find((f) => f.key === field.key) ?? {
                          key: field.key,
                          type: field.type ?? "string",
                          label: field.label ?? field.key,
                        }
                      }
                      t={t}
                      editing={editing?.key === field.key ? editing : null}
                      saving={savingKey === field.key}
                      fieldError={fieldError}
                      onStartEdit={() => onStartEdit(field.key)}
                      onDraft={onDraft}
                      onSave={() => onSave(field.key)}
                      onCancel={onCancel}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions + export */}
      <div className="fd-doc-card fd-doc-card-pad flex flex-wrap items-center gap-3">
        <span className="text-sm font-bold text-foreground flex items-center gap-1.5">
          <Download size={15} style={{ color: "#6366F1" }} />
          {t("documents.export")}
        </span>
        <select
          value={exportFormat}
          onChange={(e) => setExportFormat(e.target.value as (typeof EXPORT_FORMATS)[number])}
          className="fd-doc-select"
        >
          {EXPORT_FORMATS.map((f) => (
            <option key={f} value={f}>{f.toUpperCase()}</option>
          ))}
        </select>
        <div className="flex-1" />
        <button onClick={onRerun} className="fd-doc-btn fd-doc-btn-secondary">
          <RefreshCw size={15} />
          {t("documents.rerun")}
        </button>
        <button onClick={onDelete} className="fd-doc-btn fd-doc-btn-danger">
          <Trash2 size={15} />
          {t("documents.delete")}
        </button>
        <button onClick={onExport} disabled={exporting} className="fd-doc-btn fd-doc-btn-indigo">
          {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
          {t("documents.download")}
        </button>
      </div>
    </div>
  );
}

/* ─── OCR preview ──────────────────────────────────────────────────────── */

function OcrPreview({
  job,
  t,
}: {
  job: JobDTO;
  t: (key: string) => string;
}) {
  const ocr = job.ocr;
  const isImage =
    !!job.fileUrl && /\.(jpe?g|png|gif|webp)(\?.*)?$/i.test(job.fileUrl);
  const lines = ocr?.lines?.length ? ocr.lines : null;

  const evidenceLines = new Set<number>();
  for (const f of job.fields ?? []) {
    for (const e of f.evidence ?? []) {
      if (typeof e.lineIndex === "number") evidenceLines.add(e.lineIndex);
    }
  }

  return (
    <div className="space-y-4">
      {isImage && (
        <div>
          <p className="fd-doc-preview-label">{t("documents.preview.imageTitle")}</p>
          <img
            src={job.fileUrl!}
            alt={t("documents.preview.imageTitle")}
            className="fd-doc-preview-img"
          />
        </div>
      )}

      {lines ? (
        <div>
          <p className="fd-doc-preview-label">{t("documents.preview.linesTitle")}</p>
          <div className="fd-doc-ocr-lines">
            {lines.map((line, i) => {
              const conf = line.confidence;
              const uncertain = conf !== undefined && conf < 0.6;
              const evidenced = evidenceLines.has(i);
              const words = line.words?.length ? line.words : null;
              return (
                <div
                  key={i}
                  className={`fd-doc-ocr-line ${uncertain ? "uncertain" : ""} ${evidenced ? "evidence" : ""}`}
                  title={
                    evidenced
                      ? t("documents.preview.evidenceLine")
                      : uncertain
                        ? t("documents.preview.uncertainLine")
                        : undefined
                  }
                >
                  <span className="fd-doc-ocr-line-no">{i + 1}</span>
                  <span className="fd-doc-ocr-line-text">
                    {words ? (
                      words.map((w, wi) => {
                        const wUncertain = w.confidence !== undefined && w.confidence < 0.6;
                        return (
                          <span
                            key={wi}
                            className={`fd-doc-ocr-word ${wUncertain ? "uncertain" : ""}`}
                            title={
                              w.confidence !== undefined
                                ? `${Math.round(w.confidence * 100)}% ${t("documents.preview.wordConfidence")}`
                                : undefined
                            }
                          >
                            {w.text}
                            {" "}
                          </span>
                        );
                      })
                    ) : (
                      line.text || " "
                    )}
                  </span>
                  {conf !== undefined && (
                    <span className="fd-doc-ocr-line-conf">
                      {Math.round(conf * 100)}% {t("documents.preview.lineConfidence")}
                    </span>
                  )}
                </div>
              );
            })}
            <div className="fd-doc-ocr-legend">
              <span>
                <i className="lg-evidence" />
                {t("documents.preview.evidenceLegend")}
              </span>
              <span>
                <i className="lg-uncertain" />
                {t("documents.preview.uncertainLegend")}
              </span>
            </div>
          </div>
        </div>
      ) : job.sourceText ? (
        <div>
          <p className="fd-doc-preview-label">{t("documents.preview.rawTitle")}</p>
          <pre className="fd-doc-field-pre">{job.sourceText}</pre>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("documents.preview.noOcr")}</p>
      )}
    </div>
  );
}

/* ─── Field row ───────────────────────────────────────────────────────── */

interface FieldRowProps {
  field: FieldDTO;
  label: string;
  def?: FieldSchemaDTO;
  t: (key: string, params?: Record<string, string | number>) => string;
  editing: { key: string; draft: string } | null;
  saving: boolean;
  fieldError: string | null;
  onStartEdit: () => void;
  onDraft: (draft: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function FieldRow({
  field,
  label,
  def,
  t,
  editing,
  saving,
  fieldError,
  onStartEdit,
  onDraft,
  onSave,
  onCancel,
}: FieldRowProps) {
  const value = displayValue(field.value);
  const empty = value === "";
  const color = confidenceColor(field.confidence);
  const type = def?.type ?? "string";
  const inEdit = editing?.key === field.key;
  const isStructured = type === "array" || type === "object";

  const statusColor =
    field.status === "edited"
      ? "#8B5CF6"
      : field.status === "verified"
        ? "#22C55E"
        : field.status === "flagged"
          ? "#EF4444"
          : field.status === "ambiguous"
            ? "#F59E0B"
            : "#6366F1";

  const uncertaintyReasons = field.reasons ?? [];
  const hasUncertainty = uncertaintyReasons.length > 0 ||
    field.status === "flagged" ||
    field.status === "ambiguous";

  return (
    <div className={`fd-doc-field-row ${inEdit ? "editing" : ""}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[.74rem] font-bold uppercase tracking-wide text-muted-foreground truncate">
            {label}
          </span>
          {def?.required && (
            <span className="text-[.68rem] font-bold" style={{ color: "#F59E0B" }}>•</span>
          )}
          <span
            className="fd-doc-chip"
            style={{
              background: `${statusColor}1A`,
              color: statusColor,
              padding: ".12rem .45rem",
              fontSize: ".64rem",
            }}
          >
            {t(`documents.fieldStatus.${field.status}`) || field.status}
          </span>
        </div>

        {inEdit ? (
          <div>
            <Editor
              type={type}
              def={def}
              draft={editing!.draft}
              onDraft={onDraft}
              onSave={onSave}
              onCancel={onCancel}
            />
            {fieldError && (
              <p className="text-[.72rem] text-destructive mt-1.5 flex items-center gap-1">
                <AlertTriangle size={12} />
                {fieldError}
              </p>
            )}
          </div>
        ) : empty ? (
          <p className="fd-doc-field-value empty">—</p>
        ) : isStructured ? (
          <pre className="fd-doc-field-pre">{value}</pre>
        ) : (
          <p className="fd-doc-field-value">{value}</p>
        )}

        {!inEdit && !!field.raw && field.raw !== field.value && (
          <p className="text-[.7rem] text-muted-foreground mt-0.5 truncate" title={String(field.raw)}>
            raw: {String(field.raw)}
          </p>
        )}

        {!inEdit && hasUncertainty && (
          <div className="mt-1.5 space-y-0.5">
            <p className="text-[.7rem] font-bold flex items-center gap-1" style={{ color: "#F59E0B" }}>
              <AlertTriangle size={11} />
              {t("documents.uncertainty.title")}
            </p>
            {uncertaintyReasons.length > 0 ? (
              uncertaintyReasons.map((r) => (
                <p key={r} className="text-[.7rem] m-0" style={{ color: "#D97706" }}>
                  {t(`documents.uncertainty.${r}`) || r}
                </p>
              ))
            ) : (
              <p className="text-[.7rem] m-0" style={{ color: "#D97706" }}>
                {t("documents.uncertainty.ocr_confidence_low")}
              </p>
            )}
          </div>
        )}
      </div>

      {!inEdit && (
        <span className="fd-doc-chip flex-shrink-0" style={{ background: `${color}1A`, color }}>
          {Math.round(field.confidence * 100)}%
        </span>
      )}

      {inEdit ? (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button onClick={onSave} disabled={saving} className="fd-doc-btn fd-doc-btn-indigo" style={{ padding: ".5rem .8rem" }}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {t("documents.save")}
          </button>
          <button onClick={onCancel} disabled={saving} className="fd-doc-btn fd-doc-btn-secondary" style={{ padding: ".5rem .8rem" }}>
            <X size={14} />
            {t("documents.cancel")}
          </button>
        </div>
      ) : (
        <button
          onClick={onStartEdit}
          className="fd-doc-btn fd-doc-btn-secondary flex-shrink-0"
          style={{ padding: ".5rem .75rem" }}
          title={t("documents.edit")}
        >
          <Pencil size={13} />
        </button>
      )}
    </div>
  );
}

/* ─── Type-aware field editor ─────────────────────────────────────────── */

function Editor({
  type,
  def,
  draft,
  onDraft,
  onSave,
  onCancel,
}: {
  type: string;
  def?: FieldSchemaDTO;
  draft: string;
  onDraft: (draft: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (type === "enum" && def?.enum?.length) {
    return (
      <select
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        className="fd-doc-input"
        autoFocus
        onKeyDown={(e) => { if (e.key === "Enter") onSave(); if (e.key === "Escape") onCancel(); }}
      >
        <option value="">—</option>
        {def.enum.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }
  if (type === "boolean") {
    return (
      <select
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        className="fd-doc-input"
        autoFocus
        onKeyDown={(e) => { if (e.key === "Enter") onSave(); if (e.key === "Escape") onCancel(); }}
      >
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (type === "date") {
    return (
      <input
        type="date"
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        className="fd-doc-input"
        autoFocus
        onKeyDown={(e) => { if (e.key === "Enter") onSave(); if (e.key === "Escape") onCancel(); }}
      />
    );
  }
  if (type === "array" || type === "object") {
    return (
      <textarea
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        className="fd-doc-input"
        rows={5}
        autoFocus
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
        style={{ fontFamily: "'SF Mono', ui-monospace, Consolas, monospace", fontSize: ".78rem" }}
      />
    );
  }
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => onDraft(e.target.value)}
      className="fd-doc-input"
      autoFocus
      onKeyDown={(e) => { if (e.key === "Enter") onSave(); if (e.key === "Escape") onCancel(); }}
    />
  );
}
