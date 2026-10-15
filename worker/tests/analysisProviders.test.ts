import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AnthropicClient } from "../src/analysis/anthropic.ts";
import { costUsd, worstCaseUsd } from "../src/analysis/budget.ts";
import { createClients } from "../src/analysis/clients.ts";
import { applySettingsProfile, loadAnalysisConfig, type ModelSettings } from "../src/analysis/config.ts";
import { loadEvidencePack } from "../src/analysis/evidence.ts";
import { estimateInputTokens, MockModelClient, ModelCallError, type ModelRequest } from "../src/analysis/model.ts";
import { ESTIMATE_SAFETY_FACTOR, OpenAIClient, strictSchema } from "../src/analysis/openai.ts";
import { runAnalysis, type CallUsageDetail, type PipelineOptions } from "../src/analysis/pipeline.ts";
import { AnalystOutputSchema, RevisionOutputSchema, toolSchema, VerifierOutputSchema } from "../src/analysis/schemas.ts";
import { COMPANY, evidenceRow, LIMITS, RUN, standardFixture } from "./helpers/evidenceFixtures.ts";
import { analystReply, finding, MemorySink, PIPE_LIMITS, verifierReply } from "./helpers/pipelineFixtures.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const GPT: ModelSettings = {
  provider: "openai",
  model: "gpt-6-sol",
  pricing: { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  maxOutputTokens: 12_000,
  imageDetail: "high",
  reasoningEffort: "medium",
  serviceTier: "default",
};
const GPT_VERIFIER: ModelSettings = { ...GPT, maxOutputTokens: 4_000 };
const CLAUDE: ModelSettings = { provider: "anthropic", model: "claude-sonnet-5-5", pricing: { inputUsdPerMTok: 2, outputUsdPerMTok: 10 }, maxOutputTokens: 12_000, imageDetail: null, reasoningEffort: null, serviceTier: null };
const CLAUDE_VERIFIER: ModelSettings = { ...CLAUDE, maxOutputTokens: 4_000 };

const BASE_ENV = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x" };

const req: ModelRequest = {
  role: "analyst",
  settings: GPT,
  system: "sys",
  content: [
    { type: "text", text: "hello" },
    { type: "image", ref: "IMG-01", mediaType: "image/jpeg", data: Buffer.from("jpg"), estimatedTokens: 10 },
  ],
  tool: { name: "submit_analyst_result", description: "d", inputSchema: toolSchema(AnalystOutputSchema) },
};

function fakeFetch(handler: (url: string, body: Record<string, unknown>) => Response) {
  const seen: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    seen.push({ url, body, headers: init.headers as Record<string, string> });
    return handler(url, body);
  }) as typeof fetch;
  return seen;
}

const openai = () => new OpenAIClient({ apiKey: "sk-openai-test", baseUrl: "https://api.example.test/", timeoutMs: 1000 });

const completed = (args: unknown, usage: Record<string, unknown> = { input_tokens: 5000, output_tokens: 900, output_tokens_details: { reasoning_tokens: 400 } }) =>
  Response.json({ status: "completed", output: [{ type: "reasoning" }, { type: "function_call", name: "submit_analyst_result", arguments: JSON.stringify(args) }], usage });

const pack = async () => loadEvidencePack(await standardFixture([evidenceRow("pdp_1", "mobile")]), { researchRunId: RUN, companyDomain: COMPANY.domain }, LIMITS);
const opts = (analyst: ModelSettings, verifier: ModelSettings, over: Partial<PipelineOptions> = {}): PipelineOptions => ({ analyst, verifier, limits: PIPE_LIMITS, workerVersion: "test", revise: false, ...over });
const usageOf = (sink: MemorySink) => (sink.run!.config as { usage: { calls: CallUsageDetail[]; reasoning_tokens: number; uncertain_billing_reserved_usd: number } }).usage;

