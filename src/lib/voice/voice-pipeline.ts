// Web Speech API type declarations
interface SpeechRecognition extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start(): void;
    stop(): void;
    onresult: (event: SpeechRecognitionEvent) => void;
    onerror: (event: SpeechRecognitionErrorEvent) => void;
    onend: () => void;
}

interface SpeechRecognitionEvent extends Event {
    resultIndex: number;
    results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
    length: number;
    item(index: number): SpeechRecognitionResult;
    [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
    length: number;
    item(index: number): SpeechRecognitionAlternative;
    [index: number]: SpeechRecognitionAlternative;
    isFinal: boolean;
}

interface SpeechRecognitionAlternative {
    transcript: string;
    confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
    error: string;
    message: string;
}

interface SpeechSynthesisVoice {
    voiceURI: string;
    name: string;
    lang: string;
    localService: boolean;
    default: boolean;
}

interface VoicePipelineState {
    current: 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'ERROR';
    transitions: Record<'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'ERROR', string[]>;
}

// اللغات المدعومة — اختار منها في الواجهة
export const SUPPORTED_LANGUAGES = [
    { code: 'ar-EG', label: 'العربية (مصر)' },
    { code: 'ar-SA', label: 'العربية (الخليج)' },
    { code: 'en-US', label: 'English (US)' },
    { code: 'en-GB', label: 'English (UK)' },
    { code: 'fr-FR', label: 'Français' },
    { code: 'es-ES', label: 'Español' },
    { code: 'de-DE', label: 'Deutsch' },
    { code: 'it-IT', label: 'Italiano' },
    { code: 'pt-BR', label: 'Português' },
    { code: 'tr-TR', label: 'Türkçe' },
    { code: 'ru-RU', label: 'Русский' },
    { code: 'hi-IN', label: 'हिन्दी' },
    { code: 'ur-PK', label: 'اردو' },
    { code: 'fa-IR', label: 'فارسی' },
    { code: 'he-IL', label: 'עברית' },
    { code: 'ja-JP', label: '日本語' },
    { code: 'ko-KR', label: '한국어' },
    { code: 'zh-CN', label: '中文' },
];

const RTL_PREFIXES = ['ar', 'he', 'fa', 'ur'];

export function isRtlLanguage(langCode: string): boolean {
    return RTL_PREFIXES.includes(langCode.split('-')[0].toLowerCase());
}

class VoicePipeline {
    private synth: SpeechSynthesis;
    private recognition: SpeechRecognition | null;
    private isListening: boolean;
    private voices: SpeechSynthesisVoice[] = [];
    private voicesLoaded: boolean = false;

    // اللغة الحالية (الاستماع + الصوت الافتراضي)
    private language: string = 'ar-EG';

    // Chat persistence
    private chatId: string | null = null;
    private agentId: string | null = null;

    // Callbacks
    private onStateChange: (state: 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'ERROR') => void;
    private onInterimTranscript: (transcript: string) => void;
    private onTranscript: (transcript: string) => void;
    private onAIResponse: (chunk: string, isComplete: boolean) => void;
    private onError: (error: string) => void;
    private onLanguageChange?: (lang: string) => void;

    // TTS Queue for streaming
    private ttsQueue: Array<{ utterance: SpeechSynthesisUtterance, resolve: () => void }> = [];
    private isSpeaking: boolean = false;
    private currentUtterance: SpeechSynthesisUtterance | null = null;
    private sentenceBuffer: string = '';
    private currentRequestAbortController: AbortController | null = null;

    // Chat history for context
    private chatHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    private stateMachine: VoicePipelineState;

