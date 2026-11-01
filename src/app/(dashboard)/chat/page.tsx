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
  Download,
  Settings,
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { useStreamChat } from "@/lib/hooks/use-stream-chat";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { AIAvatar, UserAvatar, ThinkingDots, StreamingCursor } from "@/components/chat-avatars";
import { stripMarkdown } from "@/lib/strip-markdown";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { createClient } from "@/lib/supabase/client";


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

// ─── Sidebar List ─────────────────────────────────────────────────────────────
function SidebarList({
  chats,
  chatId,
  onSelect,
  onDelete,
  newChatLabel,
}: {
  chats: ChatRecord[];
  chatId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  newChatLabel: string;
}) {
  return (
    <div className="fd-scroll flex-1 overflow-y-auto p-2 space-y-0.5">
      {chats.length === 0 && (
        <div className="px-3 py-8 text-center">
          <MessageSquare size={20} className="text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-xs text-muted-foreground/60">No conversations yet</p>
        </div>
      )}

      {chats.map((chat) => (
        <div
          key={chat.id}
          className={`group relative flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm cursor-pointer transition-colors ${chatId === chat.id
            ? "bg-primary/10 text-foreground border border-primary/15"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            }`}
          onClick={() => onSelect(chat.id)}
        >
          <div
            className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${chatId === chat.id ? "bg-primary" : "bg-transparent"
              }`}
          />
          <span className="flex-1 truncate text-xs font-medium">
            {chat.title || newChatLabel}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(chat.id);
            }}
            className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
            aria-label="Delete chat"
            title="Delete chat"
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

function getGreeting(name: string) {
  const hour = new Date().getHours();

  let timeOfDay = "Good Evening";
  if (hour >= 5 && hour < 12) {
    timeOfDay = "Good Morning";
  } else if (hour >= 12 && hour < 17) {
    timeOfDay = "Good Afternoon";
  } else if (hour >= 17 && hour < 22) {
    timeOfDay = "Good Evening";
  } else {
    timeOfDay = "Good Night";
  }

  return `${timeOfDay}, ${name}`;
}

// ─── Empty State ──────────────────────────────────────────────────────────────
function EmptyState({
  onSuggestion,
  userName,
  ready,
}: {
  onSuggestion: (s: string) => void;
  userName?: string | null;
  /** False until the client knows the real name and local time. */
  ready: boolean;
}) {
  const { t } = useTranslation();
  const name = userName && userName.trim() ? userName.trim() : "Hamza";
  // The greeting depends on the visitor's clock and profile, so it must never
  // be painted from the prerendered HTML: a placeholder keeps the space until
  // the real greeting can be rendered in one go.
  const greeting = getGreeting(name);

  const suggestions = [
    t("chat.generalSuggestions.explain"),
    t("chat.generalSuggestions.write"),
    t("chat.generalSuggestions.brainstorm"),
    t("chat.generalSuggestions.advice"),
  ];

  return (
    <div className="my-auto flex flex-col items-center justify-center gap-8 px-4 py-8 select-none">
      <div className="flex flex-col items-center gap-4 text-center">
        <div>
          {ready ? (
            <h2 className="text-[clamp(25px,3vw,34px)] leading-[1.2] tracking-[-1.15px] font-semibold text-foreground">
              {greeting}
            </h2>
          ) : (
            <div
              aria-hidden="true"
              className="mx-auto h-[clamp(30px,3.6vw,41px)] w-[min(62vw,17rem)] rounded-xl bg-muted/60 animate-pulse"
            />
          )}
          <p className="text-sm text-muted-foreground mt-2 max-w-xs leading-relaxed mx-auto">
            {t("chat.howCanIHelp")}
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
  const { streaming, streamedContent, generatedImages, sendStream, abort } = useStreamChat();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [chatId, setChatId] = useState<string | null>(initialChatId);
  const [chatHistory, setChatHistory] = useState<ChatRecord[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<{
    isOpen: boolean;
    chatId: string | null;
  }>({ isOpen: false, chatId: null });
  const [userName, setUserName] = useState<string | null>(null);
  const [userAvatar, setUserAvatar] = useState<string | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [modelIcon, setModelIcon] = useState<string | null>(null);
  const [modelIconType, setModelIconType] = useState<"preset" | "custom" | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const initialLoadDone = useRef(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { createClient } = await import("@/lib/supabase/client");
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("name, avatar_url, model_icon, model_icon_type")
            .eq("id", user.id)
            .maybeSingle();
          if (!active) return;
          if (profile?.name) {
            setUserName(profile.name);
          }
          if (profile?.avatar_url) {
            setUserAvatar(profile.avatar_url);
          }
          if (profile?.model_icon) {
            setModelIcon(profile.model_icon);
            setModelIconType(profile.model_icon_type as "preset" | "custom" | null);
          }
        }
      } catch {
        // Ignore — the greeting falls back to the default name.
      }
      if (active) setProfileLoaded(true);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamedContent, generatedImages]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "24px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const fetchChatHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/chat-history");
      if (res.ok) {
        const data: ChatRecord[] = await res.json();
        setChatHistory(data);
      }
    } catch (err) {
      console.error("[Chat] Failed to fetch chat history:", err);
    }
  }, []);

  const fetchMessages = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chat-history/${id}?scope=general`);
      if (!res.ok) {
        // A chat from /agents must never open inside the general chatbot.
        setChatId(null);
        setMessages([]);
        router.replace("/chat", { scroll: false });
        return;
      }
      const data: Message[] = await res.json();
      setMessages(data);
    } catch (err) {
      console.error("[Chat] Failed to fetch messages:", err);
    }
  }, [router]);

  useEffect(() => {
    fetchChatHistory();
    if (initialChatId && !initialLoadDone.current) {
      initialLoadDone.current = true;
      fetchMessages(initialChatId);
    }
  }, [initialChatId, fetchChatHistory, fetchMessages]);

  async function handleSend(contentOverride?: string) {
    const text = (contentOverride ?? input).trim();
    if (!text || streaming) return;
    const userContent = text;
    setMessages((prev) => [
      ...prev,
      { id: `temp-${Date.now()}`, role: "user", content: userContent, created_at: new Date().toISOString() },
    ]);
    setInput("");
    try {
      const result = await sendStream(chatId, userContent);
      if (!result) {
        setMessages((prev) => prev.filter((m) => !m.id.startsWith("temp-")));
        return;
      }
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

  function handleDeleteChat(id: string) {
    setDeleteDialog({ isOpen: true, chatId: id });
  }

  async function confirmDelete() {
    if (!deleteDialog.chatId) return;
    try {
      const res = await fetch(`/api/chat/${deleteDialog.chatId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || t("common.error"));
      } else {
        setChatHistory((prev) => prev.filter((c) => c.id !== deleteDialog.chatId));
        if (chatId === deleteDialog.chatId) {
          setChatId(null);
          setMessages([]);
          router.replace("/chat", { scroll: false });
        }
      }
    } catch (err) {
      console.error("[Chat] Failed to delete chat:", err);
      alert(t("common.error"));
    }
    setDeleteDialog({ isOpen: false, chatId: null });
  }

  function cancelDelete() {
    setDeleteDialog({ isOpen: false, chatId: null });
  }

  function handleNewChat() {
    setChatId(null);
    setMessages([]);
    router.replace("/chat", { scroll: false });
  }

  function handleSelectChat(id: string) {
    setChatId(id);
    fetchMessages(id);
    router.replace(`/chat?chatId=${id}`, { scroll: false });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleModelIconChange(icon: string | File | null, type: "preset" | "custom") {
    if (!icon) return;

    let finalIcon: string = typeof icon === "string" ? icon : "";

    // If it's a custom file, upload it first
    if (type === "custom" && icon instanceof File) {
      try {
        const { createClient } = await import("@/lib/supabase/client");
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        const fileName = `model-icon-${user.id}-${Date.now()}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(fileName, icon, {
            cacheControl: '3600',
            upsert: true
          });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('avatars')
          .getPublicUrl(fileName);

        finalIcon = publicUrl;
      } catch (err) {
        console.error("Failed to upload model icon:", err);
        alert("Failed to upload icon");
        return;
      }
    }

    setModelIcon(finalIcon);
    setModelIconType(type);

    // Save to profile
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase
          .from('profiles')
          .update({
            model_icon: finalIcon,
            model_icon_type: type
          })
          .eq('id', user.id);
      }
    } catch (err) {
      console.error("Failed to save model icon:", err);
    }
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
    } catch (err: any) {
      alert(err.message || t("common.error"));
    }
  }

  function handleCopy(text: string, id: string) {
    navigator.clipboard.writeText(stripMarkdown(text));
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
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
      <div
        className={`${sidebarOpen ? "w-64" : "w-0"} transition-all duration-200 overflow-hidden border-r border-border flex-shrink-0`}
      >
        <div className="w-64 h-full flex flex-col bg-card">
          <div className="p-3 border-b border-border space-y-2">
            <button
              onClick={handleNewChat}
              className="flex items-center justify-center gap-2 w-full px-3 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <Plus size={15} />
              {t("nav.newChat")}
            </button>
          </div>

          <SidebarList
            chats={chatHistory}
            chatId={chatId}
            newChatLabel={t("nav.newChat")}
            onSelect={handleSelectChat}
            onDelete={handleDeleteChat}
          />
        </div>
      </div>

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col min-w-0 h-full">
        {/* Header */}
        <div className="h-12 border-b border-border flex items-center px-4 gap-3 bg-card/50 backdrop-blur-sm flex-shrink-0">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
          <h2 className="text-sm font-medium text-foreground truncate">
            {chatId
              ? chatHistory.find((c) => c.id === chatId)?.title || t("nav.chat")
              : t("nav.newChat")}
          </h2>
        </div>

        {/* Messages */}
        <div className="fd-scroll flex-1 overflow-y-auto flex flex-col">
          {messages.length === 0 && !streaming ? (
            <EmptyState onSuggestion={(s) => handleSend(s)} userName={userName} ready={profileLoaded} />
          ) : (
            <div className="w-full px-4 sm:px-6 py-5 space-y-6">
              {messages.map((msg, idx) => (
                <div key={msg.id} className="group">
                  <div className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    {msg.role === "assistant" && <AIAvatar size={28} className="mt-0.5" modelIcon={modelIcon} modelIconType={modelIconType} onModelIconChange={handleModelIconChange} />}

                    <div className="flex flex-col gap-1.5 max-w-[80%]">
                      <div
                        className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${msg.role === "user"
                          ? "bg-primary text-primary-foreground rounded-tr-sm"
                          : "bg-card border border-border text-foreground rounded-tl-sm"
                          }`}
                      >
                        {msg.role === "user" ? (
                          <span dir="auto" className="whitespace-pre-wrap">
                            {msg.content}
                          </span>
                        ) : (
                          <MarkdownRenderer key={msg.content} content={msg.content} />
                        )}
                      </div>

                      {/* Action buttons */}
                      <div
                        className={`flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ${msg.role === "user" ? "justify-end" : "justify-start"
                          }`}
                      >
                        <button
                          onClick={() => handleCopy(msg.content, msg.id)}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                          title={t("chat.copy")}
                        >
                          {copiedId === msg.id ? (
                            <Check size={12} className="text-green-500" />
                          ) : (
                            <Copy size={12} />
                          )}
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
                        {msg.role === "assistant" &&
                          idx > 0 &&
                          messages[idx - 1]?.role === "user" && (
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

                    {msg.role === "user" && (
                      <UserAvatar
                        size={28}
                        src={userAvatar}
                        alt={userName || "Profile"}
                        className="mt-0.5"
                        onClick={() => router.push("/settings")}
                      />
                    )}
                  </div>
                </div>
              ))}

              {/* Streaming */}
              {streaming && streamedContent && (
                <div className="flex gap-3 justify-start">
                  <AIAvatar size={28} className="mt-0.5" modelIcon={modelIcon} modelIconType={modelIconType} onModelIconChange={handleModelIconChange} />
                  <div className="max-w-[80%] rounded-2xl rounded-tl-sm px-4 py-3 bg-card border border-border text-foreground text-sm leading-relaxed">
                    <MarkdownRenderer key={streamedContent} content={streamedContent} />
                    {generatedImages.length > 0 && (
                      <div className="mt-3 space-y-3">
                        {generatedImages.map((img, i) => (
                          <div
                            key={i}
                            className="relative group/img"
                          >
                            <img
                              src={img.url}
                              alt={img.prompt}
                              className="rounded-xl border border-border max-w-full h-auto"
                              loading="lazy"
                            />
                            <button
                              onClick={() =>
                                handleDownloadImage(img.url, img.prompt)
                              }
                              className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 text-white opacity-0 group-hover/img:opacity-100 transition-opacity hover:bg-black/70"
                              title={t("documents.download")}
                            >
                              <Download size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <StreamingCursor />
                  </div>
                </div>
              )}

              {streaming && !streamedContent && (
                <div className="flex gap-3 justify-start">
                  <AIAvatar size={28} modelIcon={modelIcon} modelIconType={modelIconType} onModelIconChange={handleModelIconChange} />
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
        <div className="shrink-0 border-t border-border/60 bg-background px-4 sm:px-6 py-3">
          <div className="w-full">
            <div className="flex items-end gap-2 rounded-2xl border border-border bg-card px-3 py-2 focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10 transition-all">
              <div className="flex-1 min-w-0 relative flex items-center min-h-10">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder=""
                  rows={1}
                  className="w-full resize-none bg-transparent text-sm leading-6 text-foreground focus:outline-none block relative z-10"
                  style={{ height: "24px", maxHeight: "200px", lineHeight: "24px", padding: 0 }}
                />
                {input === "" && (
                  <div className="absolute start-0 top-1/2 -translate-y-1/2 pointer-events-none text-sm text-muted-foreground">
                    <span>{t("chat.placeholderAnimated") || "Type your message"}</span>
                    <span className="inline-block animate-pulse">.</span>
                    <span className="inline-block animate-pulse [animation-delay:200ms]">.</span>
                    <span className="inline-block animate-pulse [animation-delay:400ms]">.</span>
                  </div>
                )}
              </div>
              <button
                onClick={() => (streaming ? abort() : handleSend())}
                disabled={!streaming && !input.trim()}
                className={`p-2 rounded-xl shrink-0 self-end mb-1 transition-all ${streaming
                  ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                  : input.trim()
                    ? "bg-primary text-primary-foreground hover:opacity-90 shadow-sm"
                    : "bg-muted text-muted-foreground cursor-not-allowed"
                  }`}
              >
                {streaming ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Send size={16} />
                )}
              </button>
            </div>
            <p className="text-center text-[11px] text-muted-foreground/50 mt-1.5">
              {t("chat.disclaimer")}
            </p>
          </div>
        </div>

        <ConfirmDialog
          isOpen={deleteDialog.isOpen}
          title={t("chat.deleteTitle")}
          message={t("chat.deleteDescription")}
          confirmText={t("common.delete")}
          cancelText={t("common.cancel")}
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full">
          <Loader2 className="animate-spin text-muted-foreground" size={24} />
        </div>
      }
    >
      <ChatContent />
    </Suspense>
  );
}
