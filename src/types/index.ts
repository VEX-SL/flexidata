export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface AIResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

export interface Agent {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  system_prompt: string | null;
  model_preference: string | null;
  temperature: number | null;
  visibility: "private" | "shared" | "public";
  share_token: string | null;
  chats_count: number;
  files_count: number;
  created_at: string;
  updated_at: string;
}

export interface AgentFile {
  id: string;
  agent_id: string;
  file_name: string;
  file_type: string;
  file_url: string | null;
  status: "uploaded" | "processing" | "indexed" | "error";
  error_message: string | null;
  created_at: string;
}

export interface Chat {
  id: string;
  user_id: string;
  agent_id: string | null;
  title: string | null;
  file_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  chat_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}

export interface FileRecord {
  id: string;
  user_id: string;
  name: string;
  original_name: string;
  url: string;
  mime_type: string;
  size_bytes: number;
  extracted_text: string | null;
  status: "processing" | "ready" | "error";
  error_message: string | null;
  created_at: string;
}
