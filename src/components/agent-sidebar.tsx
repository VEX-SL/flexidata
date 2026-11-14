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
  MoreVertical,
  Share2,
  Pin,
  Edit2
} from "lucide-react";
import { useTranslation } from "@/lib/i18n";

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
  agentId,
  onBackToFiles,
  userName = "VEX",
  userEmail = "user@email.com",
  userAvatar,
  onLogout = () => { },
}: AgentSidebarProps) {
  const { t } = useTranslation();
  const [isUserMenuOpen, setUserMenuOpen] = useState(false);
  const [isArabic, setIsArabic] = useState(true);
  const [isDark, setIsDark] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [activeMenuChatId, setActiveMenuChatId] = useState<string | null>(null);

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
    (chat.title || t("dashboard.noChats") || "New Chat").toLowerCase().includes(searchQuery.toLowerCase())
  );

  const logoSrc = isDark ? "/photos/auth-logo.png" : "/photos/whitebg.png";

  return (
    <>
      {/* ✅ Collapsed state — the sidebar disappears completely (no rail, no
          border lines, content takes the full width). Only the logo (top)
          and the account picture (bottom) float in its place, unframed.
          Clicking either one re-opens the full sidebar. Hovering the MIDDLE
          strip (between logo and picture) reveals the mini navigation icons
          as a floating rail that slides in from the edge. `start-*` keeps
          everything on the correct side in Arabic (RTL) vs English (LTR). */}
      {!isOpen && (
        <div
          dir={isArabic ? "rtl" : "ltr"}
          className="fixed inset-y-0 start-0 z-40 w-12 flex flex-col items-center pt-4 pointer-events-none select-none animate-fade-in"
          // The page publishes its input-bar height as --fd-input-h (see the
          // chat page), so the floating picture and the hover rail sit just
          // ABOVE the message input instead of covering it — even when the
          // textarea grows with a long message. Defaults to 0 on pages
          // without an input bar.
          style={{ paddingBottom: "calc(var(--fd-input-h, 0px) + 1rem)" }}
        >
          {/* Floating logo — nothing around it, click opens the full sidebar */}
          <button
            onClick={() => onToggle?.()}
            title="FlexiData"
            aria-label="FlexiData"
            className="pointer-events-auto relative w-9 h-9 rounded-xl flex items-center justify-center hover:bg-accent/40 transition-colors"
          >
            <div className="relative w-7 h-7">
              <Image src={logoSrc} alt="FlexiData" fill className="object-contain rounded-lg" priority />
            </div>
          </button>

          {/* Middle hover zone → floating mini-icons rail (peek) */}
          <div className="relative flex-1 w-full group/peek pointer-events-auto">
            <nav
              aria-label="Quick navigation"
              className={`absolute top-1/2 -translate-y-1/2 start-0.5 flex flex-col items-center gap-1 p-1.5 rounded-2xl border border-border/70 bg-card/95 backdrop-blur-xl shadow-2xl shadow-black/25 opacity-0 scale-95 pointer-events-none transition-all duration-200 group-hover/peek:opacity-100 group-hover/peek:scale-100 group-hover/peek:pointer-events-auto ${isArabic
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

              <RailIconButton title={t("nav.browserAgent") || "Browser Agent"} onClick={() => onNavigate("browser-agent")}>
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
            </nav>
          </div>

          {/* Floating account picture — nothing around it, click opens the full sidebar */}
          <button
            onClick={() => onToggle?.()}
            title={userName}
            aria-label={userName}
            className="pointer-events-auto w-8 h-8 rounded-full overflow-hidden flex items-center justify-center transition-transform duration-150 hover:scale-105"
          >
            {userAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src="/api/profile" alt={userName} className="w-full h-full object-cover" />
            ) : (
              <span className="w-full h-full rounded-full bg-gradient-to-br from-accent to-accent/50 flex items-center justify-center text-xs font-bold text-foreground">
                {userName?.charAt(0)?.toUpperCase() || "V"}
              </span>
            )}
          </button>
        </div>
      )}

      {/* ✅ Full sidebar — collapses to w-0 when closed (fully gone, no
          border line left behind). The inner block stays pinned at w-64 so
          the collapse animates as a slide-out instead of squashing, and
          fades out while shrinking. `border-e` (logical) puts the separator
          on the content side in BOTH directions — English (right edge) and
          Arabic (left edge, since the sidebar sits on the right). */}
      <aside
        aria-label="Agent Sidebar"
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
                <Image src={logoSrc} alt="Logo" fill className="object-contain rounded-lg" priority />
              </div>
              {isOpen && <span className="text-base font-bold tracking-tight text-foreground truncate">FlexiData</span>}
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
              {isOpen && <span className="truncate text-xs">{t("nav.browserAgent") || "Browser Agent"}</span>}
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
                  <span className="text-[11px] font-semibold text-muted-foreground">{t("dashboard.recentChats") || "Chats"}</span>
                  <button
                    onClick={() => {
                      setIsSearching(!isSearching);
                      if (isSearching) setSearchQuery("");
                    }}
                    className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    {isSearching ? <X size={13} /> : <Search size={13} />}
                  </button>
                </div>

                {isSearching && (
                  <div className="px-2 mb-2">
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder={t("dashboard.searchPlaceholder") || "Search chats..."}
                      className="w-full px-2.5 py-1 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                )}

                {filteredChats.map((chat) => (
                  <div
                    key={chat.id}
                    onClick={() => onSelectChat(chat.id)}
                    className={`group relative flex items-center gap-2 px-3 py-2 rounded-xl text-sm cursor-pointer transition-colors ${selectedChatId === chat.id
                      ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                      }`}
                  >
                    {chat.pinned && (
                      <Pin size={12} className={`shrink-0 ${selectedChatId === chat.id ? "text-primary-foreground" : "text-primary fill-primary"}`} />
                    )}

                    <span className="flex-1 text-xs truncate">
                      {chat.title || t("dashboard.noChats") || "New Chat"}
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
                            onShareChat(chat.id, chat.title || "New Chat");
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-start"
                        >
                          <Share2 size={13} />
                          {t("common.confirm") || "Share"}
                        </button>

                        <button
                          onClick={() => {
                            setActiveMenuChatId(null);
                            onTogglePin(chat.id);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-start"
                        >
                          <Pin size={13} />
                          {chat.pinned ? (t("chat.unpin") || "Unpin") : (t("chat.pin") || "Pin")}
                        </button>

                        <button
                          onClick={() => {
                            setActiveMenuChatId(null);
                            onEditChatTitle(chat.id, chat.title || "New Chat");
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-start"
                        >
                          <Edit2 size={13} />
                          {t("documents.edit")}
                        </button>

                        <div className="my-1 h-px bg-border/60" />

                        <button
                          onClick={() => {
                            setActiveMenuChatId(null);
                            onDeleteChat(chat.id);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors text-start"
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

          <div className="p-2.5 border-t border-border/60 bg-muted/20 relative flex-shrink-0" ref={menuRef}>
            <div
              className={`absolute bottom-full left-3 right-3 mb-2 bg-card border border-border rounded-2xl shadow-2xl p-3 z-50 transition-all duration-200 ease-out origin-bottom ${isUserMenuOpen && isOpen
                ? "opacity-100 scale-100 translate-y-0 pointer-events-auto"
                : "opacity-0 scale-95 translate-y-2 pointer-events-none"
                }`}
            >
              <div className="flex items-center gap-3 pb-3 border-b border-border mb-2">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 flex items-center justify-center overflow-hidden shrink-0">
                  {userAvatar ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src="/api/profile" alt={userName} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-sm font-bold text-primary">{userName?.charAt(0)?.toUpperCase() || "V"}</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-xs font-semibold text-foreground truncate">{userName}</h4>
                  <p className="text-[11px] text-muted-foreground truncate">{userEmail}</p>
                </div>
              </div>

              <div className="space-y-1">
                <button
                  onClick={() => {
                    setUserMenuOpen(false);
                    router.push("/settings");
                  }}
                  className="flex items-center gap-2 w-full px-2.5 py-2 rounded-xl text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-start"
                >
                  <Settings size={14} />
                  {t("settings.title")}
                </button>

                <button
                  onClick={() => {
                    setUserMenuOpen(false);
                    onLogout();
                  }}
                  className="flex items-center gap-2 w-full px-2.5 py-2 rounded-xl text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors text-start"
                >
                  <LogOut size={14} />
                  {t("nav.signOut")}
                </button>
              </div>
            </div>

            <button
              onClick={() => {
                if (!isOpen) {
                  if (onToggle) onToggle();
                } else {
                  setUserMenuOpen(!isUserMenuOpen);
                }
              }}
              className={`w-full flex items-center gap-3 rounded-xl transition-colors text-start overflow-hidden ${!isOpen ? "px-0 py-2 justify-center" : "p-2 hover:bg-accent/60"
                }`}
              title={!isOpen ? userName : undefined}
            >
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-accent to-accent/50 border border-border flex items-center justify-center shrink-0 overflow-hidden">
                {userAvatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src="/api/profile" alt={userName} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-xs font-bold text-foreground">{userName?.charAt(0)?.toUpperCase() || "V"}</span>
                )}
              </div>
              {isOpen && (
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-foreground text-xs truncate">{userName}</h3>
                  <p className="text-[10px] text-muted-foreground truncate">{t("sidebar.freePlan") || "Free Plan"}</p>
                </div>
              )}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

export default AgentSidebar;
