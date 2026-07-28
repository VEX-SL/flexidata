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

  const sendStream = useCallback(
    async (
      chatId: string | null,
      content: string,
      refImageUrl?: string
    ): Promise<{
      chatId: string;
      title: string | null;
      fullContent: string;
      images: GeneratedImage[];
    } | null> => {
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      setStreaming(true);
      setStreamedContent("");
      setGeneratedImages([]);

      try {
        const res = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            content,
            agentId: options.agentId,
            refImageUrl: refImageUrl || undefined,
          }),
          signal: abortRef.current.signal,
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed");
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No stream");

        const decoder = new TextDecoder();
        let buffer = "";
        let fullContent = "";
        let resultChatId = chatId || "";
        let resultTitle: string | null = null;
        const images: GeneratedImage[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const event of events) {
            const lines = event.split("\n");
            let eventType = "";
            let eventData = "";

            for (const line of lines) {
              if (line.startsWith("event: ")) eventType = line.slice(7);
              if (line.startsWith("data: ")) eventData = line.slice(6);
            }

            if (eventType === "token") {
              fullContent += eventData;
              setStreamedContent(fullContent);
            } else if (eventType === "image") {
              const img = JSON.parse(eventData) as GeneratedImage;
              images.push(img);
              setGeneratedImages([...images]);
            } else if (eventType === "done") {
              const parsed = JSON.parse(eventData);
              resultChatId = parsed.chatId;
              resultTitle = parsed.title;
            } else if (eventType === "error") {
              throw new Error(eventData);
            }
          }
        }

        return {
          chatId: resultChatId,
          title: resultTitle,
          fullContent,
          images,
        };
      } catch (err: any) {
        if (err.name === "AbortError") return null;
        throw err;
      } finally {
        setStreaming(false);
      }
    },
    [options.agentId]
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  const reset = useCallback(() => {
    setStreamedContent("");
  }, []);

  return { streaming, streamedContent, generatedImages, sendStream, abort, reset };
}
