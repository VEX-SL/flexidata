"use client";

import { PanelLeftOpen, PanelLeftClose, MessageSquare, FileText, MessageSquarePlus, Globe, LayoutDashboard, FileCheck, Settings, User, LogOut, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { UserModal } from "./user-modal";

export interface AgentSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (page: string) => void;
  chats: Array<{ id: string; title: string | null; updated_at: string }>;
  selectedChatId: string | null;
  onSelectChat: (id: string | null) => void;
  onDeleteChat: (id: string) => void;
  onNewChat: () => void;
  agentId?: string;
  onBackToFiles?: (agentId: string) => void;
  userName?: string;
}

export function AgentSidebar({
  isOpen,
  onClose,
  onNavigate,
  chats,
  selectedChatId,
  onSelectChat,
  onDeleteChat,
  onNewChat,
  agentId,
  onBackToFiles,
  userName = "User Name",
}: AgentSidebarProps) {
  const { t } = useTranslation();
  const [isUserModalOpen, setUserModalOpen] = useState(false);

  return (
    <>
      {/* User Modal */}
      <UserModal
        isOpen={isUserModalOpen}
        onClose={() => setUserModalOpen(false)}
        onSettings={() => onNavigate("settings")}
        onLogout={() => {
          // TODO: Implement logout
          onClose();
        }}
      />

      {/* Sidebar */}
      <div
        className={`fixed left-0 top-0 h-full transition-all duration-200 border-r border-border ${isOpen ? "w-72" : "w-16"} bg-card overflow-hidden`}
      >
        {/* Toggle Button */}
        <button
          onClick={onClose}
          className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 bg-primary rounded-full flex items-center justify-center shadow-lg hover:bg-primary/90 transition-colors z-10"
        >
          {isOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
        </button>

        {/* Logo */}
        <div className="pt-4 pb-6 px-4 text-center border-b border-border">
          <button
            onClick={onClose}
            className="w-full flex items-center justify-center gap-3 py-3 px-4 rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 hover:from-primary/20 hover:to-primary/10 transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center shadow-lg">
              <MessageSquare size={20} className="text-white" />
            </div>
            <span className={`font-semibold text-foreground transition-all ${isOpen ? "opacity-100" : "opacity-0"}`}>
              FlexiData
            </span>
          </button>
        </div>

        {/* User Info */}
        <div
          onClick={() => setUserModalOpen(true)}
          className="p-4 cursor-pointer hover:bg-accent/30 transition-colors border-b border-border/50"
        >
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-accent to-accent/50 border-2 border-border flex items-center justify-center">
              <MessageSquare size={20} className="text-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className={`font-medium text-foreground truncate transition-all ${isOpen ? "opacity-100" : "opacity-0"}`}>
                {userName}
              </h3>
              <p className={`text-xs text-muted-foreground truncate transition-all ${isOpen ? "opacity-100" : "opacity-0"}`}>
                user@email.com
              </p>
            </div>
          </div>
        </div>

        {/* Navigation Items */}
        <nav className="p-2">
          {agentId && onBackToFiles && (
            <button
              onClick={() => onBackToFiles(agentId)}
              className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-all mb-1"
            >
              <FileText size={18} />
              <span className={`flex-1 text-xs font-medium transition-all ${isOpen ? "opacity-100" : "opacity-0"}`}>
                {t("agents.backToFiles") || "Back to Files"}
              </span>
            </button>
          )}

          <button
            onClick={() => onNavigate("new-chat")}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-all mb-1"
          >
            <MessageSquarePlus size={18} />
            <span className={`flex-1 text-xs font-medium transition-all ${isOpen ? "opacity-100" : "opacity-0"}`}>
              {t("nav.newChat") || "New Chat"}
            </span>
          </button>

          <div className="my-2 h-px bg-border/50" />

          <button
            onClick={() => onNavigate("browser-agent")}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-xl text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-all mb-1"
          >
            <Globe size={18} />
            <span className={`flex-1 text-xs font-medium transition-all ${isOpen ? "opacity-100" : "opacity-0"}`}>
              Browser Agent
            </span>
          </button>

          <button
            onClick={() => onNavigate("dashboard")}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-xl text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-all mb-1"
          >
            <LayoutDashboard size={18} />
            <span className={`flex-1 text-xs font-medium transition-all ${isOpen ? "opacity-100" : "opacity-0"}`}>
              Dashboard
            </span>
          </button>

          <button
            onClick={() => onNavigate("documents")}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-xl text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-all mb-1"
          >
            <FileCheck size={18} />
            <span className={`flex-1 text-xs font-medium transition-all ${isOpen ? "opacity-100" : "opacity-0"}`}>
              Documents
            </span>
          </button>

          <button
            onClick={() => onNavigate("chat")}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-xl text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-all mb-1"
          >
            <MessageSquare size={18} />
            <span className={`flex-1 text-xs font-medium transition-all ${isOpen ? "opacity-100" : "opacity-0"}`}>
              Chat
            </span>
          </button>

          <div className="my-2 h-px bg-border/50" />

          {/* Chat List */}
          <div className="px-3 py-2">
            <span className={`text-xs font-semibold text-muted-foreground mb-2 block transition-all ${isOpen ? "opacity-100" : "opacity-0"}`}>
              {t("sidebar.chats") || "Chats"}
            </span>

            {chats.length === 0 && (
              <div className="px-1">
                <p className={`text-xs text-muted-foreground/50 py-2 transition-all ${isOpen ? "opacity-100" : "opacity-0"}`}>
                  No conversations
                </p>
              </div>
            )}

            {chats.map((chat) => (
              <div
                key={chat.id}
                onClick={() => onSelectChat(chat.id)}
                className={`group relative flex items-center gap-2 px-3 py-2 rounded-xl text-sm cursor-pointer transition-all mb-1 ${selectedChatId === chat.id
                  ? "bg-primary/10 text-foreground border border-primary/15"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  }`}
              >
                <div
                  className={`w-1.5 h-1.5 rounded-full transition-colors ${selectedChatId === chat.id ? "bg-primary" : "bg-transparent"}`}
                />
                <span className={`flex-1 truncate transition-all ${isOpen ? "opacity-100" : "opacity-0"}`}>
                  {chat.title || t("nav.newChat") || "New Chat"}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteChat(chat.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                  aria-label="Delete chat"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        </nav>
      </div>
    </>
  );
}