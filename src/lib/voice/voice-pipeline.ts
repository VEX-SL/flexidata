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

class VoicePipeline {
    private apiKey: string;
    private synth: SpeechSynthesis;
    private recognition: SpeechRecognition | null;
    private isListening: boolean;
    private voices: SpeechSynthesisVoice[] = [];
    private voicesLoaded: boolean = false;

    // Callbacks
    private onStateChange: (state: 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'ERROR') => void;
    private onInterimTranscript: (transcript: string) => void;
    private onTranscript: (transcript: string) => void;
    private onAIResponse: (chunk: string, isComplete: boolean) => void;
    private onError: (error: string) => void;

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
    } = {}) {
        this.onStateChange = options.onStateChange || (() => {});
        this.onInterimTranscript = options.onInterimTranscript || (() => {});
        this.onTranscript = options.onTranscript || (() => {});
        this.onAIResponse = options.onAIResponse || (() => {});
        this.onError = options.onError || (() => {});

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

    private initVoices() {
        const loadVoices = () => {
            this.voices = this.synth.getVoices();
            this.voicesLoaded = true;
        };

        loadVoices();

        if (this.synth.onvoiceschanged !== undefined) {
            this.synth.onvoiceschanged = loadVoices;
        }
    }

    private initSTT() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            this.onError("التعرف على الصوت غير مدعوم في هذا المتصفح");
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.continuous = false;
        this.recognition.interimResults = true;
        this.recognition.lang = 'ar-EG';

        this.recognition.onresult = (event) => {
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

        this.recognition.onerror = (err) => {
            console.error("STT Error:", err);
            if (err.error !== 'no-speech') {
                this.onError(`خطأ في التعرف على الصوت: ${err.error}`);
            }
            this.isListening = false;
            this.setState('ERROR');
        };

        this.recognition.onend = () => {
            this.isListening = false;
        };
    }

    public start() {
        if (this.recognition && !this.isListening) {
            try {
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

        this.chatHistory.push({ role: 'user', content: text });
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
                    messages: this.chatHistory,
                    systemPrompt: "أنت مساعد ذكي ناطق بالعربية. اجعل ردودك مختصرة ومباشرة ومحادثة (1-3 جمل كحد أقصى). تجنب التنسيق المعقد. تحدث بشكل طبيعي."
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

    private bufferAndSpeak(chunk: string) {
        this.sentenceBuffer += chunk;
        const sentenceRegex = /[^.!?؟]+[.!?؟]+/g;
        let match;

        while ((match = sentenceRegex.exec(this.sentenceBuffer)) !== null) {
            const sentence = match[0].trim();
            if (sentence) {
                this.speakImmediate(sentence);
            }
        }
    }

    private speakImmediate(text: string): Promise<void> {
        return new Promise((resolve) => {
            const utterance = new SpeechSynthesisUtterance(text);
            const targetVoice = this.voices.find(v =>
                v.lang.startsWith('ar') || v.lang.startsWith('en')
            );

            if (targetVoice) {
                utterance.voice = targetVoice;
                utterance.lang = targetVoice.lang;
            }

            utterance.onend = () => {
                this.isSpeaking = false;
                this.currentUtterance = null;
                resolve();
            };

            utterance.onerror = () => {
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

        const { utterance, resolve } = this.ttsQueue.shift()!;
        this.currentUtterance = utterance;

        this.synth.speak(utterance);
        await utterance.onend.promise;
        resolve();
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
            this.recognition.onresult = null;
            this.recognition.onerror = null;
            this.recognition.onend = null;
            this.recognition = null;
        }

        this.setState('IDLE');
    }
}

export default VoicePipeline;