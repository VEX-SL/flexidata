"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Plus, Bot, Trash2, Copy, MessageSquare, FileText, ArrowRight, Sparkles, Check } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { ConfirmDialog } from "@/components/confirm-dialog";

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
  "linear-gradient(135deg, rgba(115,115,115,.15), rgba(80,80,80,.1))",
  "linear-gradient(135deg, rgba(95,95,95,.15), rgba(34,211,238,.1))",
  "linear-gradient(135deg, rgba(90,90,90,.15), rgba(236,72,153,.1))",
  "linear-gradient(135deg, rgba(34,197,94,.15), rgba(140,140,140,.1))",
  "linear-gradient(135deg, rgba(245,158,11,.15), rgba(249,115,22,.1))",
  "linear-gradient(135deg, rgba(239,68,68,.15), rgba(244,63,94,.1))",
];

const ICON_COLORS = ["#9c9c9c", "#6b6b6b", "#535353", "#575757", "#d4d4d4", "#414141"];

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<{
    isOpen: boolean;
    agentId: string | null;
    agentName: string;
  }>({ isOpen: false, agentId: null, agentName: "" });
  const router = useRouter();
  const supabase = createClient();
  const { t } = useTranslation();

  // Custom translations for delete confirmation
  const customTranslations = {
    agents: {
      deleteAgentConfirm: {
        en: "Are you sure you want to delete agent '{name}'?",
        ar: "هل أنت متأكد من حذف الوكيل '{name}'؟"
      }
    },
    common: {
      confirmDelete: "Confirm Delete",
      delete: "Delete"
    }
  };

  const getTranslation = (key: string, params?: Record<string, string>) => {
    const translationKey = key.split('.').reduce((obj, part) => obj && obj[part], customTranslations);
    if (!translationKey) return key;
    const translation = translationKey;
    return params ? translation.replace(new RegExp(`{${Object.keys(params)[0]}}`, 'g'), params[Object.keys(params)[0]]) : translation;
  };

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

  function handleDelete(agent: Agent) {
    setDeleteDialog({ isOpen: true, agentId: agent.id, agentName: agent.name });
  }

  function cancelDelete() {
    setDeleteDialog({ isOpen: false, agentId: null, agentName: "" });
  }

  async function confirmDelete() {
    const id = deleteDialog.agentId;
    setDeleteDialog({ isOpen: false, agentId: null, agentName: "" });
    if (!id) return;
    try {
      const res = await fetch(`/api/agents/${id}`, { method: "DELETE" });
      if (res.ok) setAgents((prev) => prev.filter((a) => a.id !== id));
    } catch {}
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
          padding: 1rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .fd-agents-list {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 1rem;
          padding: 1rem;
        }
        .fd-agents-card {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 12px;
          padding: 1.5rem;
          backdrop-filter: blur(10px);
          transition: transform 0.2s, box-shadow 0.2s;
          cursor: pointer;
          position: relative;
          overflow: hidden;
        }
        .fd-agents-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
        }
        .fd-agents-card-header {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          margin-bottom: 1rem;
        }
        .fd-agents-card-name {
          font-size: 1.1rem;
          font-weight: 600;
          color: var(--color-foreground);
          margin: 0;
          line-height: 1.4;
        }
        .fd-agents-card-desc {
          font-size: 0.85rem;
          color: var(--color-muted-foreground);
          margin: 0;
          line-height: 1.4;
        }
        .fd-agents-card-actions {
          display: flex;
          gap: 0.5rem;
          margin-top: 1rem;
        }
        .fd-agents-card-stats {
          display: flex;
          gap: 1rem;
          font-size: 0.8rem;
          margin-top: 0.5rem;
        }
        .fd-agents-card-stat {
          display: flex;
          align-items: center;
          gap: 0.3rem;
          color: var(--color-muted-foreground);
        }
        .fd-agents-create {
          position: fixed;
          bottom: 2rem;
          right: 2rem;
          width: 56px;
          height: 56px;
          border-radius: 50%;
          background: var(--color-primary);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          transition: transform 0.2s, box-shadow 0.2s;
        }
        .fd-agents-create:hover {
          transform: scale(1.05);
          box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
        }
        .fd-agents-create-button {
          width: 100%;
          height: 100%;
          border-radius: 50%;
          background: var(--color-primary);
          border: none;
          color: var(--color-primary-foreground);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
        }
        .fd-agents-create-button:hover {
          background: var(--color-primary-hover);
        }
        .fd-agents-create-input {
          width: 100%;
          padding: 0.75rem;
          border-radius: 24px;
          border: 1px solid rgba(255, 255, 255, 0.2);
          background: rgba(255, 255, 255, 0.05);
          color: var(--color-foreground);
          font-size: 0.9rem;
          margin-top: 0.5rem;
        }
        .fd-agents-create-input:focus {
          outline: none;
          border-color: var(--color-primary);
          box-shadow: 0 0 0 2px var(--color-primary-focus);
        }
      `}
    </style>
    <div className="fd-agents-root">
      <div className="fd-agents-header">
        <h1 className="text-2xl font-bold text-foreground">Agents</h1>
      </div>
      <div className="fd-agents-list">
        {agents.map((agent, gradIdx) => (
          <div key={agent.id} className="fd-agents-card" onClick={() => router.push(`/agents/${agent.id}`)}>
            <div className="fd-agents-card-header">
              <div className="fd-agents-card-icon" style={{ background: GRADIENTS[gradIdx % GRADIENTS.length] }}>
                <Bot size={24} style={{ color: ICON_COLORS[gradIdx % ICON_COLORS.length] }} />
              </div>
              <div>
                <h3 className="fd-agents-card-name">{agent.name}</h3>
                {agent.description && <p className="fd-agents-card-desc">{agent.description}</p>}
              </div>
            </div>
            <div className="fd-agents-card-stats">
              <span className="fd-agents-card-stat">
                <FileText size={12} /> {agent.files_count} {t('dashboard.files').toLowerCase()}
              </span>
              <span className="fd-agents-card-stat">
                <MessageSquare size={12} /> {agent.chats_count} {t('dashboard.allChats').toLowerCase()}
              </span>
            </div>
            <div className="fd-agents-card-actions" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => setDeleteDialog({ isOpen: true, agentId: agent.id, agentName: agent.name })}
                style={{ padding: 6, borderRadius: 8, background: 'var(--color-muted)', border: 'none', cursor: 'pointer', color: 'var(--color-muted-foreground)', display: 'flex', transition: 'color .2s' }}
                onMouseEnter={(ev) => ev.currentTarget.style.color = '#EF4444'}
                onMouseLeave={(ev) => ev.currentTarget.style.color = 'var(--color-muted-foreground)'}
                title="Delete agent"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        isOpen={deleteDialog.isOpen}
        title={getTranslation('common.confirmDelete')}
        message={getTranslation('agents.deleteAgentConfirm', { name: deleteDialog.agentName })}
        confirmText={getTranslation('common.delete')}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </div>
  );
}