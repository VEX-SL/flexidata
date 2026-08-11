"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  FileText,
  MessageSquare,
  Loader2,
  Bot,
  Plus,
  Sparkles,
  ArrowRight,
  Zap,
  FolderOpen,
  Search,
  Bell,
  MoreHorizontal,
  Clock,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  FileImage,
  FileCode,
  File,
  TrendingUp,
  Activity,
  X,
  ChevronRight,
  BarChart3,
  Users,
  Flame,
  Settings,
  LogOut,
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";

interface Agent {
  id: string;
  name: string;
  files_count: number;
  chats_count: number;
  created_at?: string;
  description?: string;
}

interface AgentFile {
  id: string;
  file_name: string;
  file_type: string;
  status: string;
  created_at: string;
  size?: number;
}

function getFileIcon(type: string) {
  const t = type.toLowerCase();
  if (t.includes("pdf") || t.includes("doc")) return <FileText size={16} />;
  if (t.includes("sheet") || t.includes("excel") || t.includes("csv")) return <FileSpreadsheet size={16} />;
  if (t.includes("image") || t.includes("jpg") || t.includes("png")) return <FileImage size={16} />;
  if (t.includes("json") || t.includes("code") || t.includes("md")) return <FileCode size={16} />;
  return <File size={16} />;
}

function getFileColor(type: string) {
  const t = type.toLowerCase();
  if (t.includes("pdf") || t.includes("doc")) return { bg: "bg-indigo-500/10", color: "text-indigo-500", border: "border-indigo-500/20" };
  if (t.includes("sheet") || t.includes("excel") || t.includes("csv")) return { bg: "bg-emerald-500/10", color: "text-emerald-500", border: "border-emerald-500/20" };
  if (t.includes("image") || t.includes("jpg") || t.includes("png")) return { bg: "bg-amber-500/10", color: "text-amber-500", border: "border-amber-500/20" };
  if (t.includes("json") || t.includes("code") || t.includes("md")) return { bg: "bg-pink-500/10", color: "text-pink-500", border: "border-pink-500/20" };
  return { bg: "bg-slate-500/10", color: "text-slate-500", border: "border-slate-500/20" };
}

