export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
