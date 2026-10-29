declare module "../../../../../types" {
    export interface AIRequest {
        messages: Array<{
            role: "user" | "assistant" | "system";
            content: string;
        }>;
        temperature?: number;
        maxTokens?: number;
        system?: string;
    }
}