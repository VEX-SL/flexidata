"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
  MessageSquare,
  FileText,
  MessageSquarePlus,
  Globe,
  LayoutDashboard,
  FileCheck,
  Settings,
  LogOut,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
  Check,
  Circle,
  CheckCircle2,
  MoreVertical,
  Share2,
  Pin,
  Edit2
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { ConfirmDialog } from "@/components/confirm-dialog";

export interface ChatItem {
  id: string;
  title: string | null;
  updated_at: string;
  pinned?: boolean;
  pinned_at?: number | string;
}

export interface AgentSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onToggle?: () => void;
  onNavigate: (page: string) => void;
  chats: ChatItem[];
  selectedChatId: string | null;
  onSelectChat: (id: string | null) => void;
  onDeleteChat: (id: string) => void;
  onEditChatTitle: (id: string, currentTitle: string) => void;
  onTogglePin: (id: string) => void;
  onShareChat: (id: string, title: string) => void;
  onNewChat: () => void;
  onDeleteChats?: (ids: string[]) => Promise<void> | void;
  agentId?: string;
  onBackToFiles?: (agentId: string) => void;
  userName?: string;
  userEmail?: string;
  userAvatar?: string | null;
  onLogout?: () => void;
}

// ✅ Collapsed-sidebar quick-nav: one round icon button inside the floating
// rail that appears when hovering the middle strip. The label comes from
// i18n and doubles as the native tooltip (localized per language).
function RailIconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="w-9 h-9 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
    >
      {children}
    </button>
  );
}

