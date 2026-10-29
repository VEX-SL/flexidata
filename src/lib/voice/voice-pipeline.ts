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

declare global {
    interface Window {
        SpeechRecognition: { new(): SpeechRecognition };
        webkitSpeechRecognition: { new(): SpeechRecognition };
    }
}

interface VoicePipelineOptions {
    apiKey?: string;
    onStateChange?: (state: 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'ERROR') => void;
    onInterimTranscript?: (transcript: string) => void;
    onTranscript?: (transcript: string) => void;
    onAIResponse?: (chunk: string, isComplete: boolean) => void;
    onError?: (error: string) => void;
}

interface QueuedUtterance {
    utterance: SpeechSynthesisUtterance;
    resolve: () => void;
}

class VoicePipeline {
    private apiKey: string;
    private synth: SpeechSynthesis;
    private recognition: SpeechRecognition | null;
    private isListening: boolean;
    private voices: SpeechSynthesisVoice[] = [];
    
    // Callbacks
    private onStateChange: (state: 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'ERROR') => void;
    private onInterimTranscript: (transcript: string) => void;
    private onTranscript: (transcript: string) => void;
    private onAIResponse: (chunk: string, isComplete: boolean) => void;
    private onError: (error: string) => void;

    // TTS Queue for streaming
    private ttsQueue: QueuedUtterance[] = [];
    private isSpeaking: boolean = false;
    private currentUtterance: SpeechSynthesisUtterance | null = null;
    private sentenceBuffer: string = '';
    
    // Chat history for context
    private chatHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    constructor(options: VoicePipelineOptions = {}) {
        this.apiKey = options.apiKey || '';
        this.synth = window.speechSynthesis;
        this.recognition = null;
        this.isListening = false;
        
        this.onStateChange = options.onStateChange || (() => {});
        this.onInterimTranscript = options.onInterimTranscript || (() => {});
        this.onTranscript = options.onTranscript || (() => {});
        this.onAIResponse = options.onAIResponse || (() => {});
        this.onError = options.onError || (() => {});

        this.initVoices();
        this.initSTT();
        this.processTTSQueue();
    }

    private initVoices() {
        const loadVoices = () => {
            this.voices = this.synth.getVoices();
        };
        
        loadVoices();
        if (this.synth.onvoiceschanged !== undefined) {
            this.synth.onvoiceschanged = loadVoices;
        }
    }

    private initSTT() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            console.warn("STT not supported in this browser. Fallback required.");
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

            // Update interim transcript in real-time
            if (interimTranscript) {
                this.onInterimTranscript(interimTranscript);
            }

