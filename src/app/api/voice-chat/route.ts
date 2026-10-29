import { getProviderManager } from "../../../lib/ai/manager";
import { AIRequest } from "@/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  try {
    const { messages, systemPrompt, temperature, maxTokens, chatId, agentId } = await req.json();

    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ error: "Messages required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Get user session for chat persistence using Supabase auth
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id;

    const providerManager = getProviderManager();

    // Check if first message is already a system message
    const hasSystemMessage = messages.length > 0 && messages[0].role === 'system';
    const systemContent = systemPrompt || "أنت مساعد ذكي ناطق بالعربية. اجعل ردودك مختصرة ومباشرة ومحادثة (1-3 جمل كحد أقصى). تجنب التنسيق المعقد. تحدث بشكل طبيعي.";
    
    const requestMessages = hasSystemMessage 
      ? messages 
      : [{ role: 'system' as const, content: systemContent }, ...messages];

    const request: AIRequest = {
      messages: requestMessages,
      temperature: temperature ?? 0.7,
      maxTokens: maxTokens ?? 1024,
    };

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          let fullResponse = '';
          
          for await (const chunk of providerManager.streamChatCompletion(request)) {
            fullResponse += chunk;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
          }
          
          // Save to database if we have chatId and userId
          if (userId && chatId) {
            try {
              const supabaseAdmin = createAdminClient();
              
              // Save user message (last user message in the conversation)
              const lastUserMessage = messages.filter((m: { role: string }) => m.role === 'user').pop();
              if (lastUserMessage) {
                await supabaseAdmin.from("messages").insert({
                  chat_id: chatId,
                  role: "user",
                  content: lastUserMessage.content,
                });
              }
              
              // Save assistant response
              if (fullResponse.trim()) {
                await supabaseAdmin.from("messages").insert({
                  chat_id: chatId,
                  role: "assistant",
                  content: fullResponse.trim(),
                });
                
                // Update chat timestamp
                await supabaseAdmin
                  .from("chats")
                  .update({ updated_at: new Date().toISOString() })
                  .eq("id", chatId);
              }
            } catch (dbError) {
              console.error("Voice chat DB save error:", dbError);
              // Don't fail the response if DB save fails
            }
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