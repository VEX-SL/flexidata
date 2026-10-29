import { useState, useEffect, useRef } from 'react';
import VoicePipeline from '@/lib/voice/voice-pipeline';

const AudioChat = ({ onClose }: { onClose: () => void }) => {
    const [state, setState] = useState<string>('IDLE');
    const voicePipelineRef = useRef<VoicePipeline | null>(null);
    const [isOpen, setIsOpen] = useState(true);
    
    useEffect(() => {
        const apiKey = 'YOUR_API_KEY_HERE'; // استبدل هذا بالAPI key الخاص بك
        voicePipelineRef.current = new VoicePipeline({
            apiKey,
            onStateChange: setState,
            onTranscript: (transcript) => {
                console.log('Transcript:', transcript);
            },
            onAIResponse: (response) => {
                console.log('AI Response:', response);
            }
        });
        
        return () => {
            if (voicePipelineRef.current) {
                voicePipelineRef.current.stop();
            }
        };
    }, []);
    
    const handleStartListening = () => {
        if (voicePipelineRef.current) {
            voicePipelineRef.current.start();
        }
    };
    
    const handleStopListening = () => {
        if (voicePipelineRef.current) {
            voicePipelineRef.current.stop();
        }
    };
    
    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-bold">Voice Chat</h2>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>
                <div className="flex flex-col items-center gap-4">
                    <div className="text-center p-4 bg-gray-50 rounded-lg">
                        {state === 'LISTENING' && (
                            <div className="flex flex-col items-center">
                                <div className="animate-pulse text-blue-500 text-2xl">🎤</div>
                                <p>Listening...</p>
                            </div>
                        )}
                        {state === 'PROCESSING_LLM' && (
                            <div className="flex flex-col items-center">
                                <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500 mx-auto my-2"></div>
                                <p>Processing...</p>
                            </div>
                        )}
                        {state === 'SPEAKING_TTS' && (
                            <div className="flex flex-col items-center">
                                <div className="animate-pulse text-green-500 text-2xl">🎙️</div>
                                <p>Speaking...</p>
                            </div>
                        )}
                        {state === 'IDLE' && (
                            <div className="flex flex-col items-center">
                                <div className="text-gray-400 text-2xl">🎤</div>
                                <p>Ready to speak</p>
                            </div>
                        )}
                    </div>
                    <div className="flex gap-4">
                        <button
                            onClick={handleStartListening}
                            className="bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded-lg flex items-center gap-2"
                            disabled={state === 'LISTENING' || state === 'PROCESSING_LLM' || state === 'SPEAKING_TTS'}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 0l-3 3a1 1 0 001.414 1.414L9 9.414V13a1 1 0 102 0V9.414l1.293 1.293a1 1 0 001.414-1.414z" clipRule="evenodd" /></svg>
                            Start Listening
                        </button>
                        <button
                            onClick={handleStopListening}
                            className="bg-gray-500 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg"
                            disabled={state !== 'LISTENING'}
                        >
                            Stop
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AudioChat;