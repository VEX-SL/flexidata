"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import AudioChat from "@/components/chat/audio-chat";
import { Loader2, ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function AgentVoiceChatPage() {
  const params = useParams();
  const agentId = Array.isArray(params.id) ? params.id[0] : params.id;
  const [mounted, setMounted] = useState(false);
  // chatId المشترك بين الشات الصوتي والنصي — لو مش موجود مفيش حفظ/مزامنة
  const [chatId, setChatId] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // جيب أو أنشئ شات للوكيل (نفس الشات اللي بيفتح في الشات النصي)
  useEffect(() => {
    if (!agentId) return;

    fetch(`/api/agents/${agentId}/voice-session`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d?.chatId) setChatId(d.chatId);
      })
      .catch(() => {
        // لو فشل (مثلًا مش مسجل دخول)، نكمل من غير حفظ بدل ما نعلق الصفحة
      })
      .finally(() => setSessionReady(true));
  }, [agentId]);

  if (!mounted || !sessionReady) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="animate-spin text-cyan-400" size={32} />
          <p className="text-slate-400 text-sm">Loading Voice Chat...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col relative overflow-hidden">
      {/* Animated Background */}
      <div className="fixed inset-0 -z-10 overflow-hidden">
        {/* Gradient Orbs */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-gradient-to-br from-cyan-500/10 to-transparent rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-gradient-to-br from-pink-500/10 to-transparent rounded-full blur-3xl animate-pulse delay-1000" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-72 h-72 bg-gradient-to-br from-amber-500/5 to-transparent rounded-full blur-3xl animate-pulse delay-2000" />

        {/* Grid Pattern */}
        <div className="absolute inset-0 bg-[url('data:image/svg+xml,%3Csvg width=%2260%22 height=%2260%22 viewBox=%220 0 60 60%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cg fill=%22none%22 fill-rule=%22evenodd%22%3E%3Cg fill=%22%2322d3ee%22 fill-opacity=%220.02%22%3E%3Cpath d=%22M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z%22/%3E%3C/g%3E%3C/g%3E%3C/svg%3E')] opacity-50" />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-slate-800/50 bg-slate-900/60 backdrop-blur-xl sticky top-0">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link
              href={`/agents/${agentId}/chat`}
              className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors group"
            >
              <ArrowLeft className="w-5 h-5 transition-transform group-hover:-translate-x-1" />
              <span className="font-medium text-sm hidden sm:inline">Back to Chat</span>
            </Link>

            <div className="flex items-center gap-3">
              {/* Connection Status */}
              <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800/50 border border-slate-700/50">
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-xs font-medium text-slate-300">Connected</span>
              </div>

              {/* Time */}
              <time className="text-xs text-slate-500 font-mono tabular-nums hidden sm:block" id="current-time">
                --:--
              </time>
            </div>
          </div>
        </div>

        {/* Subtle divider glow */}
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-full max-w-4xl h-px bg-gradient-to-r from-transparent via-cyan-400/20 to-transparent" />
      </header>

      {/* Voice Chat Component - Full Screen */}
      <main className="flex-1 relative z-10">
        <AudioChat onClose={() => window.history.back()} agentId={agentId} chatId={chatId ?? undefined} />
      </main>

      {/* Update time */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function() {
              function updateTime() {
                const el = document.getElementById('current-time');
                if (el) {
                  el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                }
              }
              updateTime();
              setInterval(updateTime, 1000);
            })();
          `,
        }}
      />
    </div>
  );
}