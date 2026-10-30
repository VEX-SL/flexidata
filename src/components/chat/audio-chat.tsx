'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import VoicePipeline from '@/lib/voice/voice-pipeline';
import { X, Mic, Volume2, Loader2, Send, Trash2, Minimize2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/lib/i18n';

interface VoiceMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  isInterim?: boolean;
}

const AudioChat = ({ onClose, chatId, agentId }: { onClose: () => void; chatId?: string; agentId?: string }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'ERROR'>('IDLE');
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const [interimTranscript, setInterimTranscript] = useState<string>('');
  const [isMinimized, setIsMinimized] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [sttSupported, setSttSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const voicePipelineRef = useRef<VoicePipeline | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, interimTranscript]);

  useEffect(() => {
    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setSttSupported(false);
    }

    voicePipelineRef.current = new VoicePipeline({
      chatId,
      agentId,
      onStateChange: (newState) => {
        setState(newState);
        if (newState === 'IDLE') {
          setInterimTranscript('');
          setError(null);
        }
      },
      onInterimTranscript: (transcript: string) => {
        setInterimTranscript(transcript);
      },
      onTranscript: (transcript: string) => {
        const newMessage: VoiceMessage = {
          id: `user-${Date.now()}`,
          role: 'user',
          content: transcript,
          timestamp: new Date(),
        };
        setMessages(prev => [...prev, newMessage]);
        setInterimTranscript('');
        setTextInput('');
      },
      onAIResponse: (chunk: string) => {
        setMessages(prev => [...prev, {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: chunk,
          timestamp: new Date(),
          isInterim: false,
        }]);
      },
      onError: (err: string) => {
        setError(err);
        setState('ERROR');
      },
    });

    return () => {
      if (voicePipelineRef.current) {
        voicePipelineRef.current.dispose();
        voicePipelineRef.current = null;
      }
    };
  }, [chatId, agentId]);

  const handleStartListening = useCallback(() => {
    voicePipelineRef.current?.start();
  }, []);

  const handleStopListening = useCallback(() => {
    voicePipelineRef.current?.stop();
  }, []);

  const handleClearChat = useCallback(() => {
    setMessages([]);
    voicePipelineRef.current?.clearHistory();
  }, []);

  const handleSendText = useCallback((text: string) => {
    if (!text.trim() || !voicePipelineRef.current) return;
    voicePipelineRef.current.sendText(text);
    setTextInput('');
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendText(textInput);
    }
  }, [textInput, handleSendText]);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const getStateLabel = () => {
    switch (state) {
      case 'LISTENING': return t('voiceChat.listening');
      case 'PROCESSING': return t('voiceChat.processing');
      case 'SPEAKING': return t('voiceChat.speaking');
      default: return t('voiceChat.ready');
    }
  };

  if (!sttSupported) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-slate-900/95 border border-slate-700 rounded-2xl max-w-md w-full p-8 text-center">
          <h3 className="text-xl font-semibold text-white mb-2">{t('voiceChat.error')}</h3>
          <p className="text-slate-400 mb-6">{t('voiceChat.sttNotSupported')}</p>
          <button onClick={onClose} className="px-6 py-3 rounded-xl bg-blue-600 text-white font-medium">
            {t('common.back')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col" role="dialog" aria-modal="true">
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div className="flex-1 flex flex-col max-w-3xl w-full mx-auto my-auto relative z-10">
        <div className="flex items-center justify-between p-4 bg-slate-900/80 border-b border-slate-800/50 rounded-t-2xl">
          <div className="flex items-center gap-3">
            <div className="relative p-2.5 rounded-xl bg-cyan-500/15 border border-cyan-400/20">
              <Sparkles className="w-7 h-7 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">{t('voiceChat.title')}</h2>
              <p className="text-xs text-slate-400">{getStateLabel()}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setIsMinimized(true)} className="p-2 text-slate-400 hover:text-white">
              <Minimize2 className="w-5 h-5" />
            </button>
            <button onClick={onClose} className="p-2 text-slate-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 bg-slate-950/50">
          {messages.map((msg) => (
            <div key={msg.id} className={cn('flex gap-3', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
              {msg.role === 'assistant' && (
                <div className="w-9 h-9 rounded-full bg-rose-600 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Volume2 className="w-4.5 h-4.5 text-white" />
                </div>
              )}
              <div className={cn('max-w-[85%]', msg.role === 'user' ? 'text-right' : 'text-left')}>
                <div className={cn(
                  'rounded-2xl px-4 py-3.5 text-sm leading-relaxed',
                  msg.role === 'user' ? 'bg-cyan-600/30 border border-cyan-400/30 text-white rounded-br-none' : 'bg-slate-800/60 text-slate-100 rounded-bl-none'
                )}>
                  <p className="whitespace-pre-wrap break-words" dir="auto">{msg.content}</p>
                </div>
                <span className="text-xs text-slate-500 mt-1.5 block">{formatTime(msg.timestamp)}</span>
              </div>
            </div>
          ))}

          {interimTranscript && state === 'LISTENING' && (
            <div className="flex justify-end">
              <div className="max-w-[85%] text-right">
                <div className="rounded-2xl bg-cyan-500/10 border border-cyan-400/40 text-cyan-300 px-4 py-3 text-sm rounded-br-none animate-pulse">
                  <p dir="auto">{interimTranscript}</p>
                </div>
              </div>
            </div>
          )}

          {state === 'PROCESSING' && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2.5 px-4 py-3 bg-slate-800/60 rounded-2xl rounded-bl-none">
                <Loader2 className="w-4.5 h-4.5 text-amber-400 animate-spin" />
                <span className="text-sm text-slate-300">{t('voiceChat.thinkingNow')}</span>
              </div>
            </div>
          )}

          {error && (
            <div className="flex justify-center">
              <div className="bg-red-500/20 border border-red-400/30 rounded-xl px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 sm:p-6 bg-slate-900/80 border-t border-slate-800/50 rounded-b-2xl">
          <div className="flex items-end gap-3">
            <div className="flex-1 relative">
              <input
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('voiceChat.typeOrSpeak')}
                dir="auto"
                className="w-full bg-slate-800/50 border border-slate-700 text-white placeholder-slate-500 rounded-xl px-4 py-3.5 pr-12 focus:outline-none focus:border-cyan-400"
                disabled={state !== 'IDLE'}
              />
              <button
                onClick={() => handleSendText(textInput)}
                disabled={state !== 'IDLE' || !textInput.trim()}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-2 text-slate-400 hover:text-cyan-400 disabled:opacity-50"
              >
                <Send className="w-5 h-5" />
              </button>
            </div>

            <button
              onClick={state === 'LISTENING' ? handleStopListening : handleStartListening}
              disabled={state === 'PROCESSING' || state === 'SPEAKING'}
              className={cn(
                'p-4 rounded-2xl flex items-center justify-center transition-all shadow-xl border',
                state === 'LISTENING' ? 'bg-red-600 border-red-400 animate-pulse' :
                state === 'SPEAKING' ? 'bg-pink-600 border-pink-400 animate-pulse' :
                state === 'PROCESSING' ? 'bg-amber-600 border-amber-400' :
                'bg-cyan-600 border-cyan-400 hover:scale-105'
              )}
            >
              {state === 'LISTENING' || state === 'SPEAKING' ? (
                <Volume2 className="w-9 h-9 text-white animate-pulse" />
              ) : state === 'PROCESSING' ? (
                <Loader2 className="w-9 h-9 text-white animate-spin" />
              ) : (
                <Mic className="w-9 h-9 text-white" />
              )}
            </button>

            {messages.length > 0 && (
              <button onClick={handleClearChat} className="p-3 text-slate-400 hover:text-red-400 border border-slate-700 rounded-xl">
                <Trash2 className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AudioChat;