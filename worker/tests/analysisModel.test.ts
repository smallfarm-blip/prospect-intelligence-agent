import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AnthropicClient } from "../src/analysis/anthropic.ts";
import { loadAnalysisConfig } from "../src/analysis/config.ts";
import { ModelCallError, type ModelRequest } from "../src/analysis/model.ts";
import { MODEL } from "./helpers/pipelineFixtures.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const req: ModelRequest = {
  role: "analyst",
  settings: MODEL,
  system: "sys",
  content: [
    { type: "text", text: "hello" },
    { type: "image", ref: "IMG-01", mediaType: "image/jpeg", data: Buffer.from("jpg"), estimatedTokens: 10 },
  ],
  tool: { name: "submit_analyst_result", description: "d", inputSchema: { type: "object" } },
};

function fakeFetch(handler: (url: string, body: Record<string, unknown>, headers: Record<string, string>) => Response) {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    seen.push({ url, body });
    return handler(url, body, init.headers as Record<string, string>);
  }) as typeof fetch;
  return seen;
}

const client = () => new AnthropicClient({ apiKey: "sk-test", baseUrl: "https://api.example.test", timeoutMs: 1000 });

test("forces a single tool call, sends images as base64 and returns usage", async () => {
  const seen = fakeFetch((url, _b, headers) => {
    assert.equal(headers["x-api-key"], "sk-test");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    if (url.endsWith("/count_tokens")) return Response.json({ input_tokens: 1234 });
    return Response.json({ content: [{ type: "tool_use", name: "submit_analyst_result", input: { ok: true } }], usage: { input_tokens: 1200, output_tokens: 300 }, stop_reason: "tool_use" });
  });
  assert.deepEqual(await client().countInputTokens(req), { tokens: 1234, method: "provider" });
  assert.equal((await client().complete(req)).reasoningTokens, null);
  const res = await client().complete(req);
  seen.splice(1, 1);
  assert.deepEqual(res.toolInput, { ok: true });
  assert.equal(res.inputTokens, 1200);
  assert.equal(res.outputTokens, 300);
  const body = seen[1].body;
  assert.deepEqual(body.tool_choice, { type: "tool", name: "submit_analyst_result" });
  assert.equal(body.max_tokens, MODEL.maxOutputTokens);
  assert.equal(seen[0].body.max_tokens, undefined, "count_tokens takes no max_tokens");
  const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
  assert.deepEqual(content[1], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from("jpg").toString("base64") } });
});

test("provider errors become typed errors; 4xx is not billed, timeouts may be", async () => {
  fakeFetch(() => Response.json({ error: { message: "invalid model" } }, { status: 400 }));
  const err = await client().complete(req).catch((e) => e);
  assert.ok(err instanceof ModelCallError);
  assert.equal(err.kind, "http");
  assert.match(err.message, /invalid model/);
  assert.equal(err.possiblyBilled, false);

  globalThis.fetch = (async () => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  }) as typeof fetch;
  const t = await client().complete(req).catch((e) => e);
  assert.equal(t.kind, "timeout");
  assert.equal(t.possiblyBilled, true);
});

test("a response without usage is malformed", async () => {
  fakeFetch(() => Response.json({ content: [] }));
  await assert.rejects(client().complete(req), (e: ModelCallError) => e.kind === "malformed");
});

test("live mode requires an API key; dry runs do not", () => {
  const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x" };
  assert.throws(() => loadAnalysisConfig(env, { live: true }), /ANTHROPIC_API_KEY/);
  const cfg = loadAnalysisConfig(env, { live: false });
  assert.equal(cfg.analyst.model, "claude-sonnet-5-5");
  assert.equal(cfg.limits.budgetUsd, 2.5);
  assert.equal(loadAnalysisConfig({ ...env, ANALYST_MODEL: "other-model", ANALYST_INPUT_USD_PER_MTOK: "3", ANALYST_OUTPUT_USD_PER_MTOK: "15", ANALYSIS_BUDGET_USD: "1" }, { live: false }).analyst.model, "other-model");
  assert.throws(() => new AnthropicClient({ apiKey: "", baseUrl: "x", timeoutMs: 1 }), /ANTHROPIC_API_KEY/);
});