test("OpenAI request: bearer auth, data-URL images at the configured detail, one forced strict function call", async () => {
  const seen = fakeFetch((url) => (url.endsWith("/input_tokens") ? Response.json({ input_tokens: 4321 }) : completed({ ok: true })));
  assert.deepEqual(await openai().countInputTokens(req), { tokens: 4321, method: "provider" });
  await openai().complete({ ...req, settings: { ...GPT, imageDetail: "low" } });

  const [count, call] = seen;
  assert.equal(count.url, "https://api.example.test/v1/responses/input_tokens");
  assert.equal(call.url, "https://api.example.test/v1/responses");
  assert.equal(call.headers.authorization, "Bearer sk-openai-test");
  assert.equal(count.body.max_output_tokens, undefined, "token counting sends no output limit");
  assert.equal(count.body.store, undefined);

  const body = call.body;
  assert.equal(body.model, "gpt-6-sol");
  assert.equal(body.instructions, "sys");
  assert.equal(body.max_output_tokens, 12_000);
  assert.equal(body.store, false);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.service_tier, "default");
  assert.deepEqual(body.reasoning, { effort: "medium" });
  assert.deepEqual(body.tool_choice, { type: "function", name: "submit_analyst_result" });
  const tools = body.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].strict, true);
  const content = (body.input as Array<{ role: string; content: Array<Record<string, unknown>> }>)[0];
  assert.equal(content.role, "user");
  assert.deepEqual(content.content[0], { type: "input_text", text: "hello" });
  assert.deepEqual(content.content[1], { type: "input_image", image_url: `data:image/jpeg;base64,${Buffer.from("jpg").toString("base64")}`, detail: "low" });
});

test("OpenAI request omits reasoning and tier when not configured", async () => {
  const seen = fakeFetch(() => completed({ ok: true }));
  await openai().complete({ ...req, settings: { ...GPT, reasoningEffort: null, serviceTier: null } });
  assert.equal(seen[0].body.reasoning, undefined);
  assert.equal(seen[0].body.service_tier, undefined);
});

test("strict schema conversion accepts all three real result schemas without loosening local validation", () => {
  for (const schema of [AnalystOutputSchema, VerifierOutputSchema, RevisionOutputSchema]) {
    const { schema: strict } = strictSchema(toolSchema(schema));
    const objects: Array<Record<string, unknown>> = [];
    const collect = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(collect);
      if (!n || typeof n !== "object") return;
      const o = n as Record<string, unknown>;
      if (o.type === "object") objects.push(o);
      Object.values(o).forEach(collect);
    };
    collect(strict);
    assert.ok(objects.length > 1);
    for (const o of objects) {
      assert.equal(o.additionalProperties, false);
      assert.deepEqual([...(o.required as string[])].sort(), Object.keys(o.properties as object).sort());
    }
  }
  assert.throws(() => strictSchema({ type: "object", properties: { a: { type: "string" } }, required: [] }), /optional at \(root\): a/);

  const { schema, localOnly } = strictSchema({ type: "object", properties: { s: { type: "string", minLength: 5 } }, required: ["s"] });
  assert.deepEqual(localOnly, ["minLength"]);
  assert.equal(((schema.properties as Record<string, Record<string, unknown>>).s).minLength, undefined);
  assert.equal(AnalystOutputSchema.safeParse({ findings: "nope" }).success, false, "zod still rejects what strict mode cannot express");
});

test("OpenAI usage: reasoning tokens are reported and already included in billed output tokens", async () => {
  fakeFetch(() => completed({ ok: true }));
  const res = await openai().complete(req);
  assert.deepEqual(res.toolInput, { ok: true });
  assert.equal(res.inputTokens, 5000);
  assert.equal(res.outputTokens, 900);
  assert.equal(res.reasoningTokens, 400);
  assert.equal(res.stopReason, "tool_use");
  assert.equal(costUsd(GPT.pricing, res.inputTokens, res.outputTokens), (5000 * 2 + 900 * 10) / 1e6);

  fakeFetch(() => completed({ ok: true }, { input_tokens: 10, output_tokens: 5 }));
  assert.equal((await openai().complete(req)).reasoningTokens, null, "absent detail stays unknown, not zero");
});

test("OpenAI truncation at the output limit maps to max_tokens; refusals and unparseable arguments yield no result", async () => {
  fakeFetch(() =>
    Response.json({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "function_call", name: "submit_analyst_result", arguments: '{"findings": [' }],
      usage: { input_tokens: 100, output_tokens: 12_000, output_tokens_details: { reasoning_tokens: 11_000 } },
    }),
  );
  const cut = await openai().complete(req);
  assert.equal(cut.stopReason, "max_tokens");
  assert.equal(cut.toolInput, null);
  assert.equal(cut.reasoningTokens, 11_000);

  fakeFetch(() => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], usage: { input_tokens: 10, output_tokens: 2 } }));
  const refused = await openai().complete(req);
  assert.equal(refused.stopReason, "refusal");
  assert.equal(refused.toolInput, null);
});