function formatFileSize(bytes?: number) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function timeAgo(date: string) {
  const seconds = Math.floor((new Date().getTime() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

export default function DashboardPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [creating, setCreating] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "recent" | "activity">("overview");
  const fileInputRef = useRef<HTMLInputElement>(null);
  
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

  async function handleFileUpload(file: File) {
    if (!selectedAgentId) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(`/api/agents/${selectedAgentId}/files`, { method: "POST", body: formData });
      if (res.ok) { const data = await res.json(); setFiles((prev) => [data.file, ...prev]); fetchAgents(); }
    } catch {}
    setUploading(false);
  }

  function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFileUpload(file);
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileUpload(file);
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
  const filteredFiles = files.filter(f => 
    f.file_name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const recentActivity = [
    { type: "upload", text: "Uploaded quarterly-report.pdf", time: "2m ago", agent: "Finance Agent" },
    { type: "chat", text: "New conversation started", time: "15m ago", agent: "Support Bot" },
    { type: "index", text: "3 files indexed successfully", time: "1h ago", agent: "Research Agent" },
  ];

  return (
    <>
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&display=swap');
      
      .fd-dash { 
        font-family: 'Sora', system-ui, sans-serif;
        min-height: 100dvh;
        background: var(--color-background);
      }
      
      /* ── Top Header ── */
      .fd-header {
        height: 64px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-card);
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 1.5rem;
        position: sticky;
        top: 0;
        z-index: 20;
        backdrop-filter: blur(12px);
        background: rgba(var(--color-card-rgb), 0.8);
      }
      
      .fd-search {
        position: relative;
        width: 100%;
        max-width: 360px;
      }
      .fd-search svg {
        position: absolute;
        left: 12px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--color-muted-foreground);
        pointer-events: none;
      }
      .fd-search input {
        width: 100%;
        padding: 0.55rem 0.9rem 0.55rem 2.5rem;
        border-radius: 10px;
        border: 1px solid var(--color-border);
        background: var(--color-background);
        color: var(--color-foreground);
        font-family: inherit;
        font-size: 0.85rem;
        outline: none;
        transition: all 0.2s;
      }
      .fd-search input:focus {
        border-color: rgba(99,102,241,0.4);
        box-shadow: 0 0 0 3px rgba(99,102,241,0.08);
      }
      
      .fd-header-actions {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .fd-icon-btn {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        border: 1px solid var(--color-border);
        background: var(--color-background);
        color: var(--color-muted-foreground);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.15s;
        position: relative;
      }
      .fd-icon-btn:hover {
        border-color: rgba(129,140,248,0.3);
        color: var(--color-foreground);
        background: var(--color-accent);
      }
      
      .fd-avatar {
        width: 34px;
        height: 34px;
        border-radius: 9px;
        background: linear-gradient(135deg, #6366F1, #8B5CF6);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        font-weight: 600;
        font-size: 0.8rem;
        cursor: pointer;
        border: 2px solid var(--color-border);
        transition: all 0.15s;
      }
      .fd-avatar:hover {
        border-color: rgba(99,102,241,0.4);
        box-shadow: 0 0 0 3px rgba(99,102,241,0.1);
      }
      
      /* ── Content ── */
      .fd-content {
        padding: 1.5rem;
        max-width: 1280px;
        margin: 0 auto;
      }
      
      /* ── Hero ── */
      .fd-hero {
        position: relative;
        overflow: hidden;
        border-radius: 20px;
        padding: 2rem 2.25rem;
        background: linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(139,92,246,0.05) 50%, rgba(59,130,246,0.03) 100%);
        border: 1px solid rgba(129,140,248,0.1);
        margin-bottom: 1.5rem;
      }
      [data-theme="light"] .fd-hero {
        background: linear-gradient(135deg, rgba(99,102,241,0.04) 0%, rgba(139,92,246,0.02) 50%, rgba(59,130,246,0.02) 100%);
      }
      .fd-hero-orb {
        position: absolute;
        width: 300px;
        height: 300px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%);
        filter: blur(40px);
        top: -80px;
        right: -40px;
        pointer-events: none;
        animation: fd-orb 6s ease-in-out infinite;
      }
      @keyframes fd-orb {
        0%, 100% { transform: translate(0,0) scale(1); opacity: 0.6; }
        50% { transform: translate(-10px, 8px) scale(1.05); opacity: 0.9; }
      }
      .fd-hero h1 {
        font-size: 1.45rem;
        font-weight: 800;
        letter-spacing: -0.03em;
        color: var(--color-foreground);
        margin: 0 0 0.3rem;
        position: relative;
        z-index: 2;
      }
      .fd-hero p {
        font-size: 0.87rem;
        color: var(--color-muted-foreground);
        margin: 0;
        position: relative;
        z-index: 2;
        max-width: 480px;
        line-height: 1.6;
      }
      
      /* ── Tabs ── */
      .fd-tabs {
        display: flex;
        gap: 0.25rem;
        margin-bottom: 1.5rem;
        padding: 0.25rem;
        background: var(--color-accent);
        border-radius: 12px;
        width: fit-content;
        border: 1px solid var(--color-border);
      }
      .fd-tab {
        padding: 0.5rem 1rem;
        border-radius: 10px;
        border: none;
        background: none;
        color: var(--color-muted-foreground);
        font-family: inherit;
        font-size: 0.82rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
      }
      .fd-tab.active {
        background: var(--color-card);
        color: var(--color-foreground);
        box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      }
      .fd-tab:hover:not(.active) {
        color: var(--color-foreground);
      }
      
      /* ── Stats ── */
      .fd-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 1rem;
        margin-bottom: 1.5rem;
      }
      @media (max-width: 640px) {
        .fd-stats { grid-template-columns: 1fr; }
      }
      .fd-stat {
        position: relative;
        overflow: hidden;
        border-radius: 16px;
        padding: 1.25rem;
        border: 1px solid var(--color-border);
        background: var(--color-card);
        transition: all 0.25s;
      }
      .fd-stat:hover {
        transform: translateY(-2px);
        box-shadow: 0 12px 32px rgba(99,102,241,0.06);
        border-color: rgba(129,140,248,0.2);
      }
      .fd-stat-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: 0.75rem;
      }
      .fd-stat-icon {
        width: 38px;
        height: 38px;
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .fd-stat-badge {
        font-size: 0.7rem;
        font-weight: 700;
        padding: 0.2rem 0.5rem;
        border-radius: 6px;
        display: flex;
        align-items: center;
        gap: 0.25rem;
      }
      .fd-stat-value {
        font-size: 1.65rem;
        font-weight: 800;
        letter-spacing: -0.04em;
        color: var(--color-foreground);
        line-height: 1;
        margin-bottom: 0.2rem;
      }
      .fd-stat-label {
        font-size: 0.78rem;
        color: var(--color-muted-foreground);
        font-weight: 500;
      }
      
      /* ── Section ── */
      .fd-section {
        margin-bottom: 1.5rem;
      }
      .fd-section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 0.875rem;
      }
      .fd-section-title {
        font-size: 0.92rem;
        font-weight: 700;
        color: var(--color-foreground);
        letter-spacing: -0.01em;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .fd-section-link {
        font-size: 0.78rem;
        font-weight: 600;
        color: #6366F1;
        background: none;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 0.25rem;
        transition: gap 0.2s;
      }
      .fd-section-link:hover { gap: 0.4rem; }
      
      /* ── Agent Cards ── */
      .fd-agent-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: 0.875rem;
        margin-bottom: 1.5rem;
      }
      @media (max-width: 480px) {
        .fd-agent-grid { grid-template-columns: 1fr; }
      }
      .fd-agent-card {
        position: relative;
        border-radius: 16px;
        padding: 1.1rem;
        border: 1px solid var(--color-border);
        background: var(--color-card);
        cursor: pointer;
        transition: all 0.2s;
        text-align: left;
        font-family: inherit;
        color: inherit;
      }
      .fd-agent-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 24px rgba(99,102,241,0.06);
        border-color: rgba(129,140,248,0.25);
      }
      .fd-agent-card.active {
        border-color: rgba(99,102,241,0.4);
        background: linear-gradient(135deg, rgba(99,102,241,0.05), rgba(139,92,246,0.03));
        box-shadow: 0 0 0 3px rgba(99,102,241,0.08);
      }
      .fd-agent-card-header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 0.75rem;
      }
      .fd-agent-avatar {
        width: 40px;
        height: 40px;
        border-radius: 11px;
        background: linear-gradient(135deg, rgba(99,102,241,0.15), rgba(139,92,246,0.1));
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .fd-agent-card h3 {
        font-size: 0.88rem;
        font-weight: 700;
        color: var(--color-foreground);
        margin: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fd-agent-card p {
        font-size: 0.75rem;
        color: var(--color-muted-foreground);
        margin: 0.15rem 0 0;
      }
      .fd-agent-stats {
        display: flex;
        gap: 1rem;
        margin-top: 0.75rem;
        padding-top: 0.75rem;
        border-top: 1px solid var(--color-border);
      }
      .fd-agent-stat {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.75rem;
        color: var(--color-muted-foreground);
        font-weight: 500;
      }
      
      /* ── Upload Zone ── */
      .fd-upload {
        position: relative;
        border-radius: 16px;
        padding: 2.25rem 1.5rem;
        border: 2px dashed var(--color-border);
        text-align: center;
        transition: all 0.3s;
        cursor: pointer;
        background: var(--color-card);
        margin-bottom: 1.5rem;
      }
      .fd-upload:hover, .fd-upload.drag-over {
        border-color: rgba(99,102,241,0.4);
        background: rgba(99,102,241,0.02);
      }
      .fd-upload.drag-over {
        transform: scale(1.005);
        border-color: #6366F1;
        background: rgba(99,102,241,0.04);
      }
      .fd-upload-icon {
        width: 52px;
        height: 52px;
        border-radius: 14px;
        margin: 0 auto 0.875rem;
        background: linear-gradient(135deg, rgba(99,102,241,0.12), rgba(139,92,246,0.08));
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .fd-upload h3 {
        font-size: 0.92rem;
        font-weight: 600;
        color: var(--color-foreground);
        margin: 0 0 0.2rem;
      }
      .fd-upload p {
        font-size: 0.76rem;
        color: var(--color-muted-foreground);
        margin: 0;
      }
      
      /* ── File List ── */
      .fd-file-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        margin-bottom: 1.5rem;
      }
      .fd-file-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.7rem 0.85rem;
        border-radius: 12px;
        border: 1px solid var(--color-border);
        background: var(--color-card);
        transition: all 0.15s;
        cursor: pointer;
      }
      .fd-file-row:hover {
        background: var(--color-accent);
        border-color: rgba(129,140,248,0.2);
      }
      .fd-file-icon {
        width: 36px;
        height: 36px;
        border-radius: 9px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .fd-file-info {
        flex: 1;
        min-width: 0;
      }
      .fd-file-name {
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--color-foreground);
        margin: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fd-file-meta {
        font-size: 0.72rem;
        color: var(--color-muted-foreground);
        display: flex;
        align-items: center;
        gap: 0.35rem;
        margin-top: 0.1rem;
      }
      .fd-file-status {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        font-size: 0.7rem;
        font-weight: 600;
        padding: 0.15rem 0.5rem;
        border-radius: 99px;
        flex-shrink: 0;
      }
      .fd-file-status.indexed { background: rgba(34,197,94,0.1); color: #22C55E; }
      .fd-file-status.processing { background: rgba(245,158,11,0.1); color: #F59E0B; }
      .fd-file-status.error { background: rgba(239,68,68,0.1); color: #EF4444; }
      
      /* ── Activity Feed ── */
      .fd-activity {
        display: flex;
        flex-direction: column;
        gap: 0;
      }
      .fd-activity-item {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        padding: 0.875rem 0;
        border-bottom: 1px solid var(--color-border);
      }
      .fd-activity-item:last-child { border-bottom: none; }
      .fd-activity-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-top: 0.4rem;
        flex-shrink: 0;
      }
      .fd-activity-content {
        flex: 1;
        min-width: 0;
      }
      .fd-activity-text {
        font-size: 0.82rem;
        font-weight: 500;
        color: var(--color-foreground);
        margin: 0 0 0.15rem;
      }
      .fd-activity-meta {
        font-size: 0.72rem;
        color: var(--color-muted-foreground);
        display: flex;
        align-items: center;
        gap: 0.4rem;
      }
      
      /* ── Quick Actions ── */
      .fd-actions {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 0.75rem;
      }
      @media (max-width: 480px) {
        .fd-actions { grid-template-columns: 1fr; }
      }
      .fd-action {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.875rem 1rem;
        border-radius: 14px;
        border: 1px solid var(--color-border);
        background: var(--color-card);
        cursor: pointer;
        transition: all 0.2s;
        text-align: left;
        font-family: inherit;
        color: inherit;
      }
      .fd-action:hover {
        border-color: rgba(129,140,248,0.3);
        box-shadow: 0 4px 16px rgba(99,102,241,0.06);
        transform: translateY(-1px);
      }
      .fd-action-icon {
        width: 38px;
        height: 38px;
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .fd-action h4 {
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--color-foreground);
        margin: 0 0 0.1rem;
      }
      .fd-action p {
        font-size: 0.72rem;
        color: var(--color-muted-foreground);
        margin: 0;
      }
      
      /* ── Empty ── */
      .fd-empty {
        text-align: center;
        padding: 3rem 1.5rem;
        border-radius: 16px;
        border: 2px dashed var(--color-border);
        background: var(--color-card);
      }
      .fd-empty-icon {
        width: 56px;
        height: 56px;
        border-radius: 14px;
        margin: 0 auto 1rem;
        background: linear-gradient(135deg, rgba(99,102,241,0.08), rgba(139,92,246,0.06));
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      /* ── Modal ── */
      .fd-modal-bg {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.5);
        backdrop-filter: blur(4px);
        z-index: 50;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        animation: fd-fade-in 0.2s ease;
      }
      @keyframes fd-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .fd-modal {
        width: 100%;
        max-width: 400px;
        background: var(--color-card);
        border: 1px solid var(--color-border);
        border-radius: 20px;
        padding: 1.5rem;
        animation: fd-modal-in 0.3s cubic-bezier(0.16,1,0.3,1);
        box-shadow: 0 24px 64px rgba(0,0,0,0.2);
      }
      @keyframes fd-modal-in {
        from { opacity: 0; transform: scale(0.95) translateY(10px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      .fd-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 1.25rem;
      }
      .fd-modal-header h3 {
        font-size: 1.05rem;
        font-weight: 700;
        color: var(--color-foreground);
        margin: 0;
      }
      .fd-modal-close {
        width: 30px;
        height: 30px;
        border-radius: 8px;
        border: none;
        background: var(--color-accent);
        color: var(--color-muted-foreground);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.15s;
      }
      .fd-modal-close:hover {
        background: var(--color-border);
        color: var(--color-foreground);
      }
      
      .fd-input {
        width: 100%;
        padding: 0.65rem 0.9rem;
        border-radius: 11px;
        font-size: 0.88rem;
        font-family: inherit;
        background: var(--color-background);
        border: 1px solid var(--color-border);
        color: var(--color-foreground);
        outline: none;
        transition: all 0.2s;
        box-sizing: border-box;
        margin-bottom: 0.75rem;
      }
      .fd-input:focus {
        border-color: rgba(99,102,241,0.4);
        box-shadow: 0 0 0 3px rgba(99,102,241,0.08);
      }
      
      .fd-btn {
        width: 100%;
        padding: 0.65rem;
        border-radius: 11px;
        font-size: 0.88rem;
        font-weight: 600;
        font-family: inherit;
        border: none;
        cursor: pointer;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
      }
      .fd-btn-primary {
        background: linear-gradient(135deg, #6366F1, #8B5CF6);
        color: #fff;
      }
      .fd-btn-primary:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 8px 24px rgba(99,102,241,0.35);
      }
      .fd-btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
      .fd-btn-secondary {
        background: var(--color-background);
        color: var(--color-foreground);
        border: 1px solid var(--color-border);
      }
      .fd-btn-secondary:hover { background: var(--color-accent); }
      
      /* ── Layout Grid ── */
      .fd-layout {
        display: grid;
        grid-template-columns: 1fr 320px;
        gap: 1.5rem;
      }
      @media (max-width: 1024px) {
        .fd-layout { grid-template-columns: 1fr; }
      }
      
      /* ── Card ── */
      .fd-card {
        border-radius: 16px;
        border: 1px solid var(--color-border);
        background: var(--color-card);
        padding: 1.25rem;
      }
      .fd-card-title {
        font-size: 0.88rem;
        font-weight: 700;
        color: var(--color-foreground);
        margin: 0 0 0.75rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      
      /* ── Animations ── */
      .fd-animate {
        opacity: 0;
        transform: translateY(12px);
        animation: fd-slide-up 0.5s cubic-bezier(0.16,1,0.3,1) forwards;
      }
      @keyframes fd-slide-up {
        to { opacity: 1; transform: translateY(0); }
      }
      
      /* ── Dropdowns ── */
      .fd-dropdown {
        position: absolute;
        right: 0;
        top: calc(100% + 6px);
        min-width: 180px;
        background: var(--color-card);
        border: 1px solid var(--color-border);
        border-radius: 12px;
        box-shadow: 0 16px 48px rgba(0,0,0,0.12);
        padding: 0.4rem;
        z-index: 50;
        animation: fd-drop 0.2s ease;
      }
      @keyframes fd-drop {
        from { opacity: 0; transform: translateY(-6px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .fd-dropdown-item {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.5rem 0.65rem;
        border-radius: 8px;
        border: none;
        background: none;
        color: var(--color-foreground);
        font-family: inherit;
        font-size: 0.8rem;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s;
      }
      .fd-dropdown-item:hover { background: var(--color-accent); }
      .fd-dropdown-item.danger { color: #EF4444; }
      .fd-dropdown-item.danger:hover { background: rgba(239,68,68,0.08); }
      .fd-dropdown-divider {
        height: 1px;
        background: var(--color-border);
        margin: 0.3rem;
      }
    `}</style>

    <div className="fd-dash">
      {/* Sticky Header */}
      <header className="fd-header">
        <div className="fd-search">
          <Search size={15} />
          <input 
            type="text" 
            placeholder="Search agents, files..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="fd-header-actions">
          <div style={{ position: 'relative' }}>
            <button 
              className="fd-icon-btn"
              onClick={() => { setNotificationsOpen(!notificationsOpen); setUserMenuOpen(false); }}
            >
              <Bell size={16} />
              <span style={{
                position: 'absolute', top: 6, right: 6,
                width: 7, height: 7, borderRadius: '50%',
                background: '#EF4444', border: '2px solid var(--color-card)'
              }} />
            </button>
            {notificationsOpen && (
              <div className="fd-dropdown" style={{ width: 260, right: -10 }}>
                <div style={{ padding: '0.5rem', borderBottom: '1px solid var(--color-border)' }}>
                  <span style={{ fontSize: '0.78rem', fontWeight: 700 }}>Notifications</span>
                </div>
                <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--color-muted-foreground)', fontSize: '0.8rem' }}>
                  No new notifications
                </div>
              </div>
            )}
          </div>

          <div style={{ position: 'relative' }}>
            <div className="fd-avatar" onClick={() => { setUserMenuOpen(!userMenuOpen); setNotificationsOpen(false); }}>
              U
            </div>
            {userMenuOpen && (
              <div className="fd-dropdown">
                <button className="fd-dropdown-item" onClick={() => router.push("/settings")}>
                  <Settings size={14} /> Settings
                </button>
                <div className="fd-dropdown-divider" />
                <button className="fd-dropdown-item danger" onClick={() => {}}>
                  <LogOut size={14} /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="fd-content">
        {/* Hero */}
        <div className="fd-hero fd-animate">
          <div className="fd-hero-orb" />
          <h1>{t("dashboard.title")} 👋</h1>
          <p>{t("dashboard.subtitle")}</p>
        </div>

        {/* Tabs */}
        <div className="fd-tabs fd-animate" style={{ animationDelay: '0.05s' }}>
          <button 
            className={`fd-tab ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            Overview
          </button>
          <button 
            className={`fd-tab ${activeTab === 'recent' ? 'active' : ''}`}
            onClick={() => setActiveTab('recent')}
          >
            Recent Files
          </button>
          <button 
            className={`fd-tab ${activeTab === 'activity' ? 'active' : ''}`}
            onClick={() => setActiveTab('activity')}
          >
            Activity
          </button>
        </div>

        {/* Stats */}
        <div className="fd-stats fd-animate" style={{ animationDelay: '0.1s' }}>
          <div className="fd-stat">
            <div className="fd-stat-top">
              <div className="fd-stat-icon" style={{ background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(139,92,246,0.08))' }}>
                <Bot size={17} style={{ color: '#6366F1' }} />
              </div>
              <span className="fd-stat-badge" style={{ background: 'rgba(99,102,241,0.1)', color: '#6366F1' }}>
                <Flame size={10} /> Active
              </span>
            </div>
            <div className="fd-stat-value">{agents.length}</div>
            <div className="fd-stat-label">{t("dashboard.agents")}</div>
          </div>

          <div className="fd-stat">
            <div className="fd-stat-top">
              <div className="fd-stat-icon" style={{ background: 'linear-gradient(135deg, rgba(34,197,94,0.12), rgba(34,197,94,0.06))' }}>
                <FolderOpen size={17} style={{ color: '#22C55E' }} />
              </div>
              <span className="fd-stat-badge" style={{ background: 'rgba(34,197,94,0.1)', color: '#22C55E' }}>
                <TrendingUp size={10} /> +{totalFiles > 0 ? totalFiles : 0}
              </span>
            </div>
            <div className="fd-stat-value">{totalFiles}</div>
            <div className="fd-stat-label">{t("dashboard.files")}</div>
          </div>

          <div className="fd-stat">
            <div className="fd-stat-top">
              <div className="fd-stat-icon" style={{ background: 'linear-gradient(135deg, rgba(245,158,11,0.12), rgba(245,158,11,0.06))' }}>
                <MessageSquare size={17} style={{ color: '#F59E0B' }} />
              </div>
              <span className="fd-stat-badge" style={{ background: 'rgba(245,158,11,0.1)', color: '#F59E0B' }}>
                <Activity size={10} /> Live
              </span>
            </div>
            <div className="fd-stat-value">{totalChats}</div>
            <div className="fd-stat-label">{t("dashboard.allChats")}</div>
          </div>
        </div>

        {/* Content based on active tab */}
        {activeTab === 'overview' && (
          <div className="fd-layout fd-animate" style={{ animationDelay: '0.15s' }}>
            <div>
              {/* Agent Selector Cards */}
              <div className="fd-section">
                <div className="fd-section-header">
                  <h2 className="fd-section-title">
                    <Bot size={16} style={{ color: '#6366F1' }} />
                    Your Agents
                  </h2>
                  <button className="fd-section-link" onClick={() => router.push("/agents")}>
                    View all <ChevronRight size={14} />
                  </button>
                </div>

                {agents.length > 0 ? (
                  <div className="fd-agent-grid">
                    {agents.map((agent) => (
                      <button
                        key={agent.id}
                        className={`fd-agent-card ${agent.id === selectedAgentId ? 'active' : ''}`}
                        onClick={() => setSelectedAgentId(agent.id)}
                      >
                        <div className="fd-agent-card-header">
                          <div className="fd-agent-avatar">
                            <Bot size={18} style={{ color: '#6366F1' }} />
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <h3>{agent.name}</h3>
                            <p>AI Document Agent</p>
                          </div>
                        </div>
                        <div className="fd-agent-stats">
                          <span className="fd-agent-stat">
                            <FolderOpen size={12} /> {agent.files_count} files
                          </span>
                          <span className="fd-agent-stat">
                            <MessageSquare size={12} /> {agent.chats_count} chats
                          </span>
                        </div>
                      </button>
                    ))}
                    <button 
                      className="fd-agent-card"
                      onClick={() => setShowCreateAgent(true)}
                      style={{ 
                        borderStyle: 'dashed', 
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'center',
                        gap: '0.5rem',
                        color: 'var(--color-muted-foreground)',
                        fontWeight: 600,
                        fontSize: '0.85rem'
                      }}
                    >
                      <Plus size={18} /> Create Agent
                    </button>
                  </div>
                ) : (
                  <div className="fd-empty">
                    <div className="fd-empty-icon">
                      <Bot size={24} style={{ color: '#6366F1' }} />
                    </div>
                    <p style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--color-foreground)', margin: '0 0 0.3rem' }}>
                      {t("agents.noAgents")}
                    </p>
                    <p style={{ fontSize: '0.8rem', color: 'var(--color-muted-foreground)', margin: '0 0 1.25rem' }}>
                      {t("agents.noAgentsSub")}
                    </p>
                    <button 
                      onClick={() => setShowCreateAgent(true)} 
                      className="fd-btn fd-btn-primary"
                      style={{ maxWidth: 200, margin: '0 auto' }}
                    >
                      <Plus size={16} /> {t("agents.create")}
                    </button>
                  </div>
                )}
              </div>

              {/* Upload Zone */}
              {selectedAgent && (
                <div 
                  className={`fd-upload ${dragOver ? 'drag-over' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.json,.jpg,.jpeg,.png,.gif,.webp"
                    onChange={onFileInputChange}
                    disabled={uploading}
                  />
                  {uploading ? (
                    <div className="flex flex-col items-center">
                      <Loader2 size={24} className="animate-spin" style={{ color: '#6366F1', marginBottom: '0.6rem' }} />
                      <h3>Uploading...</h3>
                      <p>Processing your document</p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center">
                      <div className="fd-upload-icon">
                        <Upload size={22} style={{ color: '#6366F1' }} />
                      </div>
                      <h3>Drop files here or click to upload</h3>
                      <p>PDF, Word, Excel, Images, Code — up to 50MB</p>
                    </div>
                  )}
                </div>
              )}

              {/* Quick Actions */}
              {selectedAgent && (
                <div className="fd-actions">
                  <button className="fd-action" onClick={() => router.push(`/agents/${selectedAgentId}`)}>
                    <div className="fd-action-icon" style={{ background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(139,92,246,0.08))' }}>
                      <FolderOpen size={17} style={{ color: '#6366F1' }} />
                    </div>
                    <div>
                      <h4>Manage Files</h4>
                      <p>View and organize documents</p>
                    </div>
                  </button>
                  <button className="fd-action" onClick={() => router.push(`/agents/${selectedAgentId}/chat`)}>
                    <div className="fd-action-icon" style={{ background: 'linear-gradient(135deg, rgba(245,158,11,0.12), rgba(245,158,11,0.06))' }}>
                      <Zap size={17} style={{ color: '#F59E0B' }} />
                    </div>
                    <div>
                      <h4>Start Chat</h4>
                      <p>Talk with your AI agent</p>
                    </div>
                  </button>
                </div>
              )}
            </div>

            {/* Right Sidebar Content */}
            <div>
              <div className="fd-card fd-animate" style={{ animationDelay: '0.2s' }}>
                <h3 className="fd-card-title">
                  <Activity size={15} style={{ color: '#F59E0B' }} />
                  Recent Activity
                </h3>
                <div className="fd-activity">
                  {recentActivity.map((item, i) => (
                    <div key={i} className="fd-activity-item">
                      <div 
                        className="fd-activity-dot" 
                        style={{ 
                          background: item.type === 'upload' ? '#6366F1' : item.type === 'chat' ? '#F59E0B' : '#22C55E' 
                        }} 
                      />
                      <div className="fd-activity-content">
                        <p className="fd-activity-text">{item.text}</p>
                        <div className="fd-activity-meta">
                          <span>{item.agent}</span>
                          <span>·</span>
                          <span>{item.time}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {selectedAgent && filteredFiles.length > 0 && (
                <div className="fd-card fd-animate" style={{ animationDelay: '0.25s', marginTop: '1rem' }}>
                  <div className="fd-section-header" style={{ marginBottom: '0.75rem' }}>
                    <h3 className="fd-card-title" style={{ margin: 0 }}>
                      <FileText size={15} style={{ color: '#6366F1' }} />
                      Latest Files
                    </h3>
                  </div>
                  <div className="fd-file-list">
                    {filteredFiles.slice(0, 4).map((file) => {
                      const colors = getFileColor(file.file_type);
                      return (
                        <div key={file.id} className="fd-file-row">
                          <div className={`fd-file-icon ${colors.bg} ${colors.color}`}>
                            {getFileIcon(file.file_type)}
                          </div>
                          <div className="fd-file-info">
                            <p className="fd-file-name">{file.file_name}</p>
                            <div className="fd-file-meta">
                              <span>{formatFileSize(file.size)}</span>
                              <span>·</span>
                              <span>{timeAgo(file.created_at)}</span>
                            </div>
                          </div>
                          <span className={`fd-file-status ${file.status}`}>
                            {file.status === 'indexed' && <CheckCircle2 size={9} />}
                            {file.status === 'processing' && <Clock size={9} />}
                            {file.status === 'error' && <AlertCircle size={9} />}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {filteredFiles.length > 4 && (
                    <button 
                      className="fd-section-link" 
                      style={{ marginTop: '0.75rem', width: '100%', justifyContent: 'center' }}
                      onClick={() => router.push(`/agents/${selectedAgentId}`)}
                    >
                      View all {filteredFiles.length} files <ChevronRight size={14} />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'recent' && (
          <div className="fd-animate" style={{ animationDelay: '0.15s' }}>
            {filteredFiles.length > 0 ? (
              <div className="fd-file-list">
                {filteredFiles.map((file) => {
                  const colors = getFileColor(file.file_type);
                  return (
                    <div key={file.id} className="fd-file-row">
                      <div className={`fd-file-icon ${colors.bg} ${colors.color}`}>
                        {getFileIcon(file.file_type)}
                      </div>
                      <div className="fd-file-info">
                        <p className="fd-file-name">{file.file_name}</p>
                        <div className="fd-file-meta">
                          <span>{formatFileSize(file.size)}</span>
                          <span>·</span>
                          <span>{timeAgo(file.created_at)}</span>
                        </div>
                      </div>
                      <span className={`fd-file-status ${file.status}`}>
                        {file.status === 'indexed' && <CheckCircle2 size={9} />}
                        {file.status === 'processing' && <Clock size={9} />}
                        {file.status === 'error' && <AlertCircle size={9} />}
                        {file.status}
                      </span>
                      <button className="fd-icon-btn" style={{ width: 32, height: 32 }}>
                        <MoreHorizontal size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="fd-empty">
                <p style={{ color: 'var(--color-muted-foreground)', fontSize: '0.9rem' }}>
                  {searchQuery ? `No files match "${searchQuery}"` : "No files uploaded yet"}
                </p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'activity' && (
          <div className="fd-card fd-animate" style={{ animationDelay: '0.15s', maxWidth: 640 }}>
            <h3 className="fd-card-title">
              <BarChart3 size={15} style={{ color: '#6366F1' }} />
              Activity Log
            </h3>
            <div className="fd-activity">
              {recentActivity.map((item, i) => (
                <div key={i} className="fd-activity-item">
                  <div 
                    className="fd-activity-dot" 
                    style={{ 
                      background: item.type === 'upload' ? '#6366F1' : item.type === 'chat' ? '#F59E0B' : '#22C55E' 
                    }} 
                  />
                  <div className="fd-activity-content">
                    <p className="fd-activity-text">{item.text}</p>
                    <div className="fd-activity-meta">
                      <span>{item.agent}</span>
                      <span>·</span>
                      <span>{item.time}</span>
                    </div>
                  </div>
                </div>
              ))}
              <div className="fd-activity-item" style={{ opacity: 0.5 }}>
                <div className="fd-activity-dot" style={{ background: 'var(--color-border)' }} />
                <div className="fd-activity-content">
                  <p className="fd-activity-text">End of recent activity</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Create Agent Modal */}
      {showCreateAgent && (
        <div className="fd-modal-bg" onClick={() => setShowCreateAgent(false)}>
          <div className="fd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="fd-modal-header">
              <h3>Create New Agent</h3>
              <button className="fd-modal-close" onClick={() => setShowCreateAgent(false)}>
                <X size={15} />
              </button>
            </div>
            <input
              type="text"
              placeholder={t("agents.namePlaceholder")}
              value={newAgentName}
              onChange={(e) => setNewAgentName(e.target.value)}
              className="fd-input"
              autoFocus
              onKeyDown={(e) => { 
                if (e.key === "Enter") handleCreateAgent(); 
                if (e.key === "Escape") setShowCreateAgent(false); 
              }}
            />
            <div className="flex gap-2">
              <button 
                onClick={handleCreateAgent} 
                disabled={creating || !newAgentName.trim()} 
                className="fd-btn fd-btn-primary"
                style={{ flex: 1 }}
              >
                {creating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {creating ? t("agents.creating") : t("agents.create")}
              </button>
              <button 
                onClick={() => setShowCreateAgent(false)} 
                className="fd-btn fd-btn-secondary"
                style={{ width: 'auto', padding: '0.65rem 1.1rem' }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}