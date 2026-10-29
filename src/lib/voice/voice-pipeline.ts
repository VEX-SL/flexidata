import { useEffect, useState } from 'react';

class VoicePipeline {
    private apiKey: string;
    private synth: SpeechSynthesis;
    private recognition: SpeechRecognition | null;
    private isListening: boolean;
    private onStateChange: (state: string) => void;
    private onTranscript: (transcript: string) => void;
    private onAIResponse: (response: string) => void;
    private voices: SpeechSynthesisVoice[] = [];
    
    constructor(options: {
        apiKey?: string,
        onStateChange?: (state: string) => void,
        onTranscript?: (transcript: string) => void,
        onAIResponse?: (response: string) => void
    }) {
        this.apiKey = options.apiKey || '';
        this.synth = window.speechSynthesis;
        this.isListening = false;
        this.onStateChange = options.onStateChange || (() => {});
        this.onTranscript = options.onTranscript || (() => {});
        this.onAIResponse = options.onAIResponse || (() => {});
        this.initVoices();
        this.initSTT();
    }
    
    private initVoices() {
        this.voices = this.synth.getVoices();
    }
    
    private initSTT() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            console.warn("STT not supported in this browser. Fallback required.");
            return;
        }
        
        this.recognition = new SpeechRecognition();
        this.recognition.continuous = false;
        this.recognition.interimResults = true;
        this.recognition.lang = 'ar-EG';
        
        this.recognition.onresult = (event) => {
            let finalTranscript = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                }
            }
            if (finalTranscript) {
                this.onTranscript(finalTranscript);
                this.handleLLMStream(finalTranscript);
            }
        };
        
        this.recognition.onerror = (err) => console.error("STT Error:", err);
        this.recognition.onend = () => {
            this.isListening = false;
            this.onStateChange('IDLE');
        };
    }
    
    public start() {
        if (this.synth.speaking) this.synth.cancel();
        if (this.recognition && !this.isListening) {
            this.recognition.start();
            this.isListening = true;
            this.onStateChange('LISTENING');
        }
    }
    
    public stop() {
        if (this.recognition && this.isListening) {
            this.recognition.stop();
            this.isListening = false;
        }
    }
    
    public async handleLLMStream(prompt: string) {
        this.onStateChange('PROCESSING_LLM');
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?key=${this.apiKey}`;
        
        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    systemInstruction: { parts: [{ text: "Keep responses concise, conversational, and direct (1-3 sentences max)." }] }
                })
            });
            
            if (!response.ok) throw new Error("Streaming failed");
            
            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
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
                                this.onAIResponse(textChunk);
                                this.speak(textChunk);
                            }
                        } catch (e) {
                            console.error("Error parsing SSE chunk:", e);
                        }
                    }
                }
            }
        } catch (e) {
            console.error("LLM Error:", e);
            this.onStateChange('IDLE');
        }
    }
    
    public speak(text: string) {
        this.onStateChange('SPEAKING_TTS');
        if (this.synth.speaking) this.synth.cancel();
        
        const sentences = text.match(/[^.!?؟]+[.!?؟]+|\S+$/g) || [text];
        
        sentences.forEach((sentence) => {
            const utterance = new SpeechSynthesisUtterance(sentence.trim());
            const targetVoice = this.voices.find(v => v.lang.includes('ar') || v.lang.includes('en'));
            if (targetVoice) utterance.voice = targetVoice;
            
            utterance.onend = () => {
                this.onStateChange('IDLE');
            };
            
            this.synth.speak(utterance);
        });
    }
}

export default VoicePipeline;