test("OpenAI errors: 4xx not billed, 5xx/failed/timeouts/missing usage may be billed", async () => {
  fakeFetch(() => Response.json({ error: { message: "bad schema" } }, { status: 400 }));
  const bad = await openai().complete(req).catch((e) => e);
  assert.ok(bad instanceof ModelCallError);
  assert.match(bad.message, /bad schema/);
  assert.equal(bad.possiblyBilled, false);

  fakeFetch(() => Response.json({ status: "failed", error: { message: "server" }, usage: { input_tokens: 1, output_tokens: 1 } }));
  assert.equal((await openai().complete(req).catch((e) => e)).possiblyBilled, true);

  fakeFetch(() => Response.json({ status: "completed", output: [] }));
  await assert.rejects(openai().complete(req), (e: ModelCallError) => e.kind === "malformed" && e.possiblyBilled);

  globalThis.fetch = (async () => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  }) as typeof fetch;
  assert.equal((await openai().complete(req).catch((e) => e)).possiblyBilled, true);
});

test("if OpenAI cannot count tokens for the model, a padded local estimate is used and labelled as such", async () => {
  fakeFetch(() => Response.json({ error: { message: "not found" } }, { status: 404 }));
  const count = await openai().countInputTokens(req);
  assert.equal(count.method, "estimate");
  assert.equal(count.tokens, Math.ceil(estimateInputTokens(req) * ESTIMATE_SAFETY_FACTOR));

  fakeFetch(() => Response.json({ error: { message: "bad key" } }, { status: 401 }));
  await assert.rejects(openai().countInputTokens(req), /bad key/, "other count errors still stop the call");
});

test("config: provider switching, per-role settings, explicit prices off the default model or tier", () => {
  const claude = loadAnalysisConfig(BASE_ENV, { live: false });
  assert.equal(claude.analyst.provider, "anthropic");
  assert.equal(claude.verifier.provider, "anthropic");
  assert.equal(claude.analyst.imageDetail, null);

  const gpt = loadAnalysisConfig({ ...BASE_ENV, ANALYST_PROVIDER: "openai", VERIFIER_PROVIDER: "openai", VERIFIER_IMAGE_DETAIL: "auto", ANALYST_REASONING_EFFORT: "high" }, { live: false });
  assert.equal(gpt.analyst.model, "gpt-6-sol");
  assert.deepEqual(gpt.analyst.pricing, { inputUsdPerMTok: 2, outputUsdPerMTok: 10 });
  assert.equal(gpt.analyst.imageDetail, "high");
  assert.equal(gpt.verifier.imageDetail, "auto");
  assert.equal(gpt.analyst.reasoningEffort, "high");
  assert.equal(gpt.verifier.reasoningEffort, null);
  assert.equal(gpt.analyst.serviceTier, "default");
  assert.equal(gpt.verifier.maxOutputTokens, 4_000);

  assert.throws(() => loadAnalysisConfig({ ...BASE_ENV, ANALYST_PROVIDER: "openai", ANALYST_SERVICE_TIER: "priority" }, { live: false }), /ANALYST_INPUT_USD_PER_MTOK .* priority tier/);
  assert.throws(() => loadAnalysisConfig({ ...BASE_ENV, VERIFIER_PROVIDER: "openai", VERIFIER_MODEL: "gpt-other" }, { live: false }), /VERIFIER_INPUT_USD_PER_MTOK/);
  assert.throws(() => loadAnalysisConfig({ ...BASE_ENV, ANALYST_PROVIDER: "gemini" }, { live: false }), /ANALYST_PROVIDER must be one of/);
  assert.throws(() => loadAnalysisConfig({ ...BASE_ENV, ANALYST_PROVIDER: "openai", ANALYST_IMAGE_DETAIL: "max" }, { live: false }), /ANALYST_IMAGE_DETAIL/);
  assert.throws(() => loadAnalysisConfig({ ...BASE_ENV, ANALYST_IMAGE_DETAIL: "low" }, { live: false }), /OpenAI only/);
  assert.throws(() => loadAnalysisConfig({ ...BASE_ENV, ANALYST_PROVIDER: "openai", ANALYST_REASONING_EFFORT: "extreme" }, { live: false }), /REASONING_EFFORT/);
});

