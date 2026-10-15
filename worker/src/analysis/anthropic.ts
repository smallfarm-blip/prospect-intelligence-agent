import { ModelCallError, type ModelClient, type ModelRequest, type ModelResponse } from "./model.ts";

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

  private async post(path: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.opts.apiKey, "anthropic-version": API_VERSION },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === "TimeoutError" || name === "AbortError") throw new ModelCallError("timeout", `No response within ${timeoutMs} ms`);
      throw new ModelCallError("network", `Network error: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 500);
      try {
        detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail;
      } catch {
        // keep raw text
      }
      throw new ModelCallError("http", `Provider returned ${res.status}: ${detail}`, res.status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ModelCallError("malformed", "Provider response was not JSON");
    }
  }

  async countInputTokens(req: ModelRequest): Promise<number> {
    const data = (await this.post("/v1/messages/count_tokens", this.body(req), 60_000)) as { input_tokens?: unknown };
    if (typeof data.input_tokens !== "number") throw new ModelCallError("malformed", "Token count response had no input_tokens");
    return data.input_tokens;
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
      stopReason: data.stop_reason ?? null,
      latencyMs: Date.now() - started,
    };
  }
}
