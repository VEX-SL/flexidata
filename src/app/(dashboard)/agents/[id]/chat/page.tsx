"use client";

import { Suspense, useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Send,
  Loader2,
  Plus,
  X,
  AudioLines,
  CheckCircle2,
  Download,
  Wrench,
  Square,
  Copy,
  Check,
  RotateCw,
  ChevronLeft,
  ChevronRight,
  ArrowRight,
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import AudioChat from "@/components/chat/audio-chat";
import { AgentSidebar, ChatItem } from "@/components/agent-sidebar";
import { useStreamChat } from "@/lib/hooks/use-stream-chat";
import { ToolSteps, type ToolStep } from "@/components/tool-steps";
import {
  parseFileEdits,
  type FileEdit,
} from "@/components/file-edit-card";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { AIAvatar, UserAvatar, ThinkingDots, StreamingCursor } from "@/components/chat-avatars";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FileTypeIcon, SUPPORTED_FILE_ACCEPT } from "@/components/file-icon";

// ─── Quick Responses ([QUICK_RESPONSE] markers) ──────────────────────────────
// The model may append up to 3 suggested follow-up messages as
// "[QUICK_RESPONSE] ..." lines at the very end of its reply (see prompts.ts).
// They are saved inside the message content (so they survive reloads) but
// are NEVER rendered as text — they render as tappable arrow rows under the
// last assistant message; tapping one sends it immediately. The rows vanish
// as soon as a new message is sent (the last message is no longer an idle
// assistant message).
// Exact parser: tolerates the variants models actually emit — list markers
// ("- ", "* ", "1. "), a colon after the marker, lowercase markers, and
// quotes/backticks wrapped around the suggestion.
const QR_LINE_EXACT_RE = /^[ \t]*(?:[-*>]\s+|\d+[.)]\s+)?\[quick_response\][ \t]*:?[ \t]*/i;
// Mangled / mid-line markers: models emit "QUICK_RESPONSE]", "[QUICK RESPONSE]:"
// (the bracket often gets eaten by markdown link parsing) — hide them anywhere.
const QR_ANYWHERE_RE = /\[?QUICK[_ \t-]?RESPONSE\]?\s*:?/gi;
const QR_MARKER_LOWER = "[quick_response]";

