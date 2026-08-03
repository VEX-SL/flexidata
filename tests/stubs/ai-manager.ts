export interface AIClient {
  chatCompletion(request: {
    messages: { role: string; content: string }[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ content: string; model?: string; provider?: string }>;
}

export function getProviderManager() {
  return {
    chatCompletion: async () => {
      throw new Error(
        "Stubbed @/lib/ai/manager: inject a fake AIClient in tests instead of using the default provider adapter"
      );
    },
    streamChatCompletion: async function* () {
      throw new Error(
        "Stubbed @/lib/ai/manager: streamChatCompletion is not available in tests"
      );
    },
  };
}
