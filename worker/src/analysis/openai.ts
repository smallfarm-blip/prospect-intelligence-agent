import { ModelCallError, estimateInputTokens, postJson, type ModelClient, type ModelRequest, type ModelResponse, type TokenCount } from "./model.ts";

interface OpenAIOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

/**
 * Used only if the provider cannot count tokens for the configured model. Deliberately generous
 * because OpenAI image token accounting differs from the local (Anthropic-style) image estimate.
 */
export const ESTIMATE_SAFETY_FACTOR = 1.5;

/** Keywords OpenAI strict structured outputs accept. Everything else is still enforced by our own zod validation. */
const STRICT_KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "description",
  "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "$defs", "$ref",
]);

/**
 * Converts our JSON schema to the subset OpenAI strict mode accepts: every object closed and every
 * property required. Throws on optional properties rather than silently changing their meaning.
 * Dropped keywords (e.g. string length limits) are listed in `localOnly` and still checked locally.
 */
export function strictSchema(schema: Record<string, unknown>): { schema: Record<string, unknown>; localOnly: string[] } {
  const localOnly = new Set<string>();
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((n, i) => walk(n, `${path}[${i}]`));
    if (!node || typeof node !== "object") return node;
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src)) {
      if (!STRICT_KEYWORDS.has(key)) {
        localOnly.add(key);
        continue;
      }
      if (key === "properties" || key === "$defs") {
        out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, `${path}.${k}`)]));
      } else if (key === "items" || key === "anyOf") {
        out[key] = walk(value, path);
      } else out[key] = value;
    }
    if (src.type === "object" || src.properties) {
      const keys = Object.keys((src.properties as Record<string, unknown>) ?? {});
      const required = new Set((src.required as string[]) ?? []);
      const optional = keys.filter((k) => !required.has(k));
      if (optional.length) throw new Error(`Strict structured output needs every property required; optional at ${path || "(root)"}: ${optional.join(", ")}`);
      out.required = keys;
      out.additionalProperties = false;
    }
    return out;
  };
  return { schema: walk(schema, "") as Record<string, unknown>, localOnly: [...localOnly].sort() };
}

interface ResponsesOutputItem {
  type: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type: string; refusal?: string }>;
}

interface ResponsesBody {
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: ResponsesOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
}

/** OpenAI Responses API. Structured output is a single forced strict function call validated by the caller. */
export class OpenAIClient implements ModelClient {
  readonly provider = "openai";

  constructor(private readonly opts: OpenAIOptions) {
    if (!opts.apiKey) throw new Error("OPENAI_API_KEY is required for live analysis");
  }

  private request(req: ModelRequest) {
    const detail = req.settings.imageDetail ?? "high";
    return {
      model: req.settings.model,
      instructions: req.system,
      input: [
        {
          role: "user",
          content: req.content.map((b) =>
            b.type === "text" ? { type: "input_text", text: b.text } : { type: "input_image", image_url: `data:${b.mediaType};base64,${b.data.toString("base64")}`, detail },
          ),
        },
      ],
      tools: [{ type: "function", name: req.tool.name, description: req.tool.description, parameters: strictSchema(req.tool.inputSchema).schema, strict: true }],
      tool_choice: { type: "function", name: req.tool.name },
      ...(req.settings.reasoningEffort ? { reasoning: { effort: req.settings.reasoningEffort } } : {}),
    };
  }

  private post(path: string, payload: unknown, timeoutMs: number) {
    return postJson(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, { authorization: `Bearer ${this.opts.apiKey}` }, payload, timeoutMs);
  }

  async countInputTokens(req: ModelRequest): Promise<TokenCount> {
    try {
      const data = (await this.post("/v1/responses/input_tokens", this.request(req), 60_000)) as { input_tokens?: unknown };
      if (typeof data.input_tokens !== "number") throw new ModelCallError("malformed", "Token count response had no input_tokens");
      return { tokens: data.input_tokens, method: "provider" };
    } catch (err) {
      if (err instanceof ModelCallError && err.kind === "http" && err.status === 404) {
        return { tokens: Math.ceil(estimateInputTokens(req) * ESTIMATE_SAFETY_FACTOR), method: "estimate" };
      }
      throw err;
    }
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();
    const payload = {
      ...this.request(req),
      max_output_tokens: req.settings.maxOutputTokens,
      parallel_tool_calls: false,
      store: false,
      ...(req.settings.serviceTier ? { service_tier: req.settings.serviceTier } : {}),
    };
    const data = (await this.post("/v1/responses", payload, this.opts.timeoutMs)) as ResponsesBody;
    if (data.status === "failed") throw new ModelCallError("http", `Provider reported a failed response: ${data.error?.message ?? "no detail"}`, 500);
    const usage = data.usage;
    if (!usage || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
      throw new ModelCallError("malformed", "Provider response had no usage information");
    }

    const call = data.output?.find((o) => o.type === "function_call" && o.name === req.tool.name);
    let toolInput: unknown = null;
    if (call?.arguments) {
      try {
        toolInput = JSON.parse(call.arguments);
      } catch {
        toolInput = null;
      }
    }
    const refused = data.output?.some((o) => o.content?.some((c) => c.type === "refusal"));
    const stopReason =
      data.status === "incomplete"
        ? data.incomplete_details?.reason === "max_output_tokens"
          ? "max_tokens"
          : data.incomplete_details?.reason ?? "incomplete"
        : refused
          ? "refusal"
          : call
            ? "tool_use"
            : data.status ?? null;

    return {
      toolInput,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
      stopReason,
      latencyMs: Date.now() - started,
    };
  }
}
