"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
  Search,
  Bell,
  Settings,
  LogOut,
  LayoutDashboard,
  Users,
  BarChart3,
  MoreVertical,
  Trash2,
  X,
  Menu,
  ChevronLeft,
  Clock,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  FileImage,
  FileCode,
  File,
  TrendingUp,
  Activity,
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/client";

interface Agent {
  id: string;
  name: string;
  files_count: number;
  chats_count: number;
  created_at?: string;
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
  if (t.includes("pdf") || t.includes("doc")) return <FileText size={18} />;
  if (t.includes("sheet") || t.includes("excel") || t.includes("csv")) return <FileSpreadsheet size={18} />;
  if (t.includes("image") || t.includes("jpg") || t.includes("png")) return <FileImage size={18} />;
  if (t.includes("json") || t.includes("code") || t.includes("md")) return <FileCode size={18} />;
  return <File size={18} />;
}

function getFileColor(type: string) {
  const t = type.toLowerCase();
  if (t.includes("pdf") || t.includes("doc")) return { bg: "rgba(99,102,241,.12)", color: "#6366F1" };
  if (t.includes("sheet") || t.includes("excel") || t.includes("csv")) return { bg: "rgba(34,197,94,.12)", color: "#22C55E" };
  if (t.includes("image") || t.includes("jpg") || t.includes("png")) return { bg: "rgba(245,158,11,.12)", color: "#F59E0B" };
  if (t.includes("json") || t.includes("code") || t.includes("md")) return { bg: "rgba(236,72,153,.12)", color: "#EC4899" };
  return { bg: "rgba(148,163,184,.12)", color: "#94A3B8" };
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const router = useRouter();
  const { t } = useTranslation();
  const supabase = createClient();

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

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const filteredFiles = files.filter(f => 
    f.file_name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const recentFiles = [...files].sort((a, b) => 
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  ).slice(0, 4);

  return (
    <>
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&display=swap');
      
      .fd-dash-root { 
        font-family: 'Sora', system-ui, sans-serif; 
        display: flex;
        height: 100dvh;
        overflow: hidden;
        background: var(--color-background);
      }
      
      /* ── Sidebar ── */
      .fd-sidebar {
        width: 280px;
        height: 100%;
        background: var(--color-card);
        border-right: 1px solid var(--color-border);
        display: flex;
        flex-direction: column;
        transition: width .35s cubic-bezier(.16,1,.3,1);
        flex-shrink: 0;
        position: relative;
        z-index: 40;
      }
      .fd-sidebar.collapsed { width: 72px; }
      
      @media (max-width: 1023px) {
        .fd-sidebar {
          position: fixed;
          left: 0; top: 0;
          transform: translateX(-100%);
          box-shadow: 8px 0 32px rgba(0,0,0,.2);
        }
        .fd-sidebar.mobile-open { transform: translateX(0); }
      }
      
      .fd-sidebar-header {
        padding: 1.25rem 1.25rem .75rem;
        display: flex;
        align-items: center;
        gap: .75rem;
        border-bottom: 1px solid var(--color-border);
      }
      .fd-sidebar-logo {
        width: 38px; height: 38px;
        background: linear-gradient(135deg, #6366F1, #8B5CF6);
        border-radius: 11px;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
        box-shadow: 0 4px 14px rgba(99,102,241,.35);
      }
      .fd-sidebar-brand {
        font-size: 1.15rem; font-weight: 700;
        color: var(--color-foreground);
        letter-spacing: -.02em;
        white-space: nowrap;
        opacity: 1;
        transition: opacity .2s;
      }
      .collapsed .fd-sidebar-brand { opacity: 0; width: 0; }
      
      .fd-sidebar-nav {
        flex: 1;
        overflow-y: auto;
        padding: .75rem;
      }
      .fd-sidebar-nav::-webkit-scrollbar { width: 4px; }
      .fd-sidebar-nav::-webkit-scrollbar-thumb { background: rgba(129,140,248,.15); border-radius: 99px; }
      
      .fd-nav-section {
        font-size: .68rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .08em;
        color: var(--color-muted-foreground);
        padding: .75rem .75rem .4rem;
        white-space: nowrap;
        opacity: 1;
        transition: opacity .2s;
      }
      .collapsed .fd-nav-section { opacity: 0; }
      
      .fd-nav-item {
        width: 100%;
        display: flex;
        align-items: center;
        gap: .75rem;
        padding: .6rem .75rem;
        border-radius: 10px;
        border: none;
        background: none;
        color: var(--color-muted-foreground);
        font-family: inherit;
        font-size: .85rem;
        font-weight: 500;
        cursor: pointer;
        transition: all .15s;
        margin-bottom: 2px;
        white-space: nowrap;
      }
      .fd-nav-item:hover {
        background: var(--color-accent);
        color: var(--color-foreground);
      }
      .fd-nav-item.active {
        background: linear-gradient(135deg, rgba(99,102,241,.12), rgba(139,92,246,.08));
        color: #6366F1;
        font-weight: 600;
      }
      .fd-nav-item .nav-text {
        opacity: 1;
        transition: opacity .2s;
      }
      .collapsed .fd-nav-item .nav-text { opacity: 0; width: 0; }
      
      .fd-agent-list-item {
        width: 100%;
        display: flex;
        align-items: center;
        gap: .65rem;
        padding: .55rem .6rem;
        border-radius: 10px;
        border: none;
        background: none;
        color: var(--color-foreground);
        font-family: inherit;
        font-size: .82rem;
        font-weight: 500;
        cursor: pointer;
        transition: all .15s;
        margin-bottom: 2px;
        text-align: left;
      }
      .fd-agent-list-item:hover { background: var(--color-accent); }
      .fd-agent-list-item.active {
        background: rgba(99,102,241,.1);
        color: #6366F1;
      }
      .fd-agent-list-item .agent-text {
        flex: 1;
        min-width: 0;
        opacity: 1;
        transition: opacity .2s;
      }
      .collapsed .fd-agent-list-item .agent-text { opacity: 0; width: 0; }
      
      .fd-sidebar-footer {
        padding: .75rem;
        border-top: 1px solid var(--color-border);
      }
      
      .fd-collapse-btn {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: .5rem;
        padding: .5rem;
        border-radius: 8px;
        border: none;
        background: var(--color-accent);
        color: var(--color-muted-foreground);
        cursor: pointer;
        font-family: inherit;
        font-size: .75rem;
        transition: all .15s;
      }
      .fd-collapse-btn:hover { background: var(--color-border); }
      .collapsed .fd-collapse-btn svg { transform: rotate(180deg); }
      
      /* ── Main Content ── */
      .fd-main {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-width: 0;
      }
      
      /* ── Top Bar ── */
      .fd-topbar {
        height: 64px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-card);
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 1.5rem;
        flex-shrink: 0;
        gap: 1rem;
      }
      
      .fd-search-wrap {
        position: relative;
        width: 100%;
        max-width: 400px;
      }
      .fd-search-wrap svg {
        position: absolute;
        left: 12px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--color-muted-foreground);
        pointer-events: none;
      }
      .fd-search-input {
        width: 100%;
        padding: .55rem .75rem .55rem 2.5rem;
        border-radius: 10px;
        border: 1px solid var(--color-border);
        background: var(--color-background);
        color: var(--color-foreground);
        font-family: inherit;
        font-size: .85rem;
        outline: none;
        transition: all .2s;
        box-sizing: border-box;
      }
      .fd-search-input:focus {
        border-color: rgba(99,102,241,.4);
        box-shadow: 0 0 0 3px rgba(99,102,241,.08);
      }
      .fd-search-input::placeholder { color: var(--color-muted-foreground); }
      
      .fd-topbar-actions {
        display: flex;
        align-items: center;
        gap: .5rem;
      }
      .fd-icon-btn {
        width: 38px; height: 38px;
        border-radius: 10px;
        border: 1px solid var(--color-border);
        background: var(--color-background);
        color: var(--color-muted-foreground);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all .15s;
        position: relative;
      }
      .fd-icon-btn:hover {
        border-color: rgba(129,140,248,.3);
        color: var(--color-foreground);
        background: var(--color-accent);
      }
      
      .fd-avatar {
        width: 36px; height: 36px;
        border-radius: 10px;
        background: linear-gradient(135deg, #6366F1, #8B5CF6);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        font-weight: 600;
        font-size: .85rem;
        cursor: pointer;
        border: 2px solid var(--color-border);
        transition: all .15s;
      }
      .fd-avatar:hover { border-color: rgba(99,102,241,.4); box-shadow: 0 0 0 3px rgba(99,102,241,.1); }
      
      /* ── Content Scroll Area ── */
      .fd-content {
        flex: 1;
        overflow-y: auto;
        padding: 1.5rem;
      }
      .fd-content::-webkit-scrollbar { width: 6px; }
      .fd-content::-webkit-scrollbar-thumb { background: rgba(129,140,248,.15); border-radius: 99px; }
      .fd-content::-webkit-scrollbar-track { background: transparent; }
      
      .fd-content-inner {
        max-width: 1200px;
        margin: 0 auto;
      }
      
      /* ── Hero ── */
      .fd-hero {
        position: relative;
        overflow: hidden;
        border-radius: 20px;
        padding: 2rem 2.25rem;
        background: linear-gradient(135deg, rgba(99,102,241,.1) 0%, rgba(139,92,246,.06) 50%, rgba(59,130,246,.04) 100%);
        border: 1px solid rgba(129,140,248,.12);
        margin-bottom: 1.5rem;
      }
      [data-theme="light"] .fd-hero {
        background: linear-gradient(135deg, rgba(99,102,241,.05) 0%, rgba(139,92,246,.03) 50%, rgba(59,130,246,.02) 100%);
      }
      .fd-hero-orb {
        position: absolute;
        width: 350px; height: 350px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(99,102,241,.15) 0%, transparent 70%);
        filter: blur(50px);
        top: -100px; right: -60px;
        pointer-events: none;
        animation: fd-hero-orb 7s ease-in-out infinite;
      }
      @keyframes fd-hero-orb {
        0%, 100% { transform: translate(0,0) scale(1); opacity: .6; }
        50% { transform: translate(-15px, 10px) scale(1.08); opacity: .9; }
      }
      .fd-hero h1 {
        font-size: 1.5rem;
        font-weight: 800;
        letter-spacing: -.03em;
        color: var(--color-foreground);
        margin: 0 0 .35rem;
        position: relative;
        z-index: 2;
      }
      .fd-hero p {
        font-size: .88rem;
        color: var(--color-muted-foreground);
        margin: 0;
        position: relative;
        z-index: 2;
        max-width: 500px;
      }
      
      /* ── Stats ── */
      .fd-stats-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 1rem;
        margin-bottom: 1.5rem;
      }
      @media (max-width: 640px) {
        .fd-stats-grid { grid-template-columns: 1fr; }
      }
      
      .fd-stat-card {
        position: relative;
        overflow: hidden;
        border-radius: 16px;
        padding: 1.25rem;
        border: 1px solid var(--color-border);
        background: var(--color-card);
        transition: all .25s;
      }
      .fd-stat-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 12px 32px rgba(99,102,241,.06);
        border-color: rgba(129,140,248,.2);
      }
      .fd-stat-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: .75rem;
      }
      .fd-stat-icon-wrap {
        width: 40px; height: 40px;
        border-radius: 11px;
        display: flex; align-items: center; justify-content: center;
      }
      .fd-stat-trend {
        font-size: .72rem;
        font-weight: 600;
        padding: .2rem .5rem;
        border-radius: 6px;
        background: rgba(34,197,94,.1);
        color: #22C55E;
      }
      .fd-stat-value {
        font-size: 1.75rem;
        font-weight: 800;
        letter-spacing: -.04em;
        color: var(--color-foreground);
        line-height: 1;
        margin-bottom: .25rem;
      }
      .fd-stat-label {
        font-size: .78rem;
        color: var(--color-muted-foreground);
        font-weight: 500;
      }
      
      /* ── Section Headers ── */
      .fd-section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 1rem;
      }
      .fd-section-title {
        font-size: .95rem;
        font-weight: 700;
        color: var(--color-foreground);
        letter-spacing: -.01em;
      }
      
      /* ── Upload Zone ── */
      .fd-upload-zone {
        position: relative;
        border-radius: 16px;
        padding: 2.5rem 1.5rem;
        border: 2px dashed var(--color-border);
        text-align: center;
        transition: all .3s;
        cursor: pointer;
        background: var(--color-card);
        margin-bottom: 1.5rem;
      }
      .fd-upload-zone:hover, .fd-upload-zone.drag-over {
        border-color: rgba(99,102,241,.4);
        background: rgba(99,102,241,.03);
      }
      .fd-upload-zone.drag-over {
        transform: scale(1.01);
        border-color: #6366F1;
      }
      .fd-upload-icon-wrap {
        width: 56px; height: 56px;
        border-radius: 16px;
        margin: 0 auto 1rem;
        background: linear-gradient(135deg, rgba(99,102,241,.12), rgba(139,92,246,.08));
        display: flex; align-items: center; justify-content: center;
      }
      .fd-upload-zone h3 {
        font-size: .95rem;
        font-weight: 600;
        color: var(--color-foreground);
        margin: 0 0 .25rem;
      }
      .fd-upload-zone p {
        font-size: .78rem;
        color: var(--color-muted-foreground);
        margin: 0;
      }
      
      /* ── File Grid ── */
      .fd-file-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: .875rem;
        margin-bottom: 1.5rem;
      }
      @media (max-width: 640px) {
        .fd-file-grid { grid-template-columns: 1fr; }
      }
      
      .fd-file-card {
        position: relative;
        border-radius: 14px;
        padding: 1rem;
        border: 1px solid var(--color-border);
        background: var(--color-card);
        transition: all .2s;
        cursor: pointer;
        group: true;
      }
      .fd-file-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 24px rgba(99,102,241,.06);
        border-color: rgba(129,140,248,.25);
      }
      .fd-file-card-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: .75rem;
      }
      .fd-file-icon-wrap {
        width: 44px; height: 44px;
        border-radius: 12px;
        display: flex; align-items: center; justify-content: center;
      }
      .fd-file-menu-btn {
        opacity: 0;
        transition: opacity .15s;
        width: 28px; height: 28px;
        border-radius: 6px;
        border: none;
        background: var(--color-accent);
        color: var(--color-muted-foreground);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
      }
      .fd-file-card:hover .fd-file-menu-btn { opacity: 1; }
      .fd-file-menu-btn:hover { background: var(--color-border); color: var(--color-foreground); }
      
      .fd-file-name {
        font-size: .82rem;
        font-weight: 600;
        color: var(--color-foreground);
        margin: 0 0 .15rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .fd-file-meta {
        font-size: .72rem;
        color: var(--color-muted-foreground);
        display: flex;
        align-items: center;
        gap: .4rem;
      }
      .fd-file-status {
        display: inline-flex;
        align-items: center;
        gap: .25rem;
        font-size: .7rem;
        font-weight: 600;
        padding: .15rem .4rem;
        border-radius: 4px;
        margin-top: .5rem;
      }
      .fd-file-status.indexed { background: rgba(34,197,94,.1); color: #22C55E; }
      .fd-file-status.processing { background: rgba(245,158,11,.1); color: #F59E0B; }
      .fd-file-status.error { background: rgba(239,68,68,.1); color: #EF4444; }
      
      /* ── Quick Actions ── */
      .fd-quick-actions {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: .875rem;
        margin-bottom: 1.5rem;
      }
      @media (max-width: 480px) {
        .fd-quick-actions { grid-template-columns: 1fr; }
      }
      
      .fd-action-card {
        display: flex;
        align-items: center;
        gap: .875rem;
        padding: 1rem 1.1rem;
        border-radius: 14px;
        border: 1px solid var(--color-border);
        background: var(--color-card);
        cursor: pointer;
        transition: all .2s;
        text-align: left;
        font-family: inherit;
        color: inherit;
      }
      .fd-action-card:hover {
        border-color: rgba(129,140,248,.3);
        box-shadow: 0 4px 16px rgba(99,102,241,.06);
        transform: translateY(-1px);
      }
      .fd-action-icon {
        width: 42px; height: 42px;
        border-radius: 11px;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      .fd-action-card h4 {
        font-size: .85rem;
        font-weight: 600;
        color: var(--color-foreground);
        margin: 0 0 .15rem;
      }
      .fd-action-card p {
        font-size: .75rem;
        color: var(--color-muted-foreground);
        margin: 0;
      }
      
      /* ── Create Agent Modal ── */
      .fd-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,.5);
        backdrop-filter: blur(4px);
        z-index: 50;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        animation: fd-fade-in .2s ease;
      }
      @keyframes fd-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .fd-modal {
        width: 100%;
        max-width: 420px;
        background: var(--color-card);
        border: 1px solid var(--color-border);
        border-radius: 20px;
        padding: 1.5rem;
        animation: fd-modal-in .3s cubic-bezier(.16,1,.3,1);
        box-shadow: 0 24px 64px rgba(0,0,0,.2);
      }
      @keyframes fd-modal-in {
        from { opacity: 0; transform: scale(.95) translateY(10px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      .fd-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 1.25rem;
      }
      .fd-modal-header h3 {
        font-size: 1.1rem;
        font-weight: 700;
        color: var(--color-foreground);
        margin: 0;
      }
      .fd-modal-close {
        width: 32px; height: 32px;
        border-radius: 8px;
        border: none;
        background: var(--color-accent);
        color: var(--color-muted-foreground);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        transition: all .15s;
      }
      .fd-modal-close:hover { background: var(--color-border); color: var(--color-foreground); }
      
      .fd-input {
        width: 100%;
        padding: .7rem .9rem;
        border-radius: 11px;
        font-size: .9rem;
        font-family: inherit;
        background: var(--color-background);
        border: 1px solid var(--color-border);
        color: var(--color-foreground);
        outline: none;
        transition: all .2s;
        box-sizing: border-box;
        margin-bottom: .75rem;
      }
      .fd-input:focus {
        border-color: rgba(99,102,241,.4);
        box-shadow: 0 0 0 3px rgba(99,102,241,.08);
      }
      .fd-input::placeholder { color: var(--color-muted-foreground); }
      
      .fd-btn-primary {
        width: 100%;
        padding: .7rem;
        border-radius: 11px;
        font-size: .9rem;
        font-weight: 600;
        font-family: inherit;
        color: #fff;
        border: none;
        cursor: pointer;
        background: linear-gradient(135deg, #6366F1, #8B5CF6);
        transition: all .2s;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: .5rem;
      }
      .fd-btn-primary:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 8px 24px rgba(99,102,241,.35);
      }
      .fd-btn-primary:disabled { opacity: .6; cursor: not-allowed; }
      
      .fd-btn-secondary {
        width: 100%;
        padding: .7rem;
        border-radius: 11px;
        font-size: .9rem;
        font-weight: 600;
        font-family: inherit;
        color: var(--color-foreground);
        border: 1px solid var(--color-border);
        background: var(--color-background);
        cursor: pointer;
        transition: all .2s;
      }
      .fd-btn-secondary:hover { background: var(--color-accent); }
      
      /* ── Empty State ── */
      .fd-empty {
        text-align: center;
        padding: 3rem 1.5rem;
        border-radius: 16px;
        border: 2px dashed var(--color-border);
        background: var(--color-card);
      }
      .fd-empty-icon {
        width: 64px; height: 64px;
        border-radius: 16px;
        margin: 0 auto 1rem;
        background: linear-gradient(135deg, rgba(99,102,241,.08), rgba(139,92,246,.06));
        display: flex; align-items: center; justify-content: center;
      }
      
      /* ── Mobile Overlay ── */
      .fd-mobile-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,.4);
        backdrop-filter: blur(2px);
        z-index: 35;
      }
      
      /* ── Animations ── */
      .fd-fade-up {
        animation: fd-fade-up .5s cubic-bezier(.16,1,.3,1) both;
      }
      @keyframes fd-fade-up {
        from { opacity: 0; transform: translateY(12px); }
        to { opacity: 1; transform: translateY(0); }
      }
      
      /* ── Dropdown Menus ── */
      .fd-dropdown {
        position: absolute;
        right: 0;
        top: calc(100% + 6px);
        min-width: 200px;
        background: var(--color-card);
        border: 1px solid var(--color-border);
        border-radius: 12px;
        box-shadow: 0 16px 48px rgba(0,0,0,.15);
        padding: .5rem;
        z-index: 50;
        animation: fd-dropdown-in .2s ease;
      }
      @keyframes fd-dropdown-in {
        from { opacity: 0; transform: translateY(-6px) scale(.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .fd-dropdown-item {
        width: 100%;
        display: flex;
        align-items: center;
        gap: .6rem;
        padding: .55rem .65rem;
        border-radius: 8px;
        border: none;
        background: none;
        color: var(--color-foreground);
        font-family: inherit;
        font-size: .82rem;
        font-weight: 500;
        cursor: pointer;
        transition: background .15s;
      }
      .fd-dropdown-item:hover { background: var(--color-accent); }
      .fd-dropdown-item.danger { color: #EF4444; }
      .fd-dropdown-item.danger:hover { background: rgba(239,68,68,.08); }
      .fd-dropdown-divider {
        height: 1px;
        background: var(--color-border);
        margin: .4rem .3rem;
      }
    `}</style>

    <div className="fd-dash-root">
      {/* Mobile Overlay */}
      {mobileMenuOpen && (
        <div className="fd-mobile-overlay" onClick={() => setMobileMenuOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`fd-sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${mobileMenuOpen ? 'mobile-open' : ''}`}>
        <div className="fd-sidebar-header">
          <div className="fd-sidebar-logo">
            <img src="/photos/auth-logo.png" alt="" style={{ width: 22, height: 22, objectFit: 'contain' }} />
          </div>
          <span className="fd-sidebar-brand">FlexiData</span>
          <button 
            className="fd-icon-btn lg:hidden" 
            onClick={() => setMobileMenuOpen(false)}
            style={{ marginLeft: 'auto' }}
          >
            <X size={18} />
          </button>
        </div>

        <nav className="fd-sidebar-nav">
          <div className="fd-nav-section">Overview</div>
          <button className="fd-nav-item active">
            <LayoutDashboard size={18} />
            <span className="nav-text">Dashboard</span>
          </button>
          <button className="fd-nav-item" onClick={() => router.push("/agents")}>
            <Bot size={18} />
            <span className="nav-text">All Agents</span>
          </button>
          <button className="fd-nav-item" onClick={() => router.push("/analytics")}>
            <BarChart3 size={18} />
            <span className="nav-text">Analytics</span>
          </button>

          <div className="fd-nav-section" style={{ marginTop: '.5rem' }}>Your Agents</div>
          {agents.length === 0 && !sidebarCollapsed && (
            <p style={{ fontSize: '.75rem', color: 'var(--color-muted-foreground)', padding: '.5rem .75rem' }}>
              No agents yet
            </p>
          )}
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => setSelectedAgentId(agent.id)}
              className={`fd-agent-list-item ${agent.id === selectedAgentId ? 'active' : ''}`}
            >
              <div style={{ 
                width: 28, height: 28, borderRadius: 8, 
                background: agent.id === selectedAgentId ? 'linear-gradient(135deg, rgba(99,102,241,.2), rgba(139,92,246,.12))' : 'var(--color-muted)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
              }}>
                <Bot size={13} style={{ color: agent.id === selectedAgentId ? '#6366F1' : 'var(--color-muted-foreground)' }} />
              </div>
              <div className="agent-text">
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {agent.name}
                </div>
                {!sidebarCollapsed && (
                  <div style={{ fontSize: '.7rem', color: 'var(--color-muted-foreground)', marginTop: 1 }}>
                    {agent.files_count} files · {agent.chats_count} chats
                  </div>
                )}
              </div>
              {agent.id === selectedAgentId && !sidebarCollapsed && (
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#6366F1', flexShrink: 0 }} />
              )}
            </button>
          ))}
          
          <button 
            onClick={() => setShowCreateAgent(true)} 
            className="fd-nav-item"
            style={{ marginTop: '.5rem', color: '#6366F1' }}
          >
            <Plus size={18} />
            <span className="nav-text">Create Agent</span>
          </button>
        </nav>

        <div className="fd-sidebar-footer">
          <button 
            className="fd-collapse-btn hidden lg:flex" 
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            <ChevronLeft size={14} />
            <span className="nav-text">Collapse</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="fd-main">
        {/* Top Bar */}
        <header className="fd-topbar">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <button 
              className="fd-icon-btn lg:hidden" 
              onClick={() => setMobileMenuOpen(true)}
            >
              <Menu size={18} />
            </button>
            <div className="fd-search-wrap hidden sm:block">
              <Search size={15} />
              <input 
                type="text" 
                placeholder="Search files..." 
                className="fd-search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          <div className="fd-topbar-actions">
            <button 
              className="fd-icon-btn sm:hidden"
              onClick={() => router.push("/search")}
            >
              <Search size={16} />
            </button>
            
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
                <div className="fd-dropdown" style={{ width: 280, right: -10 }}>
                  <div style={{ padding: '.5rem .5rem .75rem', borderBottom: '1px solid var(--color-border)' }}>
                    <span style={{ fontSize: '.8rem', fontWeight: 700 }}>Notifications</span>
                  </div>
                  <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--color-muted-foreground)', fontSize: '.82rem' }}>
                    No new notifications
                  </div>
                </div>
              )}
            </div>

            <div style={{ position: 'relative' }}>
              <div 
                className="fd-avatar"
                onClick={() => { setUserMenuOpen(!userMenuOpen); setNotificationsOpen(false); }}
              >
                U
              </div>
              
              {userMenuOpen && (
                <div className="fd-dropdown">
                  <button className="fd-dropdown-item" onClick={() => router.push("/settings")}>
                    <Settings size={14} /> Settings
                  </button>
                  <div className="fd-dropdown-divider" />
                  <button className="fd-dropdown-item danger" onClick={handleSignOut}>
                    <LogOut size={14} /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Scrollable Content */}
        <div className="fd-content">
          <div className="fd-content-inner">
            {/* Hero */}
            <div className="fd-hero fd-fade-up">
              <div className="fd-hero-orb" />
              <h1>{t("dashboard.title")} 👋</h1>
              <p>{t("dashboard.subtitle")}</p>
            </div>

            {/* Stats */}
            <div className="fd-stats-grid fd-fade-up" style={{ animationDelay: '.1s' }}>
              <div className="fd-stat-card">
                <div className="fd-stat-header">
                  <div className="fd-stat-icon-wrap" style={{ background: 'linear-gradient(135deg, rgba(99,102,241,.12), rgba(139,92,246,.08))' }}>
                    <Bot size={18} style={{ color: '#6366F1' }} />
                  </div>
                  <span className="fd-stat-trend">+{agents.length > 0 ? '1' : '0'} new</span>
                </div>
                <div className="fd-stat-value">{agents.length}</div>
                <div className="fd-stat-label">{t("dashboard.agents")}</div>
              </div>
              
              <div className="fd-stat-card">
                <div className="fd-stat-header">
                  <div className="fd-stat-icon-wrap" style={{ background: 'linear-gradient(135deg, rgba(34,197,94,.12), rgba(34,197,94,.06))' }}>
                    <FolderOpen size={18} style={{ color: '#22C55E' }} />
                  </div>
                  <span className="fd-stat-trend" style={{ background: 'rgba(99,102,241,.1)', color: '#6366F1' }}>
                    <TrendingUp size={10} style={{ display: 'inline', marginRight: 2 }} />
                    Active
                  </span>
                </div>
                <div className="fd-stat-value">{totalFiles}</div>
                <div className="fd-stat-label">{t("dashboard.files")}</div>
              </div>
              
              <div className="fd-stat-card">
                <div className="fd-stat-header">
                  <div className="fd-stat-icon-wrap" style={{ background: 'linear-gradient(135deg, rgba(245,158,11,.12), rgba(245,158,11,.06))' }}>
                    <MessageSquare size={18} style={{ color: '#F59E0B' }} />
                  </div>
                  <span className="fd-stat-trend" style={{ background: 'rgba(245,158,11,.1)', color: '#F59E0B' }}>
                    <Activity size={10} style={{ display: 'inline', marginRight: 2 }} />
                    Live
                  </span>
                </div>
                <div className="fd-stat-value">{totalChats}</div>
                <div className="fd-stat-label">{t("dashboard.allChats")}</div>
              </div>
            </div>

            {/* Selected Agent Content */}
            {selectedAgent ? (
              <>
                {/* Upload Zone */}
                <div 
                  className={`fd-upload-zone fd-fade-up ${dragOver ? 'drag-over' : ''}`}
                  style={{ animationDelay: '.15s' }}
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
                      <Loader2 size={28} className="animate-spin" style={{ color: '#6366F1', marginBottom: '.75rem' }} />
                      <h3>Uploading...</h3>
                      <p>Processing your document</p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center">
                      <div className="fd-upload-icon-wrap">
                        <Upload size={24} style={{ color: '#6366F1' }} />
                      </div>
                      <h3>Drop files here or click to upload</h3>
                      <p>PDF, Word, Excel, Images, Code — up to 50MB</p>
                    </div>
                  )}
                </div>

                {/* Quick Actions */}
                <div className="fd-quick-actions fd-fade-up" style={{ animationDelay: '.2s' }}>
                  <button 
                    className="fd-action-card"
                    onClick={() => router.push(`/agents/${selectedAgentId}`)}
                  >
                    <div className="fd-action-icon" style={{ background: 'linear-gradient(135deg, rgba(99,102,241,.12), rgba(139,92,246,.08))' }}>
                      <FolderOpen size={18} style={{ color: '#6366F1' }} />
                    </div>
                    <div>
                      <h4>Manage Files</h4>
                      <p>View and organize agent documents</p>
                    </div>
                  </button>
                  <button 
                    className="fd-action-card"
                    onClick={() => router.push(`/agents/${selectedAgentId}/chat`)}
                  >
                    <div className="fd-action-icon" style={{ background: 'linear-gradient(135deg, rgba(245,158,11,.12), rgba(245,158,11,.06))' }}>
                      <Zap size={18} style={{ color: '#F59E0B' }} />
                    </div>
                    <div>
                      <h4>Start Chat</h4>
                      <p>Talk with your AI agent</p>
                    </div>
                  </button>
                </div>

                {/* Recent Files */}
                {filteredFiles.length > 0 ? (
                  <div className="fd-fade-up" style={{ animationDelay: '.25s' }}>
                    <div className="fd-section-header">
                      <h2 className="fd-section-title">Recent Files</h2>
                      <button 
                        onClick={() => router.push(`/agents/${selectedAgentId}`)}
                        style={{ 
                          fontSize: '.8rem', fontWeight: 600, color: '#6366F1',
                          background: 'none', border: 'none', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', gap: '.25rem'
                        }}
                      >
                        View all <ArrowRight size={14} />
                      </button>
                    </div>
                    
                    <div className="fd-file-grid">
                      {filteredFiles.slice(0, 8).map((file) => {
                        const colors = getFileColor(file.file_type);
                        return (
                          <div key={file.id} className="fd-file-card">
                            <div className="fd-file-card-header">
                              <div className="fd-file-icon-wrap" style={{ background: colors.bg, color: colors.color }}>
                                {getFileIcon(file.file_type)}
                              </div>
                              <button className="fd-file-menu-btn">
                                <MoreVertical size={14} />
                              </button>
                            </div>
                            <div className="fd-file-name" title={file.file_name}>{file.file_name}</div>
                            <div className="fd-file-meta">
                              <span>{formatFileSize(file.size)}</span>
                              <span>·</span>
                              <span>{timeAgo(file.created_at)}</span>
                            </div>
                            <div className={`fd-file-status ${file.status}`}>
                              {file.status === 'indexed' && <CheckCircle2 size={10} />}
                              {file.status === 'processing' && <Clock size={10} />}
                              {file.status === 'error' && <AlertCircle size={10} />}
                              {file.status}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : searchQuery ? (
                  <div className="fd-empty fd-fade-up" style={{ animationDelay: '.25s' }}>
                    <p style={{ color: 'var(--color-muted-foreground)', fontSize: '.9rem' }}>
                      No files match "{searchQuery}"
                    </p>
                  </div>
                ) : null}
              </>
            ) : agents.length === 0 ? (
              /* Empty State - No Agents */
              <div className="fd-empty fd-fade-up" style={{ animationDelay: '.15s' }}>
                <div className="fd-empty-icon">
                  <Bot size={28} style={{ color: '#6366F1' }} />
                </div>
                <p style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--color-foreground)', margin: '0 0 .3rem' }}>
                  {t("agents.noAgents")}
                </p>
                <p style={{ fontSize: '.85rem', color: 'var(--color-muted-foreground)', margin: '0 0 1.5rem' }}>
                  {t("agents.noAgentsSub")}
                </p>
                <button 
                  onClick={() => setShowCreateAgent(true)} 
                  className="fd-btn-primary"
                  style={{ maxWidth: 220, margin: '0 auto' }}
                >
                  <Plus size={16} />
                  {t("agents.create")}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </main>

      {/* Create Agent Modal */}
      {showCreateAgent && (
        <div className="fd-modal-overlay" onClick={() => setShowCreateAgent(false)}>
          <div className="fd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="fd-modal-header">
              <h3>Create New Agent</h3>
              <button className="fd-modal-close" onClick={() => setShowCreateAgent(false)}>
                <X size={16} />
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
                className="fd-btn-primary"
                style={{ flex: 1 }}
              >
                {creating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {creating ? t("agents.creating") : t("agents.create")}
              </button>
              <button 
                onClick={() => setShowCreateAgent(false)} 
                className="fd-btn-secondary"
                style={{ width: 'auto', padding: '.7rem 1.2rem' }}
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