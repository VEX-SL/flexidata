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
  Copy,
  Check,
  RotateCw,
  MessageSquare,
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { useStreamChat } from "@/lib/hooks/use-stream-chat";
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

// ─── Empty State ──────────────────────────────────────────────────────────────
function EmptyState({ onSuggestion }: { onSuggestion: (s: string) => void }) {
  const suggestions = [
    "Summarize the uploaded document",
    "What are the key data points?",
    "Explain this in simple terms",
    "Create a table from this data",
  ];

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-8 px-4 select-none">
      <div className="flex flex-col items-center gap-4 text-center">
        <AIAvatar size={56} className="shadow-lg shadow-primary/20" />
        <div>
          <h2 className="text-lg font-semibold text-foreground tracking-tight">
            How can I help you?
          </h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-xs leading-relaxed">
            Ask me anything about your files, data, or documents.
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

// ─── Chat Content ─────────────────────────────────────────────────────────────
function ChatContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialChatId = searchParams.get("chatId");
  const { t } = useTranslation();
  const { streaming, streamedContent, sendStream, abort } = useStreamChat();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [chatId, setChatId] = useState<string | null>(initialChatId);
  const [chatHistory, setChatHistory] = useState<ChatRecord[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const fetchChatHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/chat-history");
      if (res.ok) setChatHistory(await res.json());
    } catch {}
  }, []);

  const fetchMessages = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chat-history/${id}`);
      if (res.ok) setMessages(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchChatHistory();
    if (initialChatId) fetchMessages(initialChatId);
  }, [initialChatId, fetchChatHistory, fetchMessages]);

  async function handleSend() {
    if (!input.trim() || streaming) return;
    const userContent = input.trim();
    setMessages((prev) => [
      ...prev,
      { id: `temp-${Date.now()}`, role: "user", content: userContent, created_at: new Date().toISOString() },
    ]);
    setInput("");
    try {
      const result = await sendStream(chatId, userContent);
      if (!result) { setMessages((prev) => prev.filter((m) => !m.id.startsWith("temp-"))); return; }
      if (!chatId && result.chatId) {
        setChatId(result.chatId);
        router.replace(`/chat?chatId=${result.chatId}`, { scroll: false });
        fetchChatHistory();
      }
      setMessages((prev) => [
        ...prev.filter((m) => !m.id.startsWith("temp-")),
        { id: `user-${Date.now()}`, role: "user", content: userContent, created_at: new Date().toISOString() },
        { id: `assistant-${Date.now()}`, role: "assistant", content: result.fullContent, created_at: new Date().toISOString() },
      ]);
    } catch (err: any) {
      setMessages((prev) => prev.filter((m) => !m.id.startsWith("temp-")));
      alert(err.message || t("common.error"));
    }
  }

  async function handleDeleteChat(id: string) {
    if (!confirm(t("agents.confirmDelete"))) return;
    await fetch(`/api/chat/${id}`, { method: "DELETE" });
    setChatHistory((prev) => prev.filter((c) => c.id !== id));
    if (chatId === id) { setChatId(null); setMessages([]); router.replace("/chat", { scroll: false }); }
  }

  function handleNewChat() {
    setChatId(null); setMessages([]);
    router.replace("/chat", { scroll: false });
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
    setMessages(messages.slice(0, msgIndex + 1));
    try {
      const result = await sendStream(chatId, userMsg.content);
      if (!result) return;
      setMessages((prev) => [
        ...prev,
        { id: `assistant-${Date.now()}`, role: "assistant", content: result.fullContent, created_at: new Date().toISOString() },
      ]);
    } catch (err: any) { alert(err.message || t("common.error")); }
  }

  return (
    <div className="flex h-full bg-background">
      {/* ── Sidebar ── */}
      <div className={`${sidebarOpen ? "w-64" : "w-0"} transition-all duration-200 overflow-hidden border-r border-border flex-shrink-0`}>
        <div className="w-64 h-full flex flex-col bg-card">
          <div className="p-3 border-b border-border">
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
                  router.replace(`/chat?chatId=${chat.id}`, { scroll: false });
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
          <h2 className="text-sm font-medium text-foreground truncate">
            {chatId ? chatHistory.find((c) => c.id === chatId)?.title || t("nav.chat") : t("nav.newChat")}
          </h2>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          {messages.length === 0 && !streaming ? (
            <EmptyState onSuggestion={(s) => setInput(s)} />
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
                          : <MarkdownRenderer content={msg.content} />
                        }
                      </div>

                      {/* Action buttons — visible on hover */}
                      <div className={`flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ${
                        msg.role === "user" ? "justify-end" : "justify-start"
                      }`}>
                        <button
                          onClick={() => handleCopy(msg.content, msg.id)}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                          title={t("chat.copy")}
                        >
                          {copiedId === msg.id
                            ? <Check size={12} className="text-green-500" />
                            : <Copy size={12} />
                          }
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
                </div>
              ))}

              {/* Streaming */}
              {streaming && streamedContent && (
                <div className="flex gap-3 justify-start">
                  <AIAvatar size={28} className="mt-0.5" />
                  <div className="max-w-[80%] rounded-2xl rounded-tl-sm px-4 py-3 bg-card border border-border text-foreground text-sm leading-relaxed">
                    <MarkdownRenderer content={streamedContent} />
                    <StreamingCursor />
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

export default function ChatPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full">
        <Loader2 className="animate-spin text-muted-foreground" size={24} />
      </div>
    }>
      <ChatContent />
    </Suspense>
  );
}
