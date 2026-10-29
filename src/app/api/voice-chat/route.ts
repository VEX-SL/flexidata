import { getProviderManager } from "../../../lib/ai/manager";
import { AIRequest } from "@/types";

interface IncomingMessage {
  role: "system" | "user" | "assistant";
  content: string;
}


export async function POST(req: Request) {
  try {
    const { messages, systemPrompt } = await req.json();

    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ error: "Messages required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const providerManager = getProviderManager();

    const systemMsg: IncomingMessage = {
      role: "system",
      content: systemPrompt || "أنت مساعد ذكي ناطق بالعربية. اجعل ردودك مختصرة ومباشرة ومحادثة (1-3 جمل كحد أقصى). تجنب التنسيق المعقد. تحدث بشكل طبيعي."
    };

    const request: AIRequest = {
      messages: [systemMsg, ...messages.map((m: IncomingMessage) => ({ role: m.role, content: m.content }))],
      temperature: 0.7,
      maxTokens: 1024,
    };

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