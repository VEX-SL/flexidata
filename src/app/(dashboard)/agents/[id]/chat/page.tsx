"use client";

import { Suspense, useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Send,
  Loader2,
  Plus,
  Copy,
  Check,
  RotateCw,
  X,
  AudioLines,
  CheckCircle2,
  Download,
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import AudioChat from '@/components/chat/audio-chat';
import { AgentSidebar, ChatItem } from "@/components/agent-sidebar";
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
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FileTypeIcon, SUPPORTED_FILE_ACCEPT } from "@/components/file-icon";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface Agent {
  id: string;
  name: string;
  description: string | null;
}

function InputDialog({
  isOpen,
  title,
  initialValue,
  confirmText = "Save",
  cancelText = "Cancel",
  onConfirm,
  onCancel,
}: {
  isOpen: boolean;
  title: string;
  initialValue: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: (val: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(initialValue);
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, initialValue]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] transition-opacity duration-300 animate-in fade-in">
      <div 
        className="w-full max-w-md bg-card border border-border rounded-2xl shadow-2xl p-6 mx-4 transition-all duration-200 transform scale-100 animate-in fade-in zoom-in-95"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-foreground mb-4">{title}</h3>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm(value);
            if (e.key === "Escape") onCancel();
          }}
          className="w-full px-3 py-2 text-sm rounded-xl border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 mb-6"
        />
        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-xs font-medium rounded-xl border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={() => onConfirm(value)}
            className="px-4 py-2 text-xs font-semibold rounded-xl bg-primary text-primary-foreground hover:opacity-90 transition-all shadow-sm"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  agentName,
  onSuggestion,
  userName,
  ready,
}: {
  agentName?: string;
  onSuggestion: (s: string) => void;
  userName?: string | null;
  ready: boolean;
}) {
  const { t } = useTranslation();
  const name = userName && userName.trim() ? userName.trim() : "Hamza";

  const getGreeting = (name: string) => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return t("chat.goodMorning", { name });
    if (hour >= 12 && hour < 17) return t("chat.goodAfternoon", { name });
    if (hour >= 17 && hour < 21) return t("chat.goodEvening", { name });
    return t("chat.goodNight", { name });
  };

  const greeting = getGreeting(name);

  const suggestions = [
    t("chat.suggestions.summarize"),
    t("chat.suggestions.keyPoints"),
    t("chat.suggestions.listData"),
    t("chat.suggestions.simpleTerms"),
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
            {t("chat.howCanIHelpAgent")} {agentName ? `(${agentName})` : ""}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 w-full max-w-md">
        {suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => onSuggestion(s)}
            className="text-right px-3 py-2.5 rounded-xl border border-border bg-card hover:bg-accent text-xs text-muted-foreground hover:text-foreground transition-colors leading-relaxed"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function AgentChatContent({ agentId }: { agentId: string }) {
  const [isVoiceChatOpen, setIsVoiceChatOpen] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialChatId = searchParams.get("chatId");
  const { t } = useTranslation();
  const { streaming, streamedContent, generatedImages, sendStream, abort } = useStreamChat({ agentId });

  const [agent, setAgent] = useState<Agent | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [chatId, setChatId] = useState<string | null>(initialChatId);
  const [chatHistory, setChatHistory] = useState<ChatItem[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [messageEdits, setMessageEdits] = useState<Record<string, FileEdit[]>>({});

  const [toastMessage, setToastMessage] = useState<{ text: string; chatTitle: string } | null>(null);
  const [isArabic, setIsArabic] = useState(true);

  const [editDialog, setEditDialog] = useState<{
    isOpen: boolean;
    chatId: string | null;
    currentTitle: string;
  }>({ isOpen: false, chatId: null, currentTitle: "" });

  const [userName, setUserName] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userAvatar, setUserAvatar] = useState<string | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [attachedFile, setAttachedFile] = useState<{ name: string } | null>(null);

  const [modelIcon, setModelIcon] = useState<string | null>(null);
  const [modelIconType, setModelIconType] = useState<"preset" | "custom" | null>(null);
  const [modelColor, setModelColor] = useState<string | null>(null);
  const [modelShape, setModelShape] = useState<string | null>(null);
  
  const [deleteDialog, setDeleteDialog] = useState<{
    isOpen: boolean;
    chatId: string | null;
  }>({ isOpen: false, chatId: null });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialLoadDone = useRef(false);

  useEffect(() => {
    const checkLang = () => {
      const dir = document.documentElement.getAttribute("dir");
      const lang = document.documentElement.getAttribute("lang");
      setIsArabic(dir === "rtl" || lang === "ar");
    };
    checkLang();
  }, []);

  const showToast = (text: string, chatTitle: string) => {
    setToastMessage({ text, chatTitle });
    setTimeout(() => setToastMessage(null), 3500);
  };

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { createClient } = await import("@/lib/supabase/client");
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          setUserEmail(user.email || null);
          const { data: profile } = await supabase
            .from("profiles")
            .select("name, avatar_url, model_icon, model_icon_type, model_color, model_shape")
            .eq("id", user.id)
            .maybeSingle();
          if (!active) return;
          if (profile?.name) setUserName(profile.name);
          if (profile?.avatar_url) setUserAvatar(profile.avatar_url);
          if (profile?.model_icon) {
            setModelIcon(profile.model_icon);
            setModelIconType(profile.model_icon_type as "preset" | "custom" | null);
          }
          if (profile?.model_color) setModelColor(profile.model_color);
          setModelShape(profile?.model_shape || "rounded");
        }
      } catch {}
      if (active) setProfileLoaded(true);
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    fetch(`/api/agents/${agentId}`).then((r) => r.json()).then(setAgent);
  }, [agentId]);

  const fetchChatHistory = useCallback(async () => {
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      
      const { data, error } = await supabase
        .from("chats")
        .select("id, title, updated_at, pinned, pinned_at")
        .eq("agent_id", agentId)
        .order("updated_at", { ascending: false });

      if (!error && data) {
        setChatHistory(data.map((c: any) => ({
          id: c.id,
          title: c.title,
          updated_at: c.updated_at,
          pinned: Boolean(c.pinned),
          pinned_at: c.pinned_at ? new Date(c.pinned_at).getTime() : 0
        })));
      }
    } catch (err) {
      console.error("Failed to fetch chat history directly", err);
    }
  }, [agentId]);

  const fetchMessages = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chat-history/${id}?agentId=${agentId}`);
      if (!res.ok) {
        setChatId(null);
        setMessages([]);
        router.replace(`/agents/${agentId}/chat`, { scroll: false });
        return;
      }
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
  }, [agentId, router]);

  useEffect(() => {
    fetchChatHistory();
    if (initialChatId && !initialLoadDone.current) {
      initialLoadDone.current = true;
      fetchMessages(initialChatId);
    }
  }, [initialChatId, fetchChatHistory, fetchMessages]);

  const handleOpenEditTitle = (id: string, currentTitle: string) => {
    setEditDialog({ isOpen: true, chatId: id, currentTitle });
  };

  const handleConfirmEditTitle = async (newTitle: string) => {
    const { chatId: id, currentTitle } = editDialog;
    setEditDialog({ isOpen: false, chatId: null, currentTitle: "" });

    if (!id || !newTitle.trim() || newTitle.trim() === currentTitle) return;
    const trimmedTitle = newTitle.trim();

    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const { error } = await supabase
        .from("chats")
        .update({ title: trimmedTitle })
        .eq("id", id);

      if (!error) {
        setChatHistory((prev) =>
          prev.map((c) => (c.id === id ? { ...c, title: trimmedTitle } : c))
        );
      }
    } catch (err) {
      console.error("Failed to update chat title", err);
    }
  };

  const handleTogglePin = async (id: string) => {
    const chat = chatHistory.find(c => c.id === id);
    if (!chat) return;

    const nextPinnedState = !chat.pinned;
    const pinnedAtVal = nextPinnedState ? new Date().toISOString() : null;

    setChatHistory((prev) =>
      prev.map((c) => (c.id === id ? { ...c, pinned: nextPinnedState, pinned_at: nextPinnedState ? Date.now() : 0 } : c))
    );

    const title = chat.title || "New Chat";
    if (nextPinnedState) {
      showToast(isArabic ? "تم تثبيت" : "Pinned", title);
    } else {
      showToast(isArabic ? "تم إلغاء تثبيت" : "Unpinned", title);
    }

    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      await supabase
        .from("chats")
        .update({ pinned: nextPinnedState, pinned_at: pinnedAtVal })
        .eq("id", id);
    } catch (err) {
      console.error("Failed to save pin state to database", err);
    }
  };

  const handleShareChat = (id: string, title: string) => {
    const url = `${window.location.origin}/agents/${agentId}/chat?chatId=${id}`;
    navigator.clipboard.writeText(url);
    showToast(isArabic ? "تم نسخ لينك الشات لـ" : "Chat link copied for", title);
  };

  async function handleModelIconChange(icon: string | File | null, type: "preset" | "custom", color?: string, shape?: string) {
    if (!icon) return;
    let finalIcon: string = typeof icon === "string" ? icon : "";

    if (type === "custom" && icon instanceof File) {
      try {
        const { createClient } = await import("@/lib/supabase/client");
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        const fileName = `model-icon-${user.id}-${Date.now()}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(fileName, icon, { cacheControl: '3600', upsert: true });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('avatars')
          .getPublicUrl(fileName);

        finalIcon = publicUrl;
      } catch (err) {
        console.error("Failed to upload model icon:", err);
        return;
      }
    }

    setModelIcon(finalIcon);
    setModelIconType(type);
    if (color !== undefined) setModelColor(color);
    if (shape !== undefined) setModelShape(shape);

    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const updatePayload: any = { model_icon: finalIcon, model_icon_type: type };
        if (color !== undefined) updatePayload.model_color = color;
        if (shape !== undefined) updatePayload.model_shape = shape;
        await supabase.from('profiles').update(updatePayload).eq('id', user.id);
      }
    } catch {}
  }

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

    const activeId = result.chatId || chatId;
    if (activeId) {
      const nowIso = new Date().toISOString();
      setChatHistory((prev) =>
        prev.map((c) => (c.id === activeId ? { ...c, updated_at: nowIso } : c))
      );
    }
  }

  async function handleSend(contentOverride?: string) {
    const text = (contentOverride ?? input).trim();
    if (!text || streaming) return;
    const userContent = text;

    setMessages((prev) => [...prev, { id: `temp-${Date.now()}`, role: "user", content: userContent, created_at: new Date().toISOString() }]);
    setInput("");
    setAttachedFile(null);
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

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachedFile({ name: file.name });
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    try { await fetch(`/api/agents/${agentId}/files`, { method: "POST", body: formData }); } catch {}
    setUploading(false);
    e.target.value = "";
  }

  function handleDeleteChat(id: string) {
    setDeleteDialog({ isOpen: true, chatId: id });
  }

  async function confirmDelete() {
    if (!deleteDialog.chatId) return;
    const id = deleteDialog.chatId;
    try {
      await fetch(`/api/chat/${id}`, { method: "DELETE" });
      setChatHistory((prev) => prev.filter((c) => c.id !== id));
      if (chatId === id) {
        setChatId(null); setMessages([]); setMessageEdits({});
        router.replace(`/agents/${agentId}/chat`, { scroll: false });
      }
    } catch {
      alert(t("common.error"));
    }
    setDeleteDialog({ isOpen: false, chatId: null });
  }

  function cancelDelete() {
    setDeleteDialog({ isOpen: false, chatId: null });
  }

  function handleNewChat() {
    setChatId(null); setMessages([]); setMessageEdits({});
    setAttachedFile(null);
    router.replace(`/agents/${agentId}/chat`, { scroll: false });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  return (
    <div className="flex h-full w-full bg-background overflow-hidden relative">
      {toastMessage && (
        <div className={`fixed top-5 z-50 flex items-center gap-2 px-4 py-3 bg-emerald-600 text-white rounded-2xl shadow-xl transition-all duration-200 ${
          isArabic ? "left-5" : "right-5"
        }`}>
          <CheckCircle2 size={18} className="shrink-0" />
          <p className="text-xs">
            {toastMessage.text} <span className="font-bold underline">{toastMessage.chatTitle}</span>
          </p>
        </div>
      )}

      <AgentSidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onToggle={() => setSidebarOpen(true)}
        onNavigate={(page: string) => router.push(`/${page}`)}
        chats={chatHistory}
        selectedChatId={chatId}
        onSelectChat={(id: string | null) => {
          setChatId(id);
          if (id) fetchMessages(id);
        }}
        onNewChat={handleNewChat}
        onDeleteChat={(id: string) => handleDeleteChat(id)}
        onEditChatTitle={(id: string, currentTitle: string) => handleOpenEditTitle(id, currentTitle)}
        onTogglePin={(id: string) => handleTogglePin(id)}
        onShareChat={(id: string, title: string) => handleShareChat(id, title)}
        agentId={agentId}
        onBackToFiles={(id: string) => router.push(`/agents/${id}`)}
        userName={userName || "VEX"}
        userEmail={userEmail || ""}
        userAvatar={userAvatar}
        onLogout={async () => {
          const { createClient } = await import("@/lib/supabase/client");
          const supabase = createClient();
          await supabase.auth.signOut();
          router.push("/login");
        }}
      />

      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-background">
        <div className="fd-scroll flex-1 overflow-y-auto flex flex-col pt-4">
          {messages.length === 0 && !streaming ? (
            <EmptyState agentName={agent?.name} onSuggestion={(s: string) => handleSend(s)} userName={userName} ready={profileLoaded} />
          ) : (
            <div className="w-full px-4 sm:px-6 py-5 space-y-6">
              {messages.map((msg) => (
                <div key={msg.id} className="group">
                  <div className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    {msg.role === "assistant" && (
                      <AIAvatar
                        size={28}
                        className="mt-0.5"
                        modelIcon={modelIcon}
                        modelIconType={modelIconType}
                        modelColor={modelColor}
                        modelShape={modelShape}
                        onModelIconChange={handleModelIconChange}
                      />
                    )}
                    <div className="flex flex-col gap-1.5 max-w-[80%]">
                      <div className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${msg.role === "user" ? "bg-primary text-primary-foreground rounded-tl-sm rounded-tr-none" : "bg-card border border-border text-foreground rounded-tr-sm rounded-tl-none"}`}>
                        {msg.role === "user" ? <span dir="auto" className="whitespace-pre-wrap">{msg.content}</span> : <MarkdownRenderer key={msg.content} content={stripFileEdits(msg.content)} />}
                      </div>
                    </div>
                    {msg.role === "user" && <UserAvatar size={28} src={userAvatar} alt={userName || "Profile"} className="mt-0.5" />}
                  </div>
                </div>
              ))}

              {streaming && streamedContent && (
                <div className="flex gap-3 justify-start">
                  <AIAvatar
                    size={28}
                    className="mt-0.5"
                    modelIcon={modelIcon}
                    modelIconType={modelIconType}
                    modelColor={modelColor}
                    modelShape={modelShape}
                    onModelIconChange={handleModelIconChange}
                  />
                  <div className="max-w-[80%] rounded-2xl rounded-tr-sm rounded-tl-none px-4 py-3 bg-card border border-border text-foreground text-sm leading-relaxed">
                    <MarkdownRenderer key={streamedContent} content={stripFileEdits(streamedContent)} />
                    {generatedImages.length > 0 && (
                      <div className="mt-3 space-y-3">
                        {generatedImages.map((img, i) => (
                          <div key={i} className="relative group/img">
                            <img src={img.url} alt={img.prompt} className="rounded-xl border border-border max-w-full h-auto" loading="lazy" />
                            <button
                              onClick={() => {
                                const a = document.createElement("a");
                                a.href = img.url;
                                a.download = `generated-${img.prompt.slice(0, 50).replace(/[^a-z0-9]/gi, "-")}.png`;
                                a.target = "_blank";
                                a.rel = "noopener noreferrer";
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                              }}
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
                  </div>
                </div>
              )}

              {streaming && !streamedContent && (
                <div className="flex gap-3 justify-start">
                  <AIAvatar
                    size={28}
                    modelIcon={modelIcon}
                    modelIconType={modelIconType}
                    modelColor={modelColor}
                    modelShape={modelShape}
                    onModelIconChange={handleModelIconChange}
                  />
                  <div className="bg-card border border-border rounded-2xl rounded-tr-sm rounded-tl-none px-4 py-3.5">
                    <ThinkingDots />
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Bar */}
        <div className="shrink-0 border-t border-border/60 bg-background px-4 sm:px-6 py-3">
          <div className="w-full">
            <div className="rounded-2xl border border-border bg-card px-3 py-2 focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15 transition-all">
              <input ref={fileInputRef} type="file" className="hidden"
                accept={SUPPORTED_FILE_ACCEPT}
                onChange={handleFileUpload}
              />

              {attachedFile && (
                <div className="flex items-center gap-2 mb-2 w-fit max-w-full rounded-lg border border-border bg-muted/50 px-2.5 py-1.5 text-[11px] text-foreground">
                  <FileTypeIcon fileName={attachedFile.name} size={15} />
                  <span className="truncate max-w-[220px]" title={attachedFile.name}>
                    {attachedFile.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAttachedFile(null)}
                    className="ml-0.5 p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <X size={12} />
                  </button>
                </div>
              )}

              <div className="flex items-end gap-2">
                <div className="relative group shrink-0 self-end mb-1">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
                  >
                    {uploading ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                  </button>
                </div>

                <div className="flex-1 min-w-0 relative flex items-center min-h-10 py-1.5">
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t("chat.placeholder")}
                    rows={1}
                    className="w-full resize-none bg-transparent text-sm leading-6 text-foreground focus:outline-none block relative z-10"
                    style={{ height: "24px", maxHeight: "200px", lineHeight: "24px", padding: 0 }}
                  />
                  {input === "" && (
                    <div className="absolute start-0 top-1/2 -translate-y-1/2 pointer-events-none text-sm text-muted-foreground flex items-center">
                      <span>{t("chat.placeholderAnimated")}</span>
                      <span className="inline-block animate-pulse">.</span>
                      <span className="inline-block animate-pulse [animation-delay:200ms]">.</span>
                      <span className="inline-block animate-pulse [animation-delay:400ms]">.</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {input.trim() ? (
                    <button
                      onClick={() => (streaming ? abort() : handleSend())}
                      disabled={!streaming && !input.trim()}
                      className="p-2 rounded-xl shrink-0 self-end mb-1 bg-primary text-primary-foreground hover:opacity-90 shadow-sm transition-all"
                    >
                      {streaming ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    </button>
                  ) : (
                    <button
                      onClick={() => setIsVoiceChatOpen(true)}
                      disabled={streaming}
                      className="p-2.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white transition-all shadow-sm shrink-0 self-end mb-1 disabled:opacity-50 flex items-center justify-center"
                      title={t("voiceChat.startConversation")}
                    >
                      <AudioLines size={18} className="text-white" />
                    </button>
                  )}
                </div>
                {isVoiceChatOpen && (
                  <AudioChat onClose={() => setIsVoiceChatOpen(false)} />
                )}
              </div>
            </div>
            <p className="text-center text-[11px] text-muted-foreground/50 mt-1.5">
              {t("chat.disclaimer")}
            </p>
          </div>
        </div>
      </div>

      <InputDialog
        isOpen={editDialog.isOpen}
        title="Edit Chat Name"
        initialValue={editDialog.currentTitle}
        confirmText="Save"
        cancelText="Cancel"
        onConfirm={handleConfirmEditTitle}
        onCancel={() => setEditDialog({ isOpen: false, chatId: null, currentTitle: "" })}
      />

      <ConfirmDialog
        isOpen={deleteDialog.isOpen}
        title={t("chat.deleteTitle") || "Delete Chat"}
        message={t("chat.deleteDescription") || "Are you sure you want to delete this conversation? This action cannot be undone."}
        confirmText={t("common.delete") || "Delete"}
        cancelText={t("common.cancel") || "Cancel"}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
        type="danger"
      />
    </div>
  );
}

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
    <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className="animate-spin text-muted-foreground" size={24} /></div>}>
      <AgentChatContent agentId={agentId} />
    </Suspense>
  );
}