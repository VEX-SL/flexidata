"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import {
  Upload,
  FileText,
  Trash2,
  MessageSquare,
  Loader2,
  Download,
  Copy,
  Check,
  Pencil,
  X,
  Eye,
  ArrowLeft,
  Zap,
  Sparkles,
  FileCode,
  FileSpreadsheet,
  FileImage,
  File,
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { downloadText } from "@/lib/download";

interface Agent {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string | null;
  share_token: string | null;
  files_count: number;
}

interface AgentFile {
  id: string;
  file_name: string;
  file_type: string;
  status: string;
  created_at: string;
}

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["pdf"].includes(ext)) return { icon: FileText, color: "#EF4444", bg: "rgba(239,68,68,.1)" };
  if (["doc", "docx", "txt", "md", "rtf"].includes(ext)) return { icon: FileText, color: "#3B82F6", bg: "rgba(59,130,246,.1)" };
  if (["xls", "xlsx", "csv"].includes(ext)) return { icon: FileSpreadsheet, color: "#22C55E", bg: "rgba(34,197,94,.1)" };
  if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)) return { icon: FileImage, color: "#A855F7", bg: "rgba(168,85,247,.1)" };
  if (["js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "cs", "go", "rs", "rb", "php", "sh", "sql", "yaml", "yml", "xml", "html", "css", "scss", "vue", "svelte", "toml", "ini", "env", "json"].includes(ext)) return { icon: FileCode, color: "#F59E0B", bg: "rgba(245,158,11,.1)" };
  return { icon: File, color: "#64748B", bg: "rgba(100,116,139,.1)" };
}

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [viewingContent, setViewingContent] = useState("");
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const supabase = createClient();
  const { t } = useTranslation();
  const dragCounter = useRef(0);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    params.then(({ id }) => {
      setAgentId(id);
      fetch(`/api/agents/${id}`).then((r) => r.json()).then(setAgent);
      fetchFiles(id);
    });
  }, [params]);

  function fetchFiles(id?: string) {
    const fetchId = id || agentId;
    if (!fetchId) return;
    fetch(`/api/agents/${fetchId}/files?t=${Date.now()}`).then((r) => r.json()).then(setFiles);
  }

  async function uploadFile(file: File) {
    if (!agent) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(`/api/agents/${agent.id}/files`, { method: "POST", body: formData });
      if (res.ok) { const data = await res.json(); setFiles((prev) => [data.file, ...prev]); }
    } catch {}
    setUploading(false);
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadFile(file);
    e.target.value = "";
  }

  function handleDragEnter(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); dragCounter.current++; setDragging(true); }
  function handleDragLeave(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); dragCounter.current--; if (dragCounter.current === 0) setDragging(false); }
  function handleDragOver(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); }
  async function handleDrop(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation(); dragCounter.current = 0; setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await uploadFile(file);
  }

  async function handleFileDelete(fileId: string) {
    if (!confirm(t("agents.confirmDeleteFile"))) return;
    try {
      const res = await fetch(`/api/agents/${agent!.id}/files?fileId=${fileId}`, { method: "DELETE" });
      if (res.ok) {
        setFiles((prev) => prev.filter((f) => f.id !== fileId));
        if (viewingFile === fileId) { setViewingFile(null); setViewingContent(""); }
        if (editingFile === fileId) { setEditingFile(null); setEditContent(""); }
      }
    } catch {}
  }

  async function fetchFileContent(fileId: string): Promise<string | null> {
    try {
      const res = await fetch(`/api/agents/${agent!.id}/files?fileId=${fileId}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.content || null;
    } catch { return null; }
  }

  async function handleViewFile(fileId: string) {
    if (viewingFile === fileId) { setViewingFile(null); setViewingContent(""); return; }
    setLoadingFile(fileId);
    const content = await fetchFileContent(fileId);
    if (content) { setViewingFile(fileId); setViewingContent(content); }
    setLoadingFile(null);
  }

  async function handleEditFile(fileId: string) {
    if (editingFile === fileId) { setEditingFile(null); setEditContent(""); return; }
    setLoadingFile(fileId);
    const content = await fetchFileContent(fileId);
    if (content) { setEditingFile(fileId); setEditContent(content); setViewingFile(null); }
    setLoadingFile(null);
  }

  async function handleSaveEdit(fileId: string, fileName: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${agent!.id}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: fileName, newContent: editContent }),
      });
      if (res.ok) { setEditingFile(null); setEditContent(""); }
      else { const err = await res.json(); alert(err.error || "Failed to save"); }
    } catch { alert("Failed to save"); }
    setSaving(false);
  }

  async function handleDownloadFile(fileId: string, fileName: string) {
    setLoadingFile(fileId);
    const content = await fetchFileContent(fileId);
    if (content) downloadText(content, fileName);
    setLoadingFile(null);
  }

  async function handleCopyFile(fileId: string) {
    setLoadingFile(fileId);
    const content = await fetchFileContent(fileId);
    if (content) { await navigator.clipboard.writeText(content); setCopiedFile(fileId); setTimeout(() => setCopiedFile(null), 2000); }
    setLoadingFile(null);
  }

  if (!agent) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin" size={24} style={{ color: '#6366F1' }} />
      </div>
    );
  }

  return (
    <>
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&display=swap');
      .fd-detail-root { font-family: 'Sora', system-ui, sans-serif; }
      .fd-detail-hero {
        position: relative; overflow: hidden;
        border-radius: 20px; padding: 1.8rem 2rem;
        background: linear-gradient(135deg, rgba(99,102,241,.1) 0%, rgba(59,130,246,.06) 50%, rgba(168,85,247,.05) 100%);
        border: 1px solid rgba(129,140,248,.1);
      }
      [data-theme="light"] .fd-detail-hero {
        background: linear-gradient(135deg, rgba(99,102,241,.05) 0%, rgba(59,130,246,.03) 50%, rgba(168,85,247,.02) 100%);
      }
      .fd-detail-hero-orb {
        position: absolute; width: 300px; height: 300px; border-radius: 50%;
        background: radial-gradient(circle, rgba(99,102,241,.12) 0%, transparent 70%);
        filter: blur(50px); top: -80px; right: -40px; pointer-events: none;
      }
      .fd-detail-upload {
        position: relative; border-radius: 18px; padding: 2.5rem 1.5rem;
        border: 2px dashed var(--color-border); text-align: center;
        transition: all .3s; cursor: pointer;
      }
      .fd-detail-upload:hover {
        border-color: rgba(99,102,241,.35);
        background: rgba(99,102,241,.02);
      }
      .fd-detail-upload.dragging {
        border-color: rgba(99,102,241,.5);
        background: rgba(99,102,241,.05);
        transform: scale(1.01);
      }
      .fd-detail-upload-icon {
        width: 56px; height: 56px; border-radius: 15px; margin: 0 auto .9rem;
        display: flex; align-items: center; justify-content: center;
        transition: transform .3s, box-shadow .3s;
      }
      .fd-detail-upload:hover .fd-detail-upload-icon {
        transform: translateY(-3px);
        box-shadow: 0 8px 20px rgba(99,102,241,.15);
      }
      .fd-detail-file {
        display: flex; align-items: center; gap: .8rem;
        padding: .8rem 1rem; border-radius: 14px;
        border: 1px solid var(--color-border); background: var(--color-card);
        transition: all .2s;
      }
      .fd-detail-file:hover {
        border-color: rgba(129,140,248,.2);
        background: var(--color-accent);
        box-shadow: 0 2px 8px rgba(99,102,241,.04);
      }
      .fd-detail-file-icon {
        width: 38px; height: 38px; border-radius: 10px;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      .fd-detail-file-btn {
        padding: 6px; border-radius: 8px; border: none; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        background: var(--color-muted); color: var(--color-muted-foreground);
        transition: all .15s;
      }
      .fd-detail-file-btn:hover { background: var(--color-accent); color: var(--color-foreground); }
      .fd-detail-file-btn.active { background: rgba(99,102,241,.12); color: #6366F1; }
      .fd-detail-file-btn.danger:hover { background: rgba(239,68,68,.1); color: #EF4444; }
      .fd-detail-view {
        border: 1px solid var(--color-border); border-top: none;
        border-radius: 0 0 14px 14px; background: var(--color-muted);
        margin-top: -1px; overflow: hidden;
      }
      .fd-detail-view-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: .6rem .85rem; border-bottom: 1px solid var(--color-border);
      }
      .fd-detail-view pre {
        padding: .85rem; margin: 0; font-size: .78rem; font-family: 'SF Mono', 'Fira Code', monospace;
        color: var(--color-foreground); opacity: .85; overflow-x: auto;
        max-height: 320px; overflow-y: auto; white-space: pre-wrap;
        line-height: 1.6; background: transparent;
      }
      .fd-detail-view textarea {
        width: 100%; padding: .85rem; margin: 0; font-size: .78rem;
        font-family: 'SF Mono', 'Fira Code', monospace;
        color: var(--color-foreground); background: transparent;
        border: none; outline: none; resize: vertical;
        min-height: 200px; max-height: 600px; line-height: 1.6;
        box-sizing: border-box;
      }
      .fd-detail-action {
        display: inline-flex; align-items: center; gap: .45rem;
        padding: .6rem 1.1rem; border-radius: 12px;
        font-size: .85rem; font-weight: 600; font-family: inherit;
        border: none; cursor: pointer; transition: all .2s;
      }
      .fd-detail-action.primary {
        background: linear-gradient(135deg, #6366F1, #8B5CF6);
        color: #fff; box-shadow: 0 4px 14px rgba(99,102,241,.25);
      }
      .fd-detail-action.primary:hover {
        transform: translateY(-1px);
        box-shadow: 0 8px 24px rgba(99,102,241,.35);
      }
      .fd-detail-action.secondary {
        background: var(--color-card); color: var(--color-foreground);
        border: 1px solid var(--color-border);
      }
      .fd-detail-action.secondary:hover {
        border-color: rgba(129,140,248,.3);
        background: var(--color-accent);
      }
      .fd-detail-save-btn {
        display: flex; align-items: center; gap: .35rem;
        padding: .4rem .7rem; border-radius: 8px;
        font-size: .75rem; font-weight: 600; font-family: inherit;
        border: none; cursor: pointer;
        background: linear-gradient(135deg, #22C55E, #16A34A);
        color: #fff; transition: all .2s;
      }
      .fd-detail-save-btn:hover { box-shadow: 0 4px 12px rgba(34,197,94,.3); }
    `}</style>
    <div className="fd-detail-root h-full overflow-auto p-6">
      <div className="max-w-4xl mx-auto space-y-7">
        {/* Hero */}
        <div className="fd-detail-hero" style={{ opacity: mounted ? 1 : 0, transform: mounted ? 'translateY(0)' : 'translateY(12px)', transition: 'all .5s cubic-bezier(.16,1,.3,1)' }}>
          <div className="fd-detail-hero-orb" />
          <div className="flex items-center justify-between relative" style={{ zIndex: 2 }}>
            <div>
              <button
                onClick={() => router.push("/agents")}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '.78rem', color: 'var(--color-muted-foreground)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: '.5rem', fontFamily: 'inherit' }}
              >
                <ArrowLeft size={13} /> {t("agents.title")}
              </button>
              <h1 style={{ fontSize: '1.45rem', fontWeight: 800, letterSpacing: '-.035em', color: 'var(--color-foreground)', margin: '0 0 .2rem' }}>
                {agent.name}
              </h1>
              {agent.description && (
                <p style={{ fontSize: '.85rem', color: 'var(--color-muted-foreground)', margin: 0 }}>
                  {agent.description}
                </p>
              )}
            </div>
            <button onClick={() => router.push(`/agents/${agent.id}/chat`)} className="fd-detail-action primary">
              <Zap size={15} />
              {t("agents.chat")}
            </button>
          </div>
        </div>

        {/* Upload Zone */}
        <div
          className={`fd-detail-upload ${dragging ? 'dragging' : ''}`}
          style={{ opacity: mounted ? 1 : 0, transform: mounted ? 'translateY(0)' : 'translateY(10px)', transition: 'all .5s cubic-bezier(.16,1,.3,1) .1s' }}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <input
            type="file"
            id="agent-file-upload"
            className="hidden"
            accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.json,.png,.jpg,.jpeg,.gif,.webp,.js,.jsx,.ts,.tsx,.py,.java,.c,.cpp,.cs,.go,.rs,.rb,.php,.sh,.sql,.yaml,.yml,.xml,.html,.css,.scss,.json,.toml,.ini,.env,.vue,.svelte"
            onChange={handleFileUpload}
            disabled={uploading}
          />
          <label htmlFor="agent-file-upload" className="cursor-pointer">
            {uploading ? (
              <div className="flex flex-col items-center">
                <Loader2 size={26} className="animate-spin" style={{ color: '#6366F1', marginBottom: '.7rem' }} />
                <p style={{ fontSize: '.9rem', fontWeight: 600, color: 'var(--color-foreground)', margin: '0 0 .2rem' }}>{t("agents.uploading")}</p>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <div className="fd-detail-upload-icon" style={{ background: dragging ? 'linear-gradient(135deg, rgba(99,102,241,.2), rgba(139,92,246,.12))' : 'linear-gradient(135deg, rgba(99,102,241,.1), rgba(139,92,246,.06))' }}>
                  <Upload size={24} style={{ color: dragging ? '#6366F1' : 'var(--color-muted-foreground)' }} />
                </div>
                <p style={{ fontSize: '.95rem', fontWeight: 700, color: 'var(--color-foreground)', margin: '0 0 .25rem' }}>
                  {dragging ? t("agents.dropHere") : t("agents.uploadFiles")}
                </p>
                <p style={{ fontSize: '.8rem', color: 'var(--color-muted-foreground)', margin: 0 }}>
                  {dragging ? "Release to upload" : "PDF, Word, Excel, Images, Code — drag & drop or click"}
                </p>
              </div>
            )}
          </label>
        </div>

        {/* File List */}
        {files.length > 0 && (
          <div style={{ opacity: mounted ? 1 : 0, transform: mounted ? 'translateY(0)' : 'translateY(10px)', transition: 'all .5s cubic-bezier(.16,1,.3,1) .2s' }}>
            <div className="flex items-center justify-between mb-3">
              <h2 style={{ fontSize: '.95rem', fontWeight: 700, color: 'var(--color-foreground)' }}>
                {t("agents.agentFiles", { count: files.length })}
              </h2>
            </div>
            <div className="space-y-2">
              {files.map((file, idx) => {
                const fi = getFileIcon(file.file_name);
                const Icon = fi.icon;
                return (
                  <div key={file.id} style={{ animation: `fd-dash-drop .25s ease ${idx * 0.03}s both` }}>
                    <div className="fd-detail-file">
                      <div className="fd-detail-file-icon" style={{ background: fi.bg }}>
                        <Icon size={17} style={{ color: fi.color }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p style={{ fontSize: '.85rem', fontWeight: 600, color: 'var(--color-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
                          {file.file_name}
                        </p>
                        <p style={{ fontSize: '.72rem', color: 'var(--color-muted-foreground)', margin: 0, marginTop: 2 }}>
                          <span style={{ color: file.status === "indexed" ? '#22C55E' : file.status === "error" ? '#EF4444' : '#F59E0B' }}>
                            {t(`fileStatus.${file.status}`) || file.status}
                          </span>
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => handleViewFile(file.id)} disabled={loadingFile === file.id} className={`fd-detail-file-btn ${viewingFile === file.id ? 'active' : ''}`} title="View">
                          {loadingFile === file.id ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
                        </button>
                        <button onClick={() => handleEditFile(file.id)} disabled={loadingFile === file.id} className={`fd-detail-file-btn ${editingFile === file.id ? 'active' : ''}`} title="Edit">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => handleCopyFile(file.id)} disabled={loadingFile === file.id} className="fd-detail-file-btn" title="Copy">
                          {copiedFile === file.id ? <Check size={13} style={{ color: '#22C55E' }} /> : <Copy size={13} />}
                        </button>
                        <button onClick={() => handleDownloadFile(file.id, file.file_name)} disabled={loadingFile === file.id} className="fd-detail-file-btn" title="Download">
                          <Download size={13} />
                        </button>
                        <button onClick={() => handleFileDelete(file.id)} className="fd-detail-file-btn danger" title="Delete">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>

                    {/* View Panel */}
                    {viewingFile === file.id && viewingContent && (
                      <div className="fd-detail-view" style={{ animation: 'fd-dash-drop .2s ease' }}>
                        <div className="fd-detail-view-header">
                          <span style={{ fontSize: '.75rem', fontWeight: 600, color: 'var(--color-muted-foreground)' }}>Content Preview</span>
                          <button onClick={() => { setViewingFile(null); setViewingContent(""); }} className="fd-detail-file-btn" style={{ padding: 4 }}>
                            <X size={11} />
                          </button>
                        </div>
                        <pre>{viewingContent}</pre>
                      </div>
                    )}

                    {/* Edit Panel */}
                    {editingFile === file.id && (
                      <div className="fd-detail-view" style={{ animation: 'fd-dash-drop .2s ease' }}>
                        <div className="fd-detail-view-header">
                          <span style={{ fontSize: '.75rem', fontWeight: 600, color: '#6366F1' }}>Editing {file.file_name}</span>
                          <div className="flex items-center gap-2">
                            <button onClick={() => handleSaveEdit(file.id, file.file_name)} disabled={saving} className="fd-detail-save-btn">
                              {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                              Save
                            </button>
                            <button onClick={() => { setEditingFile(null); setEditContent(""); }} className="fd-detail-file-btn" style={{ padding: 4 }}>
                              <X size={11} />
                            </button>
                          </div>
                        </div>
                        <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} spellCheck={false} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