    constructor(options: {
        onStateChange?: (state: 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'ERROR') => void;
        onInterimTranscript?: (transcript: string) => void;
        onTranscript?: (transcript: string) => void;
        onAIResponse?: (chunk: string, isComplete: boolean) => void;
        onError?: (error: string) => void;
        onLanguageChange?: (lang: string) => void;
        chatId?: string;
        agentId?: string;
        language?: string;
    } = {}) {
        this.onStateChange = options.onStateChange || (() => {});
        this.onInterimTranscript = options.onInterimTranscript || (() => {});
        this.onTranscript = options.onTranscript || (() => {});
        this.onAIResponse = options.onAIResponse || (() => {});
        this.onError = options.onError || (() => {});
        this.onLanguageChange = options.onLanguageChange;

        this.chatId = options.chatId || null;
        this.agentId = options.agentId || null;

        // اللغة: من الإعدادات → من التخزين المحلي → عربي افتراضيًا
        let savedLang: string | null = null;
        try { savedLang = localStorage.getItem('voice-chat-lang'); } catch {}
        this.language = options.language || savedLang || 'ar-EG';

        this.synth = window.speechSynthesis;
        this.recognition = null;
        this.isListening = false;

        this.stateMachine = {
            current: 'IDLE',
            transitions: {
                'IDLE': ['LISTENING', 'PROCESSING'],
                'LISTENING': ['PROCESSING', 'IDLE'],
                'PROCESSING': ['SPEAKING', 'IDLE'],
                'SPEAKING': ['IDLE'],
                'ERROR': ['IDLE']
            }
        };

        this.initVoices();
        this.initSTT();
    }

    // تغيير لغة الاستماع يدويًا من الواجهة
    public setLanguage(lang: string) {
        this.language = lang;
        try { localStorage.setItem('voice-chat-lang', lang); } catch {}
        if (this.recognition) {
            this.recognition.lang = lang;
        }
        this.onLanguageChange?.(lang);
    }

    public getLanguage(): string {
        return this.language;
    }

    private initVoices() {
        const loadVoices = () => {
            const v = this.synth.getVoices();
            if (v.length) {
                this.voices = v;
                this.voicesLoaded = true;
            }
        };

        loadVoices();
        if (this.synth.onvoiceschanged !== undefined) {
            this.synth.onvoiceschanged = loadVoices;
        }
    }

    private initSTT() {
        const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRecognitionCtor) {
            this.onError("التعرف على الصوت غير مدعوم في هذا المتصفح");
            return;
        }

        const recognition = new SpeechRecognitionCtor();

        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = this.language; // ← اللغة المختارة بدل الثابت ar-EG

        recognition.onresult = (event: any) => {
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += transcript;
                } else {
                    interimTranscript += transcript;
                }
            }

            if (interimTranscript) {
                this.onInterimTranscript(interimTranscript);
            }