test("config: live runs need keys only for the providers actually used", () => {
  const openaiOnly = { ...BASE_ENV, ANALYST_PROVIDER: "openai", VERIFIER_PROVIDER: "openai" };
  assert.throws(() => loadAnalysisConfig(openaiOnly, { live: true }), /OPENAI_API_KEY/);
  assert.doesNotThrow(() => loadAnalysisConfig({ ...openaiOnly, OPENAI_API_KEY: "sk-x" }, { live: true }));
  assert.throws(() => loadAnalysisConfig({ ...BASE_ENV, OPENAI_API_KEY: "sk-x" }, { live: true }), /ANTHROPIC_API_KEY/);
  const mixed = { ...BASE_ENV, VERIFIER_PROVIDER: "openai", ANTHROPIC_API_KEY: "a" };
  assert.throws(() => loadAnalysisConfig(mixed, { live: true }), /OPENAI_API_KEY/);
  assert.doesNotThrow(() => loadAnalysisConfig({ ...mixed, OPENAI_API_KEY: "o" }, { live: true }));
});

test("settings profiles overlay model choices but refuse credentials", () => {
  const env = applySettingsProfile(BASE_ENV, "ANALYST_PROVIDER=openai\nVERIFIER_PROVIDER=openai\n# comment\nANALYST_IMAGE_DETAIL=auto\n");
  const cfg = loadAnalysisConfig(env, { live: false });
  assert.equal(cfg.analyst.provider, "openai");
  assert.equal(cfg.analyst.imageDetail, "auto");
  assert.throws(() => applySettingsProfile(BASE_ENV, "OPENAI_API_KEY=sk-leak\n"), /must not contain credentials \(OPENAI_API_KEY\)/);
  assert.throws(() => applySettingsProfile(BASE_ENV, "SUPABASE_SECRET_KEY=x\n"), /credentials/);
});

