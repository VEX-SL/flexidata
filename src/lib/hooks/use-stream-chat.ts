"use client";

import { useState, useRef, useCallback } from "react";

export interface GeneratedImage {
  url: string;
  prompt: string;
}

interface StreamChatOptions {
  agentId?: string;
}

export function useStreamChat(options: StreamChatOptions = {}) {
  const [streaming, setStreaming] = useState(false);
  const [streamedContent, setStreamedContent] = useState("");
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Debug state
  const debugRef = useRef({
    requestStartTime: 0,
    firstTokenTime: 0,
    totalTokens: 0,
    eventsReceived: [] as Array<{ type: string; data: string; timestamp: number }>,
    providerUsed: null as string | null,
    error: null as string | null,
  });

  const sendStream = useCallback(
    async (
      chatId: string | null,
      content: string
    ): Promise<{
      chatId: string;
      title: string | null;
      fullContent: string;
      images: GeneratedImage[];
    } | null> => {
      // Reset debug state
      debugRef.current = {
        requestStartTime: Date.now(),
        firstTokenTime: 0,
        totalTokens: 0,
        eventsReceived: [],
        providerUsed: null,
        error: null,
      };

      const logEvent = (type: string, data: string) => {
        const timestamp = Date.now();
        debugRef.current.eventsReceived.push({ type, data, timestamp });
        console.log(`[useStreamChat DEBUG] ${type}:`, data.substring(0, 200), timestamp === debugRef.current.requestStartTime ? "" : `(+${timestamp - debugRef.current.requestStartTime}ms)`);
      };

      console.group(`🚀 [useStreamChat] Sending message${options.agentId ? ` (agent: ${options.agentId})` : " (general)"}`);
      console.log("Request payload:", { chatId, content: content.substring(0, 100) + (content.length > 100 ? "..." : ""), agentId: options.agentId });
      console.groupEnd();

      abortRef.current?.abort();
      abortRef.current = new AbortController();

      setStreaming(true);
      setStreamedContent("");
      setGeneratedImages([]);

      try {
        const fetchStart = Date.now();
        const res = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            content,
            agentId: options.agentId,
          }),
          signal: abortRef.current.signal,
        });

        const fetchDuration = Date.now() - fetchStart;
        console.log(`[useStreamChat DEBUG] Fetch response received in ${fetchDuration}ms, status: ${res.status}, ok: ${res.ok}`);
        console.log("[useStreamChat DEBUG] Response headers:", Object.fromEntries(res.headers.entries()));

        if (!res.ok) {
          const err = await res.json();
          debugRef.current.error = err.error || `HTTP ${res.status}`;
          throw new Error(debugRef.current.error);
        }

        const reader = res.body?.getReader();
        if (!reader) {
          debugRef.current.error = "No stream reader";
          throw new Error("No stream");
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let fullContent = "";
        let resultChatId = chatId || "";
        let resultTitle: string | null = null;
        const images: GeneratedImage[] = [];

        console.log("[useStreamChat DEBUG] Starting to read stream...");

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            console.log("[useStreamChat DEBUG] Stream done (reader closed)");
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const event of events) {
            if (!event.trim()) continue;
            
            const lines = event.split("\n");
            let eventType = "";
            let eventData = "";

            for (const line of lines) {
              if (line.startsWith("event: ")) eventType = line.slice(7);
              if (line.startsWith("data: ")) eventData = line.slice(6);
            }

            logEvent(eventType || "unknown", eventData);

            if (eventType === "token") {
              if (debugRef.current.firstTokenTime === 0) {
                debugRef.current.firstTokenTime = Date.now();
                console.log(`[useStreamChat DEBUG] 🎉 FIRST TOKEN received at +${debugRef.current.firstTokenTime - debugRef.current.requestStartTime}ms`);
              }
              debugRef.current.totalTokens++;
              fullContent += eventData;
              setStreamedContent(fullContent);
            } else if (eventType === "provider") {
              debugRef.current.providerUsed = eventData;
              console.log(`[useStreamChat DEBUG] 🤖 Provider identified: ${eventData}`);
            } else if (eventType === "image") {
              const img = JSON.parse(eventData) as GeneratedImage;
              images.push(img);
              setGeneratedImages([...images]);
              console.log("[useStreamChat DEBUG] 🖼️ Image generated:", img);
            } else if (eventType === "done") {
              const parsed = JSON.parse(eventData);
              resultChatId = parsed.chatId;
              resultTitle = parsed.title;
              debugRef.current.providerUsed = parsed.provider || null;
              console.log("[useStreamChat DEBUG] ✅ Stream completed:", { chatId: resultChatId, title: resultTitle, provider: debugRef.current.providerUsed, totalTokens: debugRef.current.totalTokens, totalTime: Date.now() - debugRef.current.requestStartTime });
            } else if (eventType === "error") {
              debugRef.current.error = eventData;
              throw new Error(eventData);
            }
          }
        }

        // Final summary
        const totalTime = Date.now() - debugRef.current.requestStartTime;
        const firstTokenLatency = debugRef.current.firstTokenTime ? debugRef.current.firstTokenTime - debugRef.current.requestStartTime : null;
        
        console.group(`📊 [useStreamChat] Stream Summary`);
        console.log("Total time:", `${totalTime}ms`);
        console.log("First token latency:", firstTokenLatency ? `${firstTokenLatency}ms` : "N/A (no tokens)");
        console.log("Total tokens received:", debugRef.current.totalTokens);
        console.log("Provider used:", debugRef.current.providerUsed || "unknown (check server logs)");
        console.log("Events received:", debugRef.current.eventsReceived.length);
        console.log("Full content length:", fullContent.length);
        console.log("Images generated:", images.length);
        console.log("Error:", debugRef.current.error || "none");
        console.groupEnd();

        return {
          chatId: resultChatId,
          title: resultTitle,
          fullContent,
          images,
        };
      } catch (err: any) {
        const totalTime = Date.now() - debugRef.current.requestStartTime;
        debugRef.current.error = err.message;
        
        console.group(`❌ [useStreamChat] Error after ${totalTime}ms`);
        console.error("Error:", err.message);
        console.error("Stack:", err.stack);
        console.log("Debug state:", debugRef.current);
        console.groupEnd();

        if (err.name === "AbortError") return null;
        throw err;
      } finally {
        setStreaming(false);
      }
    },
    [options.agentId]
  );

  const abort = useCallback(() => {
    console.log("[useStreamChat DEBUG] Abort called");
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  const reset = useCallback(() => {
    setStreamedContent("");
  }, []);

  return { streaming, streamedContent, generatedImages, sendStream, abort, reset };
}
