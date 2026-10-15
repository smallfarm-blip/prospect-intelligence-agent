import type { ModelSettings } from "./config.ts";

export type CallRole = "analyst" | "verifier" | "revision";

export type ContentBlock = { type: "text"; text: string } | { type: "image"; ref: string; mediaType: "image/jpeg"; data: Buffer; estimatedTokens: number };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  role: CallRole;
  settings: ModelSettings;
  system: string;
  content: ContentBlock[];
  tool: ToolSpec;
}

export interface ModelResponse {
  toolInput: unknown;
  inputTokens: number;
  outputTokens: number;
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
  countInputTokens(req: ModelRequest): Promise<number>;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

/** Rough local count used for dry runs and tests: ~4 characters per text token plus image estimates. */
export function estimateInputTokens(req: Pick<ModelRequest, "system" | "content" | "tool">): number {
  let tokens = Math.ceil((req.system.length + JSON.stringify(req.tool.inputSchema).length) / 4) + 400;
  for (const block of req.content) tokens += block.type === "text" ? Math.ceil(block.text.length / 4) : block.estimatedTokens;
  return tokens;
}

export type MockReply = { toolInput: unknown; outputTokens?: number; stopReason?: string } | ModelCallError;

/** Scripted client for tests: each call receives the next reply produced by the responder. */
export class MockModelClient implements ModelClient {
  readonly provider = "mock";
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responder: (req: ModelRequest, index: number) => MockReply) {}

  async countInputTokens(req: ModelRequest): Promise<number> {
    return estimateInputTokens(req);
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const index = this.requests.push(req) - 1;
    const reply = this.responder(req, index);
    if (reply instanceof ModelCallError) throw reply;
    return {
      toolInput: reply.toolInput,
      inputTokens: estimateInputTokens(req),
      outputTokens: reply.outputTokens ?? 1500,
      stopReason: reply.stopReason ?? "tool_use",
      latencyMs: 1,
    };
  }
}
