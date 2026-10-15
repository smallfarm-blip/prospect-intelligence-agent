import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEvidencePack, type EvidencePack } from "../src/analysis/evidence.ts";
import { MockModelClient, ModelCallError, type ModelClient, type ModelRequest } from "../src/analysis/model.ts";
import { runAnalysis as runWithClients, type AnalysisSink, type PipelineOptions } from "../src/analysis/pipeline.ts";
import { automaticChecks } from "../src/analysis/checks.ts";
import { claimsOf } from "../src/analysis/claims.ts";
import { costUsd, worstCaseUsd } from "../src/analysis/budget.ts";
import { analystContent } from "../src/analysis/context.ts";
import { AnalystOutputSchema, toolSchema } from "../src/analysis/schemas.ts";
import { captureStates, COMPANY, evidenceRow, LIMITS, RUN, standardFixture } from "./helpers/evidenceFixtures.ts";
import { analystReply, finding, MemorySink, MODEL, PIPE_LIMITS, VERIFIER, verifierReply } from "./helpers/pipelineFixtures.ts";

async function pack(legacy = false): Promise<EvidencePack> {
  const row = evidenceRow("pdp_1", "mobile", legacy ? { capture_states: captureStates({ legacy: true }) } : {});
  return loadEvidencePack(await standardFixture([row]), { researchRunId: RUN, companyDomain: COMPANY.domain }, LIMITS);
}

/** These tests use one client for both roles; mixed-provider routing is covered in analysisProviders.test.ts. */
const runAnalysis = (p: EvidencePack, client: ModelClient, sink: AnalysisSink, o: PipelineOptions) => runWithClients(p, { analyst: client, verifier: client }, sink, o);

const opts = (over: Partial<PipelineOptions> = {}): PipelineOptions => ({ analyst: MODEL, verifier: VERIFIER, limits: PIPE_LIMITS, workerVersion: "test", revise: false, ...over });

/** Analyst reply first; every later request is a verifier or revision call answered by `rest`. */
function scripted(analyst: unknown, rest: (req: ModelRequest) => unknown = () => verifierReply(5)) {
  return new MockModelClient((req, i) => {
    const out = i === 0 ? analyst : rest(req);
    return out instanceof ModelCallError ? out : { toolInput: out };
  });
}

const text = (req: ModelRequest) => req.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");

test("tool schemas are plain JSON object schemas the provider accepts", () => {
  const s = toolSchema(AnalystOutputSchema);
  assert.equal(s.type, "object");
  assert.equal(s.$schema, undefined);
  assert.ok((s.required as string[]).includes("findings"));
});

test("zero findings is a valid, completed analysis with no verifier calls", async () => {
  const sink = new MemorySink();
  const client = scripted(analystReply([], "No visitor decision problem is supported strongly enough by this evidence."));
  const res = await runAnalysis(await pack(), client, sink, opts());
  assert.equal(res.status, "completed");
  assert.equal(sink.findings.length, 0);
  assert.equal(client.requests.length, 1);
  assert.match(sink.run!.no_findings_reason!, /No visitor decision problem/);
});

test("zero findings without a reason is invalid output", () => {
  assert.equal(AnalystOutputSchema.safeParse(analystReply([], null)).success, false);
});

test("a supported finding is saved with traceable evidence and verified claim by claim", async () => {
  const sink = new MemorySink();
  const client = scripted(analystReply([finding()]));
  const res = await runAnalysis(await pack(), client, sink, opts());
  assert.equal(res.status, "completed");
  assert.deepEqual(res.findings.map((f) => f.status), ["supported"]);
  const f = sink.findings[0];
  assert.deepEqual(f.capture_states.sort(), ["after_overlay_dismissal", "extracted_text"]);
  assert.equal(f.links.length, 2);
  assert.ok(f.source_evidence_ids.length === 1);
  const v = sink.verifications[0];
  assert.equal(v.claim_checks.length, 5);
  assert.ok(v.automatic_checks.every((c) => c.passed));

  const verifierReq = client.requests[1];
  assert.equal(verifierReq.role, "verifier");
  assert.notEqual(verifierReq.system, client.requests[0].system);
  assert.ok(!text(verifierReq).includes("Visible layout is clear; behaviour is unmeasured"), "verifier must not see the analyst's confidence reasoning");
  assert.ok(!text(verifierReq).includes("Mobile PDP shade selection is the clearest"), "verifier must not see the analyst's summary");
  const verifierImages = verifierReq.content.filter((b) => b.type === "image").map((b) => (b as { ref: string }).ref);
  assert.deepEqual(verifierImages, ["IMG-02", "IMG-01"], "cited image first, then the page's other viewport state; no unrelated sections");
});

