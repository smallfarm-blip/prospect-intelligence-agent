import { AnthropicClient } from "./anthropic.ts";
import type { AnalysisConfig, ModelSettings } from "./config.ts";
import type { ModelClient, ModelClients } from "./model.ts";
import { OpenAIClient } from "./openai.ts";

/** Builds one client per configured provider and assigns each role the client matching its settings. */
export function createClients(config: AnalysisConfig): ModelClients {
  const cache = new Map<string, ModelClient>();
  const forSettings = (s: ModelSettings): ModelClient => {
    const existing = cache.get(s.provider);
    if (existing) return existing;
    const timeoutMs = config.modelTimeoutMs;
    const client =
      s.provider === "openai"
        ? new OpenAIClient({ apiKey: config.openaiApiKey, baseUrl: config.openaiBaseUrl, timeoutMs })
        : new AnthropicClient({ apiKey: config.anthropicApiKey, baseUrl: config.anthropicBaseUrl, timeoutMs });
    cache.set(s.provider, client);
    return client;
  };
  return { analyst: forSettings(config.analyst), verifier: forSettings(config.verifier) };
}
