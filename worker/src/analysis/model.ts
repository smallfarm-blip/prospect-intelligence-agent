import type { ModelSettings } from "./config.ts";

export type CallRole = "analyst" | "verifier" | "revision";

export type ContentBlock = { type: "text"; text: string } | { type: "image"; ref: string; mediaType: "image/jpeg"; data: Buffer; estimatedTokens: number };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  role: CallRole | "screening";
  settings: ModelSettings;
  system: string;
  content: ContentBlock[];
  tool: ToolSpec;
}

/** "provider" = counted by the provider's API; "estimate" = conservative local estimate. */
export interface TokenCount {
  tokens: number;
  method: "provider" | "estimate";
}

export interface ModelResponse {
  toolInput: unknown;
  inputTokens: number;
  /** Billed output tokens; for reasoning models this already includes reasoning tokens. */
  outputTokens: number;
  reasoningTokens: number | null;
  /** Provider-neutral: "max_tokens" means the output limit cut the answer off. */
  stopReason: string | null;
  latencyMs: number;
}

export type ModelErrorKind = "timeout" | "network" | "http" | "malformed";

export class ModelCallError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }

  /** Whether the provider may have processed (and billed) the request despite the error. */
  get possiblyBilled(): boolean {
    return this.kind === "timeout" || this.kind === "network" || (this.kind === "http" && (this.status ?? 0) >= 500) || this.kind === "malformed";
  }
}

/** Provider-agnostic model access. Implementations must keep credentials server-side. */
export interface ModelClient {
  readonly provider: string;
  countInputTokens(req: ModelRequest): Promise<TokenCount>;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

/** Revision calls use the analyst's client. */
export interface ModelClients {
  analyst: ModelClient;
  verifier: ModelClient;
}

export async function postJson(url: string, headers: Record<string, string>, payload: unknown, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") throw new ModelCallError("timeout", `No response within ${timeoutMs} ms`);
    throw new ModelCallError("network", `Network error: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 500);
    try {
      const body = JSON.parse(text) as { error?: string | { message?: string }; tag?: string };
      const message = typeof body.error === "string" ? body.error : body.error?.message;
      if (message) detail = body.tag ? `${message} (${body.tag})` : message;
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

/** Rough local count used for dry runs and tests: ~4 characters per text token plus image estimates. */
export function estimateInputTokens(req: Pick<ModelRequest, "system" | "content" | "tool">): number {
  let tokens = Math.ceil((req.system.length + JSON.stringify(req.tool.inputSchema).length) / 4) + 400;
  for (const block of req.content) tokens += block.type === "text" ? Math.ceil(block.text.length / 4) : block.estimatedTokens;
  return tokens;
}

export type MockReply = { toolInput: unknown; outputTokens?: number; reasoningTokens?: number; stopReason?: string } | ModelCallError;

/** Scripted client for tests: each call receives the next reply produced by the responder. */
export class MockModelClient implements ModelClient {
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly responder: (req: ModelRequest, index: number) => MockReply,
    readonly provider = "mock",
  ) {}

  async countInputTokens(req: ModelRequest): Promise<TokenCount> {
    return { tokens: estimateInputTokens(req), method: "estimate" };
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const index = this.requests.push(req) - 1;
    const reply = this.responder(req, index);
    if (reply instanceof ModelCallError) throw reply;
    return {
      toolInput: reply.toolInput,
      inputTokens: estimateInputTokens(req),
      outputTokens: reply.outputTokens ?? 1500,
      reasoningTokens: reply.reasoningTokens ?? null,
      stopReason: reply.stopReason ?? "tool_use",
      latencyMs: 1,
    };
  }
}
