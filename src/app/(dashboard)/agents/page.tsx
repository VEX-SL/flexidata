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
];

const ICON_COLORS = ["#9c9c9c", "#6b6b6b", "#535353"];

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [deleteDialog, setDeleteDialog] = useState<{ isOpen: boolean; agentId: string | null; agentName: string }>({
    isOpen: false,
    agentId: null,
    agentName: ""
  });
  const router = useRouter();
  const supabase = createClient();
  const { t } = useTranslation();

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      if (res.ok) setAgents(await res.json());
    } catch {}
  }, []);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  function handleDelete(agent: Agent) {
    setDeleteDialog(prev => ({ 
      isOpen: true,
      agentId: agent.id as string,
      agentName: agent.name
    }));
  }

  function cancelDelete() {
    setDeleteDialog({
      isOpen: false,
      agentId: null,
      agentName: ""
    });
  }

  async function confirmDelete() {
    const id = deleteDialog.agentId;
    if (!id) return;
    setDeleteDialog({
      isOpen: false,
      agentId: null,
      agentName: ""
    });
    if (!id) return;
    try {
      const res = await fetch(`/api/agents/${id}`, { method: "DELETE" });
      if (res.ok) {
        setAgents(prev => prev.filter(a => a.id !== id));
      }
    } catch {}
  }

  return (
    <div className="p-6">
      <div className="fd-agents-list">
        {agents.map((agent, gradIdx) => (
          <div key={agent.id} className="fd-agents-card" onClick={() => router.push(`/agents/${agent.id}`)}>
            <div className="fd-agents-card-header">
              <div className="fd-agents-card-icon" style={{ background: GRADIENTS[gradIdx % GRADIENTS.length] }}>
                <Bot size={24} style={{ color: ICON_COLORS[gradIdx % ICON_COLORS.length] }} />
              </div>
              <div>
                <h3 className="fd-agents-card-name">{agent.name}</h3>
              </div>
            </div>
            <div className="fd-agents-card-actions" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => handleDelete(agent)}
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
        title="Confirm Delete"
        message={`Are you sure you want to delete agent '${deleteDialog.agentName}'?`}
        confirmText="Delete"
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </div>
  );
}