test("a fabricated conversion claim is rejected automatically without paying for verification", async () => {
  const sink = new MemorySink();
  const bad = finding({ commercial_relevance: "Fixing this would lift conversion by 12% and recover $40k in monthly revenue." });
  const client = scripted(analystReply([bad]));
  const res = await runAnalysis(await pack(), client, sink, opts());
  assert.deepEqual(res.findings.map((f) => f.status), ["rejected"]);
  assert.equal(client.requests.length, 1);
  const check = sink.verifications[0].automatic_checks.find((c) => c.check === "no_invented_figures")!;
  assert.equal(check.passed, false);
  assert.match(sink.verifications[0].reason, /no_invented_figures/);
});

test("numbers framed as data to investigate are allowed", async () => {
  const p = await pack();
  const ok = finding({
    hypothesis: "We should measure whether more than 20% of mobile sessions open the shade guide before adding to bag.",
    validation_data_needed: ["Conversion rate of 3% baseline vs swatch users"],
  });
  assert.ok(automaticChecks(ok, p).find((c) => c.check === "no_invented_figures")!.passed);
  const quoted = finding({ observed_facts: [{ ...finding().observed_facts[0], statement: "The banner promises free shipping, increasing appeal for orders over $35." }] });
  assert.ok(automaticChecks(quoted, p).find((c) => c.check === "no_invented_figures")!.passed, "figure appears in page text");
});

test("a finding citing evidence that does not exist is rejected", async () => {
  const sink = new MemorySink();
  const bad = finding({ observed_facts: [{ ...finding().observed_facts[0], evidence_refs: ["IMG-77"], region: null, text_excerpt: null }] });
  const client = scripted(analystReply([bad]));
  const res = await runAnalysis(await pack(), client, sink, opts());
  assert.deepEqual(res.findings.map((f) => f.status), ["rejected"]);
  assert.match(sink.verifications[0].reason, /IMG-77/);
  assert.equal(sink.findings[0].links.length, 0);
});

test("a quote that is not in the stored page text is rejected", async () => {
  const bad = finding({ observed_facts: [{ ...finding().observed_facts[0], text_excerpt: "Rated #1 concealer by 10,000 reviewers" }] });
  const c = automaticChecks(bad, await pack()).find((x) => x.check === "quotes_match_page_text")!;
  assert.equal(c.passed, false);
});

test("a generic 'add social proof' finding is rejected by verification", async () => {
  const sink = new MemorySink();
  const generic = finding({ short_title: "Add social proof to the PDP", hypothesis: "Adding reviews and trust badges is a best practice that would build trust." });
  const client = scripted(analystReply([generic]), () =>
    verifierReply(5, { generic_check: { generic: true, reason: "Applies to any site; rests on best practice" }, overall: "rejected", overall_reason: "Generic recommendation" }),
  );
  const res = await runAnalysis(await pack(), client, sink, opts());
  assert.deepEqual(res.findings.map((f) => f.status), ["rejected"]);
  assert.match(sink.verifications[0].reason, /Generic/);
});

test("an observed fact the verifier cannot see is rejected, an overstated one needs revision", async () => {
  for (const [verdict, expected] of [["not_demonstrated", "rejected"], ["contradicted", "rejected"], ["partially_demonstrated", "needs_revision"]] as const) {
    const sink = new MemorySink();
    const client = scripted(analystReply([finding()]), () => verifierReply(5, {}, verdict));
    const res = await runAnalysis(await pack(), client, sink, opts());
    assert.equal(res.findings[0].status, expected, verdict);
  }
});

