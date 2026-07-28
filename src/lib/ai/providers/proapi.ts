import { BaseAIProvider } from "./base";
import type { AIRequest, AIResponse } from "@/types";

const PROAPI_BASE_URL = process.env.PROAPI_BASE_URL!;
const PROAPI_API_KEY = process.env.PROAPI_API_KEY!;
const PROAPI_DEVICE_ID = process.env.PROAPI_DEVICE_ID!;

const sessionCache = new Map<string, string>();

async function getOrCreateSession(model: string): Promise<string> {
  if (sessionCache.has(model)) return sessionCache.get(model)!;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${PROAPI_BASE_URL}/create_session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "User-Agent": "okhttp/5.0.0-alpha.3",
        "x-device-id": PROAPI_DEVICE_ID,
        "x-api-key": PROAPI_API_KEY,
        accept: "*/*",
      },
      body: JSON.stringify({ aiModel: model }),
      signal: controller.signal,
    });

    if (!response.ok)
      throw new Error(`ProAPI session creation failed: ${response.status}`);

    const data = await response.json();
    if (!data.id) throw new Error("Invalid session response from ProAPI");

    sessionCache.set(model, data.id);
    return data.id;
  } finally {
    clearTimeout(timer);
  }
}

async function readStream(response: Response): Promise<string> {
  let fullContent = "";
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body from ProAPI");

  const decoder = new TextDecoder();
  let done = false;

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    done = streamDone;
    if (value) {
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data:")) {
          try {
            const json = JSON.parse(line.substring(5).trim());
            if (json.type === "chunk" && json.content) {
              fullContent += json.content;
            }
          } catch {
            // ignore malformed chunks
          }
        }
      }
    }
  }

  return fullContent;
}

export class ProApiProvider extends BaseAIProvider {
  public name = "proapi";

  constructor() {
    super({
      apiKey: PROAPI_API_KEY,
      model: process.env.PROAPI_MODEL || "GPT-4o",
    });
  }

  async chatCompletion(request: AIRequest): Promise<AIResponse> {
    const model = this.config.model!;
    const sessionId = await getOrCreateSession(model);

    const lastUserMsg = [...request.messages]
      .reverse()
      .find((m) => m.role === "user");
    if (!lastUserMsg) throw new Error("No user message");

    const systemMsg = request.messages.find((m) => m.role === "system");
    const fullMessage = `${systemMsg?.content || "You are FlexiData AI."}\n\nUser: ${lastUserMsg.content}`;

    const formData = new FormData();
    formData.append("sessionId", sessionId);
    formData.append("message", fullMessage);

    const response = await this.fetchWithTimeout(`${PROAPI_BASE_URL}/interact`, {
      method: "POST",
      headers: {
        "User-Agent": "okhttp/5.0.0-alpha.3",
        "x-device-id": PROAPI_DEVICE_ID,
        "x-api-key": PROAPI_API_KEY,
        accept: "*/*",
      },
      body: formData,
    });

    if (!response.ok) {
      sessionCache.delete(model);
      throw new Error(`ProAPI interact failed: ${response.status}`);
    }

    const content = await readStream(response);
    if (!content.trim()) throw new Error("ProAPI returned empty response");

    return { content, model };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await getOrCreateSession(this.config.model!);
      return true;
    } catch {
      return false;
    }
  }
}
