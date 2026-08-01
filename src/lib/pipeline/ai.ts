import { getProviderManager } from "@/lib/ai/manager";
import type { AIClient } from "./types";

/**
 * Default AIClient — the ONLY place in the pipeline that touches a concrete
 * provider (ProviderManager). Stages depend on the `AIClient` interface; this
 * adapter is the dependency-inversion boundary. ProviderManager stays fully
 * independent of the pipeline (never imports it).
 */
export const defaultAIClient: AIClient = {
  chatCompletion: (request) => getProviderManager().chatCompletion(request),
};