            if (finalTranscript) {
                this.onTranscript(finalTranscript.trim());
                this.handleLLMStream(finalTranscript.trim());
            }
        };

        recognition.onerror = (err: any) => {
            console.error("STT Error:", err);
            if (err.error !== 'no-speech') {
                this.onError(`خطأ في التعرف على الصوت: ${err.error}`);
            }
            this.isListening = false;
            this.setState('ERROR');
        };

        recognition.onend = () => {
            this.isListening = false;
        };

        this.recognition = recognition;
    }

    public start() {
        if (this.recognition && !this.isListening) {
            try {
                this.recognition.lang = this.language; // تأكيد اللغة الحالية
                this.recognition.start();
                this.isListening = true;
                this.setState('LISTENING');
            } catch (e) {
                console.error('Failed to start recognition:', e);
                this.onError('فشل في بدء التعرف على الصوت');
                this.setState('ERROR');
            }
        }
    }

    public sendText(text: string) {
        if (!text.trim()) return;
        // ملاحظة: handleLLMStream هي اللي بتضيف للـ history عشان منتكررش الرسالة
        this.onTranscript(text);
        this.handleLLMStream(text);
    }

    public stop() {
        if (this.recognition && this.isListening) {
            this.recognition.stop();
            this.isListening = false;
        }
    }

    public cancel() {
        this.cancelTTS();
        this.cancelLLMRequest();
        this.setState('IDLE');
    }

    private cancelTTS() {
        this.synth.cancel();
        this.ttsQueue = [];
        this.isSpeaking = false;
        this.currentUtterance = null;
        this.sentenceBuffer = '';
    }

    private cancelLLMRequest() {
        if (this.currentRequestAbortController) {
            this.currentRequestAbortController.abort();
            this.currentRequestAbortController = null;
        }
    }

    private async handleLLMStream(prompt: string) {
        this.setState('PROCESSING');

        this.chatHistory.push({ role: 'user', content: prompt });
        this.currentRequestAbortController = new AbortController();

        try {
            const response = await fetch('/api/voice-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: "أنت مساعد ذكي ناطق بالعربية. اجعل ردودك مختصرة ومباشرة ومحادثة (1-3 جمل كحد أقصى). تجنب التنسيق المعقد. تحدث بشكل طبيعي." },
                        ...this.chatHistory
                    ],
                    temperature: 0.7,
                    maxTokens: 1024,
                    chatId: this.chatId,
                    agentId: this.agentId,
                }),
                signal: this.currentRequestAbortController.signal
            });

            if (!response.ok) {
                throw new Error(`API Error: ${response.status}`);
            }

            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullResponse = '';

            while (true) {
                if (!reader) break;

                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const json = JSON.parse(line.slice(6));

                            if (json.done) {
                                break;
                            }

                            if (json.error) {
                                throw new Error(json.error);
                            }

                            const textChunk = json.chunk;
                            fullResponse += textChunk;
                            this.onAIResponse(textChunk, false);
                            this.bufferAndSpeak(textChunk);
                        } catch (e) {
                            this.onError(`خطأ في تحليل الرد: ${e instanceof Error ? e.message : 'خطأ غير معروف'}`);
                            this.setState('ERROR');
                        }
                    }
                }
            }

            if (this.sentenceBuffer.trim()) {
                this.speakImmediate(this.sentenceBuffer.trim());
                this.sentenceBuffer = '';
            }

            this.onAIResponse('', true);
            this.chatHistory.push({ role: 'assistant', content: fullResponse.trim() });
        } catch (e) {
            if (e instanceof Error && e.name !== 'AbortError') {
                this.onError(`خطأ في الاتصال: ${e.message}`);
                this.setState('ERROR');
            }
        } finally {
            this.currentRequestAbortController = null;
            this.setState('IDLE');
        }
    }

    // تحديد لغة النص من خطه (عربي/إنجليزي/...) لاختيار الصوت المناسب
    private detectTextLanguage(text: string): string | null {
        if (/[\u0600-\u06FF]/.test(text)) return 'ar';
        if (/[\u0590-\u05FF]/.test(text)) return 'he';
        if (/[\u0750-\u077F]/.test(text)) return 'fa';
        if (/[\u0400-\u04FF]/.test(text)) return 'ru';
        if (/[\u0370-\u03FF]/.test(text)) return 'el';
        if (/[\u0900-\u097F]/.test(text)) return 'hi';
        if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(text)) return 'ja';
        if (/[\uAC00-\uD7AF]/.test(text)) return 'ko';
        if (/[a-zA-Z]/.test(text)) return 'en';
        return null;
    }

    // اختيار صوت مناسب لنص معيّن: لغة النص أولًا، ثم لغة الإعداد، ثم أي صوت
    private pickVoice(text: string): SpeechSynthesisVoice | undefined {
        const fresh = this.synth.getVoices();
        if (fresh.length) this.voices = fresh;

        const detected = this.detectTextLanguage(text);
        const primary = (detected || this.language.split('-')[0]).toLowerCase();
        const fallback = this.language.split('-')[0].toLowerCase();

        return (
            this.voices.find(v => v.lang.toLowerCase().startsWith(primary)) ||
            this.voices.find(v => v.lang.toLowerCase().startsWith(fallback)) ||
            this.voices.find(v => v.lang.toLowerCase().startsWith('en')) ||
            this.voices[0]
        );
    }

    // إصلاح الـ Bug: مسح الجمل اللي اتنطقت من الـ buffer عشان ماتتكررش
    private bufferAndSpeak(chunk: string) {
        this.sentenceBuffer += chunk;
        const sentenceRegex = /[^.!?؟\n]+[.!?؟]+/g;
        let match;
        let lastIndex = 0;

        while ((match = sentenceRegex.exec(this.sentenceBuffer)) !== null) {
            lastIndex = sentenceRegex.lastIndex;
            const sentence = match[0].trim();
            if (sentence) {
                this.speakImmediate(sentence);
            }
        }

        if (lastIndex > 0) {
            this.sentenceBuffer = this.sentenceBuffer.slice(lastIndex);
        }
    }

    private speakImmediate(text: string): Promise<void> {
        return new Promise((resolve) => {
            // تنظيف النص من علامات الماركداون قبل النطق
            const cleanText = text
                .replace(/[*_#`~>|]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (!cleanText) { resolve(); return; }

            const utterance = new SpeechSynthesisUtterance(cleanText);

            // ← الصوت بيختار حسب لغة الجملة نفسها: عربي للعربي وإنجليزي للإنجليزي
            const targetVoice = this.pickVoice(cleanText);
            if (targetVoice) {
                utterance.voice = targetVoice;
                utterance.lang = targetVoice.lang;
            } else {
                utterance.lang = this.language;
            }

            utterance.rate = 1.0;
            utterance.volume = 1.0;
            utterance.pitch = 1.0;

            utterance.onend = () => {
                this.isSpeaking = false;
                this.currentUtterance = null;
                resolve();
            };

            utterance.onerror = (event) => {
                console.error('Speech synthesis error:', event);
                this.isSpeaking = false;
                this.currentUtterance = null;
                this.onError('فشل في النطق');
                resolve();
            };

            this.ttsQueue.push({ utterance, resolve });
            this.processTTSQueue();
        });
    }

    private async processTTSQueue() {
        if (this.isSpeaking || this.ttsQueue.length === 0) return;

        this.isSpeaking = true;
        this.onStateChange('SPEAKING');

        while (this.ttsQueue.length > 0) {
            const { utterance, resolve } = this.ttsQueue.shift()!;
            this.currentUtterance = utterance;

            await new Promise<void>((resolveQueue) => {
                utterance.onend = () => {
                    this.isSpeaking = false;
                    this.currentUtterance = null;
                    resolve();
                    resolveQueue();
                };

                utterance.onerror = () => {
                    this.isSpeaking = false;
                    this.currentUtterance = null;
                    this.onError('فشل في النطق');
                    resolve();
                    resolveQueue();
                };

                this.synth.speak(utterance);
            });
        }

        this.isSpeaking = false;
        this.currentUtterance = null;
    }

    private setState(newState: 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'ERROR') {
        if (this.stateMachine.transitions[this.stateMachine.current].includes(newState)) {
            this.stateMachine.current = newState;
            this.onStateChange(newState);
        } else {
            console.warn(`Invalid state transition from ${this.stateMachine.current} to ${newState}`);
        }
    }

    public addToHistory(role: 'user' | 'assistant', content: string) {
        this.chatHistory.push({ role, content });
        if (this.chatHistory.length > 20) {
            this.chatHistory = this.chatHistory.slice(-20);
        }
    }

    public clearHistory() {
        this.chatHistory = [];
        this.cancelLLMRequest();
    }

    public getState(): 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'ERROR' {
        return this.stateMachine.current;
    }

    public dispose() {
        this.cancelTTS();
        this.cancelLLMRequest();
        this.isListening = false;
        this.isSpeaking = false;
        this.ttsQueue = [];
        this.currentUtterance = null;
        this.sentenceBuffer = '';
        this.chatHistory = [];

        if (this.recognition) {
            (this.recognition as any).onresult = null;
            (this.recognition as any).onerror = null;
            (this.recognition as any).onend = null;
            this.recognition = null;
        }

        this.setState('IDLE');
    }
}

export default VoicePipeline;