test("regression d1408822: promo listed as dismissed, cookie banner still visible", async () => {
  const p = await pack(true);
  const prompt = analystContent(p).filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
  assert.match(prompt, /recorded as closed: promotional pop-up \("Get 15% off your first order"\)/);
  assert.doesNotMatch(prompt, /recorded as closed:[^\n]*cookie consent banner/);
  assert.match(prompt, /earlier record format; cookie consent banners were not reliably detected/);
  assert.ok(p.warnings.some((w) => /may omit cookie banners/.test(w)));

  const claimsRemoved = finding({
    observed_facts: [{ ...finding().observed_facts[0], statement: "After the cookie banner was dismissed, the Add to bag control is fully visible." }],
  });
  const blocked = automaticChecks(claimsRemoved, p).find((c) => c.check === "overlay_metadata_consistency")!;
  assert.equal(blocked.passed, false);
  assert.equal(blocked.severity, "blocker");

  const honest = finding({
    observed_facts: [{ ...finding().observed_facts[0], statement: "In the after-dismissal screenshot a cookie banner is still visible across the bottom of the screen." }],
  });
  const caveat = automaticChecks(honest, p).find((c) => c.check === "overlay_metadata_consistency")!;
  assert.equal(caveat.passed, true);
  assert.equal(caveat.severity, "warning");
  assert.match(caveat.detail, /says all_dismissed but uses the earlier format/);

  const sink = new MemorySink();
  const client = scripted(analystReply([honest]), () =>
    verifierReply(5, {
      metadata_consistency: { consistent: false, contradictions: ["Record says all_dismissed, but IMG-02 still shows a cookie consent banner"] },
    }),
  );
  await runAnalysis(p, client, sink, opts());
  const verifierText = text(client.requests[1]);
  assert.match(verifierText, /NOTE: earlier record format/);
  assert.ok(client.requests[1].content.some((b) => b.type === "image" && b.ref === "IMG-01"), "verifier gets the initial state to compare");
  assert.equal(sink.verifications[0].model_verdict!.metadata_consistency.consistent, false);
  assert.match(sink.verifications[0].model_verdict!.metadata_consistency.contradictions[0], /cookie consent banner/);
});

