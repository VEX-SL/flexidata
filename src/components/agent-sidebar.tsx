"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
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
  onLogout = () => {},
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

  // ─── منطق الترتيب المطلوب ───
  // 1. المثبتون في الأعلى ولا يتغير ترتيبهم بنشاط الرسائل (مرتبون بثابت pinned_at)
  // 2. الغير مثبتين أسفل المثبتين ومرتبون حسب آخر شات تم الإرسال فيه (updated_at)
  const sortedChats = [...safeChats].sort((a, b) => {
    if (a.pinned && b.pinned) {
      return (Number(b.pinned_at) || 0) - (Number(a.pinned_at) || 0);
    }
    if (a.pinned) return -1;
    if (b.pinned) return 1;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  const filteredChats = sortedChats.filter((chat) => 
    (chat.title || "New Chat").toLowerCase().includes(searchQuery.toLowerCase())
  );

  const logoSrc = isDark ? "/photos/auth-logo.png" : "/photos/whitebg.png";

  return (
    <aside
      aria-label="Agent Sidebar"
      dir={isArabic ? "rtl" : "ltr"}
      className={`h-screen sticky top-0 flex flex-col border-r border-border/60 bg-card/50 backdrop-blur-xl transition-[width] duration-200 ease-in-out flex-shrink-0 z-30 overflow-hidden ${
        isOpen ? "w-64" : "w-16"
      }`}
    >
      {/* Header & Logo */}
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

      {/* Navigation */}
      <nav className="flex-1 px-2.5 py-3 space-y-1 overflow-y-auto fd-scroll">
        {agentId && onBackToFiles && (
          <button
            onClick={() => onBackToFiles(agentId)}
            className={`w-full group relative flex items-center gap-3 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ${!isOpen ? "px-0 py-2.5 justify-center" : "px-3 py-2.5"}`}
          >
            <FileText size={18} className="shrink-0" />
            {isOpen && <span className="truncate text-xs">{t("agents.backToFiles") || "Back to Files"}</span>}
          </button>
        )}

        <button
          onClick={onNewChat}
          className={`w-full group relative flex items-center gap-3 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ${!isOpen ? "px-0 py-2.5 justify-center" : "px-3 py-2.5"}`}
        >
          <MessageSquarePlus size={18} className="shrink-0" />
          {isOpen && <span className="truncate text-xs">{t("nav.newChat") || "New Chat"}</span>}
        </button>

        <div className="my-2 h-px bg-border/40" />

        <button onClick={() => onNavigate("browser-agent")} className={`w-full group relative flex items-center gap-3 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ${!isOpen ? "px-0 py-2.5 justify-center" : "px-3 py-2.5"}`}>
          <Globe size={18} className="shrink-0" />
          {isOpen && <span className="truncate text-xs">Browser Agent</span>}
        </button>

        <button onClick={() => onNavigate("dashboard")} className={`w-full group relative flex items-center gap-3 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ${!isOpen ? "px-0 py-2.5 justify-center" : "px-3 py-2.5"}`}>
          <LayoutDashboard size={18} className="shrink-0" />
          {isOpen && <span className="truncate text-xs">Dashboard</span>}
        </button>

        <button onClick={() => onNavigate("documents")} className={`w-full group relative flex items-center gap-3 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ${!isOpen ? "px-0 py-2.5 justify-center" : "px-3 py-2.5"}`}>
          <FileCheck size={18} className="shrink-0" />
          {isOpen && <span className="truncate text-xs">Documents</span>}
        </button>

        <button onClick={() => onNavigate("chat")} className={`w-full group relative flex items-center gap-3 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ${!isOpen ? "px-0 py-2.5 justify-center" : "px-3 py-2.5"}`}>
          <MessageSquare size={18} className="shrink-0" />
          {isOpen && <span className="truncate text-xs">Chat</span>}
        </button>

        <div className="my-2 h-px bg-border/40" />

        {/* Chats List */}
        {isOpen && (
          <div className="py-1 space-y-1">
            <div className="flex items-center justify-between px-3 mb-1">
              <span className="text-[11px] font-semibold text-muted-foreground">Chats</span>
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
                  placeholder="Search chats..."
                  className="w-full px-2.5 py-1 text-xs rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            )}

            {filteredChats.map((chat) => (
              <div
                key={chat.id}
                onClick={() => onSelectChat(chat.id)}
                className={`group relative flex items-center gap-2 px-3 py-2 rounded-xl text-sm cursor-pointer transition-colors ${
                  selectedChatId === chat.id
                    ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                }`}
              >
                {chat.pinned && (
                  <Pin size={12} className={`shrink-0 ${selectedChatId === chat.id ? "text-primary-foreground" : "text-primary fill-primary"}`} />
                )}

                <span className="flex-1 text-xs truncate">
                  {chat.title || "New Chat"}
                </span>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveMenuChatId(activeMenuChatId === chat.id ? null : chat.id);
                  }}
                  className={`p-1 rounded-md text-muted-foreground hover:text-foreground transition-all shrink-0 ${
                    activeMenuChatId === chat.id ? "opacity-100 bg-accent" : "opacity-0 group-hover:opacity-100 hover:bg-accent/80"
                  }`}
                >
                  <MoreVertical size={14} />
                </button>

                {activeMenuChatId === chat.id && (
                  <div
                    ref={chatMenuRef}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute top-full right-2 mt-1 w-44 bg-card border border-border rounded-xl shadow-xl py-1 z-50 text-foreground animate-in fade-in zoom-in-95 duration-100"
                  >
                    <button
                      onClick={() => {
                        setActiveMenuChatId(null);
                        onShareChat(chat.id, chat.title || "New Chat");
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-left"
                    >
                      <Share2 size={13} />
                      Share Chat
                    </button>

                    <button
                      onClick={() => {
                        setActiveMenuChatId(null);
                        onTogglePin(chat.id);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-left"
                    >
                      <Pin size={13} />
                      {chat.pinned ? "Unpin Chat" : "Pin"}
                    </button>

                    <button
                      onClick={() => {
                        setActiveMenuChatId(null);
                        onEditChatTitle(chat.id, chat.title || "New Chat");
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-left"
                    >
                      <Edit2 size={13} />
                      Edit Chat Name
                    </button>

                    <div className="my-1 h-px bg-border/60" />

                    <button
                      onClick={() => {
                        setActiveMenuChatId(null);
                        onDeleteChat(chat.id);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors text-left"
                    >
                      <Trash2 size={13} />
                      Delete Chat
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </nav>

      {/* User Profile Section */}
      <div className="p-2.5 border-t border-border/60 bg-muted/20 relative flex-shrink-0" ref={menuRef}>
        <div 
          className={`absolute bottom-full left-3 right-3 mb-2 bg-card border border-border rounded-2xl shadow-2xl p-3 z-50 transition-all duration-200 ease-out origin-bottom ${
            isUserMenuOpen && isOpen
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

          <div className="flex items-center justify-between p-2 mb-2 rounded-xl bg-accent/50 border border-border/60">
            <div>
              <span className="text-[11px] font-bold text-foreground block">Free Plan</span>
              <span className="text-[9px] text-muted-foreground">Standard Features</span>
            </div>
            <button 
              onClick={() => { setUserMenuOpen(false); router.push("/settings"); }}
              className="px-2 py-1 text-[11px] font-semibold bg-primary text-primary-foreground rounded-lg hover:opacity-95 transition-opacity"
            >
              Upgrade
            </button>
          </div>

          <div className="space-y-1">
            <button
              onClick={() => {
                setUserMenuOpen(false);
                router.push("/settings");
              }}
              className="flex items-center gap-2 w-full px-2.5 py-2 rounded-xl text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-left"
            >
              <Settings size={14} />
              {t("settings.title") || "Settings"}
            </button>

            <button
              onClick={() => {
                setUserMenuOpen(false);
                onLogout();
              }}
              className="flex items-center gap-2 w-full px-2.5 py-2 rounded-xl text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors text-left"
            >
              <LogOut size={14} />
              {t("nav.signOut") || "Sign out"}
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
          className={`w-full flex items-center gap-3 rounded-xl transition-colors text-left overflow-hidden ${
            !isOpen ? "px-0 py-2 justify-center" : "p-2 hover:bg-accent/60"
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
              <p className="text-[10px] text-muted-foreground truncate">Free Plan</p>
            </div>
          )}
        </button>
      </div>
    </aside>
  );
}

export default AgentSidebar;