"use client";

import { useEffect, useRef, useState } from "react";
import {
  Upload,
  FileText,
  Loader2,
  Check,
  AlertTriangle,
  X,
  Pencil,
  CheckCircle2,
  Circle,
  Download,
  RefreshCw,
  History,
  ScanText,
  Sparkles,
  ShieldCheck,
  Clipboard,
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import {
  usePipeline,
  type JobDTO,
  type FieldDTO,
} from "@/lib/hooks/use-pipeline";
import { downloadBlob } from "@/lib/download";

const STAGE_ORDER = ["queued", "classifying", "extracting", "validating", "complete"] as const;
const EXPORT_FORMATS = ["json", "csv"] as const;
const ACCEPT =
  ".pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.json,.jpg,.jpeg,.png,.gif,.webp";

function humanize(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(formatValue).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function confidenceColor(c: number): string {
  if (c >= 0.9) return "#22C55E";
  if (c >= 0.7) return "#F59E0B";
  return "#EF4444";
}

function isReady(field: FieldDTO): boolean {
  const value = field.value;
  const empty =
    value === null || value === undefined || value === "" ||
    (Array.isArray(value) && value.length === 0);
  if (empty) return false;
  return field.status === "verified" || field.status === "edited" || field.confidence >= 0.9;
}

export default function DocumentsPage() {
  const { t } = useTranslation();  const {
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
  } = usePipeline();

  const [dragging, setDragging] = useState(false);
  const [history, setHistory] = useState<JobDTO[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [exportFormat, setExportFormat] = useState<(typeof EXPORT_FORMATS)[number]>("json");
  const [exporting, setExporting] = useState(false);
  const [editing, setEditing] = useState<{ key: string; draft: string } | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/pipeline/extractions?limit=20");
        if (res.ok) {
          const data = await res.json();
          setHistory(data.items ?? []);
        }
      } catch {
        // ignore — history is non-critical
      } finally {
        setHistoryLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!job || (phase !== "complete" && phase !== "error")) return;
    (async () => {
      try {
        const res = await fetch("/api/pipeline/extractions?limit=20");
        if (res.ok) {
          const data = await res.json();
          setHistory(data.items ?? []);
        }
      } catch {
        // ignore — history is non-critical
      }
    })();
  }, [job, phase]);

  async function handleFile(file: File) {
    if (!file) return;
    setEditing(null);
    setFieldError(null);
    await runPipeline(file);
  }

  async function handleExport() {
    if (!job) return;
    setExporting(true);
    try {
      const res = await fetch(
        `/api/pipeline/extractions/${job.id}/export?format=${exportFormat}`
      );
      if (!res.ok) return;
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const match = cd.match(/filename="?([^"]+)"?/);
      downloadBlob(blob, match?.[1] ?? `${job.id}.${exportFormat}`);
    } finally {
      setExporting(false);
    }
  }

  async function handleFieldSave(key: string) {
    if (!editing) return;
    setSavingKey(key);
    setFieldError(null);
    try {
      await saveFields({ [key]: editing.draft });
      setEditing(null);
    } catch (e) {
      setFieldError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingKey(null);
    }
  }

  const fields = job?.fields ?? [];
  const readyFields = fields.filter(isReady);
  const reviewFields = fields.filter((f) => !isReady(f));
  const missing = job?.validation?.missing ?? [];
  const canRerun = !!activeFileName && (phase === "complete" || phase === "error");
  const running =
    phase === "queued" || phase === "classifying" || phase === "extracting" || phase === "validating";

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&display=swap');
        .fd-doc-root { font-family: 'Sora', system-ui, sans-serif; }
        .fd-doc-hero {
          position: relative; overflow: hidden;
          border-radius: 20px; padding: 2rem 1.75rem;
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
        .fd-doc-card-pad { padding: 1.4rem 1.4rem; }
        .fd-doc-btn {
          display: inline-flex; align-items: center; gap: .5rem;
          padding: .65rem 1.15rem; border-radius: 12px;
          font-size: .85rem; font-weight: 600; font-family: inherit;
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
        .fd-doc-chip {
          display: inline-flex; align-items: center; gap: .35rem;
          padding: .28rem .6rem; border-radius: 999px;
          font-size: .72rem; font-weight: 600;
        }
        .fd-doc-upload {
          position: relative; border-radius: 16px; padding: 2.2rem 1.5rem;
          border: 2px dashed var(--color-border); text-align: center;
          transition: border-color .25s, background .25s; cursor: pointer;
        }
        .fd-doc-upload:hover { border-color: rgba(16,185,129,.4); background: rgba(16,185,129,.03); }
        .fd-doc-upload.dragging { border-color: rgba(16,185,129,.55); background: rgba(16,185,129,.06); }
        .fd-doc-upload-icon {
          width: 56px; height: 56px; border-radius: 16px; margin: 0 auto .9rem;
          background: linear-gradient(135deg, rgba(16,185,129,.12), rgba(99,102,241,.08));
          display: flex; align-items: center; justify-content: center;
        }
        .fd-doc-stage {
          display: flex; align-items: center; gap: .8rem;
          padding: .65rem .85rem; border-radius: 12px;
        }
        .fd-doc-stage.done { color: var(--color-muted-foreground); }
        .fd-doc-stage.active {
          background: rgba(99,102,241,.07); border: 1px solid rgba(99,102,241,.15);
        }
        .fd-doc-stage-icon {
          width: 30px; height: 30px; border-radius: 9px; flex-shrink: 0;
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
          word-break: break-word;
        }
        .fd-doc-field-value.empty { color: var(--color-muted-foreground); font-weight: 400; font-style: italic; }
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
        .fd-doc-hist-row {
          display: flex; align-items: center; gap: .75rem;
          padding: .7rem .85rem; border-radius: 12px;
          border: 1px solid var(--color-border); background: var(--color-card);
          cursor: pointer; transition: background .15s, border-color .15s;
        }
        .fd-doc-hist-row:hover { background: var(--color-accent); border-color: rgba(129,140,248,.2); }
        .fd-doc-hist-row.active { border-color: rgba(99,102,241,.4); background: rgba(99,102,241,.06); }
        .fd-doc-banner {
          display: flex; align-items: center; gap: .6rem;
          padding: .7rem .9rem; border-radius: 12px; font-size: .8rem;
        }
        .fd-doc-banner.warn { background: rgba(245,158,11,.08); border: 1px solid rgba(245,158,11,.25); color: var(--color-foreground); }
        .fd-doc-banner.ok { background: rgba(34,197,94,.08); border: 1px solid rgba(34,197,94,.25); color: var(--color-foreground); }
        @keyframes fd-doc-rise {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .fd-doc-enter { animation: fd-doc-rise .5s cubic-bezier(.16,1,.3,1) both; }
        .fd-doc-enter-d1 { animation-delay: .1s; }
        .fd-doc-enter-d2 { animation-delay: .18s; }
      `}</style>

      <div className="fd-doc-root h-full overflow-auto p-6" suppressHydrationWarning>
        <div className="max-w-6xl mx-auto space-y-6">
          {/* Hero */}
          <div className="fd-doc-hero fd-doc-enter">
            <div className="fd-doc-hero-orb" />
            <h1 className="text-2xl font-extrabold tracking-tight text-foreground m-0 relative z-[2]">
              {t("documents.title")} <ScanText size={22} style={{ color: "#10B981", verticalAlign: "middle" }} />
            </h1>
            <p className="text-sm text-muted-foreground m-0 mt-1 relative z-[2]">{t("documents.subtitle")}</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6 items-start">
            {/* Main column */}
            <div className="space-y-5 min-w-0">
              {/* Upload zone */}
              {phase === "idle" && (
                <div
                  className={`fd-doc-upload fd-doc-enter ${dragging ? "dragging" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    accept={ACCEPT}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
                  />
                  <div onClick={() => fileInputRef.current?.click()} className="cursor-pointer">
                    <div className="fd-doc-upload-icon">
                      <Upload size={24} style={{ color: "#10B981" }} />
                    </div>
                    <p className="text-[.95rem] font-bold text-foreground m-0 mb-1">{t("documents.uploadTitle")}</p>
                    <p className="text-[.8rem] text-muted-foreground m-0 mb-4">{t("documents.uploadSub")}</p>
                    <span
                      className="fd-doc-btn fd-doc-btn-primary"
                      onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                    >
                      <Upload size={15} />
                      {t("documents.browse")}
                    </span>
                  </div>
                </div>
              )}

              {/* Uploading */}
              {phase === "uploading" && (
                <div className="fd-doc-card fd-doc-card-pad fd-doc-enter">
                  <div className="flex items-center gap-3">
                    <Loader2 size={20} className="animate-spin" style={{ color: "#10B981" }} />
                    <div>
                      <p className="text-sm font-bold text-foreground m-0">{t("documents.uploading")}</p>
                      <p className="text-xs text-muted-foreground m-0 mt-0.5 truncate">{activeFileName}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Running stages */}
              {running && (
                <div className="fd-doc-card fd-doc-card-pad fd-doc-enter">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="fd-doc-stage-icon" style={{ background: "rgba(99,102,241,.12)" }}>
                      <Sparkles size={16} style={{ color: "#6366F1" }} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-foreground m-0 truncate">{activeFileName ?? t("documents.running")}</p>
                      <p className="text-xs text-muted-foreground m-0 mt-0.5">
                        {t("documents.running")}… {t(`documents.stage.${STAGE_ORDER[stageIndex]}`)}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-1">
                    {STAGE_ORDER.slice(0, 4).map((stage, i) => {
                      const isActive = i === stageIndex;
                      const isDone = i < stageIndex;
                      return (
                        <div key={stage} className={`fd-doc-stage ${isActive ? "active" : ""}`}>
                          <div
                            className="fd-doc-stage-icon"
                            style={{
                              background: isDone ? "rgba(34,197,94,.12)" : isActive ? "rgba(99,102,241,.12)" : "var(--color-muted)",
                            }}
                          >
                            {isDone ? (
                              <Check size={14} style={{ color: "#22C55E" }} />
                            ) : isActive ? (
                              <Loader2 size={14} className="animate-spin" style={{ color: "#6366F1" }} />
                            ) : (
                              <Circle size={12} style={{ color: "var(--color-muted-foreground)" }} />
                            )}
                          </div>
                          <span
                            className="text-[.82rem] font-semibold"
                            style={{ color: isActive ? "var(--color-foreground)" : isDone ? "#22C55E" : "var(--color-muted-foreground)" }}
                          >
                            {t(`documents.stage.${stage}`)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Error */}
              {phase === "error" && (
                <div className="fd-doc-card fd-doc-card-pad fd-doc-enter">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="fd-doc-stage-icon" style={{ background: "rgba(239,68,68,.12)" }}>
                      <AlertTriangle size={18} style={{ color: "#EF4444" }} />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-foreground m-0">{t("documents.errorTitle")}</p>
                      {activeFileName && <p className="text-xs text-muted-foreground m-0 mt-0.5 truncate">{activeFileName}</p>}
                    </div>
                  </div>
                  <div className="fd-doc-banner warn mb-4">
                    <AlertTriangle size={14} style={{ color: "#F59E0B", flexShrink: 0 }} />
                    <span>{error ?? t("common.error")}</span>
                  </div>
                  <div className="flex gap-2">
                    {canRerun && (
                      <button onClick={() => rerun()} className="fd-doc-btn fd-doc-btn-secondary">
                        <RefreshCw size={15} />
                        {t("documents.rerun")}
                      </button>
                    )}
                    <button onClick={reset} className="fd-doc-btn fd-doc-btn-indigo">
                      <Upload size={15} />
                      {t("documents.uploadTitle")}
                    </button>
                  </div>
                </div>
              )}

              {/* Review (complete) */}
              {phase === "complete" && job && (
                <div className="space-y-5">
                  <div className="fd-doc-card fd-doc-card-pad fd-doc-enter">
                    {/* Header */}
                    <div className="flex flex-wrap items-center gap-3 mb-4">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="fd-doc-stage-icon" style={{ background: "rgba(16,185,129,.12)" }}>
                          <FileText size={16} style={{ color: "#10B981" }} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-foreground m-0 truncate">
                            {activeFileName ?? t(`documents.profile.${job.profileType}`)}
                          </p>
                          <p className="text-xs text-muted-foreground m-0 mt-0.5">
                            {t(`documents.profile.${job.profileType}`)} · {t("documents.reviewTitle")}
                          </p>
                        </div>
                      </div>
                      <div className="flex-1" />
                      <span className="fd-doc-chip" style={{ background: "rgba(16,185,129,.1)", color: "#10B981" }}>
                        <ShieldCheck size={13} />
                        {Math.round((job.overallConfidence ?? 0) * 100)}% {t("documents.confidence").toLowerCase()}
                      </span>
                    </div>

                    {/* Validation banner */}
                    {missing.length > 0 ? (
                      <div className="fd-doc-banner warn mb-4">
                        <AlertTriangle size={14} style={{ color: "#F59E0B", flexShrink: 0 }} />
                        <span>
                          {t("documents.missingFields", { fields: missing.map(humanize).join(", ") })}
                        </span>
                      </div>
                    ) : (
                      <div className="fd-doc-banner ok mb-4">
                        <CheckCircle2 size={14} style={{ color: "#22C55E", flexShrink: 0 }} />
                        <span>{t("documents.allFieldsOk")}</span>
                      </div>
                    )}

                    {fields.length === 0 && (
                      <div className="text-center py-6 text-sm text-muted-foreground">{t("common.error")}</div>
                    )}

                    {/* Ready group */}
                    {readyFields.length > 0 && (
                      <div className="mb-3">
                        <p className="text-[.72rem] font-bold uppercase tracking-wider text-[#22C55E] mb-2 px-1 flex items-center gap-1.5">
                          <CheckCircle2 size={13} /> {t("documents.groupReady")}
                        </p>
                        <div className="space-y-1">
                          {readyFields.map((field) => (
                            <FieldRow
                              key={field.key}
                              field={field}
                              t={t}
                              editing={editing?.key === field.key ? editing : null}
                              saving={savingKey === field.key}
                              fieldError={fieldError}
                              onStartEdit={() => { setFieldError(null); setEditing({ key: field.key, draft: formatValue(field.value) }); }}
                              onDraft={(draft) => setEditing((prev) => (prev ? { ...prev, draft } : prev))}
                              onSave={() => handleFieldSave(field.key)}
                              onCancel={() => { setEditing(null); setFieldError(null); }}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Review group */}
                    {reviewFields.length > 0 && (
                      <div>
                        <p className="text-[.72rem] font-bold uppercase tracking-wider text-[#F59E0B] mb-2 px-1 flex items-center gap-1.5">
                          <AlertTriangle size={13} /> {t("documents.groupReview")}
                        </p>
                        <div className="space-y-1">
                          {reviewFields.map((field) => (
                            <FieldRow
                              key={field.key}
                              field={field}
                              t={t}
                              editing={editing?.key === field.key ? editing : null}
                              saving={savingKey === field.key}
                              fieldError={fieldError}
                              onStartEdit={() => { setFieldError(null); setEditing({ key: field.key, draft: formatValue(field.value) }); }}
                              onDraft={(draft) => setEditing((prev) => (prev ? { ...prev, draft } : prev))}
                              onSave={() => handleFieldSave(field.key)}
                              onCancel={() => { setEditing(null); setFieldError(null); }}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Export bar */}
                  <div className="fd-doc-card fd-doc-card-pad fd-doc-enter flex flex-wrap items-center gap-3">
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
                    <button onClick={handleExport} disabled={exporting} className="fd-doc-btn fd-doc-btn-indigo">
                      {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                      {t("documents.download")}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* History column */}
            <div className="space-y-3 min-w-0 fd-doc-enter fd-doc-enter-d2">
              <div className="flex items-center gap-2 px-1">
                <History size={15} style={{ color: "var(--color-muted-foreground)" }} />
                <span className="text-[.78rem] font-bold uppercase tracking-wider text-muted-foreground">
                  {t("documents.history")}
                </span>
              </div>
              {historyLoading ? (
                <div className="fd-doc-card fd-doc-card-pad flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 size={15} className="animate-spin" />
                  {t("documents.loadingHistory")}
                </div>
              ) : history.length === 0 ? (
                <div className="fd-doc-card fd-doc-card-pad text-center py-8">
                  <div className="w-12 h-12 rounded-xl mx-auto mb-3 flex items-center justify-center" style={{ background: "rgba(99,102,241,.08)" }}>
                    <Clipboard size={20} style={{ color: "#6366F1" }} />
                  </div>
                  <p className="text-sm font-bold text-foreground m-0 mb-1">{t("documents.noHistory")}</p>
                  <p className="text-xs text-muted-foreground m-0">{t("documents.noHistorySub")}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {history.map((item) => (
                    <div
                      key={item.id}
                      onClick={() => loadJob(item.id)}
                      className={`fd-doc-hist-row ${job?.id === item.id ? "active" : ""}`}
                    >
                      <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: item.status === "error" ? "rgba(239,68,68,.1)" : "rgba(16,185,129,.1)" }}>
                        {item.status === "error" ? (
                          <X size={15} style={{ color: "#EF4444" }} />
                        ) : item.status === "complete" ? (
                          <FileText size={15} style={{ color: "#10B981" }} />
                        ) : (
                          <Loader2 size={15} className="animate-spin" style={{ color: "#F59E0B" }} />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[.8rem] font-bold text-foreground m-0 truncate">
                          {t(`documents.profile.${item.profileType}`)}
                        </p>
                        <p className="text-[.7rem] text-muted-foreground m-0 mt-0.5 truncate">
                          {item.status === "complete"
                            ? `${Math.round((item.overallConfidence ?? 0) * 100)}% · ${new Date(item.createdAt).toLocaleString()}`
                            : `${t(`documents.stage.${item.status}`)} · ${new Date(item.createdAt).toLocaleString()}`}
                        </p>
                      </div>
                      <span
                        className="fd-doc-chip"
                        style={
                          item.status === "complete"
                            ? { background: "rgba(16,185,129,.1)", color: "#10B981" }
                            : item.status === "error"
                              ? { background: "rgba(239,68,68,.1)", color: "#EF4444" }
                              : { background: "rgba(245,158,11,.1)", color: "#F59E0B" }
                        }
                      >
                        {t(`documents.stage.${item.status}`)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ─── Field row ─────────────────────────────────────────────────────────── */

interface FieldRowProps {
  field: FieldDTO;
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
  t,
  editing,
  saving,
  fieldError,
  onStartEdit,
  onDraft,
  onSave,
  onCancel,
}: FieldRowProps) {
  const value = formatValue(field.value);
  const empty = value === "";
  const color = confidenceColor(field.confidence);
  const isBool = typeof field.value === "boolean";
  const inEdit = editing?.key === field.key;

  return (
    <div className={`fd-doc-field-row ${inEdit ? "editing" : ""}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[.74rem] font-bold uppercase tracking-wide text-muted-foreground truncate">
            {humanize(field.key)}
          </span>
          <span
            className="fd-doc-chip"
            style={{
              background: field.status === "edited" ? "rgba(139,92,246,.1)" : "rgba(99,102,241,.08)",
              color: field.status === "edited" ? "#8B5CF6" : "#6366F1",
              padding: ".12rem .45rem",
              fontSize: ".64rem",
            }}
          >
            {field.status === "edited"
              ? t("documents.fieldStatus.edited")
              : field.source
                ? t(`documents.fieldSource.${field.source}`) || field.source
                : t("documents.fieldStatus.extracted")}
          </span>
        </div>
        {inEdit ? (
          <div>
            {isBool ? (
              <select
                value={editing!.draft}
                onChange={(e) => onDraft(e.target.value)}
                className="fd-doc-input"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") onSave(); if (e.key === "Escape") onCancel(); }}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                type="text"
                value={editing!.draft}
                onChange={(e) => onDraft(e.target.value)}
                className="fd-doc-input"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") onSave(); if (e.key === "Escape") onCancel(); }}
              />
            )}
            {fieldError && (
              <p className="text-[.72rem] text-destructive mt-1.5 flex items-center gap-1">
                <AlertTriangle size={12} />
                {fieldError}
              </p>
            )}
          </div>
        ) : (
          <p className={`fd-doc-field-value ${empty ? "empty" : ""}`}>{empty ? "—" : value}</p>
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
