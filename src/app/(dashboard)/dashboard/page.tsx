"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  FileText,
  MessageSquare,
  Loader2,
  ChevronDown,
  Bot,
  Plus,
  Sparkles,
  ArrowRight,
  Zap,
  FolderOpen,
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";

interface Agent {
  id: string;
  name: string;
  files_count: number;
  chats_count: number;
}

interface AgentFile {
  id: string;
  file_name: string;
  file_type: string;
  status: string;
  created_at: string;
}

export default function DashboardPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [creating, setCreating] = useState(false);
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const { t } = useTranslation();

  useEffect(() => setMounted(true), []);

  const totalFiles = agents.reduce((sum, a) => sum + (a.files_count || 0), 0);
  const totalChats = agents.reduce((sum, a) => sum + (a.chats_count || 0), 0);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      if (res.ok) {
        const data = await res.json();
        setAgents(data);
        if (data.length > 0 && !selectedAgentId) {
          setSelectedAgentId(data[0].id);
        }
      }
    } catch {}
  }, [selectedAgentId]);

  const fetchFiles = useCallback(async () => {
    if (!selectedAgentId) { setFiles([]); return; }
    try {
      const res = await fetch(`/api/agents/${selectedAgentId}/files`);
      if (res.ok) setFiles(await res.json());
    } catch {}
  }, [selectedAgentId]);

  useEffect(() => { fetchAgents(); }, []);
  useEffect(() => { fetchFiles(); }, [selectedAgentId, fetchFiles]);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !selectedAgentId) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(`/api/agents/${selectedAgentId}/files`, { method: "POST", body: formData });
      if (res.ok) { const data = await res.json(); setFiles((prev) => [data.file, ...prev]); fetchAgents(); }
    } catch {}
    setUploading(false);
    e.target.value = "";
  }

  async function handleCreateAgent() {
    if (!newAgentName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newAgentName.trim() }),
      });
      if (res.ok) {
        const agent = await res.json();
        setAgents((prev) => [agent, ...prev]);
        setSelectedAgentId(agent.id);
        setNewAgentName("");
        setShowCreateAgent(false);
        router.push(`/agents/${agent.id}`);
      }
    } finally { setCreating(false); }
  }

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  return (
    <>
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&display=swap');
      .fd-dash-root { font-family: 'Sora', system-ui, sans-serif; }
      .fd-dash-hero {
        position: relative; overflow: hidden;
        border-radius: 20px; padding: 2.5rem 2rem;
        background: linear-gradient(135deg, rgba(99,102,241,.12) 0%, rgba(139,92,246,.08) 50%, rgba(59,130,246,.06) 100%);
        border: 1px solid rgba(129,140,248,.12);
      }
      [data-theme="light"] .fd-dash-hero {
        background: linear-gradient(135deg, rgba(99,102,241,.06) 0%, rgba(139,92,246,.04) 50%, rgba(59,130,246,.03) 100%);
        border-color: rgba(99,102,241,.1);
      }
      .fd-dash-hero-orb {
        position: absolute; width: 400px; height: 400px; border-radius: 50%;
        background: radial-gradient(circle, rgba(99,102,241,.18) 0%, transparent 70%);
        filter: blur(60px); top: -120px; right: -80px; pointer-events: none;
        animation: fd-dash-orb 8s ease-in-out infinite;
      }
      [data-theme="light"] .fd-dash-hero-orb {
        background: radial-gradient(circle, rgba(99,102,241,.1) 0%, transparent 70%);
      }
      @keyframes fd-dash-orb {
        0%, 100% { transform: translate(0, 0) scale(1); opacity: .7; }
        50% { transform: translate(-20px, 15px) scale(1.1); opacity: 1; }
      }
      .fd-dash-greeting {
        font-size: 1.65rem; font-weight: 800; letter-spacing: -.035em;
        color: var(--color-foreground); margin: 0 0 .35rem; position: relative; z-index: 2;
      }
      .fd-dash-sub {
        font-size: .92rem; color: var(--color-muted-foreground);
        margin: 0; position: relative; z-index: 2; font-weight: 400;
      }
      .fd-dash-stat {
        position: relative; overflow: hidden;
        border-radius: 16px; padding: 1.25rem 1.1rem;
        border: 1px solid var(--color-border);
        background: var(--color-card);
        transition: transform .25s, box-shadow .25s, border-color .25s;
        cursor: default;
      }
      .fd-dash-stat:hover {
        transform: translateY(-3px);
        box-shadow: 0 12px 32px rgba(99,102,241,.08);
        border-color: rgba(129,140,248,.25);
      }
      .fd-dash-stat-icon {
        width: 42px; height: 42px; border-radius: 12px;
        display: flex; align-items: center; justify-content: center;
        margin-bottom: .85rem;
      }
      .fd-dash-stat-num {
        font-size: 1.85rem; font-weight: 800; letter-spacing: -.04em;
        color: var(--color-foreground); line-height: 1;
      }
      .fd-dash-stat-label {
        font-size: .78rem; color: var(--color-muted-foreground);
        margin-top: .25rem; font-weight: 500;
      }
      .fd-dash-agent-btn {
        width: 100%; display: flex; align-items: center; justify-content: space-between;
        padding: .85rem 1rem; border-radius: 14px;
        border: 1px solid var(--color-border); background: var(--color-card);
        color: var(--color-foreground); cursor: pointer;
        transition: border-color .2s, box-shadow .2s, background .2s;
      }
      .fd-dash-agent-btn:hover {
        border-color: rgba(129,140,248,.3);
        box-shadow: 0 4px 16px rgba(99,102,241,.06);
      }
      .fd-dash-dropdown {
        position: absolute; z-index: 30; width: 100%; margin-top: 6px;
        border-radius: 14px; border: 1px solid var(--color-border);
        background: var(--color-card); box-shadow: 0 16px 48px rgba(0,0,0,.12);
        overflow: hidden; animation: fd-dash-drop .2s ease;
      }
      @keyframes fd-dash-drop {
        from { opacity: 0; transform: translateY(-6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .fd-dash-drop-item {
        width: 100%; display: flex; align-items: center; gap: .7rem;
        padding: .75rem 1rem; text-align: left; border: none; background: none;
        color: var(--color-foreground); cursor: pointer; font-family: inherit;
        transition: background .15s;
      }
      .fd-dash-drop-item:hover { background: var(--color-accent); }
      .fd-dash-drop-item.active { background: rgba(99,102,241,.08); }
      .fd-dash-upload {
        position: relative; border-radius: 16px; padding: 2rem 1.5rem;
        border: 2px dashed var(--color-border); text-align: center;
        transition: border-color .25s, background .25s; cursor: pointer;
      }
      .fd-dash-upload:hover {
        border-color: rgba(99,102,241,.35);
        background: rgba(99,102,241,.03);
      }
      .fd-dash-upload.dragging {
        border-color: rgba(99,102,241,.5);
        background: rgba(99,102,241,.06);
      }
      .fd-dash-upload-icon {
        width: 52px; height: 52px; border-radius: 14px; margin: 0 auto .8rem;
        background: linear-gradient(135deg, rgba(99,102,241,.1), rgba(139,92,246,.08));
        display: flex; align-items: center; justify-content: center;
      }
      .fd-dash-file-row {
        display: flex; align-items: center; gap: .75rem;
        padding: .7rem .85rem; border-radius: 12px;
        border: 1px solid var(--color-border); background: var(--color-card);
        transition: background .15s, border-color .15s;
      }
      .fd-dash-file-row:hover {
        background: var(--color-accent);
        border-color: rgba(129,140,248,.2);
      }
      .fd-dash-action-btn {
        display: inline-flex; align-items: center; gap: .5rem;
        padding: .65rem 1.2rem; border-radius: 12px;
        font-size: .85rem; font-weight: 600; font-family: inherit;
        border: none; cursor: pointer; transition: all .2s;
      }
      .fd-dash-action-primary {
        background: linear-gradient(135deg, #6366F1, #8B5CF6);
        color: #fff; box-shadow: 0 4px 14px rgba(99,102,241,.25);
      }
      .fd-dash-action-primary:hover {
        transform: translateY(-1px);
        box-shadow: 0 8px 24px rgba(99,102,241,.35);
      }
      .fd-dash-action-secondary {
        background: var(--color-card); color: var(--color-foreground);
        border: 1px solid var(--color-border);
      }
      .fd-dash-action-secondary:hover {
        border-color: rgba(129,140,248,.3);
        background: var(--color-accent);
      }
      .fd-dash-empty {
        text-align: center; padding: 2.5rem 1.5rem; border-radius: 16px;
        border: 2px dashed var(--color-border);
      }
      .fd-dash-empty-icon {
        width: 64px; height: 64px; border-radius: 16px; margin: 0 auto 1rem;
        background: linear-gradient(135deg, rgba(99,102,241,.08), rgba(139,92,246,.06));
        display: flex; align-items: center; justify-content: center;
      }
      .fd-dash-create-input {
        width: 100%; padding: .7rem .9rem; border-radius: 12px;
        font-size: .9rem; font-family: inherit;
        background: var(--color-background); border: 1px solid var(--color-border);
        color: var(--color-foreground); outline: none;
        transition: border-color .2s, box-shadow .2s; box-sizing: border-box;
      }
      .fd-dash-create-input:focus {
        border-color: rgba(99,102,241,.45);
        box-shadow: 0 0 0 3px rgba(99,102,241,.08);
      }
      .fd-dash-create-input::placeholder { color: var(--color-muted-foreground); }
    `}</style>
    <div className="fd-dash-root h-full overflow-auto p-6" suppressHydrationWarning>
      <div className="max-w-4xl mx-auto space-y-7">
        {/* Hero */}
        <div className="fd-dash-hero" style={{ opacity: mounted ? 1 : 0, transform: mounted ? 'translateY(0)' : 'translateY(12px)', transition: 'all .5s cubic-bezier(.16,1,.3,1)' }}>
          <div className="fd-dash-hero-orb" />
          <h1 className="fd-dash-greeting">
            {t("dashboard.title")} 👋
          </h1>
          <p className="fd-dash-sub">{t("dashboard.subtitle")}</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="fd-dash-stat" style={{ opacity: mounted ? 1 : 0, transform: mounted ? 'translateY(0)' : 'translateY(10px)', transition: 'all .5s cubic-bezier(.16,1,.3,1) .1s' }}>
            <div className="fd-dash-stat-icon" style={{ background: 'linear-gradient(135deg, rgba(99,102,241,.12), rgba(139,92,246,.08))' }}>
              <Bot size={20} style={{ color: '#6366F1' }} />
            </div>
            <div className="fd-dash-stat-num">{agents.length}</div>
            <div className="fd-dash-stat-label">{t("dashboard.agents")}</div>
          </div>
          <div className="fd-dash-stat" style={{ opacity: mounted ? 1 : 0, transform: mounted ? 'translateY(0)' : 'translateY(10px)', transition: 'all .5s cubic-bezier(.16,1,.3,1) .15s' }}>
            <div className="fd-dash-stat-icon" style={{ background: 'linear-gradient(135deg, rgba(34,197,94,.12), rgba(34,197,94,.06))' }}>
              <FolderOpen size={20} style={{ color: '#22C55E' }} />
            </div>
            <div className="fd-dash-stat-num">{totalFiles}</div>
            <div className="fd-dash-stat-label">{t("dashboard.files")}</div>
          </div>
          <div className="fd-dash-stat" style={{ opacity: mounted ? 1 : 0, transform: mounted ? 'translateY(0)' : 'translateY(10px)', transition: 'all .5s cubic-bezier(.16,1,.3,1) .2s' }}>
            <div className="fd-dash-stat-icon" style={{ background: 'linear-gradient(135deg, rgba(245,158,11,.12), rgba(245,158,11,.06))' }}>
              <MessageSquare size={20} style={{ color: '#F59E0B' }} />
            </div>
            <div className="fd-dash-stat-num">{totalChats}</div>
            <div className="fd-dash-stat-label">{t("dashboard.allChats")}</div>
          </div>
        </div>

        {/* Agent Selector */}
        <div className="space-y-4" style={{ opacity: mounted ? 1 : 0, transform: mounted ? 'translateY(0)' : 'translateY(10px)', transition: 'all .5s cubic-bezier(.16,1,.3,1) .25s' }}>
          <label style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--color-muted-foreground)', letterSpacing: '.02em', textTransform: 'uppercase' }}>
            {t("dashboard.selectAgent")}
          </label>
          <div className="relative">
            <button onClick={() => setDropdownOpen(!dropdownOpen)} className="fd-dash-agent-btn">
              <div className="flex items-center gap-3">
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, rgba(99,102,241,.15), rgba(139,92,246,.1))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Bot size={17} style={{ color: '#6366F1' }} />
                </div>
                <div>
                  <div style={{ fontSize: '.9rem', fontWeight: 600 }}>
                    {selectedAgent ? selectedAgent.name : t("dashboard.selectAgent")}
                  </div>
                  {selectedAgent && (
                    <div style={{ fontSize: '.75rem', color: 'var(--color-muted-foreground)', marginTop: 1 }}>
                      {selectedAgent.files_count} {t("dashboard.files").toLowerCase()} · {selectedAgent.chats_count} {t("dashboard.allChats").toLowerCase()}
                    </div>
                  )}
                </div>
              </div>
              <ChevronDown size={16} style={{ color: 'var(--color-muted-foreground)', transition: 'transform .2s', transform: dropdownOpen ? 'rotate(180deg)' : 'rotate(0)' }} />
            </button>

            {dropdownOpen && (
              <div className="fd-dash-dropdown">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => { setSelectedAgentId(agent.id); setDropdownOpen(false); }}
                    className={`fd-dash-drop-item ${agent.id === selectedAgentId ? 'active' : ''}`}
                  >
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: agent.id === selectedAgentId ? 'linear-gradient(135deg, rgba(99,102,241,.2), rgba(139,92,246,.12))' : 'var(--color-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Bot size={14} style={{ color: agent.id === selectedAgentId ? '#6366F1' : 'var(--color-muted-foreground)' }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div style={{ fontSize: '.85rem', fontWeight: 600 }}>{agent.name}</div>
                      <div style={{ fontSize: '.72rem', color: 'var(--color-muted-foreground)' }}>
                        {agent.files_count} {t("dashboard.files").toLowerCase()} · {agent.chats_count} {t("dashboard.allChats").toLowerCase()}
                      </div>
                    </div>
                    {agent.id === selectedAgentId && (
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#6366F1', flexShrink: 0 }} />
                    )}
                  </button>
                ))}
                <button
                  onClick={() => { setDropdownOpen(false); setShowCreateAgent(true); }}
                  className="fd-dash-drop-item"
                  style={{ borderTop: '1px solid var(--color-border)', color: '#6366F1', fontWeight: 600 }}
                >
                  <Plus size={15} />
                  {t("dashboard.newAgent")}
                </button>
              </div>
            )}
          </div>

          {/* Create Agent */}
          {showCreateAgent && (
            <div style={{ padding: '1.1rem', borderRadius: 14, border: '1px solid var(--color-border)', background: 'var(--color-card)', animation: 'fd-dash-drop .2s ease' }}>
              <input
                type="text"
                placeholder={t("agents.namePlaceholder")}
                value={newAgentName}
                onChange={(e) => setNewAgentName(e.target.value)}
                className="fd-dash-create-input"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateAgent(); if (e.key === "Escape") setShowCreateAgent(false); }}
              />
              <div className="flex gap-2 mt-3">
                <button onClick={handleCreateAgent} disabled={creating || !newAgentName.trim()} className="fd-dash-action-btn fd-dash-action-primary" style={{ flex: 1 }}>
                  {creating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {creating ? t("agents.creating") : t("agents.create")}
                </button>
                <button onClick={() => setShowCreateAgent(false)} className="fd-dash-action-btn fd-dash-action-secondary">
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          )}

          {/* Empty State */}
          {agents.length === 0 && !showCreateAgent && (
            <div className="fd-dash-empty">
              <div className="fd-dash-empty-icon">
                <Bot size={28} style={{ color: '#6366F1' }} />
              </div>
              <p style={{ fontSize: '.9rem', fontWeight: 600, color: 'var(--color-foreground)', margin: '0 0 .3rem' }}>
                {t("agents.noAgents")}
              </p>
              <p style={{ fontSize: '.82rem', color: 'var(--color-muted-foreground)', margin: '0 0 1.2rem' }}>
                {t("agents.noAgentsSub")}
              </p>
              <button onClick={() => setShowCreateAgent(true)} className="fd-dash-action-btn fd-dash-action-primary">
                <Plus size={15} />
                {t("agents.create")}
              </button>
            </div>
          )}

          {/* Selected Agent Actions */}
          {selectedAgent && (
            <>
              {/* Upload Zone */}
              <div className="fd-dash-upload">
                <input
                  type="file"
                  id="file-upload-dash"
                  className="hidden"
                  accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.json,.jpg,.jpeg,.png,.gif,.webp"
                  onChange={handleFileUpload}
                  disabled={uploading}
                />
                <label htmlFor="file-upload-dash" className="cursor-pointer">
                  {uploading ? (
                    <div className="flex flex-col items-center">
                      <Loader2 size={24} className="animate-spin" style={{ color: '#6366F1', marginBottom: '.6rem' }} />
                      <span style={{ fontSize: '.85rem', color: 'var(--color-muted-foreground)' }}>{t("agents.uploading")}</span>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center">
                      <div className="fd-dash-upload-icon">
                        <Upload size={22} style={{ color: '#6366F1' }} />
                      </div>
                      <p style={{ fontSize: '.9rem', fontWeight: 600, color: 'var(--color-foreground)', margin: '0 0 .2rem' }}>
                        {t("agents.uploadFiles")}
                      </p>
                      <p style={{ fontSize: '.78rem', color: 'var(--color-muted-foreground)', margin: 0 }}>
                        PDF, Word, Excel, Images, Code — up to 50MB
                      </p>
                    </div>
                  )}
                </label>
              </div>

              {/* Recent Files */}
              {files.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h2 style={{ fontSize: '.95rem', fontWeight: 700, color: 'var(--color-foreground)' }}>
                      {t("agents.agentFiles", { count: files.length })}
                    </h2>
                  </div>
                  <div className="space-y-2">
                    {files.slice(0, 5).map((file) => (
                      <div key={file.id} className="fd-dash-file-row">
                        <div style={{ width: 34, height: 34, borderRadius: 9, background: 'linear-gradient(135deg, rgba(99,102,241,.1), rgba(139,92,246,.06))', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <FileText size={15} style={{ color: '#6366F1' }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--color-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {file.file_name}
                          </p>
                          <p style={{ fontSize: '.72rem', color: 'var(--color-muted-foreground)', margin: 0 }}>
                            <span style={{ color: file.status === "indexed" ? '#22C55E' : file.status === "error" ? '#EF4444' : '#F59E0B' }}>
                              {t(`fileStatus.${file.status}`) || file.status}
                            </span>
                          </p>
                        </div>
                      </div>
                    ))}
                    {files.length > 5 && (
                      <p style={{ fontSize: '.75rem', color: 'var(--color-muted-foreground)', textAlign: 'center', padding: '.5rem 0' }}>
                        +{files.length - 5} more files
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3">
                <button onClick={() => router.push(`/agents/${selectedAgentId}`)} className="fd-dash-action-btn fd-dash-action-secondary" style={{ flex: 1 }}>
                  <FolderOpen size={15} />
                  {t("dashboard.files")}
                  <ArrowRight size={14} style={{ marginLeft: 'auto' }} />
                </button>
                <button onClick={() => router.push(`/agents/${selectedAgentId}/chat`)} className="fd-dash-action-btn fd-dash-action-primary" style={{ flex: 1 }}>
                  <Zap size={15} />
                  {t("agents.chat")}
                  <ArrowRight size={14} style={{ marginLeft: 'auto' }} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
