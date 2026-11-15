"use client";

import { useState, useRef, useCallback } from "react";
import type { BrowserAction, BrowserPageContext } from "@/lib/browser-agent/bridge";

export interface GeneratedImage {
  url: string;
  prompt: string;
}

interface SkillInfo {
  name: string;
  display_name: string;
}

export interface ToolStep {
  type: "thinking" | "skill" | "file_edit" | "new_file" | "file_delete" | "image" | "search" | "cmd" | "browser";
  title: string;
  content?: string;
  duration_ms?: number;
  timestamp?: number;
}

interface StreamChatOptions {
  agentId?: string;
  onToolsAvailable?: (tools: string[], skills: SkillInfo[]) => void;
  onToolStep?: (step: ToolStep) => void;
}

export function useStreamChat(options: StreamChatOptions = {}) {
  const [streaming, setStreaming] = useState(false);
  const [streamedContent, setStreamedContent] = useState("");
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([]);
  const [liveToolSteps, setLiveToolSteps] = useState<ToolStep[]>([]);
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
      content: string,
      opts?: {
        replaceMessageId?: string;
        browserContext?: BrowserPageContext;
        internalBrowserTurn?: boolean;
        browserActionResult?: string;
        forceBrowserSkill?: boolean;
      }
    ): Promise<{
      chatId: string;
      title: string | null;
      fullContent: string;
      images: GeneratedImage[];
      availableTools: string[];
      toolSteps: ToolStep[];
      // ✅ Real DB ids from the meta/done events (null in regenerate mode or
      // if the route is an older version). The page uses them to replace its
      // temporary message ids so later regenerations send a valid UUID.
      userMessageId: string | null;
      assistantMessageId: string | null;
      browserAction?: BrowserAction | null;
      // ✅ True when the user pressed Stop. The hook then returns everything
      // generated SO FAR (fullContent/toolSteps are partial) instead of
      // null, so the page can keep the partial reply visible.
      aborted?: boolean;
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
      setLiveToolSteps([]);

      try {
        const fetchStart = Date.now();
        const res = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId,
            content,
            agentId: options.agentId,
            replaceMessageId: opts?.replaceMessageId,
            browserContext: opts?.browserContext,
            internalBrowserTurn: opts?.internalBrowserTurn,
            browserActionResult: opts?.browserActionResult,
            forceBrowserSkill: opts?.forceBrowserSkill,
          }),
          signal: abortRef.current.signal,
        });

        const fetchDuration = Date.now() - fetchStart;
        console.log(`[useStreamChat DEBUG] Fetch response received in ${fetchDuration}ms, status: ${res.status}, ok: ${res.ok}`);
        console.log("[useStreamChat DEBUG] Response headers:", Object.fromEntries(res.headers.entries()));

        if (!res.ok) {
          const err = await res.json();
          const errorMessage = err.error || `HTTP ${res.status}`;
          debugRef.current.error = errorMessage;
          throw new Error(errorMessage);
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
        // Track tools/usedTool inside the hook so we can return them in the
        // result (avoids React state batching issues where the page reads
        // currentAvailableTools before the state update propagates).
        let resultAvailableTools: string[] = [];
        const resultToolSteps: ToolStep[] = [];
        // ✅ Real DB ids returned by the done event
        let resultUserMessageId: string | null = null;
        let resultAssistantMessageId: string | null = null;
        let resultBrowserAction: BrowserAction | null = null;

        // Helper: when we receive a tool_step event, either update the
        // existing step (if same timestamp) or append a new one. Then push
        // to the live state for the streaming UI.
        const handleToolStep = (step: ToolStep) => {
          // If a step with the same timestamp exists, update it (route
          // emits the step twice: once on creation, once with content).
          const existingIdx = resultToolSteps.findIndex(
            (s) => s.timestamp === step.timestamp && s.type === step.type
          );
          if (existingIdx >= 0) {
            resultToolSteps[existingIdx] = { ...resultToolSteps[existingIdx], ...step };
          } else {
            resultToolSteps.push(step);
          }
          setLiveToolSteps([...resultToolSteps]);
          if (options.onToolStep) {
            options.onToolStep(step);
          }
        };

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

            const lines = event.split(/\r?\n/);
            let eventType = "";
            const dataLines: string[] = [];

            for (const line of lines) {
              if (line.startsWith("event: ")) eventType = line.slice(7);
              // SSE allows a single event to carry multiple data fields; the
              // browser concatenates them with `\n`. Preserve that behavior
              // so streamed Markdown/code keeps its original line breaks.
              if (line.startsWith("data:")) {
                dataLines.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
              }
            }
            const eventData = dataLines.join("\n");

            logEvent(eventType || "unknown", eventData);

            if (eventType === "meta") {
              // ── NEW: sent by the route BEFORE streaming starts, right after
              // the chat/user message are created. Capturing the ids here
              // means an aborted stream still knows which chat + user
              // message it belongs to (needed to keep the partial reply).
              try {
                const meta = JSON.parse(eventData);
                if (meta.chatId) resultChatId = meta.chatId;
                if (meta.userMessageId) resultUserMessageId = meta.userMessageId;
                console.log("[useStreamChat DEBUG] 🪪 Meta received:", { chatId: resultChatId, userMessageId: resultUserMessageId });
              } catch (e) {
                console.warn("[useStreamChat] Failed to parse meta event:", e);
              }
            } else if (eventType === "token") {
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
            } else if (eventType === "tools_available") {
              // ── NEW: handle tools_available event from the route ──
              // Fallback: if `tools` is empty but `skills` exists, use skill
              // display_names as the visible "tools" list. This handles
              // skills that don't declare required_tools.
              try {
                const data = JSON.parse(eventData);
                const rawTools: string[] = Array.isArray(data.tools) ? data.tools : [];
                const skills: SkillInfo[] = Array.isArray(data.skills) ? data.skills : [];

                // Build the final tools list: prefer required_tools, fall
                // back to skill display_names so the badge isn't empty.
                const finalTools: string[] = rawTools.length > 0
                  ? rawTools
                  : skills.map(s => s.display_name || s.name).filter(Boolean);

                // Save in the result so the page can read it directly
                resultAvailableTools = finalTools;

                console.log(`[useStreamChat DEBUG] 🛠️ Tools available (${finalTools.length}):`, finalTools);
                console.log(`[useStreamChat DEBUG] 📋 Skills (${skills.length}):`, skills.map(s => s.name).join(", "));
                if (options.onToolsAvailable) {
                  options.onToolsAvailable(finalTools, skills);
                }
              } catch (e) {
                console.warn("[useStreamChat] Failed to parse tools_available event:", e);
              }
            } else if (eventType === "tool_used") {
              // LEGACY: kept for backwards-compat (route.ts no longer emits
              // this; tool_step is the new event)
              console.log("[useStreamChat DEBUG] ✨ Tool used (legacy event):", eventData);
            } else if (eventType === "tool_step") {
              // ── NEW: handle tool_step event (skill invocation, file edit,
              // image generation, etc.) ──
              try {
                const step = JSON.parse(eventData) as ToolStep;
                console.log(`[useStreamChat DEBUG] 📌 Tool step: ${step.type} - ${step.title}`);
                handleToolStep(step);
              } catch (e) {
                console.warn("[useStreamChat] Failed to parse tool_step event:", e);
              }
            } else if (eventType === "browser_action") {
              try {
                resultBrowserAction = JSON.parse(eventData) as BrowserAction;
              } catch (e) {
                console.warn("[useStreamChat] Failed to parse browser_action event:", e);
              }
            } else if (eventType === "clear") {
              // ── NEW: clear streamed content (used before re-prompting with skill content) ──
              console.log("[useStreamChat DEBUG] 🧹 Clearing stream for re-prompt");
              fullContent = "";
              setStreamedContent("");
            } else if (eventType === "replace_content") {
              // ── NEW: replace the streamed content with the fixed version ──
              // (used by the route when it normalizes file blocks after the
              // stream finishes — fixes raw HTML/JS that got eaten by the
              // markdown renderer)
              console.log(`[useStreamChat DEBUG] 🔄 Replacing streamed content (${eventData.length} chars)`);
              fullContent = eventData;
              setStreamedContent(fullContent);
            } else if (eventType === "done") {
              const parsed = JSON.parse(eventData);
              resultChatId = parsed.chatId;
              resultTitle = parsed.title;
              resultUserMessageId = parsed.userMessageId ?? null;
              resultAssistantMessageId = parsed.assistantMessageId ?? null;
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
          availableTools: resultAvailableTools,
          toolSteps: resultToolSteps,
          userMessageId: resultUserMessageId,
          assistantMessageId: resultAssistantMessageId,
          browserAction: resultBrowserAction,
        };
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        // ✅ User pressed Stop → the fetch/reader rejects with AbortError
        // ("signal is aborted without reason"). That is normal control
        // flow, NOT an error: it must never hit console.error — the
        // Next.js dev overlay surfaces console.error as a runtime error
        // and spams the run panel with a fake stack trace.
        const isAbort =
          error.name === "AbortError" ||
          (/abort/i.test(error.message) &&
            abortRef.current?.signal.aborted === true);

        if (isAbort) {
          console.info(
            `[useStreamChat] ⏹️ Stream aborted by user after ${Date.now() - debugRef.current.requestStartTime}ms (${debugRef.current.totalTokens} tokens received)`
          );
          return null;
        }

        const totalTime = Date.now() - debugRef.current.requestStartTime;
        debugRef.current.error = error.message;

        console.group(`❌ [useStreamChat] Error after ${totalTime}ms`);
        console.error("Error:", error.message);
        console.error("Stack:", error.stack);
        console.log("Debug state:", debugRef.current);
        console.groupEnd();

        throw error;
      } finally {
        setStreaming(false);
      }
    },
    [options.agentId, options.onToolsAvailable, options.onToolStep]
  );

  const abort = useCallback(() => {
    console.log("[useStreamChat DEBUG] Abort called");
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  const reset = useCallback(() => {
    setStreamedContent("");
    setLiveToolSteps([]);
  }, []);

  return { streaming, streamedContent, generatedImages, liveToolSteps, sendStream, abort, reset };
}