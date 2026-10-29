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

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950">
        <Loader2 className="animate-spin text-cyan-400" size={32} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link
              href={`/agents/${agentId}/chat`}
              className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
              <span className="font-medium">Back to Chat</span>
            </Link>
            <h1 className="text-xl font-semibold text-white">Voice Chat</h1>
            <div className="w-20" /> {/* Spacer for centering */}
          </div>
        </div>
      </header>

      {/* Voice Chat Component - Full Screen */}
      <AudioChat onClose={() => window.history.back()} />
    </div>
  );
}