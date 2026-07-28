"use client";

import { Suspense, useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Send,
  Loader2,
  Plus,
  Trash2,
  PanelLeftOpen,
  PanelLeftClose,
  ArrowLeft,
  Paperclip,
  Copy,
  Check,
  RotateCw,
  MessageSquare,
  Download,
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { useStreamChat } from "@/lib/hooks/use-stream-chat";
import {
  FileEditCard,
  NewFileCard,
  parseFileEdits,
  stripFileEdits,
  type FileEdit,
} from "@/components/file-edit-card";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { AIAvatar, UserAvatar, ThinkingDots, StreamingCursor } from "@/components/chat-avatars";
import { stripMarkdown } from "@/lib/strip-markdown";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface ChatRecord {
  id: string;
  title: string | null;
  updated_at: string;
}

interface Agent {
  id: string;
  name: string;
  description: string | null;
}

// ─── Empty State ──────────────────────────────────────────────────────────────
function EmptyState({
  agentName,
  onSuggestion,
}: {
  agentName?: string;
  onSuggestion: (s: string) => void;
}) {
  const suggestions = [
    "Summarize the documents",
    "What are the key points?",
    "List all important data",
    "Explain this simply",
  ];

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-8 px-4 select-none">
      <div className="flex flex-col items-center gap-4 text-center">
        <AIAvatar size={56} className="shadow-lg shadow-primary/20" />
        <div>
          <h2 className="text-lg font-semibold text-foreground tracking-tight">
            {agentName ? `Chat with ${agentName}` : "How can I help you?"}
          </h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-xs leading-relaxed">
            Ask me anything about the files and documents in this agent.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 w-full max-w-md">
        {suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => onSuggestion(s)}
            className="text-left px-3 py-2.5 rounded-xl border border-border bg-card hover:bg-accent text-xs text-muted-foreground hover:text-foreground transition-colors leading-relaxed"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Agent Chat Content ───────────────────────────────────────────────────────
function AgentChatContent({ agentId }: { agentId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialChatId = searchParams.get("chatId");
  const { t } = useTranslation();
  const { streaming, streamedContent, generatedImages, sendStream, abort } = useStreamChat({ agentId });

  const [agent, setAgent] = useState<Agent | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [chatId, setChatId] = useState<string | null>(initialChatId);
  const [chatHistory, setChatHistory] = useState<ChatRecord[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [messageEdits, setMessageEdits] = useState<Record<string, FileEdit[]>>({});
  const [appliedEdits, setAppliedEdits] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(`applied-edits-${agentId}`);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });
  const [applyingEdit, setApplyingEdit] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialLoadDone = useRef(false);

  function editFingerprint(edit: FileEdit) {
    return `${edit.filename}::${edit.replacement.slice(0, 200)}`;
  }

  useEffect(() => {
    try {
      localStorage.setItem(`applied-edits-${agentId}`, JSON.stringify([...appliedEdits]));
    } catch {}
  }, [appliedEdits, agentId]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamedContent]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "36px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  useEffect(() => {
    fetch(`/api/agents/${agentId}`).then((r) => r.json()).then(setAgent);
  }, [agentId]);

  const fetchChatHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/chat-history?agentId=${agentId}`);
      if (res.ok) setChatHistory(await res.json());
    } catch {}
  }, [agentId]);

  const fetchMessages = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chat-history/${id}`);
      if (!res.ok) return;
      const data: Message[] = await res.json();
      setMessages(data);
      const editsMap: Record<string, FileEdit[]> = {};
      for (const msg of data) {
        if (msg.role === "assistant") {
          const edits = parseFileEdits(msg.content);
          if (edits.length > 0) editsMap[msg.id] = edits;
        }
      }
      if (Object.keys(editsMap).length > 0)
        setMessageEdits((prev) => ({ ...prev, ...editsMap }));
    } catch {}
  }, []);

  useEffect(() => {
    fetchChatHistory();
    if (initialChatId && !initialLoadDone.current) {
      initialLoadDone.current = true;
      fetchMessages(initialChatId);
    }
  }, [initialChatId, fetchChatHistory, fetchMessages]);

  function processStreamResult(
    result: { fullContent: string; chatId: string; title: string | null },
    userContent: string
  ) {
    const edits = parseFileEdits(result.fullContent);
    setMessages((prev) => {
      const withoutTemp = prev.filter((m) => !m.id.startsWith("temp-"));
      const realUserId = `user-${Date.now()}`;
      const realAssistantId = `assistant-${Date.now()}`;
      if (edits.length > 0)
        setMessageEdits((p) => ({ ...p, [realAssistantId]: edits }));
      return [
        ...withoutTemp,
        { id: realUserId, role: "user", content: userContent, created_at: new Date().toISOString() },
        { id: realAssistantId, role: "assistant", content: result.fullContent, created_at: new Date().toISOString() },
      ];
    });
  }

  async function handleSend() {
    if (!input.trim() || streaming) return;
    const userContent = input.trim();

    setMessages((prev) => [...prev, { id: `temp-${Date.now()}`, role: "user", content: userContent, created_at: new Date().toISOString() }]);
    setInput("");
    try {
      const result = await sendStream(chatId, userContent);
      if (!result) { setMessages((prev) => prev.filter((m) => !m.id.startsWith("temp-"))); return; }
      if (!chatId && result.chatId) {
        setChatId(result.chatId);
        router.replace(`/agents/${agentId}/chat?chatId=${result.chatId}`, { scroll: false });
        fetchChatHistory();
      }
      processStreamResult(result, userContent);
    } catch (err: any) {
      setMessages((prev) => prev.filter((m) => !m.id.startsWith("temp-")));
      alert(err.message || t("common.error"));
    }
  }

  async function handleDeleteChat(id: string) {
    if (!confirm(t("agents.confirmDelete"))) return;
    await fetch(`/api/chat/${id}`, { method: "DELETE" });
    setChatHistory((prev) => prev.filter((c) => c.id !== id));
    if (chatId === id) {
      setChatId(null); setMessages([]); setMessageEdits({});
      router.replace(`/agents/${agentId}/chat`, { scroll: false });
    }
  }

  function handleNewChat() {
    setChatId(null); setMessages([]); setMessageEdits({});
    router.replace(`/agents/${agentId}/chat`, { scroll: false });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  function handleCopy(text: string, id: string) {
    navigator.clipboard.writeText(stripMarkdown(text));
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  async function handleRegenerate(msgIndex: number) {
    if (streaming) return;
    const userMsg = messages[msgIndex];
    if (!userMsg || userMsg.role !== "user") return;
    const truncated = messages.slice(0, msgIndex + 1);
    setMessages(truncated);
    if (msgIndex + 1 < messages.length) {
      const oldId = messages[msgIndex + 1].id;
      setMessageEdits((prev) => { const n = { ...prev }; delete n[oldId]; return n; });
    }
    try {
      const result = await sendStream(chatId, userMsg.content);
      if (!result) return;
      const regenId = `assistant-${Date.now()}`;
      const edits = parseFileEdits(result.fullContent);
      setMessages((prev) => [...prev, { id: regenId, role: "assistant", content: result.fullContent, created_at: new Date().toISOString() }]);
      if (edits.length > 0) setMessageEdits((prev) => ({ ...prev, [regenId]: edits }));
    } catch (err: any) { alert(err.message || t("common.error")); }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    try { await fetch(`/api/agents/${agentId}/files`, { method: "POST", body: formData }); } catch {}
    setUploading(false);
    e.target.value = "";
  }

  async function handleApplyEdit(editId: string) {
    const edit = Object.values(messageEdits).flat().find((e) => e.id === editId);
    if (!edit) return;
    setApplyingEdit(editId);
    try {
      const res = await fetch(`/api/agents/${agentId}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: edit.filename, newContent: edit.replacement, isNewFile: edit.isNew }),
      });
      if (res.ok) {
        setAppliedEdits((prev) => new Set(prev).add(editFingerprint(edit)));
      } else {
        const err = await res.json();
        alert(err.error || "Failed to apply edit");
      }
    } catch { alert("Failed to apply edit"); }
    setApplyingEdit(null);
  }

  function handleEditCode(editId: string, newCode: string) {
    setMessageEdits((prev) => {
      const next = { ...prev };
      for (const [msgId, edits] of Object.entries(next)) {
        const idx = edits.findIndex((e) => e.id === editId);
        if (idx !== -1) {
          next[msgId] = [...edits.slice(0, idx), { ...edits[idx], replacement: newCode }, ...edits.slice(idx + 1)];
          break;
        }
      }
      return next;
    });
  }

  function handleDownloadImage(url: string, prompt: string) {
    const a = document.createElement("a");
    a.href = url;
    a.download = `generated-${prompt.slice(0, 50).replace(/[^a-z0-9]/gi, "-")}.png`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <div className="flex h-full bg-background">
      {/* ── Sidebar ── */}
      <div className={`${sidebarOpen ? "w-64" : "w-0"} transition-all duration-200 overflow-hidden border-r border-border flex-shrink-0`}>
        <div className="w-64 h-full flex flex-col bg-card">
          <div className="p-3 border-b border-border space-y-2">
            <button
              onClick={() => router.push(`/agents/${agentId}`)}
              className="flex items-center gap-2 w-full px-3 py-2 rounded-xl border border-border text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <ArrowLeft size={13} />
              {t("agents.backToFiles")}
            </button>
            <button
              onClick={handleNewChat}
              className="flex items-center gap-2 w-full px-3 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <Plus size={15} />
              {t("nav.newChat")}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {chatHistory.length === 0 && (
              <div className="px-3 py-8 text-center">
                <MessageSquare size={20} className="text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground/60">No conversations yet</p>
              </div>
            )}
            {chatHistory.map((chat) => (
              <div
                key={chat.id}
                className={`group relative flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm cursor-pointer transition-colors ${
                  chatId === chat.id
                    ? "bg-primary/10 text-foreground border border-primary/15"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                }`}
                onClick={() => {
                  setChatId(chat.id);
                  fetchMessages(chat.id);
                  router.replace(`/agents/${agentId}/chat?chatId=${chat.id}`, { scroll: false });
                }}
              >
                <div className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${chatId === chat.id ? "bg-primary" : "bg-transparent"}`} />
                <span className="flex-1 truncate text-xs font-medium">
                  {chat.title || t("nav.newChat")}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteChat(chat.id); }}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="h-12 border-b border-border flex items-center px-4 gap-3 bg-card/50 backdrop-blur-sm flex-shrink-0">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-medium text-foreground truncate">
              {agent?.name || ""}
              {chatId && (
                <span className="text-muted-foreground font-normal">
                  {" — "}{chatHistory.find((c) => c.id === chatId)?.title || t("nav.chat")}
                </span>
              )}
            </h2>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          {messages.length === 0 && !streaming ? (
            <EmptyState agentName={agent?.name} onSuggestion={(s) => setInput(s)} />
          ) : (
            <div className="p-4 space-y-6 max-w-3xl mx-auto">
              {messages.map((msg, idx) => (
                <div key={msg.id} className="group">
                  <div className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    {msg.role === "assistant" && <AIAvatar size={28} className="mt-0.5" />}

                    <div className="flex flex-col gap-1.5 max-w-[80%]">
                      <div className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground rounded-tr-sm"
                          : "bg-card border border-border text-foreground rounded-tl-sm"
                      }`}>
                        {msg.role === "user"
                          ? <span dir="auto" className="whitespace-pre-wrap">{msg.content}</span>
                          : <MarkdownRenderer content={stripFileEdits(msg.content)} />
                        }
                      </div>

                      {/* Action buttons */}
                      <div className={`flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ${
                        msg.role === "user" ? "justify-end" : "justify-start"
                      }`}>
                        <button
                          onClick={() => handleCopy(msg.content, msg.id)}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                          title={t("chat.copy")}
                        >
                          {copiedId === msg.id ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                        </button>
                        {msg.role === "user" && (
                          <button
                            onClick={() => handleRegenerate(idx)}
                            disabled={streaming}
                            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40"
                            title={t("chat.regenerate")}
                          >
                            <RotateCw size={12} />
                          </button>
                        )}
                        {msg.role === "assistant" && idx > 0 && messages[idx - 1]?.role === "user" && (
                          <button
                            onClick={() => handleRegenerate(idx - 1)}
                            disabled={streaming}
                            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40"
                            title={t("chat.regenerate")}
                          >
                            <RotateCw size={12} />
                          </button>
                        )}
                      </div>
                    </div>

                    {msg.role === "user" && <UserAvatar size={28} className="mt-0.5" />}
                  </div>

                  {/* File Edit Cards */}
                  {msg.role === "assistant" && messageEdits[msg.id]?.length > 0 && (
                    <div className="mt-3 ml-10 space-y-3 max-w-[80%]">
                      {messageEdits[msg.id].map((edit) => {
                        const fp = editFingerprint(edit);
                        const isApplied = appliedEdits.has(fp);
                        const handleReject = (editId: string) => {
                          setAppliedEdits((prev) => new Set(prev).add(editFingerprint(edit)));
                          setMessageEdits((prev) => ({ ...prev, [msg.id]: (prev[msg.id] || []).filter((e) => e.id !== editId) }));
                        };
                        return edit.isNew ? (
                          <NewFileCard key={edit.id} edit={edit} agentId={agentId} applying={applyingEdit === edit.id} applied={isApplied} onApply={handleApplyEdit} onReject={handleReject} onEdit={handleEditCode} />
                        ) : (
                          <FileEditCard key={edit.id} edit={edit} agentId={agentId} applying={applyingEdit === edit.id} applied={isApplied} onApply={handleApplyEdit} onReject={handleReject} onEdit={handleEditCode} />
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}

              {/* Streaming */}
              {streaming && streamedContent && (
                <div className="flex gap-3 justify-start">
                  <AIAvatar size={28} className="mt-0.5" />
                  <div className="max-w-[80%] rounded-2xl rounded-tl-sm px-4 py-3 bg-card border border-border text-foreground text-sm leading-relaxed">
                    <MarkdownRenderer content={stripFileEdits(streamedContent)} />
                    {generatedImages.length > 0 && (
                      <div className="mt-3 space-y-3">
                        {generatedImages.map((img, i) => (
                          <div key={i} className="relative group/img">
                            <img src={img.url} alt={img.prompt} className="rounded-xl border border-border max-w-full h-auto" loading="lazy" />
                            <button
                              onClick={() => handleDownloadImage(img.url, img.prompt)}
                              className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 text-white opacity-0 group-hover/img:opacity-100 transition-opacity hover:bg-black/70"
                              title="Download image"
                            >
                              <Download size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <StreamingCursor />
                    {parseFileEdits(streamedContent).length > 0 && (
                      <div className="mt-3 space-y-3">
                        {parseFileEdits(streamedContent).map((edit) =>
                          edit.isNew ? (
                            <NewFileCard key={edit.id} edit={edit} agentId={agentId} onApply={handleApplyEdit} onReject={() => {}} onEdit={handleEditCode} />
                          ) : (
                            <FileEditCard key={edit.id} edit={edit} agentId={agentId} onApply={handleApplyEdit} onReject={() => {}} onEdit={handleEditCode} />
                          )
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {streaming && !streamedContent && (
                <div className="flex gap-3 justify-start">
                  <AIAvatar size={28} />
                  <div className="bg-card border border-border rounded-2xl rounded-tl-sm px-4 py-3.5">
                    <ThinkingDots />
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input */}
        <div className="shrink-0 border-t border-border/60 p-3">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-end gap-2 rounded-2xl border border-border bg-card px-3 py-2 focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10 transition-all">
              <input ref={fileInputRef} type="file" className="hidden"
                accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.json,.png,.jpg,.jpeg,.gif,.webp,.js,.jsx,.ts,.tsx,.py,.java,.c,.cpp,.cs,.go,.rs,.rb,.php,.sh,.sql,.yaml,.yml,.xml,.html,.css,.scss,.vue,.svelte,.toml,.ini,.env,.mp3,.wav,.ogg,.webm,.flac,.aac,.m4a,.mp4,.webm,.avi,.mov"
                onChange={handleFileUpload}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 transition-colors shrink-0 self-end mb-0.5"
                title="Attach file"
              >
                {uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
              </button>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("chat.placeholder")}
                rows={1}
                className="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none py-1.5"
                style={{ minHeight: "36px", maxHeight: "200px" }}
              />

              <button
                onClick={streaming ? abort : handleSend}
                disabled={!streaming && !input.trim()}
                className={`p-2 rounded-xl shrink-0 self-end mb-0.5 transition-all ${
                  streaming
                    ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                    : input.trim()
                    ? "bg-primary text-primary-foreground hover:opacity-90 shadow-sm"
                    : "bg-muted text-muted-foreground cursor-not-allowed"
                }`}
              >
                {streaming ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </div>
            <p className="text-center text-[11px] text-muted-foreground/50 mt-1.5">
              {t("chat.disclaimer")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function AgentChatPage({ params }: { params: Promise<{ id: string }> }) {
  const [agentId, setAgentId] = useState<string | null>(null);

  useEffect(() => { params.then(({ id }) => setAgentId(id)); }, [params]);

  if (!agentId) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="animate-spin text-muted-foreground" size={24} />
      </div>
    );
  }

  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full">
        <Loader2 className="animate-spin text-muted-foreground" size={24} />
      </div>
    }>
      <AgentChatContent agentId={agentId} />
    </Suspense>
  );
}
