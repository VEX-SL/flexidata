// ✅ Multimodal (vision) content — OpenAI-style parts. User messages that
// carry an attached chat image are sent as [{ type: "text" }, { type:
// "image_url" }]; ProviderManager.hasImages() detects them and routes the
// request to the vision-capable models (Gemini / OpenRouter VL / Groq).
export interface MessageContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  inline_data?: { mime_type: string; data: string };
}

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string | MessageContentPart[];
}

export interface AIRequest {
  messages: AIMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface AIResponse {
  content: string;
  model?: string;
  /** Provider name that served the request (e.g. "groq"). */
  provider?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}
