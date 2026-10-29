import { getProviderManager } from "@/lib/ai/manager";
import type { AIRequest } from "@/types";

export async function POST(req: Request) {
  try {
    const { messages, systemPrompt } = await req.json() as {
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      systemPrompt?: string;
    };

    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ error: "Messages required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const providerManager = getProviderManager();

    // Convert to AIRequest format
    const request: AIRequest = {
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: 0.7,
      maxTokens: 1024,
    };

    // Use streaming from provider manager
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of providerManager.streamChatCompletion(request)) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
          controller.close();
        } catch (error) {
          console.error("Voice chat streaming error:", error);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "Streaming failed" })}\n\n`));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (error) {
    console.error("Voice chat API error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}