            // Handle final transcript
            if (finalTranscript) {
                this.onTranscript(finalTranscript.trim());
                this.handleLLMStream(finalTranscript.trim());
            }
        };

        this.recognition.onerror = (err) => {
            console.error("STT Error:", err);
            // Don't treat 'no-speech' as a real error
            if (err.error !== 'no-speech') {
                this.onError(`خطأ في التعرف على الصوت: ${err.error}`);
            }
            this.isListening = false;
            this.onStateChange('IDLE');
        };

        this.recognition.onend = () => {
            this.isListening = false;
            if (this.onStateChange) {
                this.onStateChange('IDLE');
            }
        };
    }

    public start() {
        // Barge-in: cancel any ongoing TTS
        if (this.synth.speaking || this.isSpeaking) {
            this.cancelTTS();
        }
        
        if (this.recognition && !this.isListening) {
            try {
                this.recognition.start();
                this.isListening = true;
                this.onStateChange('LISTENING');
            } catch (e) {
                console.error('Failed to start recognition:', e);
                this.onError('فشل في بدء التعرف على الصوت');
            }
        }
    }

    public stop() {
        if (this.recognition && this.isListening) {
            this.recognition.stop();
            this.isListening = false;
        }
    }

    private cancelTTS() {
        this.synth.cancel();
        this.ttsQueue = [];
        this.isSpeaking = false;
        this.currentUtterance = null;
        this.sentenceBuffer = '';
    }

    private async handleLLMStream(prompt: string) {
        this.onStateChange('PROCESSING');
        
        // Add user message to history
        this.chatHistory.push({ role: 'user', content: prompt });

        try {
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key=${this.apiKey}`;

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: this.chatHistory.map(msg => ({
                        parts: [{ text: msg.content }],
                        role: msg.role === 'user' ? 'user' : 'model'
                    })),
                    systemInstruction: { 
                        parts: [{ 
                            text: "أنت مساعد ذكي ناطق بالعربية. اجعل ردودك مختصرة ومباشرة ومحادثة (1-3 جمل كحد أقصى). تجنب التنسيق المعقد. تحدث بشكل طبيعي." 
                        }] 
                    },
                    generationConfig: {
                        temperature: 0.7,
                        maxOutputTokens: 1024,
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API Error: ${response.status} - ${errorText}`);
            }

            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullResponse = '';
            let isFirstChunk = true;

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
                            const textChunk = json.candidates?.[0]?.content?.parts?.[0]?.text;
                            
                            if (textChunk) {
                                fullResponse += textChunk;
                                this.onAIResponse(textChunk, false);
                                
                                // Stream to TTS - buffer sentences and speak as they complete
                                this.bufferAndSpeak(textChunk);
                            }
                        } catch (e) {
                            // Ignore parse errors for incomplete chunks
                        }
                    }
                }
            }

            // Handle any remaining buffer
            if (this.sentenceBuffer.trim()) {
                this.speakImmediate(this.sentenceBuffer.trim());
                this.sentenceBuffer = '';
            }

            // Mark streaming as complete
            this.onAIResponse('', true);
            
            // Add assistant response to history
            if (fullResponse.trim()) {
                this.chatHistory.push({ role: 'assistant', content: fullResponse.trim() });
                
                // Keep history manageable (last 20 messages)
                if (this.chatHistory.length > 20) {
                    this.chatHistory = this.chatHistory.slice(-20);
                }
            }

        } catch (e) {
            console.error("LLM Streaming Error:", e);
            this.onError(`خطأ في الاتصال: ${e instanceof Error ? e.message : 'خطأ غير معروف'}`);
            this.onStateChange('ERROR');
            setTimeout(() => this.onStateChange('IDLE'), 2000);
        }
    }

    private bufferAndSpeak(chunk: string) {
        this.sentenceBuffer += chunk;
        
        // Split by sentence endings (Arabic and English)
        const sentenceRegex = /[^.!?؟]+[.!?؟]+/g;
        let match;
        const sentences: string[] = [];
        
        while ((match = sentenceRegex.exec(this.sentenceBuffer)) !== null) {
            sentences.push(match[0].trim());
        }
        
        // If we found complete sentences, speak them and keep the remainder
        if (sentences.length > 0) {
            const lastMatchEnd = sentenceRegex.lastIndex;
            this.sentenceBuffer = this.sentenceBuffer.slice(lastMatchEnd);
            
            for (const sentence of sentences) {
                if (sentence.trim()) {
                    this.speakImmediate(sentence.trim());
                }
            }
        }
    }

    private speakImmediate(text: string) {
        const utterance = new SpeechSynthesisUtterance(text);
        
        // Find best voice for Arabic/English
        const targetVoice = this.voices.find(v => 
            v.lang.startsWith('ar') || v.lang.startsWith('en')
        ) || this.voices.find(v => 
            v.name.toLowerCase().includes('arabic') || 
            v.name.toLowerCase().includes('english')
        );
        
        if (targetVoice) {
            utterance.voice = targetVoice;
        }
        
        utterance.lang = targetVoice?.lang.startsWith('ar') ? 'ar-SA' : 'en-US';
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        return new Promise<void>((resolve) => {
            utterance.onend = () => {
                this.isSpeaking = false;
                this.currentUtterance = null;
                resolve();
            };
            utterance.onerror = () => {
                this.isSpeaking = false;
                this.currentUtterance = null;
                resolve();
            };

            this.ttsQueue.push({ utterance, resolve });
            
            if (!this.isSpeaking) {
                this.processTTSQueue();
            }
        });
    }

    private async processTTSQueue() {
        if (this.isSpeaking || this.ttsQueue.length === 0) return;

        this.isSpeaking = true;
        this.onStateChange('SPEAKING');

        while (this.ttsQueue.length > 0) {
            const { utterance, resolve } = this.ttsQueue.shift()!;
            this.currentUtterance = utterance;
            
            // Check if we should cancel (barge-in)
            if (!this.isSpeaking) break;
            
            this.synth.speak(utterance);
            await new Promise<void>(resolve);
        }

        this.isSpeaking = false;
        this.currentUtterance = null;
        
        // Check if we're still listening or processing
        if (!this.isListening) {
            this.onStateChange('IDLE');
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
    }

    public getState(): 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' {
        if (this.isListening) return 'LISTENING';
        if (this.isSpeaking) return 'SPEAKING';
        return 'IDLE';
    }

    public isActive(): boolean {
        return this.isListening || this.isSpeaking || this.ttsQueue.length > 0;
    }
}

export default VoicePipeline;