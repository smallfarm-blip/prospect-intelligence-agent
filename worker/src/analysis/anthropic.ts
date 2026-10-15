import { ModelCallError, postJson, type ModelClient, type ModelRequest, type ModelResponse, type TokenCount } from "./model.ts";

const API_VERSION = "2023-06-01";

interface AnthropicOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

/** Anthropic Messages API. Structured output is a single forced tool call validated by the caller. */
export class AnthropicClient implements ModelClient {
  readonly provider = "anthropic";

  constructor(private readonly opts: AnthropicOptions) {
    if (!opts.apiKey) throw new Error("ANTHROPIC_API_KEY is required for live analysis");
  }

  private body(req: ModelRequest) {
    return {
      model: req.settings.model,
      system: req.system,
      messages: [
        {
          role: "user",
          content: req.content.map((b) =>
            b.type === "text" ? { type: "text", text: b.text } : { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data.toString("base64") } },
          ),
        },
      ],
      tools: [{ name: req.tool.name, description: req.tool.description, input_schema: req.tool.inputSchema }],
      tool_choice: { type: "tool", name: req.tool.name },
    };
  }

  private post(path: string, payload: unknown, timeoutMs: number) {
    return postJson(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, { "x-api-key": this.opts.apiKey, "anthropic-version": API_VERSION }, payload, timeoutMs);
  }

  async countInputTokens(req: ModelRequest): Promise<TokenCount> {
    const data = (await this.post("/v1/messages/count_tokens", this.body(req), 60_000)) as { input_tokens?: unknown };
    if (typeof data.input_tokens !== "number") throw new ModelCallError("malformed", "Token count response had no input_tokens");
    return { tokens: data.input_tokens, method: "provider" };
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const data = (await this.post("/v1/messages", { ...this.body(req), max_tokens: req.settings.maxOutputTokens }, this.opts.timeoutMs)) as {
      content?: Array<{ type: string; name?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    };
    if (!data.usage || typeof data.usage.input_tokens !== "number" || typeof data.usage.output_tokens !== "number") {
      throw new ModelCallError("malformed", "Provider response had no usage information");
    }
    const tool = data.content?.find((c) => c.type === "tool_use" && c.name === req.tool.name);
    return {
      toolInput: tool?.input ?? null,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
      reasoningTokens: null,
      stopReason: data.stop_reason ?? null,
      latencyMs: Date.now() - started,
    };
  }
}