test("createClients routes each role to its provider and shares one client per provider", () => {
  const keys = { ...BASE_ENV, ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" };
  const same = createClients(loadAnalysisConfig({ ...keys, ANALYST_PROVIDER: "openai", VERIFIER_PROVIDER: "openai" }, { live: true }));
  assert.ok(same.analyst instanceof OpenAIClient);
  assert.equal(same.analyst, same.verifier);

  const mixed = createClients(loadAnalysisConfig({ ...keys, VERIFIER_PROVIDER: "openai" }, { live: true }));
  assert.ok(mixed.analyst instanceof AnthropicClient);
  assert.ok(mixed.verifier instanceof OpenAIClient);
});

test("mixed providers: analyst and revision go to the analyst client, verification to the verifier client, each recorded", async () => {
  const analyst = new MockModelClient((_r, i) => (i === 0 ? { toolInput: analystReply([finding()]) } : { toolInput: { finding: { ...finding(), short_title: "Revised" }, withdrawal_reason: null } }), "anthropic");
  const verifier = new MockModelClient(() => ({ toolInput: verifierReply(3), reasoningTokens: 250 }), "openai");
  const sink = new MemorySink();
  await runAnalysis(await pack(), { analyst, verifier }, sink, opts(CLAUDE, GPT_VERIFIER, { revise: true }));

  assert.equal(verifier.requests.length >= 1, true);
  assert.ok(verifier.requests.every((r) => r.role === "verifier" && r.settings.provider === "openai"));
  assert.ok(analyst.requests.every((r) => r.role !== "verifier"));
  for (const c of sink.calls) assert.equal(c.provider, c.role === "verifier" ? "openai" : "anthropic");

  const config = sink.run!.config as Record<string, unknown>;
  assert.deepEqual(config.clients, { analyst: "anthropic", verifier: "openai" });
  assert.equal((config.analyst as ModelSettings).provider, "anthropic");
  assert.equal((config.verifier as ModelSettings).imageDetail, "high");
  assert.ok(config.images);
  const usage = usageOf(sink);
  assert.equal(usage.calls.length, sink.calls.length);
  const verifierUsage = usage.calls.filter((u) => u.role === "verifier");
  assert.ok(verifierUsage.every((u) => u.reasoning_tokens === 250 && u.provider === "openai" && u.count_method === "estimate"));
  assert.equal(usage.reasoning_tokens, 250 * verifierUsage.length);
});

test("an OpenAI response truncated at the output limit is recorded as invalid, never used", async () => {
  const client = new MockModelClient(() => ({ toolInput: analystReply([finding()]), outputTokens: 12_000, reasoningTokens: 11_500, stopReason: "max_tokens" }), "openai");
  const sink = new MemorySink();
  const res = await runAnalysis(await pack(), { analyst: client, verifier: client }, sink, opts(GPT, GPT_VERIFIER));
  assert.equal(res.status, "failed");
  assert.equal(sink.findings.length, 0);
  assert.equal(sink.calls[0].status, "invalid_output");
  assert.match(sink.calls[0].validation_errors.join(" "), /12000-token limit/);
  assert.equal(usageOf(sink).calls[0].reasoning_tokens, 11_500);
});

test("budget refusal uses each role's own OpenAI pricing before the call is made", async () => {
  const p = await pack();
  const pricey: ModelSettings = { ...GPT, pricing: { inputUsdPerMTok: 20, outputUsdPerMTok: 80 } };
  const analyst = new MockModelClient(() => ({ toolInput: analystReply([finding()]) }), "openai");
  const verifier = new MockModelClient(() => ({ toolInput: verifierReply(5) }), "openai");
  const sink = new MemorySink();
  const res = await runAnalysis(p, { analyst, verifier }, sink, opts(pricey, GPT_VERIFIER, { limits: { ...PIPE_LIMITS, budgetUsd: 0.5 } }));

  assert.equal(res.status, "stopped_budget");
  assert.equal(analyst.requests.length, 0, "the paid call was never sent");
  const refused = sink.calls[0];
  assert.equal(refused.status, "refused_budget");
  assert.equal(refused.worst_case_cost_usd, worstCaseUsd(pricey.pricing, refused.counted_input_tokens!, PIPE_LIMITS.inputCountMargin, pricey.maxOutputTokens));
  assert.ok(refused.worst_case_cost_usd! > 0.5);
});

test("an OpenAI call with unknown billing reserves its worst case and reports it separately from reported usage", async () => {
  const client = new MockModelClient((_r, i) => (i === 0 ? { toolInput: analystReply([finding()]), outputTokens: 1000 } : new ModelCallError("timeout", "timed out")), "openai");
  const sink = new MemorySink();
  const res = await runAnalysis(await pack(), { analyst: client, verifier: client }, sink, opts(GPT, GPT_VERIFIER));
  const usage = usageOf(sink) as unknown as { reported_usage_cost_usd: number; uncertain_billing_reserved_usd: number };
  const verifierWorst = sink.calls.find((c) => c.role === "verifier")!.worst_case_cost_usd!;
  assert.ok(Math.abs(usage.uncertain_billing_reserved_usd - verifierWorst) < 1e-9);
  assert.ok(Math.abs(usage.reported_usage_cost_usd + usage.uncertain_billing_reserved_usd - res.spentUsd) < 1e-9);
  assert.ok(Math.abs(sink.calls[0].estimated_cost_usd - usage.reported_usage_cost_usd) < 1e-9);
});

test("provider switching keeps the evidence, prompts and limits identical between the two pilot configurations", async () => {
  const p = await pack();
  const run = async (analystSettings: ModelSettings, verifierSettings: ModelSettings) => {
    const client = new MockModelClient((_r, i) => ({ toolInput: i === 0 ? analystReply([finding()]) : verifierReply(5) }), analystSettings.provider);
    await runAnalysis(p, { analyst: client, verifier: client }, new MemorySink(), opts(analystSettings, verifierSettings));
    return client.requests.map((r) => ({ role: r.role, system: r.system, content: r.content.map((b) => (b.type === "text" ? b.text : b.ref)), tool: r.tool.inputSchema, maxOut: r.settings.maxOutputTokens }));
  };
  const gpt = await run(GPT, GPT_VERIFIER);
  const claude = await run(CLAUDE, CLAUDE_VERIFIER);
  assert.ok(gpt.length >= 2);
  assert.deepEqual(gpt, claude);
});
