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

function getGreeting(name: string, t: (key: string, params?: Record<string, string>) => string) {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return t("goodMorning", { name });
  if (hour >= 12 && hour < 17) return t("goodAfternoon", { name });
  return t("goodEvening", { name });
}

function InputDialog({
  isOpen,
  title,
  initialValue,
  confirmText = "Save",
  cancelText = "Cancel",
  onConfirm,
  onCancel,
  t,
}: {
  isOpen: boolean;
  title: string;
  initialValue: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: (val: string) => void;
  onCancel: () => void;
  t: (key: string) => string;
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
          placeholder={t && t("chat.placeholder")}
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
  t,
}: {
  agentName?: string;
  onSuggestion: (s: string) => void;
  userName?: string | null;
  ready: boolean;
  t: (key: string, params?: Record<string, string>) => string;
}) {
  const name = userName && userName.trim() ? userName.trim() : "Hamza";
  const greeting = getGreeting(name, t);

  const suggestions = [
    t && t("chat.suggestions.summarize"),
    t && t("chat.suggestions.keyPoints"),
    t && t("chat.suggestions.listData"),
    t && t("chat.suggestions.simpleTerms"),
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
            <div>
              <h2 className="text-[clamp(25px,3vw,34px)] leading-[1.2] tracking-[-1.15px] font-semibold text-foreground">
                {t && t("chat.empty")}
              </h2>
              <p className="text-sm text-muted-foreground mt-2 max-w-xs leading-relaxed mx-auto">
                {t && t("chat.emptySub")}
              </p>
            </div>
          )}
          <p className="text-sm text-muted-foreground mt-2 max-w-xs leading-relaxed mx-auto">
            {t && t("chat.howCanIHelpAgent", { agentName: agentName || "" })}
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
  const [copiedId, setCopiedId] = useState<string | null>(null);
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

  const handleModelIconChange = async (icon: string | File | null, type: "preset" | "custom", color?: string, shape?: string) => {
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
  };

  const [deleteDialog, setDeleteDialog] = useState<{
    isOpen: boolean;
    chatId: string | null;
  }>({ isOpen: false, chatId: null });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialLoadDone = useRef(false);

  const fetchChatHistory = useCallback(async () => {
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const { data, error } = await supabase
        .from("chats")
        .select("id, title, updated_at, pinned, pinned_at")
        .eq("agent_id", agentId!)
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
      const messages = await res.json();
      setMessages(messages);
      const editsMap: Record<string, FileEdit[]> = {};
      for (const msg of messages) {
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
    const checkLang = () => {
      const dir = document.documentElement.getAttribute("dir");
      const lang = document.documentElement.getAttribute("lang");
      setIsArabic(dir === "rtl" || lang === "ar");
    };
    checkLang();
  }, []);

  useEffect(() => {
    fetchChatHistory();
    if (initialChatId && !initialLoadDone.current) {
      initialLoadDone.current = true;
      fetchMessages(initialChatId);
    }
  }, [initialChatId, fetchChatHistory, fetchMessages]);

  const showToast = (text: string, chatTitle: string) => {
    setToastMessage({ text, chatTitle });
    setTimeout(() => {
      setToastMessage(null);
    }, 3500);
  };

  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("settings-auto-scroll");
      if (saved !== null) {
        setAutoScroll(saved === "true");
      }
    } catch (err) {
      console.error("Failed to load auto-scroll setting:", err);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("settings-auto-scroll", String(autoScroll));
    } catch (err) {
      console.error("Failed to save auto-scroll setting:", err);
    }
  }, [autoScroll]);

  useEffect(() => {
    const messagesContainer = messagesEndRef.current?.parentElement;
    if (!messagesContainer) return;

    const currentScroll = messagesContainer.scrollTop;
    const maxScroll = messagesContainer.scrollHeight - messagesContainer.clientHeight;
    const nearTop = currentScroll <= 10;

    if (autoScroll && nearTop) {
      messagesContainer.scrollTo({
        top: maxScroll,
        behavior: "smooth",
      });
    }
  }, [autoScroll, messages.length, streaming]);

  return (
    <div className="flex h-full w-full bg-background overflow-hidden relative">
      {streaming && !streamedContent && (
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
          <div className="bg-card border border-border rounded-2xl rounded-tr-sm rounded-tl-none px-4 py-3.5">
            <ThinkingDots />
            <p className="text-xs text-muted-foreground mt-1 text-center">
              {t && t("chat.thinking")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AgentChatPage() {
  const searchParams = useSearchParams();
  const agentId = searchParams.get("id");

  if (!agentId) {
    return <div className="flex h-full items-center justify-center">Select an agent to chat</div>;
  }

  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center">Loading...</div>}>
      <AgentChatContent agentId={agentId} />
    </Suspense>
  );
}