export function AgentSidebar({
  isOpen,
  onClose,
  onToggle,
  onNavigate,
  chats,
  selectedChatId,
  onSelectChat,
  onDeleteChat,
  onEditChatTitle,
  onTogglePin,
  onShareChat,
  onNewChat,
  onDeleteChats,
  agentId,
  onBackToFiles,
  userName = "VEX",
  userEmail = "user@email.com",
  userAvatar,
  onLogout = () => { },
}: AgentSidebarProps) {
  const { t, lang } = useTranslation();
  const [isUserMenuOpen, setUserMenuOpen] = useState(false);
  const [isArabic, setIsArabic] = useState(true);
  const [isDark, setIsDark] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [activeMenuChatId, setActiveMenuChatId] = useState<string | null>(null);

  // Selection mode for the "Recent Chats" list: each row shows a rounded square
  // checkbox; clicking one selects it; "Select All" toggles all. When open,
  // the search toggle button becomes a red Trash2 button with a checkmark.
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const isSelected = (id: string) => selectedChatIds.includes(id);

  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const chatMenuRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    const checkSettings = () => {
      const dir = document.documentElement.getAttribute("dir");
      const lang = document.documentElement.getAttribute("lang");
      setIsArabic(dir === "rtl" || lang === "ar");

      const isHtmlDark = document.documentElement.classList.contains("dark");
      const isBodyDark = document.body.classList.contains("dark");
      const dataTheme = document.documentElement.getAttribute("data-theme") === "dark";
      const localTheme = localStorage.getItem("theme") === "dark";
      setIsDark(isHtmlDark || isBodyDark || dataTheme || localTheme);
    };

    checkSettings();
    const observer = new MutationObserver(checkSettings);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["dir", "lang", "class", "data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
      if (chatMenuRef.current && !chatMenuRef.current.contains(event.target as Node)) {
        setActiveMenuChatId(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (isSearching && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isSearching]);

  const safeChats = Array.isArray(chats) ? chats : [];

  const sortedChats = [...safeChats].sort((a, b) => {
    if (a.pinned && b.pinned) {
      return (Number(b.pinned_at) || 0) - (Number(a.pinned_at) || 0);
    }
    if (a.pinned) return -1;
    if (b.pinned) return 1;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  const filteredChats = sortedChats.filter((chat) =>
    (chat.title || t("nav.newChat")).toLowerCase().includes(searchQuery.toLowerCase())
  );

  const isAllSelected =
    filteredChats.length > 0 && selectedChatIds.length === filteredChats.length;

  const toggleSelectionMode = () => {
    setIsSelectionMode((prev) => {
      if (prev) setSelectedChatIds([]);
      return !prev;
    });
  };

  const toggleSelectAllMode = () => {
    const allIds = filteredChats.map((c) => c.id);
    if (!isSelectionMode) {
      setIsSelectionMode(true);
      setSelectedChatIds(allIds);
      return;
    }
    setSelectedChatIds((prev) => (prev.length === allIds.length ? [] : allIds));
  };

  const toggleChat = (id: string) => {
    setSelectedChatIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  // No selection → the button does nothing (no dialog, no request).
  const handleDeleteSelected = () => {
    if (selectedChatIds.length === 0) return;
    setConfirmDeleteOpen(true);
  };

  const confirmDeleteSelected = async () => {
    if (!onDeleteChats || selectedChatIds.length === 0) {
      setConfirmDeleteOpen(false);
      return;
    }
    await onDeleteChats(selectedChatIds);
    setSelectedChatIds([]);
    setIsSelectionMode(false);
    setConfirmDeleteOpen(false);
  };

  // ℹ️ The i18n helper only does simple {{key}} interpolation (no ICU plural
  // support), so the English plural "s" is appended in code.
  const deleteSelectedMessage = (() => {
    const count = selectedChatIds.length;
    const base = t("dashboard.deleteSelectedMessage", { count });
    return lang === "en" ? `${base}${count > 1 ? "s" : ""}?` : base;
  })();

  const logoSrc = isDark ? "/photos/auth-logo.png" : "/photos/whitebg.png";

  return (
    <>
      {/* ✅ Collapsed state — the sidebar disappears completely (no rail, no
          border lines, content takes the full width). Only the FlexiData
          logo floats at the top, unframed, inset a few px from the screen
          edge; clicking it re-opens the full sidebar. Hovering the strip
          below it reveals the mini navigation icons as a floating rail that
          slides in from the edge — ending with a Settings gear (the account
          picture only exists inside the OPEN sidebar). `start-*` keeps
          everything on the correct side in Arabic (RTL) vs English (LTR). */}
      {!isOpen && (
        <div
          dir={isArabic ? "rtl" : "ltr"}
          className="fixed inset-y-0 start-0 z-40 w-16 flex flex-col items-center pt-4 pb-4 pointer-events-none select-none animate-fade-in"
        >
          {/* Floating logo — nothing around it, click opens the full sidebar.
              Rendered larger than before so it reads as a proper app icon;
              the wider 64px strip gives it breathing room from the edge. */}
          <button
            onClick={() => onToggle?.()}
            title={t("common.brand")}
            aria-label={t("common.brand")}
            className="pointer-events-auto relative w-12 h-12 rounded-xl flex items-center justify-center hover:bg-accent/40 transition-colors"
          >
            <div className="relative w-10 h-10">
              <Image src={logoSrc} alt={t("common.brand")} fill className="object-contain rounded-lg" priority />
            </div>
          </button>

          {/* Hover zone → floating mini-icons rail (peek) */}
          <div className="relative flex-1 w-full group/peek pointer-events-auto">
            <nav
              aria-label={t("common.quickNav")}
              className={`absolute top-1/2 -translate-y-1/2 start-2 flex flex-col items-center gap-1 p-1.5 rounded-2xl border border-border/70 bg-card/95 backdrop-blur-xl shadow-2xl shadow-black/25 opacity-0 scale-95 pointer-events-none transition-all duration-200 group-hover/peek:opacity-100 group-hover/peek:scale-100 group-hover/peek:pointer-events-auto ${isArabic
                ? "translate-x-2 group-hover/peek:translate-x-0"
                : "-translate-x-2 group-hover/peek:translate-x-0"
                }`}
            >
              {agentId && onBackToFiles && (
                <RailIconButton title={t("agents.backToFiles")} onClick={() => onBackToFiles(agentId)}>
                  <FileText size={18} />
                </RailIconButton>
              )}
              <RailIconButton title={t("nav.newChat")} onClick={onNewChat}>
                <MessageSquarePlus size={18} />
              </RailIconButton>

              <div className="my-0.5 h-px w-6 bg-border/50" />

              <RailIconButton title={t("nav.browserAgent")} onClick={() => onNavigate("browser-agent")}>
                <Globe size={18} />
              </RailIconButton>
              <RailIconButton title={t("nav.dashboard")} onClick={() => onNavigate("dashboard")}>
                <LayoutDashboard size={18} />
              </RailIconButton>
              <RailIconButton title={t("nav.documents")} onClick={() => onNavigate("documents")}>
                <FileCheck size={18} />
              </RailIconButton>
              <RailIconButton title={t("nav.chat")} onClick={() => onNavigate("chat")}>
                <MessageSquare size={18} />
              </RailIconButton>

              <div className="my-0.5 h-px w-6 bg-border/50" />

              {/* ✅ Takes the account picture's place when the sidebar is
                  closed: a Settings gear, grouped with the other icons. */}
              <RailIconButton title={t("settings.title")} onClick={() => onNavigate("settings")}>
                <Settings size={18} />
              </RailIconButton>
            </nav>
          </div>
        </div>
      )}

      {/* ✅ Full sidebar — collapses to w-0 when closed (fully gone, no
          border line left behind). The inner block stays pinned at w-64 so
          the collapse animates as a slide-out instead of squashing, and
          fades out while shrinking. `border-e` (logical) puts the separator
          on the content side in BOTH directions — English (right edge) and
          Arabic (left edge, since the sidebar sits on the right). */}
      <aside
        aria-label={t("common.agentSidebar")}
        aria-hidden={!isOpen}
        inert={!isOpen}
        dir={isArabic ? "rtl" : "ltr"}
        className={`h-screen sticky top-0 flex flex-col flex-shrink-0 overflow-hidden z-30 bg-card/50 backdrop-blur-xl transition-[width] duration-200 ease-in-out ${isOpen ? "w-64 border-e border-border/60" : "w-0"
          }`}
      >
        <div className={`w-64 h-full flex flex-col transition-opacity duration-150 ${isOpen ? "opacity-100" : "opacity-0"}`}>
          <div className="h-16 border-b border-border/60 flex items-center justify-between px-3 gap-1 flex-shrink-0">
            <div
              className={`flex items-center gap-3 overflow-hidden cursor-pointer ${!isOpen ? "justify-center w-full" : ""}`}
              onClick={() => {
                if (!isOpen && onToggle) {
                  onToggle();
                } else {
                  router.push("/");
                }
              }}
            >
              <div className="relative w-7 h-7 shrink-0 flex items-center justify-center">
                <Image src={logoSrc} alt={t("common.brand")} fill className="object-contain rounded-lg" priority />
              </div>
              {isOpen && <span className="text-base font-bold tracking-tight text-foreground truncate">{t("common.brand")}</span>}
            </div>

            {isOpen && (
              <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/85 transition-colors shrink-0">
                {isArabic ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              </button>
            )}
          </div>

          <nav className="flex-1 px-2.5 py-3 space-y-1 overflow-y-auto fd-scroll">
            {agentId && onBackToFiles && (
              <button
                onClick={() => onBackToFiles(agentId)}
                className={`w-full group relative flex items-center gap-3 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ${!isOpen ? "px-0 py-2.5 justify-center" : "px-3 py-2.5"}`}
              >
                <FileText size={18} className="shrink-0" />
                {isOpen && <span className="truncate text-xs">{t("agents.backToFiles")}</span>}
              </button>
            )}

            <button
              onClick={onNewChat}
              className={`w-full group relative flex items-center gap-3 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ${!isOpen ? "px-0 py-2.5 justify-center" : "px-3 py-2.5"}`}
            >
              <MessageSquarePlus size={18} className="shrink-0" />
              {isOpen && <span className="truncate text-xs">{t("nav.newChat")}</span>}
            </button>

            <div className="my-2 h-px bg-border/40" />

            <button onClick={() => onNavigate("browser-agent")} className={`w-full group relative flex items-center gap-3 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ${!isOpen ? "px-0 py-2.5 justify-center" : "px-3 py-2.5"}`}>
              <Globe size={18} className="shrink-0" />
              {isOpen && <span className="truncate text-xs">{t("nav.browserAgent")}</span>}
            </button>

            <button onClick={() => onNavigate("dashboard")} className={`w-full group relative flex items-center gap-3 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ${!isOpen ? "px-0 py-2.5 justify-center" : "px-3 py-2.5"}`}>
              <LayoutDashboard size={18} className="shrink-0" />
              {isOpen && <span className="truncate text-xs">{t("nav.dashboard")}</span>}
            </button>

            <button onClick={() => onNavigate("documents")} className={`w-full group relative flex items-center gap-3 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ${!isOpen ? "px-0 py-2.5 justify-center" : "px-3 py-2.5"}`}>
              <FileCheck size={18} className="shrink-0" />
              {isOpen && <span className="truncate text-xs">{t("nav.documents")}</span>}
            </button>

            <button onClick={() => onNavigate("chat")} className={`w-full group relative flex items-center gap-3 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ${!isOpen ? "px-0 py-2.5 justify-center" : "px-3 py-2.5"}`}>
              <MessageSquare size={18} className="shrink-0" />
              {isOpen && <span className="truncate text-xs">{t("nav.chat")}</span>}
            </button>

            <div className="my-2 h-px bg-border/40" />

            {isOpen && (
              <div className="py-1 space-y-1">
                <div className="flex items-center justify-between px-3 mb-1">
                  {isSelectionMode ? (
                    /* Circle: toggles select-all / deselect-all */
                    <button
                      onClick={toggleSelectAllMode}
                      className="p-1 rounded-full text-muted-foreground hover:text-primary hover:bg-accent/60 transition-colors"
                      title={t("common.selectAll")}
                      aria-label={t("common.selectAll")}
                      aria-pressed={isAllSelected}
                    >
                      {isAllSelected ? (
                        <CheckCircle2 size={17} className="text-primary" />
                      ) : (
                        <Circle size={17} />
                      )}
                    </button>
                  ) : (
                    /* Normal state: plain "Recent Chats" text */
                    <button
                      onClick={toggleSelectionMode}
                      className="text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {t("dashboard.recentChats")}
                    </button>
                  )}
                  {isSelectionMode ? (
                    <div className="flex items-center gap-3">
                      {/* Red trash can — deletes the selected chats (nothing selected → no-op) */}
                      <button
                        onClick={handleDeleteSelected}
                        className="p-1.5 rounded-full bg-red-50 dark:bg-red-950/40 text-red-600 hover:bg-red-100 dark:hover:bg-red-900/40 hover:text-red-700 transition-colors"
                        title={t("common.delete")}
                        aria-label={t("common.delete")}
                      >
                        <Trash2 size={15} />
                      </button>
                      {/* Checkmark — confirm/exit without deleting anything */}
                      <button
                        onClick={toggleSelectionMode}
                        className="p-1.5 rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 hover:text-emerald-700 transition-colors"
                        title={t("common.confirm")}
                        aria-label={t("common.confirm")}
                      >
                        <Check size={15} strokeWidth={3} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setIsSearching(!isSearching);
                        if (isSearching) setSearchQuery("");
                      }}
                      className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    >
                      {isSearching ? <X size={13} /> : <Search size={13} />}
                    </button>
                  )}
                </div>

                {isSearching && (
                  <div className="px-2 mb-2">
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder={t("chat.searchChats")}
                      className="w-full px-2.5 py-1 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                )}

                {filteredChats.map((chat) => (
                  <div
                    key={chat.id}
                    onClick={isSelectionMode ? () => toggleChat(chat.id) : () => onSelectChat(chat.id)}
                    className={`group relative flex items-center gap-2 px-3 py-2 rounded-xl text-sm cursor-pointer transition-colors ${selectedChatId === chat.id
                      ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                      }`}
                  >
                    {isSelectionMode && (
                      <span
                        className={`grid place-items-center w-5 h-5 rounded-[6px] border shrink-0 transition-colors ${isSelected(chat.id)
                          ? "bg-primary border-primary"
                          : "border-border bg-background"
                          }`}
                      >
                        {isSelected(chat.id) && <Check size={12} className="text-primary-foreground" strokeWidth={3} />}
                      </span>
                    )}

                    {chat.pinned && (
                      <Pin size={12} className={`shrink-0 ${selectedChatId === chat.id ? "text-primary-foreground" : "text-primary fill-primary"}`} />
                    )}

                    <span className="flex-1 text-xs truncate">
                      {chat.title || t("nav.newChat")}
                    </span>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveMenuChatId(activeMenuChatId === chat.id ? null : chat.id);
                      }}
                      className={`p-1 rounded-md text-muted-foreground hover:text-foreground transition-all shrink-0 ${activeMenuChatId === chat.id ? "opacity-100 bg-accent" : "opacity-0 group-hover:opacity-100 hover:bg-accent/80"
                        }`}
                    >
                      <MoreVertical size={14} />
                    </button>

                    {activeMenuChatId === chat.id && (
                      <div
                        ref={chatMenuRef}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute top-full end-2 mt-1 w-44 bg-card border border-border rounded-xl shadow-xl py-1 z-50 text-foreground animate-in fade-in zoom-in-95 duration-100"
                      >
                        <button
                          onClick={() => {
                            setActiveMenuChatId(null);
                            onShareChat(chat.id, chat.title || t("nav.newChat"));
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-start"
                        >
                          <Share2 size={13} />
                          {t("chat.shareChat")}
                        </button>

                        <button
                          onClick={() => {
                            setActiveMenuChatId(null);
                            onTogglePin(chat.id);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-start"
                        >
                          <Pin size={13} />
                          {chat.pinned ? t("chat.unpin") : t("chat.pin")}
                        </button>

                        <button
                          onClick={() => {
                            setActiveMenuChatId(null);
                            onEditChatTitle(chat.id, chat.title || t("nav.newChat"));
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-start"
                        >
                          <Edit2 size={13} />
                          {t("common.edit")}
                        </button>

                        <div className="my-1 h-px bg-border/60" />

                        <button
                          onClick={() => {
                            setActiveMenuChatId(null);
                            onDeleteChat(chat.id);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors text-start font-medium"
                        >
                          <Trash2 size={13} />
                          {t("common.delete")}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </nav>

          {/* User Menu / Profile at the bottom */}
          <div className="mt-auto p-3 border-t border-border/60 relative shrink-0" ref={menuRef}>
            {isUserMenuOpen && (
              <div className="absolute bottom-full start-2 end-2 mb-1 bg-card border border-border rounded-xl shadow-xl overflow-hidden py-1 z-50 animate-in fade-in zoom-in-95 duration-100">
                <button
                  onClick={() => { setUserMenuOpen(false); router.push("/settings"); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-start"
                >
                  <Settings size={14} />
                  {t("nav.settings")}
                </button>
                <div className="my-1 h-px bg-border/60" />
                <button
                  onClick={() => { setUserMenuOpen(false); onLogout(); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-destructive hover:bg-destructive/10 transition-colors text-start font-medium"
                >
                  <LogOut size={14} />
                  {t("nav.signOut")}
                </button>
              </div>
            )}
            <button
              onClick={() => setUserMenuOpen(!isUserMenuOpen)}
              className={`w-full flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-accent/60 ${!isOpen ? "justify-center" : ""}`}
            >
              <div className="relative w-8 h-8 rounded-full overflow-hidden shrink-0 bg-primary/10 flex items-center justify-center text-primary font-bold">
                {userAvatar ? (
                  <Image src={userAvatar} alt={userName} fill className="object-cover" />
                ) : (
                  (userName?.[0] || "U").toUpperCase()
                )}
              </div>
              {isOpen && (
                <div className="flex-1 min-w-0 text-start">
                  <p className="text-xs font-semibold text-foreground truncate">{userName}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{userEmail}</p>
                </div>
              )}
            </button>
          </div>
        </div>
      </aside>

      {onDeleteChats && (
        <ConfirmDialog
          isOpen={confirmDeleteOpen}
          title={t("dashboard.deleteChatsTitle")}
          message={deleteSelectedMessage}
          confirmText={t("common.delete")}
          cancelText={t("common.cancel")}
          onConfirm={confirmDeleteSelected}
          onCancel={() => setConfirmDeleteOpen(false)}
          type="danger"
        />
      )}
    </>
  );
}