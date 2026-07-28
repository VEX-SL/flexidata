"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Plus, Bot, Trash2, Copy, MessageSquare, FileText, ArrowRight, Sparkles, Check } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

interface Agent {
  id: string;
  name: string;
  description: string | null;
  share_token: string | null;
  files_count: number;
  chats_count: number;
  created_at: string;
}

const GRADIENTS = [
  "linear-gradient(135deg, rgba(99,102,241,.15), rgba(139,92,246,.1))",
  "linear-gradient(135deg, rgba(59,130,246,.15), rgba(34,211,238,.1))",
  "linear-gradient(135deg, rgba(168,85,247,.15), rgba(236,72,153,.1))",
  "linear-gradient(135deg, rgba(34,197,94,.15), rgba(16,185,129,.1))",
  "linear-gradient(135deg, rgba(245,158,11,.15), rgba(249,115,22,.1))",
  "linear-gradient(135deg, rgba(239,68,68,.15), rgba(244,63,94,.1))",
];

const ICON_COLORS = ["#6366F1", "#3B82F6", "#A855F7", "#22C55E", "#F59E0B", "#EF4444"];

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();
  const { t } = useTranslation();

  useEffect(() => setMounted(true), []);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      if (res.ok) setAgents(await res.json());
    } catch {}
  }, []);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (res.ok) { const agent = await res.json(); router.push(`/agents/${agent.id}`); }
    } finally { setLoading(false); }
  }

  async function handleDelete(id: string) {
    if (!confirm(t("agents.confirmDelete"))) return;
    const res = await fetch(`/api/agents/${id}`, { method: "DELETE" });
    if (res.ok) setAgents((prev) => prev.filter((a) => a.id !== id));
  }

  function copyShareLink(token: string) {
    navigator.clipboard.writeText(`${window.location.origin}/agent/${token}`);
    setCopiedLink(token);
    setTimeout(() => setCopiedLink(null), 2000);
  }

  return (
    <>
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&display=swap');
      .fd-agents-root { font-family: 'Sora', system-ui, sans-serif; }
      .fd-agents-header {
        position: relative; overflow: hidden;
        border-radius: 20px; padding: 2rem 2rem;
        background: linear-gradient(135deg, rgba(99,102,241,.1) 0%, rgba(168,85,247,.06) 100%);
        border: 1px solid rgba(129,140,248,.1);
        margin-bottom: 1.5rem;
      }
      [data-theme="light"] .fd-agents-header {
        background: linear-gradient(135deg, rgba(99,102,241,.05) 0%, rgba(168,85,247,.03) 100%);
      }
      .fd-agents-card {
        position: relative; overflow: hidden;
        border-radius: 16px; padding: 1.3rem;
        border: 1px solid var(--color-border);
        background: var(--color-card);
        transition: transform .25s, box-shadow .25s, border-color .25s;
        cursor: pointer;
      }
      .fd-agents-card:hover {
        transform: translateY(-4px);
        box-shadow: 0 16px 40px rgba(99,102,241,.08);
        border-color: rgba(129,140,248,.25);
      }
      .fd-agents-card-icon {
        width: 46px; height: 46px; border-radius: 13px;
        display: flex; align-items: center; justify-content: center;
        margin-bottom: 1rem;
      }
      .fd-agents-card-name {
        font-size: 1rem; font-weight: 700; color: var(--color-foreground);
        margin: 0 0 .2rem; letter-spacing: -.02em;
      }
      .fd-agents-card-desc {
        font-size: .8rem; color: var(--color-muted-foreground);
        margin: 0 0 1rem; line-height: 1.5;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      }
      .fd-agents-card-stats {
        display: flex; gap: .8rem; font-size: .75rem; color: var(--color-muted-foreground);
        margin-bottom: 1rem;
      }
      .fd-agents-card-stat {
        display: flex; align-items: center; gap: .35rem;
      }
      .fd-agents-card-actions {
        display: flex; gap: .4rem; padding-top: .8rem;
        border-top: 1px solid var(--color-border);
      }
      .fd-agents-card-btn {
        flex: 1; display: flex; align-items: center; justify-content: center; gap: .4rem;
        padding: .55rem .5rem; border-radius: 10px;
        font-size: .78rem; font-weight: 600; font-family: inherit;
        border: 1px solid var(--color-border); background: var(--color-card);
        color: var(--color-foreground); cursor: pointer;
        transition: all .2s;
      }
      .fd-agents-card-btn:hover {
        background: var(--color-accent);
        border-color: rgba(129,140,248,.25);
      }
      .fd-agents-card-btn.primary {
        background: linear-gradient(135deg, #6366F1, #8B5CF6);
        color: #fff; border: none;
        box-shadow: 0 3px 10px rgba(99,102,241,.2);
      }
      .fd-agents-card-btn.primary:hover {
        box-shadow: 0 6px 18px rgba(99,102,241,.3);
        transform: translateY(-1px);
      }
      .fd-agents-create-input {
        width: 100%; padding: .75rem 1rem; border-radius: 12px;
        font-size: .9rem; font-family: inherit;
        background: var(--color-background); border: 1px solid var(--color-border);
        color: var(--color-foreground); outline: none;
        transition: border-color .2s, box-shadow .2s; box-sizing: border-box;
      }
      .fd-agents-create-input:focus {
        border-color: rgba(99,102,241,.45);
        box-shadow: 0 0 0 3px rgba(99,102,241,.08);
      }
      .fd-agents-create-input::placeholder { color: var(--color-muted-foreground); }
      .fd-agents-empty {
        text-align: center; padding: 3.5rem 1.5rem;
      }
      .fd-agents-empty-icon {
        width: 72px; height: 72px; border-radius: 18px; margin: 0 auto 1.2rem;
        background: linear-gradient(135deg, rgba(99,102,241,.1), rgba(139,92,246,.06));
        display: flex; align-items: center; justify-content: center;
      }
    `}</style>
    <div className="fd-agents-root h-full overflow-auto p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="fd-agents-header" style={{ opacity: mounted ? 1 : 0, transform: mounted ? 'translateY(0)' : 'translateY(12px)', transition: 'all .5s cubic-bezier(.16,1,.3,1)' }}>
          <div className="flex items-center justify-between">
            <div>
              <h1 style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-.035em', color: 'var(--color-foreground)', margin: '0 0 .25rem' }}>
                {t("agents.title")}
              </h1>
              <p style={{ fontSize: '.88rem', color: 'var(--color-muted-foreground)', margin: 0 }}>
                {t("agents.subtitle")}
              </p>
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="fd-agents-card-btn primary"
              style={{ padding: '.65rem 1.1rem', fontSize: '.85rem', flexShrink: 0 }}
            >
              <Plus size={15} />
              {t("agents.create")}
            </button>
          </div>
        </div>

        {/* Create Form */}
        {showCreate && (
          <div style={{ padding: '1.2rem', borderRadius: 14, border: '1px solid var(--color-border)', background: 'var(--color-card)', marginBottom: '1.5rem', animation: 'fd-dash-drop .2s ease' }}>
            <input
              type="text"
              placeholder={t("agents.namePlaceholder")}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="fd-agents-create-input"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setShowCreate(false); }}
            />
            <div className="flex gap-2 mt-3">
              <button onClick={handleCreate} disabled={loading || !newName.trim()} className="fd-agents-card-btn primary" style={{ flex: 1, padding: '.65rem' }}>
                {loading ? <span className="animate-spin">⟳</span> : <Sparkles size={14} />}
                {loading ? t("agents.creating") : t("agents.create")}
              </button>
              <button onClick={() => setShowCreate(false)} className="fd-agents-card-btn" style={{ flex: 'none', padding: '.65rem 1rem' }}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}

        {/* Empty State */}
        {agents.length === 0 && !showCreate && (
          <div className="fd-agents-empty" style={{ opacity: mounted ? 1 : 0, transition: 'all .5s cubic-bezier(.16,1,.3,1) .15s' }}>
            <div className="fd-agents-empty-icon">
              <Bot size={32} style={{ color: '#6366F1' }} />
            </div>
            <p style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--color-foreground)', margin: '0 0 .3rem' }}>
              {t("agents.noAgents")}
            </p>
            <p style={{ fontSize: '.85rem', color: 'var(--color-muted-foreground)', margin: '0 0 1.5rem', maxWidth: 320, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.6 }}>
              {t("agents.noAgentsSub")}
            </p>
            <button onClick={() => setShowCreate(true)} className="fd-agents-card-btn primary" style={{ padding: '.7rem 1.3rem', fontSize: '.88rem', display: 'inline-flex' }}>
              <Plus size={16} />
              {t("agents.create")}
            </button>
          </div>
        )}

        {/* Agent Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {agents.map((agent, idx) => {
            const gradIdx = idx % GRADIENTS.length;
            return (
              <div
                key={agent.id}
                className="fd-agents-card"
                style={{ opacity: mounted ? 1 : 0, transform: mounted ? 'translateY(0)' : 'translateY(14px)', transition: `all .5s cubic-bezier(.16,1,.3,1) ${0.1 + idx * 0.06}s` }}
              >
                {/* Top gradient accent */}
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${ICON_COLORS[gradIdx]}40, ${ICON_COLORS[gradIdx]}15)`, borderRadius: '16px 16px 0 0' }} />

                <div className="flex items-start justify-between" onClick={() => router.push(`/agents/${agent.id}`)}>
                  <div className="fd-agents-card-icon" style={{ background: GRADIENTS[gradIdx] }}>
                    <Bot size={20} style={{ color: ICON_COLORS[gradIdx] }} />
                  </div>
                  <div className="flex gap-1" style={{ opacity: 0 }} onMouseEnter={(e) => (e.currentTarget.parentElement!.style.opacity = '1')} onFocus={(e) => (e.currentTarget.parentElement!.style.opacity = '1')}>
                    {agent.share_token && (
                      <button
                        onClick={(e) => { e.stopPropagation(); copyShareLink(agent.share_token!); }}
                        style={{ padding: 6, borderRadius: 8, background: 'var(--color-muted)', border: 'none', cursor: 'pointer', color: copiedLink === agent.share_token ? '#22C55E' : 'var(--color-muted-foreground)', display: 'flex', transition: 'color .2s' }}
                        title="Copy share link"
                      >
                        {copiedLink === agent.share_token ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(agent.id); }}
                      style={{ padding: 6, borderRadius: 8, background: 'var(--color-muted)', border: 'none', cursor: 'pointer', color: 'var(--color-muted-foreground)', display: 'flex', transition: 'color .2s' }}
                      onMouseEnter={(ev) => ev.currentTarget.style.color = '#EF4444'}
                      onMouseLeave={(ev) => ev.currentTarget.style.color = 'var(--color-muted-foreground)'}
                      title="Delete agent"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                <div onClick={() => router.push(`/agents/${agent.id}`)} style={{ cursor: 'pointer' }}>
                  <h3 className="fd-agents-card-name">{agent.name}</h3>
                  {agent.description && <p className="fd-agents-card-desc">{agent.description}</p>}
                  {!agent.description && <div style={{ height: '1rem' }} />}

                  <div className="fd-agents-card-stats">
                    <span className="fd-agents-card-stat">
                      <FileText size={12} /> {agent.files_count} {t("dashboard.files").toLowerCase()}
                    </span>
                    <span className="fd-agents-card-stat">
                      <MessageSquare size={12} /> {agent.chats_count} {t("dashboard.allChats").toLowerCase()}
                    </span>
                  </div>
                </div>

                <div className="fd-agents-card-actions">
                  <button onClick={() => router.push(`/agents/${agent.id}`)} className="fd-agents-card-btn">
                    <FileText size={13} />
                    {t("dashboard.files")}
                    <ArrowRight size={12} />
                  </button>
                  <button onClick={() => router.push(`/agents/${agent.id}/chat`)} className="fd-agents-card-btn primary">
                    <MessageSquare size={13} />
                    {t("agents.chat")}
                    <ArrowRight size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
    </>
  );
}
