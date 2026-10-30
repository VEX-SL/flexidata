export interface VoicePipelineOptions {
  chatId?: string;
  agentId?: string;
  apiKey?: string;
  onStateChange?: (state: 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'ERROR') => void;
  onInterimTranscript?: (transcript: string) => void;
  onTranscript?: (transcript: string) => void;
  onAIResponse?: (chunk: string, isComplete: boolean) => void;
  onError?: (error: string) => void;
}

export function isRtlLanguage(lang: string): boolean {
  return lang.startsWith('ar') || lang.startsWith('he') || lang.startsWith('fa');
}

export default class VoicePipeline {
  private chatId?: string;
  private agentId?: string;
  private apiKey: string;
  private recognition: any | null = null;
  private synth: SpeechSynthesis;
  private isListening: boolean = false;
  private history: { role: 'user' | 'assistant'; text: string }[] = [];

  private onStateChange: (state: 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'ERROR') => void;
  private onInterimTranscript: (t: string) => void;
  private onTranscript: (t: string) => void;
  private onAIResponse: (chunk: string, isComplete: boolean) => void;
  private onError: (err: string) => void;

  constructor(options: VoicePipelineOptions) {
    this.chatId = options.chatId;
    this.agentId = options.agentId;
    this.apiKey = options.apiKey || '';
    this.synth = window.speechSynthesis;

    this.onStateChange = options.onStateChange || (() => {});
    this.onInterimTranscript = options.onInterimTranscript || (() => {});
    this.onTranscript = options.onTranscript || (() => {});
    this.onAIResponse = options.onAIResponse || (() => {});
    this.onError = options.onError || (() => {});

    this.initSTT();
  }

  private initSTT() {
    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return;

    this.recognition = new SpeechRecognitionCtor();
    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    // تعيين اللغة افتراضياً لتلتقط العربي والإنجليزي بمرونة تامة دون الحاجة لاختيار يدوي
    this.recognition.lang = 'ar-EG';

    this.recognition.onstart = () => {
      this.isListening = true;
      this.onStateChange('LISTENING');
    };

    this.recognition.onresult = (event: any) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }

      if (interim) {
        this.onInterimTranscript(interim);
      }

      if (final.trim()) {
        const userText = final.trim();
        this.onInterimTranscript('');
        this.stop();
        this.onTranscript(userText);
        this.processLLM(userText);
      }
    };

    this.recognition.onerror = (event: any) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        this.onError(`STT Error: ${event.error}`);
      }
      this.isListening = false;
      this.onStateChange('IDLE');
    };

    this.recognition.onend = () => {
      this.isListening = false;
      this.onStateChange('IDLE');
    };
  }

  public addToHistory(role: 'user' | 'assistant', text: string) {
    this.history.push({ role, text });
    if (this.history.length > 30) this.history.shift();
  }

  public clearHistory() {
    this.history = [];
  }

  public start() {
    if (this.isListening) return;

    if (this.synth.speaking || this.synth.pending) {
      this.synth.cancel();
    }

    if (this.recognition) {
      try {
        this.recognition.start();
      } catch (e) {
        this.isListening = false;
        try {
          this.recognition.stop();
          this.recognition.start();
        } catch (err) {
          this.isListening = false;
          this.onStateChange('IDLE');
        }
      }
    }
  }

  public stop() {
    this.isListening = false;
    if (this.recognition) {
      try { this.recognition.stop(); } catch (e) {}
    }
  }

  public sendText(text: string) {
    if (!text.trim()) return;
    if (this.synth.speaking || this.synth.pending) {
      this.synth.cancel();
    }
    this.onTranscript(text);
    this.processLLM(text);
  }

  private async processLLM(prompt: string) {
    this.onStateChange('PROCESSING');
    this.addToHistory('user', prompt);

    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${this.apiKey}`;

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            ...this.history.map(m => ({
              role: m.role === 'user' ? 'user' : 'model',
              parts: [{ text: m.text }]
            }))
          ],
          systemInstruction: {
            parts: [{ text: "You are a helpful, real-time voice assistant. Keep answers brief, natural, and conversational (1-3 sentences max). Detect the user's language automatically and reply in the exact same language (Arabic, English, or mixed)." }]
          }
        })
      });

      if (!res.ok) throw new Error(`API Error: ${res.statusText}`);

      const data = await res.json();
      const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || "أهلاً بك، أنا هنا لمساعدتك.";

      this.addToHistory('assistant', aiText);
      this.onAIResponse(aiText, true);
      this.speak(aiText);

    } catch (e: any) {
      this.onError(e.message || 'Failed to process request');
      this.onStateChange('IDLE');
    }
  }

  private speak(text: string) {
    this.onStateChange('SPEAKING');
    if (this.synth.speaking) this.synth.cancel();

    const sentences = text.match(/[^.!?؟]+[.!?؟]+|\S+$/g) || [text];

    sentences.forEach((sentence, idx) => {
      const utterance = new SpeechSynthesisUtterance(sentence.trim());
      
      const isArabic = /[\u0600-\u06FF]/.test(sentence);
      utterance.lang = isArabic ? 'ar-EG' : 'en-US';

      const voices = this.synth.getVoices();
      const targetVoice = voices.find(v => 
        isArabic ? v.lang.startsWith('ar') : v.lang.startsWith('en')
      ) || voices[0];

      if (targetVoice) utterance.voice = targetVoice;

      utterance.onend = () => {
        if (idx === sentences.length - 1) {
          this.onStateChange('IDLE');
        }
      };

      utterance.onerror = () => {
        if (idx === sentences.length - 1) {
          this.onStateChange('IDLE');
        }
      };

      this.synth.speak(utterance);
    });
  }

  public dispose() {
    this.stop();
    if (this.synth.speaking) this.synth.cancel();
  }
}