test("promo and cookie banner stay distinct in the evidence the model sees", async () => {
  const prompt = analystContent(await pack()).filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
  assert.match(prompt, /promotional pop-up \("Get 15% off your first order"\); cookie consent banner \("We use cookies/);
});

test("budget: an analyst call whose worst case exceeds the budget is refused before it is sent", async () => {
  const sink = new MemorySink();
  const client = scripted(analystReply([finding()]));
  const res = await runAnalysis(await pack(), client, sink, opts({ limits: { ...PIPE_LIMITS, budgetUsd: 0.05 } }));
  assert.equal(res.status, "stopped_budget");
  assert.equal(client.requests.length, 0, "no paid request was made");
  assert.equal(sink.calls[0].status, "refused_budget");
  assert.ok(sink.calls[0].worst_case_cost_usd! > 0.05);
  assert.equal(sink.run!.estimated_cost_usd, 0);
});

test("budget: verification stops when the remaining budget cannot cover it", async () => {
  const p = await pack();
  const bigVerifier = { ...VERIFIER, maxOutputTokens: 30_000 };
  const probe = new MemorySink();
  await runAnalysis(p, scripted(analystReply([finding()])), probe, opts({ verifier: bigVerifier }));
  const analystWorst = probe.calls[0].worst_case_cost_usd!;
  const budgetUsd = analystWorst + 0.01;

  const sink = new MemorySink();
  const res = await runAnalysis(p, scripted(analystReply([finding()])), sink, opts({ verifier: bigVerifier, limits: { ...PIPE_LIMITS, budgetUsd } }));
  assert.equal(res.status, "stopped_budget");
  assert.deepEqual(sink.calls.map((c) => `${c.role}:${c.status}`), ["analyst:succeeded", "verifier:refused_budget"]);
  assert.ok(res.spentUsd <= budgetUsd);
  assert.equal(res.findings[0].status, "not_verified");
  assert.equal(sink.findings.length, 1, "the analyst's finding is kept");
  assert.equal(sink.verifications.length, 0, "unverified findings get no verification row");
});

test("cost totals equal the sum of the individual calls and stay under budget", async () => {
  const sink = new MemorySink();
  const res = await runAnalysis(await pack(), scripted(analystReply([finding()])), sink, opts());
  const sum = sink.calls.reduce((s, c) => s + c.estimated_cost_usd, 0);
  assert.ok(Math.abs(sum - res.spentUsd) < 1e-9);
  assert.equal(sink.run!.estimated_cost_usd, res.spentUsd);
  for (const c of sink.calls) {
    assert.ok(Math.abs(c.estimated_cost_usd - costUsd(MODEL.pricing, c.input_tokens!, c.output_tokens!)) < 1e-12);
    assert.ok(c.estimated_cost_usd <= c.worst_case_cost_usd!);
  }
  assert.equal(sink.run!.input_tokens, sink.calls.reduce((s, c) => s + (c.input_tokens ?? 0), 0));
  assert.ok(res.spentUsd < PIPE_LIMITS.budgetUsd);
});

test("worst case includes the margin and full output allowance", () => {
  assert.ok(Math.abs(worstCaseUsd(MODEL.pricing, 100_000, 0.1, 12_000) - (110_000 * 2 + 12_000 * 10) / 1_000_000) < 1e-5);
});

test("invalid analyst output is retried once, then the run fails cleanly", async () => {
  const once = new MemorySink();
  let n = 0;
  const recovering = new MockModelClient(() => ({ toolInput: n++ === 0 ? { findings: "nope" } : analystReply([], "Nothing supported.") }));
  const ok = await runAnalysis(await pack(), recovering, once, opts());
  assert.equal(ok.status, "completed");
  assert.deepEqual(once.calls.map((c) => c.status), ["invalid_output", "succeeded"]);
  assert.ok(once.calls[0].validation_errors.length > 0);

  const twice = new MemorySink();
  const broken = new MockModelClient(() => ({ toolInput: { findings: "nope" } }));
  const bad = await runAnalysis(await pack(), broken, twice, opts());
  assert.equal(bad.status, "failed");
  assert.equal(twice.calls.length, 2);
  assert.equal(twice.run!.status, "failed");
});

test("truncated output (max tokens) is treated as invalid", async () => {
  const sink = new MemorySink();
  const client = new MockModelClient(() => ({ toolInput: analystReply([], "x".repeat(20)), stopReason: "max_tokens" }));
  await runAnalysis(await pack(), client, sink, opts());
  assert.equal(sink.calls[0].status, "invalid_output");
  assert.match(sink.calls[0].validation_errors[0], /token limit/);
});

test("a timeout is recorded as failed and its worst case is counted against the budget", async () => {
  const sink = new MemorySink();
  const client = new MockModelClient(() => new ModelCallError("timeout", "No response within 180000 ms"));
  const res = await runAnalysis(await pack(), client, sink, opts());
  assert.equal(res.status, "failed");
  assert.equal(sink.calls[0].status, "failed");
  assert.match(sink.calls[0].error!, /timeout/);
  assert.equal(res.spentUsd, sink.calls[0].worst_case_cost_usd);
});

test("a provider 400 error costs nothing; a verifier failure leaves the finding unverified", async () => {
  const sink = new MemorySink();
  const client = scripted(analystReply([finding()]), () => new ModelCallError("http", "Provider returned 400: bad", 400));
  const res = await runAnalysis(await pack(), client, sink, opts());
  assert.equal(res.status, "completed");
  assert.equal(res.findings[0].status, "not_verified");
  assert.equal(sink.calls[1].estimated_cost_usd, 0);
  assert.equal(sink.verifications.length, 0);
});

test("verifier output missing a claim verdict is invalid", async () => {
  const sink = new MemorySink();
  const client = scripted(analystReply([finding()]), () => verifierReply(3));
  const res = await runAnalysis(await pack(), client, sink, opts());
  assert.equal(sink.calls[1].status, "invalid_output");
  assert.match(sink.calls[1].validation_errors[0], /C4, C5/);
  assert.equal(res.findings[0].status, "not_verified");
});

test("revision runs only when enabled, creates a new linked finding and re-verifies it", async () => {
  const needs = () => verifierReply(5, { overall: "needs_revision", overall_reason: "Overlay fact should cite the initial state" });
  const off = scripted(analystReply([finding()]), needs);
  const offSink = new MemorySink();
  await runAnalysis(await pack(), off, offSink, opts());
  assert.equal(offSink.findings.length, 1);
  assert.ok(!off.requests.some((r) => r.role === "revision"));

  let verifierCalls = 0;
  const on = scripted(analystReply([finding()]), (req) => {
    if (req.role === "revision") return { revised: true, withdrawal_reason: null, finding: finding({ short_title: "Revised title for shade choice" }) };
    return verifierCalls++ === 0 ? needs() : verifierReply(5);
  });
  const sink = new MemorySink();
  const res = await runAnalysis(await pack(), on, sink, opts({ revise: true }));
  assert.deepEqual(res.findings.map((f) => `${f.ref}:${f.status}`), ["F-1:needs_revision", "F-1-r1:supported"]);
  assert.equal(sink.findings[1].revision_of, sink.findings[0].id);
  assert.equal(sink.findings[1].finding_ref, "F-1-r1");
});

test("claims separate facts, context, hypothesis, business implication and validation metrics", () => {
  assert.deepEqual(claimsOf(finding()).map((c) => c.type), ["observed_fact", "visitor_context", "hypothesis", "business_implication", "validation_metric"]);
});
