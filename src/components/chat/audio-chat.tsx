'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import VoicePipeline from '@/lib/voice/voice-pipeline';
import { X, Mic, Volume2, Loader2, Send, Trash2, Minimize2, Maximize2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/lib/i18n';

interface VoiceMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  isInterim?: boolean;
}

const AudioChat = ({ onClose }: { onClose: () => void }) => {
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
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Initialize voice pipeline
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSttSupported(false);
    }

    voicePipelineRef.current = new VoicePipeline({
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
      onAIResponse: (chunk: string, isComplete: boolean) => {
        if (isComplete) {
          setMessages(prev => {
            const lastMsg = prev[prev.length - 1];
            if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isInterim) {
              return [...prev.slice(0, -1), { ...lastMsg, content: lastMsg.content + chunk, isInterim: false }];
            } else {
              return [...prev, {
                id: `assistant-${Date.now()}`,
                role: 'assistant',
                content: chunk,
                timestamp: new Date(),
                isInterim: false,
              }];
            }
          });
        } else {
          setMessages(prev => {
            const lastMsg = prev[prev.length - 1];
            if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isInterim) {
              return [...prev.slice(0, -1), { ...lastMsg, content: lastMsg.content + chunk }];
            } else {
              return [...prev, {
                id: `assistant-streaming-${Date.now()}`,
                role: 'assistant',
                content: chunk,
                timestamp: new Date(),
                isInterim: true,
              }];
            }
          });
        }
      },
      onError: (error: string) => {
        console.error('Voice pipeline error:', error);
        setError(error);
        setState('ERROR');
      },
    });

    return () => {
      if (voicePipelineRef.current) {
        voicePipelineRef.current.dispose();
      }
    };
  }, []);

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

  const getStateTooltip = () => {
    switch (state) {
      case 'LISTENING': return t('voiceChat.stopListening');
      case 'SPEAKING': return t('voiceChat.speakingNow');
      case 'PROCESSING': return t('voiceChat.thinkingNow');
      default: return t('voiceChat.tapToSpeak');
    }
  };

  if (!sttSupported) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-slate-900/95 backdrop-blur-xl border border-slate-700 rounded-2xl max-w-md w-full p-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-400/30 flex items-center justify-center">
            <Mic className="w-8 h-8 text-amber-400" />
          </div>
          <h3 className="text-xl font-semibold text-white mb-2">{t('voiceChat.error')}</h3>
          <p className="text-slate-400 mb-6">{t('voiceChat.sttNotSupported')}</p>
          <button
            onClick={onClose}
            className="px-6 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-medium hover:from-cyan-400 hover:to-blue-500 transition-all"
          >
            {t('common.back')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col" role="dialog" aria-modal="true" aria-label={t('voiceChat.title')}>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Main Modal */}
      <div className="flex-1 flex flex-col max-w-3xl w-full mx-auto my-auto relative z-10">
        {/* Header */}
        <div className="flex items-center justify-between p-4 bg-slate-900/80 backdrop-blur-xl border-b border-slate-800/50 rounded-t-2xl">
          <div className="flex items-center gap-3">
            <div className="relative p-2.5 rounded-xl bg-gradient-to-br from-cyan-500/15 to-blue-600/15 border border-cyan-400/20">
              <canvas
                ref={canvasRef}
                className="w-7 h-7"
                width={56}
                height={56}
                aria-hidden="true"
              />
              <span className={cn(
                'absolute -bottom-1 -right-1 w-3 h-3 rounded-full border-2 border-slate-900',
                state === 'LISTENING' && 'bg-cyan-400 animate-pulse',
                state === 'SPEAKING' && 'bg-pink-400 animate-pulse',
                state === 'PROCESSING' && 'bg-amber-400 animate-pulse',
                state === 'IDLE' && 'bg-slate-500'
              )} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white tracking-tight">{t('voiceChat.title')}</h2>
              <p className="text-xs text-slate-400 capitalize flex items-center gap-1.5">
                <span className={cn(
                  'w-1.5 h-1.5 rounded-full',
                  state === 'LISTENING' && 'bg-cyan-400 animate-pulse',
                  state === 'SPEAKING' && 'bg-pink-400 animate-pulse',
                  state === 'PROCESSING' && 'bg-amber-400 animate-pulse',
                  state === 'IDLE' && 'bg-slate-500'
                )} />
                {getStateLabel()}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setIsMinimized(true)}
              className="p-2.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/50 transition-colors"
              aria-label={t('voiceChat.minimize')}
            >
              <Minimize2 className="w-5 h-5" />
            </button>
            <button
              onClick={onClose}
              className="p-2.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/50 transition-colors"
              aria-label={t('voiceChat.close')}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 bg-gradient-to-b from-slate-950/50 to-slate-950/30">
          {messages.map((msg, index) => (
            <div key={msg.id} className={cn(
              'flex gap-3 animate-fade-in',
              msg.role === 'user' ? 'justify-end' : 'justify-start'
            )}>
              {msg.role === 'assistant' && (
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-pink-500 to-rose-600 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-lg shadow-pink-500/20">
                  <Volume2 className="w-4.5 h-4.5 text-white" />
                </div>
              )}

              <div className={cn(
                'max-w-[85%]',
                msg.role === 'user' ? 'text-right' : 'text-left'
              )}>
                <div className={cn(
                  'rounded-2xl px-4 py-3.5 text-sm leading-relaxed shadow-sm',
                  msg.role === 'user'
                    ? 'bg-gradient-to-br from-cyan-500/25 to-blue-600/25 border border-cyan-400/30 text-white rounded-br-none shadow-cyan-500/10'
                    : 'bg-slate-800/60 border border-slate-700/50 text-slate-100 rounded-bl-none',
                  msg.isInterim && 'opacity-70'
                )}>
                  <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                  {msg.isInterim && (
                    <span className="inline-block ml-2 animate-pulse text-cyan-400 text-xs font-medium">▌</span>
                  )}
                </div>
                <span className="text-xs text-slate-500/80 mt-1.5 block">{formatTime(msg.timestamp)}</span>
              </div>

              {msg.role === 'user' && (
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-lg shadow-cyan-500/20">
                  <Mic className="w-4.5 h-4.5 text-white" />
                </div>
              )}
            </div>
          ))}

          {/* Live Interim Transcript */}
          {interimTranscript && state === 'LISTENING' && (
            <div className="flex justify-end animate-fade-in">
              <div className="max-w-[85%] text-right">
                <div className="rounded-2xl bg-cyan-500/10 border border-cyan-400/40 text-cyan-300 px-4 py-3 text-sm leading-relaxed rounded-br-none animate-pulse">
                  <p className="whitespace-pre-wrap break-words">{interimTranscript}</p>
                  <span className="inline-block ml-2 text-cyan-400 font-medium">▌</span>
                </div>
              </div>
            </div>
          )}

          {/* Typing indicator */}
          {state === 'PROCESSING' && (
            <div className="flex justify-start animate-fade-in">
              <div className="flex items-center gap-2.5 px-4 py-3 bg-slate-800/60 border border-slate-700/50 rounded-2xl rounded-bl-none">
                <Loader2 className="w-4.5 h-4.5 text-amber-400 animate-spin" />
                <span className="text-sm text-slate-300">{t('voiceChat.thinkingNow')}</span>
                <span className="text-xs text-slate-500 font-mono">...</span>
              </div>
            </div>
          )}

          {/* Error indicator */}
          {error && (
            <div className="flex justify-center animate-fade-in">
              <div className="bg-red-500/20 border border-red-400/30 rounded-xl px-4 py-3 text-sm text-red-400 flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 0l-3 3a1 1 0 101.414 1.414L9 9.414V13a1 1 0 102 0V9.414l1.293 1.293a1 1 0 001.414-1.414z" clipRule="evenodd" />
                </svg>
                <span>{error}</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="p-4 sm:p-6 bg-slate-900/80 backdrop-blur-xl border-t border-slate-800/50 rounded-b-2xl">
          <div className="flex items-end gap-3">
            {/* Text input */}
            <div className="flex-1 relative">
              <input
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('voiceChat.typeOrSpeak')}
                className={cn(
                  'w-full bg-slate-800/50 border border-slate-700 text-white placeholder-slate-500 rounded-xl px-4 py-3.5 pr-12 focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20 transition-all',
                  state !== 'IDLE' && 'opacity-50 cursor-not-allowed'
                )}
                disabled={state !== 'IDLE'}
              />
              <button
                onClick={() => handleSendText(textInput)}
                disabled={state !== 'IDLE' || !textInput.trim()}
                className={cn(
                  'absolute right-2.5 top-1/2 -translate-y-1/2 p-2 rounded-lg text-slate-400 hover:text-cyan-400 hover:bg-cyan-400/10 transition-colors disabled:opacity-50',
                  textInput.trim() && 'opacity-100 hover:opacity-90'
                )}
                aria-label={t('voiceChat.sendText')}
              >
                <Send className="w-5 h-5" />
              </button>
            </div>

            {/* Main Voice Button */}
            <button
              onClick={state === 'LISTENING' ? handleStopListening : handleStartListening}
              disabled={state === 'PROCESSING' || state === 'SPEAKING'}
              className={cn(
                'relative flex-shrink-0 p-4 rounded-2xl flex items-center justify-center transition-all duration-300',
                'shadow-xl border',
                state === 'LISTENING'
                  ? 'bg-gradient-to-br from-red-500 to-rose-600 border-red-400/50 animate-pulse ring-4 ring-red-400/20'
                  : state === 'SPEAKING'
                  ? 'bg-gradient-to-br from-pink-500 to-rose-600 border-pink-400/50 animate-pulse ring-4 ring-pink-400/20'
                  : state === 'PROCESSING'
                  ? 'bg-gradient-to-br from-amber-500 to-orange-600 border-amber-400/50 cursor-wait ring-4 ring-amber-400/20'
                  : 'bg-gradient-to-br from-cyan-500 to-blue-600 border-cyan-400/30 hover:scale-[1.02] hover:shadow-[0_0_40px_rgba(34,211,238,0.35)] hover:border-cyan-400/50'
              )}
              aria-label={getStateTooltip()}
            >
              {state === 'LISTENING' ? (
                <Mic className="w-9 h-9 text-white drop-shadow-lg" />
              ) : state === 'SPEAKING' ? (
                <Volume2 className="w-9 h-9 text-white drop-shadow-lg animate-pulse" />
              ) : state === 'PROCESSING' ? (
                <Loader2 className="w-9 h-9 text-white animate-spin" />
              ) : (
                <canvas
                  ref={canvasRef}
                  className="w-11 h-11"
                  width={88}
                  height={88}
                  aria-hidden="true"
                />
              )}
            </button>

            {/* Clear chat */}
            {messages.length > 0 && (
              <button
                onClick={handleClearChat}
                className="flex-shrink-0 p-3 rounded-xl text-slate-400 hover:text-red-400 hover:bg-red-400/10 border border-slate-700/50 transition-colors"
                aria-label={t('voiceChat.clearChat')}
              >
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