function parseQuickResponses(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(QR_LINE_EXACT_RE);
    if (m) {
      const value = line
        .slice(m[0].length)
        .trim()
        .replace(/^[`"'\u201c\u201d]+/, "")
        .replace(/[`"'\u201c\u201d]+$/, "")
        .trim();
      if (value && !out.includes(value)) out.push(value);
    }
  }
  return out.slice(0, 3); // hard cap: 3 suggestions max
}

function stripQuickResponses(content: string): string {
  // 1) Drop whole lines that START with the marker (the normal case).
  const filtered = content.split("\n").filter(
    (l) => !/^[ \t]*(?:[-*>]\s+|\d+[.)]\s+)?\[quick/i.test(l)
  );
  // 2) Remove mangled / mid-line markers anywhere so they never surface
  //    as literal text (fixes "QUICK_RESPONSE]" / "ESPONSE]" leaks —
  //    markdown link parsing can eat "[QUICK_R" and leave "ESPONSE]").
  return filtered
    .map((l) =>
      l
        .replace(QR_ANYWHERE_RE, "")
        .replace(/\b[A-Z]{0,7}SPONSE\]\s*:?/g, "")
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

// STREAMING: hold back everything from the first (complete or partial)
// [QUICK_RESPONSE] marker to the end of the stream — the suggestions render
// as chips when the stream finishes, never as message text.
function cutQuickResponseTail(content: string): string {
  const lower = content.toLowerCase();
  const first = lower.indexOf(QR_MARKER_LOWER);
  if (first !== -1) return content.slice(0, first);
  // Partial tail ("[QUICK_RESPO" mid-token) → hold from the last "[".
  const lb = content.lastIndexOf("[");
  if (lb !== -1) {
    const rest = lower.slice(lb, lb + QR_MARKER_LOWER.length);
    if (QR_MARKER_LOWER.startsWith(rest)) return content.slice(0, lb);
  }
  return content;
}

// Boilerplate confirmations like "✅ Created signin.html with a clean,
// accessible sign-in form and full styling." — the file card above the
// message already reports the operation, so the line adds nothing.
const BOILERPLATE_LINE_RE = /^[ \t]*✅[ \t]*(?:Created|Updated|Edited|Deleted|Removed|Saved|تم إنشاء|تم تحديث|تم حذف|تم تعديل)[^\n]*$/gm;

function stripBoilerplateConfirmations(content: string): string {
  return content
    .replace(BOILERPLATE_LINE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Streaming file-block analysis ───────────────────────────────────────
// While the model is streaming a [FILE_EDIT: x] / [NEW_FILE: x] block, the
// raw code must NEVER appear in the message text. analyzeFileBlocks() finds
// blocks that are still being written (no ">>>>>>> END" finished yet for
// FILE_EDIT, no closing ``` fence yet for NEW_FILE) and returns:
//   display — the content up to the first still-open block (finished blocks
//             are removed later by stripFileBlocksLocal)
//   pending — the still-open blocks WITH the live code currently inside
//             them; they render as an expandable "Editing file: x..." step
//             (click it to watch the code being written in real time).
interface StreamingFileOp {
  name: string;
  isNew: boolean;
  content: string;
}

const FILE_BLOCK_MARKER_RE = /\[(FILE_EDIT|NEW_FILE):[ \t]*([^\]\n]+)\]/g;
const FILE_BLOCK_PARTIAL_MARKERS = ["[FILE_EDIT:", "[NEW_FILE:", "[DELETE_FILE:"];
// A still-open command marker with a growing filename ("[NEW_FILE: signin.html")
// must be held too — it matches as soon as the "[" is followed by a command word.
const INCOMPLETE_COMMAND_RE = /^\[(?:NEW_FILE|FILE_EDIT|DELETE_FILE|QUICK_RESPONSE|USE_SKILL|GENERATE_IMAGE)/i;

function extractBlockBody(content: string, headerEnd: number, isNew: boolean): string {
  let body = content.slice(headerEnd).replace(/^[ \t]*\r?\n/, "");
  if (isNew) body = body.replace(/^[ \t]*```[a-zA-Z0-9_-]*[ \t]*\r?\n/, ""); // drop the opening fence line
  body = body.replace(/\r?\n[ \t]*`{0,3}[a-zA-Z0-9_-]*[ \t]*$/, ""); // drop a trailing partial/closing fence
  return body.slice(0, 12000);
}

function analyzeFileBlocks(content: string): { display: string; pending: StreamingFileOp[] } {
  const pending: StreamingFileOp[] = [];
  let firstOpenIdx = -1;
  FILE_BLOCK_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_BLOCK_MARKER_RE.exec(content)) !== null) {
    const tail = content.slice(m.index);
    const closed =
      m[1] === "NEW_FILE"
        ? (tail.match(/^[ \t]*```/gm) || []).length >= 2 // opening + closing fence
        : tail.includes(">>>>>>> END");
    if (!closed) {
      pending.push({
        name: m[2].trim(),
        isNew: m[1] === "NEW_FILE",
        content: extractBlockBody(content, m.index + m[0].length, m[1] === "NEW_FILE"),
      });
      if (firstOpenIdx === -1) firstOpenIdx = m.index;
    }
  }
  if (firstOpenIdx !== -1) {
    return { display: content.slice(0, firstOpenIdx), pending };
  }
  // An unfinished command marker ("[NEW_FILE: signin" — no "]" yet) is held
  // from its "[" so the growing filename never flashes on screen. Ordinary
  // text in brackets ("[optional]") is untouched.
  const lb = content.lastIndexOf("[");
  if (lb !== -1) {
    const rest = content.slice(lb);
    if (!rest.includes("]") && !rest.includes("\n") && INCOMPLETE_COMMAND_RE.test(rest + "]")) {
      return { display: content.slice(0, lb), pending };
    }
  }
  // A marker can also be half-streamed (content currently ends with
  // "[FILE_ED") — cut the partial marker so it never flashes on screen.
  for (const p of FILE_BLOCK_PARTIAL_MARKERS) {
    for (let len = 1; len < p.length; len++) {
      if (content.endsWith(p.slice(0, len))) {
        return { display: content.slice(0, content.length - len), pending };
      }
    }
  }
  return { display: content, pending };
}

// Robust local file-block strip (independent of file-edit-card's
// stripFileEdits). Scans marker-by-marker and removes each block body:
// - FILE_EDIT → up to ">>>>>>> END" (fenced OR unfenced — the prompt format
//   has no fences, so relying on fences leaks raw code during streaming).
// - NEW_FILE  → up to the closing ``` fence when present, otherwise to the
//   next marker / end of content.
// Text BETWEEN blocks (summaries, explanations, tables) is always preserved.
function stripFileBlocksLocal(raw: string): string {
  if (!raw) return raw;
  const MARKER_RE = /\[(NEW_FILE|FILE_EDIT|DELETE_FILE):[ \t]*[^\]\n]+\]/g;
  let out = "";
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(raw)) !== null) {
    if (m.index < pos) continue; // marker inside an already-consumed body
    out += raw.slice(pos, m.index);
    const kind = m[0].startsWith("[NEW_FILE")
      ? "NEW_FILE"
      : m[0].startsWith("[DELETE_FILE")
        ? "DELETE_FILE"
        : "FILE_EDIT";
    if (kind === "DELETE_FILE") {
      // Marker-only operation: remove the marker and the rest of its line.
      let deleteEnd = m.index + m[0].length;
      if (raw[deleteEnd] === "\r") deleteEnd++;
      if (raw[deleteEnd] === "\n") deleteEnd++;
      pos = deleteEnd;
      MARKER_RE.lastIndex = pos;
      continue;
    }
    const bodyStart = m.index + m[0].length;
    MARKER_RE.lastIndex = bodyStart;
    const next = MARKER_RE.exec(raw);
    const nextIdx = next ? next.index : -1;

    let bodyEnd: number;
    if (kind === "FILE_EDIT") {
      const endIdx = raw.indexOf(">>>>>>> END", bodyStart);
      bodyEnd =
        endIdx !== -1 && (nextIdx === -1 || endIdx < nextIdx)
          ? endIdx + ">>>>>>> END".length
          : nextIdx === -1
            ? raw.length
            : nextIdx;
    } else {
      // NEW_FILE: cut at the closing fence when the body is fenced.
      // Allow leading whitespace/newlines — blocks are streamed as
      // "[NEW_FILE: x]\n```lang", so the fence never starts flush.
      const after = raw.slice(bodyStart);
      const fenceOpen = after.match(/^[ \t\r\n]*```/);
      if (fenceOpen) {
        const firstNl = after.indexOf("\n", fenceOpen[0].length);
        const closeRel = firstNl === -1 ? -1 : after.indexOf("```", firstNl);
        bodyEnd =
          closeRel !== -1
            ? bodyStart + closeRel + 3
            : nextIdx === -1
              ? raw.length
              : nextIdx;
      } else {
        bodyEnd = nextIdx === -1 ? raw.length : nextIdx;
      }
    }
    pos = bodyEnd;
    MARKER_RE.lastIndex = pos;
  }
  out += raw.slice(pos);
  return out;
}

// Full display pipeline: hide in-progress file blocks, remove completed
// file-block bodies (storage markers), remove [QUICK_RESPONSE] lines and
// boilerplate "✅ Created …" confirmations.
// streaming=true additionally holds the [QUICK_RESPONSE] tail so the
// suggestions never flash as text while tokens arrive.
function getRenderableContent(raw: string, opts?: { streaming?: boolean }): string {
  const { display } = analyzeFileBlocks(raw);
  let text = stripFileBlocksLocal(display);
  if (opts?.streaming) text = cutQuickResponseTail(text);
  text = stripQuickResponses(text);
  return stripBoilerplateConfirmations(text);
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  tool_steps?: ToolStep[] | null;
  // ✅ Generation history: each regenerate creates a new entry here,
  // so we can navigate between attempts with < 1 > arrows.
  generations?: MessageGeneration[];
  current_generation?: number; // 0-indexed pointer into generations
}

interface MessageGeneration {
  id: string;
  content: string;
  tool_steps?: ToolStep[] | null;
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
            dir="auto"
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

  const { streaming, streamedContent, generatedImages, liveToolSteps, sendStream, abort } = useStreamChat({
    agentId,
  });

  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const [agent, setAgent] = useState<Agent | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [chatId, setChatId] = useState<string | null>(initialChatId);
  const [chatHistory, setChatHistory] = useState<ChatItem[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [messageEdits, setMessageEdits] = useState<Record<string, FileEdit[]>>({});

  const [toastMessage, setToastMessage] = useState<{ text: string; chatTitle: string } | null>(null);

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

  // ✅ Auto-scroll: container ref + "is the user near the bottom?" flag.
  // If the user scrolled up to read older messages we stop following the
  // stream so we don't yank them down (same behavior as ChatGPT/Claude).
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  // ✅ In-place regeneration: while regenerating message #regenIndex the
  // live stream renders INSIDE that message (not in the bottom bubble),
  // like ChatGPT. regenAnchorRef keeps the growing message in view, and
  // regenFollowRef stops following once the user scrolls manually.
  const [regenIndex, setRegenIndex] = useState<number | null>(null);
  const regenAnchorRef = useRef<HTMLDivElement>(null);
  const regenFollowRef = useRef(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Track whether the user is near the bottom; once they scroll up more
  // than 120px away from the bottom, auto-follow pauses until they return.
  const handleMessagesScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  // (1) Scroll when the message list changes: opening a chat, sending a
  // message, regenerate results, switching generations. Double rAF waits
  // one paint so markdown/code blocks get their real height first.
  useEffect(() => {
    if (!isNearBottomRef.current) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => scrollToBottom("auto"));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [messages, scrollToBottom]);

  // (2) While streaming: follow the growing answer as tokens arrive.
  // Normal send → keep the container bottom in view (only when the user is
  // still at the bottom — see handleMessagesScroll).
  // In-place regeneration → keep the regenerating MESSAGE in view instead
  // (messages below it must stay where they are), until the user scrolls.
  useEffect(() => {
    if (!streaming) return;
    if (regenIndex !== null) {
      if (regenFollowRef.current) {
        regenAnchorRef.current?.scrollIntoView({ block: "nearest" });
      }
    } else if (isNearBottomRef.current) {
      scrollToBottom("auto");
    }
  }, [streaming, streamedContent, liveToolSteps, generatedImages, regenIndex, scrollToBottom]);

  // Any manual wheel/touch on the chat area stops regen auto-follow
  // (until the next regeneration starts).
  const handleUserScrollIntent = useCallback(() => {
    regenFollowRef.current = false;
  }, []);

  // ✅ Auto-resize textarea: grows with the content (up to 200px ≈ 8 lines)
  // and shrinks back to a single line when cleared — same pattern as the
  // general chat page. height is fully controlled here (the element's
  // inline style no longer hardcodes 24px).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

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
    // Opening/switching a chat always lands at the bottom of the conversation.
    isNearBottomRef.current = true;
    // Leaving the chat cancels any in-place regeneration display.
    setRegenIndex(null);
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
    // ✅ i18n for the toast messages
    const pinText = nextPinnedState ? t("chat.pinned") : t("chat.unpinned");
    showToast(pinText, title);

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
    // ✅ i18n for the share toast
    showToast(t("chat.linkCopied"), title);
  };

  const handleCopyMessage = (text: string, msgId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedMessageId(msgId);
    setTimeout(() => setCopiedMessageId(null), 2000);
  };

  const handleRetryMessage = (index: number) => {
    if (index > 0 && messages[index - 1]?.role === "user") {
      const previousUserContent = messages[index - 1].content;
      // ✅ Option 3: Don't delete messages AFTER this one — only replace
      // the assistant message we're regenerating, and KEEP the rest.
      // The new response becomes a new generation in the same message's
      // `generations` array, so we can navigate with < N > arrows.
      handleRegenerate(index, previousUserContent);
    }
  };

  // ✅ Option 3: regenerate a specific assistant message in place.
  // The previous user message + everything before it is sent as context.
  // Messages AFTER this one are kept untouched.
  // The route UPDATEs the existing message (replaceMessageId) instead of
  // inserting a new one — no duplicates in the DB or on reload.
  async function handleRegenerate(assistantIndex: number, _userContent: string) {
    const targetMsg = messages[assistantIndex];
    if (!targetMsg || targetMsg.role !== "assistant") return;
    if (streaming) return;
    // NOTE: don't touch isNearBottomRef here — in-place regeneration
    // follows the message via regenFollowRef/regenAnchorRef instead, and
    // forcing near-bottom would yank the view to the chat bottom after
    // regenerating a message in the middle of the conversation.

    // ✅ Capture the original content FIRST — it seeds generations[0]
    // so the user can navigate back to the very first attempt.
    const originalContent = targetMsg.content;
    const originalToolSteps = targetMsg.tool_steps;
    const originalCreatedAt = targetMsg.created_at;
    const existingGens = targetMsg.generations ?? [
      {
        id: targetMsg.id,
        content: originalContent,
        tool_steps: originalToolSteps,
        created_at: originalCreatedAt,
      },
    ];

    if (!chatId) {
      alert(t("common.error"));
      return;
    }

    // Find the user message that triggered this assistant message
    const userMsg = messages[assistantIndex - 1];
    if (!userMsg || userMsg.role !== "user") {
      alert(t("common.error"));
      return;
    }

    // ✅ In-place display: DON'T clear the message content. While
    // regenIndex === assistantIndex && streaming, the live stream renders
    // inside this message instead of its saved content. On failure nothing
    // needs restoring — the original content was never touched.
    setRegenIndex(assistantIndex);
    regenFollowRef.current = true;

    try {
      // ✅ Pass replaceMessageId so the route UPDATEs the existing message
      // instead of inserting a new one — no duplicates on reload.
      const result = await sendStream(chatId, userMsg.content, {
        replaceMessageId: targetMsg.id,
      });
      if (
        !result ||
        (result.aborted &&
          !getRenderableContent(result.fullContent).trim() &&
          !(result.toolSteps && result.toolSteps.length > 0))
      ) {
        // Stream aborted with nothing generated — nothing to restore
        // (content was never cleared), just exit in-place mode.
        setRegenIndex(null);
        return;
      }

      // Build the new generation entry
      const newGen: MessageGeneration = {
        id: `gen-${Date.now()}`,
        content: result.fullContent,
        tool_steps: result.toolSteps ?? null,
        created_at: new Date().toISOString(),
      };

      // ✅ Append to existingGens (which includes the original), switch pointer
      const updatedGens = [...existingGens, newGen];
      setMessages((prev) =>
        prev.map((m) => {
          // ✅ Match by id (not index) — safe even if the message list
          // changed while the stream was running (e.g. chat switched).
          if (m.id !== targetMsg.id) return m;
          return {
            ...m,
            content: newGen.content,
            tool_steps: newGen.tool_steps,
            generations: updatedGens,
            current_generation: updatedGens.length - 1,
          };
        })
      );
      setRegenIndex(null);
    } catch (err: any) {
      setRegenIndex(null);
      // Content was never cleared (in-place mode) — just surface the error.
      alert(err.message || t("common.error"));
    }
  }

  // ✅ Navigate between generations: < N > arrows on a regenerated message
  function handleSwitchGeneration(assistantIndex: number, direction: -1 | 1) {
    setMessages((prev) =>
      prev.map((m, i) => {
        if (i !== assistantIndex) return m;
        const gens = m.generations;
        if (!gens || gens.length <= 1) return m;
        const currentIdx = m.current_generation ?? 0;
        const newIdx = Math.max(0, Math.min(gens.length - 1, currentIdx + direction));
        const gen = gens[newIdx];
        return {
          ...m,
          content: gen.content,
          tool_steps: gen.tool_steps,
          current_generation: newIdx,
        };
      })
    );
  }

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
    result: {
      fullContent: string;
      chatId: string;
      title: string | null;
      toolSteps?: ToolStep[];
      userMessageId?: string | null;
      assistantMessageId?: string | null;
    },
    userContent: string
  ) {
    const edits = parseFileEdits(result.fullContent);
    const savedToolSteps = result.toolSteps ?? null;
    const hasVisibleContent = getRenderableContent(result.fullContent).trim().length > 0;
    const hasSteps = (result.toolSteps?.length ?? 0) > 0;

    setMessages((prev) => {
      // ✅ Real-ids fix: use the REAL database ids returned by the route.
      // Falls back to temporary ids only if the route didn't send them.
      // This is what makes regenerate work on messages created in this
      // session (previously they sent assistant-<timestamp> → 400 error).
      const realUserId = result.userMessageId || `user-${Date.now()}`;
      const realAssistantId = result.assistantMessageId || `assistant-${Date.now()}`;
      // ✅ Duplicate-key fix: drop the temp messages AND any message that
      // already carries the real DB id. The chat-history refetch triggered
      // by the URL change can resolve BEFORE this callback runs and insert
      // the same rows — React then throws "two children with the same key"
      // and every later message in the session renders with broken avatars.
      const withoutTemp = prev.filter(
        (m) =>
          !m.id.startsWith("temp-") &&
          m.id !== realUserId &&
          m.id !== realAssistantId
      );
      if (edits.length > 0)
        setMessageEdits((p) => ({ ...p, [realAssistantId]: edits }));
      const next: Message[] = [
        ...withoutTemp,
        { id: realUserId, role: "user", content: userContent, created_at: new Date().toISOString() },
      ];
      // ✅ Never append an EMPTY assistant bubble (aborted/failed generation).
      if (hasVisibleContent || hasSteps) {
        next.push({
          id: realAssistantId,
          role: "assistant",
          content: result.fullContent,
          created_at: new Date().toISOString(),
          tool_steps: savedToolSteps,
        });
      }
      return next;
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

    // Sending a message means we want to see the reply — force auto-follow.
    isNearBottomRef.current = true;
    setMessages((prev) => [...prev, { id: `temp-${Date.now()}`, role: "user", content: userContent, created_at: new Date().toISOString() }]);
    setInput("");
    setAttachedFile(null);
    // ✅ Removed: "جاري تفعيل المهارات والأدوات المناسبة..." status message
    // The tool steps now appear live as the route streams them, so a
    // placeholder status is no longer needed.

    try {
      const result = await sendStream(chatId, userContent);
      if (!result) {
        // Defensive: the hook produced no result (aborted before any event).
        // Keep the user's message visible — only the generation stopped.
        setMessages((prev) =>
          prev.map((m) =>
            m.id.startsWith("temp-") && m.role === "user"
              ? { ...m, id: m.id.replace(/^temp-/, "user-saved-") }
              : m
          )
        );
        return;
      }
      if (result.aborted) {
        // ✅ Stop pressed: KEEP what was generated so far. The user message
        // and the partial reply stay visible IMMEDIATELY — only the
        // generation stops. (The server also persists the partial content,
        // so it survives reloads.)
        const stoppedUserId = result.userMessageId || `user-stopped-${Date.now()}`;
        const stoppedAsstId = `assistant-stopped-${Date.now()}`;
        const partialVisible = getRenderableContent(result.fullContent).trim().length > 0;
        setMessages((prev) => {
          const rest = prev.filter(
            (m) => !m.id.startsWith("temp-") && m.id !== stoppedUserId
          );
          const next: Message[] = [
            ...rest,
            { id: stoppedUserId, role: "user", content: userContent, created_at: new Date().toISOString() },
          ];
          if (
            partialVisible ||
            (result.toolSteps && result.toolSteps.length > 0)
          ) {
            next.push({
              id: stoppedAsstId,
              role: "assistant",
              content: result.fullContent,
              created_at: new Date().toISOString(),
              tool_steps:
                result.toolSteps && result.toolSteps.length > 0
                  ? result.toolSteps
                  : null,
            });
          }
          return next;
        });
        if (!chatId && result.chatId) {
          initialLoadDone.current = true;
          setChatId(result.chatId);
          router.replace(`/agents/${agentId}/chat?chatId=${result.chatId}`, { scroll: false });
          fetchChatHistory();
        }
        return;
      }
      if (!chatId && result.chatId) {
        // ✅ New chat created: mark the initial load as done BEFORE the URL
        // changes, so the searchParams effect doesn't refetch the messages
        // and race with processStreamResult (duplicate-key source).
        initialLoadDone.current = true;
        setChatId(result.chatId);
        router.replace(`/agents/${agentId}/chat?chatId=${result.chatId}`, { scroll: false });
        fetchChatHistory();
      }
      processStreamResult(result, userContent);
    } catch (err: any) {
      // Real request failure (network / 4xx): keep the user message, show the error.
      setMessages((prev) =>
        prev.map((m) =>
          m.id.startsWith("temp-") && m.role === "user"
            ? { ...m, id: m.id.replace(/^temp-/, "user-saved-") }
            : m
        )
      );
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
    isNearBottomRef.current = true;
    setRegenIndex(null);
    setChatId(null); setMessages([]); setMessageEdits({});
    setAttachedFile(null);
    router.replace(`/agents/${agentId}/chat`, { scroll: false });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  // ✅ While streaming, file blocks that are still being written are hidden
  // from the message text and surfaced as live "Editing file: x..." tool
  // steps WITH the code that is currently being written inside them — the
  // user sees activity IMMEDIATELY and can click a step to watch the live
  // code. Finished blocks hand off to the real steps streamed by the route.
  const streamFileOps =
    streaming && streamedContent ? analyzeFileBlocks(streamedContent) : null;
  const streamRenderable = streaming
    ? getRenderableContent(streamedContent || "", { streaming: true })
    : "";
  const streamDisplaySteps: ToolStep[] = [
    ...liveToolSteps,
    ...(streamFileOps?.pending ?? []).map((op) => ({
      type: (op.isNew ? "new_file" : "file_edit") as ToolStep["type"],
      title: `${op.isNew ? "Creating" : "Editing"} file: ${op.name}...`,
      content: op.content || undefined,
    })),
  ];

  return (
    <div className="flex h-full w-full bg-background overflow-hidden relative">
      {toastMessage && (
        <div className={`fixed top-5 z-50 flex items-center gap-2 px-4 py-3 bg-emerald-600 text-white rounded-2xl shadow-xl transition-all duration-200 right-5`}>
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
        <div
          ref={scrollContainerRef}
          onScroll={handleMessagesScroll}
          onWheel={handleUserScrollIntent}
          onTouchStart={handleUserScrollIntent}
          className="fd-scroll flex-1 overflow-y-auto flex flex-col pt-4"
        >
          {messages.length === 0 && !streaming ? (
            <EmptyState agentName={agent?.name} onSuggestion={(s: string) => handleSend(s)} userName={userName} ready={profileLoaded} />
          ) : (
            <div className="w-full px-4 sm:px-6 py-5 space-y-6">
              {messages.map((msg, idx) => (
                <div key={msg.id} className="group relative">
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
                      {msg.role === "assistant" && (
                        idx === regenIndex && streaming
                          ? <ToolSteps steps={streamDisplaySteps} />
                          : <ToolSteps steps={msg.tool_steps} />
                      )}
                      <div className={`relative rounded-2xl px-4 py-3 text-sm leading-relaxed ${msg.role === "user" ? "bg-primary text-primary-foreground rounded-tl-sm rounded-tr-none" : "bg-card border border-border text-foreground rounded-tr-sm rounded-tl-none"}`}>
                        {msg.role === "user" ? (
                          <span dir="auto" className="whitespace-pre-wrap">{msg.content}</span>
                        ) : idx === regenIndex && streaming ? (
                          // ✅ In-place regeneration: live content renders HERE,
                          // in the message being regenerated (not at the bottom).
                          <>
                            {streamRenderable ? (
                              <MarkdownRenderer
                                content={streamRenderable}
                                streaming={true}
                              />
                            ) : (
                              <div className="py-1">
                                <ThinkingDots />
                              </div>
                            )}
                            {generatedImages.length > 0 && (
                              <div className="mt-3 space-y-3">
                                {generatedImages.map((img, i) => (
                                  <div key={i} className="relative group/img">
                                    <img src={img.url} alt={img.prompt} className="rounded-xl border border-border max-w-full h-auto" loading="lazy" />
                                  </div>
                                ))}
                              </div>
                            )}
                            <StreamingCursor />
                          </>
                        ) : (
                          <>
                            {/* ✅ Saved messages: stable key, streaming=false.
                                File-edit blocks and [QUICK_RESPONSE] lines are
                                storage markers — never shown as message text. */}
                            <MarkdownRenderer
                              key={msg.id}
                              content={getRenderableContent(msg.content)}
                            />

                            {/* Copy + Regenerate + Generation arrows on hover */}
                            <div className="absolute -bottom-7 start-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-2 pt-1 text-muted-foreground text-xs">
                              <button
                                onClick={() => handleCopyMessage(getRenderableContent(msg.content), msg.id)}
                                className="flex items-center gap-1 hover:text-foreground bg-card/80 backdrop-blur px-2 py-1 rounded-md border border-border shadow-xs transition-colors"
                                title={t("chat.copy")}
                              >
                                {copiedMessageId === msg.id ? (
                                  <>
                                    <Check size={13} className="text-emerald-500" />
                                    <span className="text-emerald-500 font-medium">{t("chat.copied")}</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy size={13} />
                                    <span>{t("chat.copy")}</span>
                                  </>
                                )}
                              </button>
                              <button
                                onClick={() => handleRetryMessage(idx)}
                                className="flex items-center gap-1 hover:text-foreground bg-card/80 backdrop-blur px-2 py-1 rounded-md border border-border shadow-xs transition-colors"
                                title={t("chat.regenerate")}
                                disabled={streaming}
                              >
                                <RotateCw size={13} />
                                <span>{t("chat.regenerate")}</span>
                              </button>
                              {/* ✅ Generation navigation: only shows when there's >1 generation */}
                              {msg.generations && msg.generations.length > 1 && (
                                <div className="flex items-center gap-1 bg-card/80 backdrop-blur px-1.5 py-1 rounded-md border border-border shadow-xs">
                                  <button
                                    onClick={() => handleSwitchGeneration(idx, -1)}
                                    disabled={(msg.current_generation ?? 0) === 0}
                                    className="hover:text-foreground disabled:opacity-30 transition-opacity"
                                    title="Previous version"
                                  >
                                    <ChevronLeft size={13} />
                                  </button>
                                  <span className="text-[11px] font-medium tabular-nums px-0.5">
                                    {(msg.current_generation ?? 0) + 1}/{msg.generations.length}
                                  </span>
                                  <button
                                    onClick={() => handleSwitchGeneration(idx, 1)}
                                    disabled={(msg.current_generation ?? 0) === msg.generations.length - 1}
                                    className="hover:text-foreground disabled:opacity-30 transition-opacity"
                                    title="Next version"
                                  >
                                    <ChevronRight size={13} />
                                  </button>
                                </div>
                              )}
                            </div>
                          </>
                        )}
                      </div>

                      {/* ✅ Quick Responses: model-suggested follow-up messages.
                          Only under the LAST assistant message, only when the
                          stream is idle (they disappear the moment a new
                          message is sent), max 3 — tapping one sends it.
                          Style: arrow rows stacked vertically (chat.z.ai-like). */}
                      {msg.role === "assistant" &&
                        idx === messages.length - 1 &&
                        !streaming &&
                        (() => {
                          const quickResponses = parseQuickResponses(msg.content);
                          if (quickResponses.length === 0) return null;
                          return (
                            <div className="flex flex-col items-stretch gap-0.5 pt-1.5">
                              {quickResponses.map((q, i) => (
                                <button
                                  key={i}
                                  dir="auto"
                                  onClick={() => handleSend(q)}
                                  className="group flex items-center gap-1.5 w-fit max-w-full text-start px-2 py-1 -mx-2 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-accent/70 transition-colors leading-relaxed"
                                >
                                  <ArrowRight
                                    size={13}
                                    className="shrink-0 text-primary/50 group-hover:text-primary group-hover:translate-x-0.5 rtl:rotate-180 transition-all"
                                  />
                                  <span className="truncate">{q}</span>
                                </button>
                              ))}
                            </div>
                          );
                        })()}
                    </div>
                    {msg.role === "user" && <UserAvatar size={28} src={userAvatar} alt={userName || "Profile"} className="mt-0.5" />}
                  </div>
                  {/* ✅ Regen anchor: keeps the growing message in view during in-place regeneration */}
                  {idx === regenIndex && streaming && <div ref={regenAnchorRef} className="h-px" />}
                </div>
              ))}

              {streaming && regenIndex === null && (
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
                    {/* ✅ Live tool steps during streaming — including pending
                        file ops detected client-side (appear instantly) */}
                    <ToolSteps steps={streamDisplaySteps} />

                    {streamRenderable ? (
                      <>
                        {/* ✅ streaming=true → re-parses markdown on each line boundary */}
                        <MarkdownRenderer
                          content={streamRenderable}
                          streaming={true}
                        />
                        {generatedImages.length > 0 && (
                          <div className="mt-3 space-y-3">
                            {generatedImages.map((img, i) => (
                              <div key={i} className="relative group/img">
                                <img src={img.url} alt={img.prompt} className="rounded-xl border border-border max-w-full h-auto" loading="lazy" />
                              </div>
                            ))}
                          </div>
                        )}
                        <StreamingCursor />
                      </>
                    ) : (
                      <div className="py-1">
                        <ThinkingDots />
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* ✅ Floating Input Bar — chat.z.ai style: a centered card floating
            over the conversation (no border-t wall, not stretched across the
            sidebar), with a soft gradient fading the messages behind it. */}
        <div className="shrink-0 relative px-4 sm:px-6 pb-4 pt-1">
          {/* Gradient fade over the bottom of the message list */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-14 bottom-0 bg-gradient-to-t from-background via-background/90 to-transparent" />
          <div className="relative w-full max-w-3xl mx-auto">
            <div className="rounded-3xl border border-border bg-card shadow-lg shadow-black/5 px-3 py-2 focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15 transition-all">
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
                    className="w-full resize-none overflow-y-auto bg-transparent text-sm leading-6 text-foreground focus:outline-none block relative z-10"
                    style={{ maxHeight: "200px", lineHeight: "24px", padding: 0 }}
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
                  {streaming ? (
                    <button
                      onClick={() => abort()}
                      className="p-2 rounded-xl shrink-0 self-end mb-1 bg-destructive text-destructive-foreground hover:opacity-90 shadow-sm transition-all flex items-center gap-1.5 text-xs font-medium"
                      title={t("chat.stopGeneration")}
                    >
                      <Square size={14} fill="currentColor" />
                      <span>{t("chat.stop")}</span>
                    </button>
                  ) : input.trim() ? (
                    <button
                      onClick={() => handleSend()}
                      className="p-2 rounded-xl shrink-0 self-end mb-1 bg-primary text-primary-foreground hover:opacity-90 shadow-sm transition-all"
                    >
                      <Send size={16} />
                    </button>
                  ) : (
                    <button
                      onClick={() => setIsVoiceChatOpen(true)}
                      className="p-2.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white transition-all shadow-sm shrink-0 self-end mb-1 flex items-center justify-center"
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
        title={t("chat.editChatName")}
        initialValue={editDialog.currentTitle}
        confirmText={t("common.save")}
        cancelText={t("common.cancel")}
        onConfirm={handleConfirmEditTitle}
        onCancel={() => setEditDialog({ isOpen: false, chatId: null, currentTitle: "" })}
      />

      <ConfirmDialog
        isOpen={deleteDialog.isOpen}
        title={t("chat.deleteTitle")}
        message={t("chat.deleteDescription")}
        confirmText={t("common.delete")}
        cancelText={t("common.cancel")}
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
