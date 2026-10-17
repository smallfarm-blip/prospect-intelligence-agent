import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BudgetTracker } from "../src/analysis/budget.ts";
import { MockModelClient, ModelCallError } from "../src/analysis/model.ts";
import { loadProspectingConfig, loadQueries } from "../src/prospecting/config.ts";
import { entityFacts, runDiscovery } from "../src/prospecting/discover.ts";
import { ExaProvider, parseExaResponse } from "../src/prospecting/exa.ts";
import { excludeCandidate, skipNonCandidate } from "../src/prospecting/exclusion.ts";
import { MockDiscoveryProvider } from "../src/prospecting/provider.ts";
import { computePilotReport } from "../src/prospecting/report.ts";
import { screenCompany } from "../src/prospecting/screen.ts";
import { parsePeopleHits, validateScreening, type ScreeningSource } from "../src/prospecting/screening.ts";
import type { SiteCheck } from "../src/prospecting/siteCheck.ts";
import { SpendGuard } from "../src/prospecting/spend.ts";
import { runTrial, trialRequests } from "../src/prospecting/trial.ts";
import type { PilotCompany } from "../src/prospecting/ports.ts";
import { entity, hit, MemoryProspectStore, response, silentLogger } from "./helpers/prospectFixtures.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PRICING = { searchUsdPer1k: 7, extraResultUsdPer1k: 1, contentUsdPer1kPages: 1, includedResults: 10 };
const exa = () => new ExaProvider({ apiKey: "exa-test", baseUrl: "https://exa.test/", timeoutMs: 5_000, pricing: PRICING });

function fakeFetch(reply: unknown, sink: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sink.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const EXA_COMPANY_RESULT = {
  requestId: "abc123",
  costDollars: { total: 0.012 },
  results: [
    {
      url: "https://www.northwool.example/",
      title: "North Wool | Merino basics",
      publishedDate: null,
      highlights: ["Founder-led merino apparel brand from Vermont.", "Free shipping over $100."],
      entities: [{ type: "company", properties: { name: "North Wool", description: "DTC merino apparel", foundedYear: 2017, workforce: { total: 32 }, headquarters: { city: "Burlington", country: "United States" }, financials: { revenueAnnual: "8500000", fundingTotal: { value: 2000000 } } } }],
    },
    { url: "not-a-url", title: "bad" },
  ],
};

test("Exa adapter sends category searches without date filters and parses company data", async () => {
  const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  fakeFetch(EXA_COMPANY_RESULT, sent);
  const res = await exa().search({ operation: "company_search", query: "DTC apparel", numResults: 10, startPublishedDate: "2025-01-01" });
  assert.equal(sent[0].url, "https://exa.test/search");
  assert.equal(sent[0].headers["x-api-key"], "exa-test");
  assert.equal(sent[0].body.category, "company");
  assert.equal(sent[0].body.type, "auto");
  assert.equal(sent[0].body.startPublishedDate, undefined, "company search must not send date filters");
  assert.equal(sent[0].body.userLocation, undefined);
  assert.equal(res.hits.length, 1);
  assert.equal(res.reportedCostUsd, 0.012);
  assert.equal(res.requestId, "abc123");
  const e = res.hits[0].entity!;
  assert.equal(e.employeeCount, 32);
  assert.equal(e.revenueAnnualUsd, 8_500_000);
  assert.equal(e.fundingTotalUsd, 2_000_000);
  assert.equal(e.hqCountry, "United States");
  assert.match(res.hits[0].excerpt!, /Founder-led/);
});

test("Exa adapter: people has no date filter, news has one, general search has no category", () => {
  const p = exa();
  const people = p.params({ operation: "people_search", query: "x", numResults: 5, startPublishedDate: "2025-01-01" });
  assert.equal(people.category, "people");
  assert.equal(people.startPublishedDate, undefined);
  const news = p.params({ operation: "evidence_search", query: "x", numResults: 5, startPublishedDate: "2025-01-01" });
  assert.equal(news.category, "news");
  assert.equal(news.startPublishedDate, "2025-01-01");
  const web = p.params({ operation: "web_search", query: "x", numResults: 10 });
  assert.equal(web.category, undefined);
  assert.equal(p.method({ operation: "web_search", query: "x", numResults: 10 }), "exa:auto:general");
});

test("Exa cost model: base search, extra results and highlights", () => {
  const p = exa();
  assert.equal(p.worstCaseUsd({ operation: "company_search", query: "x", numResults: 10 }).toFixed(4), "0.0170");
  assert.equal(p.worstCaseUsd({ operation: "company_search", query: "x", numResults: 15 }).toFixed(4), "0.0270");
  assert.equal(p.estimatedCostUsd({ operation: "people_search", query: "x", numResults: 5 }, 2).toFixed(4), "0.0090");
});

test("parseExaResponse rejects a response without results", () => {
  assert.throws(() => parseExaResponse({ error: "bad key" }), ModelCallError);
});

test("SpendGuard refuses over-budget calls and logs actual and uncertain costs", async () => {
  const store = new MemoryProspectStore();
  const guard = new SpendGuard(new BudgetTracker(0.025), (r) => store.recordCall("run-1", r));
  let n = 0;
  const provider = new MockDiscoveryProvider(() => (n++ === 1 ? new ModelCallError("timeout", "slow") : response([hit("https://a.example/")], 0.008)), 0.01);
  const ok = await guard.search(provider, { operation: "company_search", query: "q1", numResults: 10 });
  assert.equal(ok.ok, true);
  const failed = await guard.search(provider, { operation: "company_search", query: "q2", numResults: 10 });
  assert.equal(failed.ok, false);
  const refused = await guard.search(provider, { operation: "company_search", query: "q3", numResults: 10 });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.refused, true);
  assert.deepEqual(store.calls.map((c) => [c.status, c.costBasis, c.actualCostUsd]), [
    ["succeeded", "provider_reported", 0.008],
    ["failed", "uncertain_worst_case", 0.01],
    ["refused_budget", "not_billed", 0],
  ]);
  assert.equal(provider.requests.length, 2, "refused call was never sent");
});

test("discovery deduplicates by domain, records sightings, skips non-candidates and keeps exclusion reasons", async () => {
  const store = new MemoryProspectStore();
  store.seed("Kosas", "kosas.com");
  const guard = new SpendGuard(new BudgetTracker(1), (r) => store.recordCall("run-1", r));
  const pages = [
    [
      hit("https://www.northwool.example/shop", { title: "North Wool", entity: entity({ name: "North Wool" }) }),
      hit("https://kosas.com/", { title: "Kosas" }),
      hit("https://www.amazon.com/brand", { title: "Amazon" }),
      hit("https://growthlab.example/", { title: "Growth Lab | Shopify agency", excerpt: "We help brands grow." }),
      hit("https://bigco.example/", { title: "BigCo", entity: entity({ name: "BigCo", employeeCount: 5000 }) }),
    ],
    [hit("https://northwool.example/about", { title: "About North Wool" }), hit("https://fernhome.example/", { title: "Fern Home - Linen bedding" })],
  ];
  const provider = new MockDiscoveryProvider((_req, i) => response(pages[i] ?? []));
  const summary = await runDiscovery(
    { provider, guard, store, logger: silentLogger, runId: "run-1", pilot: "p" },
    [
      { id: "a", operation: "company_search", query: "q1" },
      { id: "b", operation: "web_search", query: "q2" },
    ],
    { numResults: 10, targetCompanies: 25 },
  );
  assert.equal(summary.newCompanies, 2);
  assert.equal(summary.excludedCompanies, 2);
  assert.equal(summary.duplicates, 2);
  assert.deepEqual(summary.skipped.map((s) => s.domain), ["amazon.com"]);
  const created = store.companies.filter((c) => c.prospect);
  assert.deepEqual(created.map((c) => c.domain).sort(), ["bigco.example", "fernhome.example", "growthlab.example", "northwool.example"]);
  assert.match(created.find((c) => c.domain === "bigco.example")!.prospect!.excludedReason!, /Provider estimate suggests enterprise scale/);
  assert.equal(created.find((c) => c.domain === "growthlab.example")!.prospect!.excludedRule, "agency");
  assert.deepEqual(store.sources.map((s) => s.outcome), ["new", "duplicate", "excluded", "excluded", "duplicate", "new"]);
  const nwFacts = store.facts.get(created.find((c) => c.domain === "northwool.example")!.id)!;
  assert.ok(nwFacts.every((f) => f.status === "provider_estimate" && f.sourceType === "provider"));
});

test("discovery stops at the target and when the budget refuses the next query", async () => {
  const store = new MemoryProspectStore();
  const provider = new MockDiscoveryProvider((_r, i) => response([hit(`https://brand${i}a.example/`), hit(`https://brand${i}b.example/`)]), 0.01);
  const capped = await runDiscovery({ provider, guard: new SpendGuard(new BudgetTracker(1), (r) => store.recordCall("r", r)), store, logger: silentLogger, runId: "r", pilot: "p" }, [1, 2, 3].map((i) => ({ id: `q${i}`, operation: "company_search" as const, query: `q${i}` })), { numResults: 10, targetCompanies: 3 });
  assert.equal(capped.newCompanies, 3);
  assert.equal(capped.stoppedBy, "target_reached");

  const store2 = new MemoryProspectStore();
  const broke = await runDiscovery({ provider: new MockDiscoveryProvider(() => response([hit("https://x.example/")]), 0.01), guard: new SpendGuard(new BudgetTracker(0.015), (r) => store2.recordCall("r", r)), store: store2, logger: silentLogger, runId: "r", pilot: "p" }, [1, 2, 3].map((i) => ({ id: `q${i}`, operation: "company_search" as const, query: `q${i}` })), { numResults: 10, targetCompanies: 25 });
  assert.equal(broke.stoppedBy, "budget");
  assert.equal(broke.queriesRun, 1);
  assert.equal(store2.calls.at(-1)!.status, "refused_budget");
});

test("exclusion rules", () => {
  assert.equal(skipNonCandidate("shop.etsy.com"), "marketplace or large retailer");
  assert.equal(skipNonCandidate("klaviyo.com"), "commerce software vendor");
  assert.equal(skipNonCandidate("northwool.example"), null);
  assert.equal(excludeCandidate("The SaaS platform for brands", null)?.rule, "software_vendor");
  assert.equal(excludeCandidate("An online marketplace for makers", null)?.rule, "marketplace");
  assert.equal(excludeCandidate("Merino basics, made in Vermont", entity({ revenueAnnualUsd: 900e6 }))?.rule, "enterprise_scale");
  assert.equal(excludeCandidate("Merino basics, made in Vermont", entity()), null);
});

test("entityFacts stores every provider figure as an estimate", () => {
  const facts = entityFacts(entity({ fundingTotalUsd: 3e6 }), "exa", "https://x.example/", "call-1", "2026-01-01T00:00:00Z");
  assert.deepEqual(facts.map((f) => f.attribute).sort(), ["employee_count", "founded_year", "funding_total_usd", "hq_country", "revenue_annual_usd"]);
  assert.ok(facts.every((f) => f.status === "provider_estimate"));
});

const SOURCES: ScreeningSource[] = [
  { ref: "S1", url: "https://northwool.example/", kind: "company homepage", title: "North Wool", publishedDate: null, text: "Shop merino" },
  { ref: "S2", url: "https://news.example/nw", kind: "news", title: "North Wool launches kids line", publishedDate: "2026-03-01", text: "launch" },
];
const sig = (refs: string[], title = "Kids line launch") => ({
  signal_type: "business_trigger",
  title,
  observed_evidence: "Article reports a kids line launching in spring.",
  source_refs: refs,
  interpretation: "The catalogue may be expanding into a new audience.",
  business_relevance: "A new range may need new navigation and merchandising.",
  critical_unknowns: ["Size of the launch"],
  next_validation: "Check the kids collection page on the site.",
  confidence: "medium",
});
const screening = (signals: unknown[]) => ({ category: "apparel", business_model: "dtc_brand", leadership_model: "founder_led", signals, summary: "Founder-led merino apparel brand expanding its range." });

test("validateScreening keeps cited signals, drops uncited ones and records inferred facts", () => {
  const v = validateScreening(screening([sig(["S2"]), sig(["S9"], "Ghost")]), SOURCES, "call-9");
  assert.ok(!("error" in v));
  assert.equal(v.signals.length, 1);
  assert.deepEqual(v.signals[0].sourceUrls, ["https://news.example/nw"]);
  assert.match(v.issues[0], /Dropped "Ghost"/);
  assert.deepEqual(v.facts.map((f) => [f.attribute, f.valueText, f.status]), [["category", "apparel", "inferred"], ["business_model", "dtc_brand", "inferred"], ["leadership_model", "founder-led", "inferred"]]);
});

test("validateScreening accepts zero signals and rejects more than three", () => {
  const zero = validateScreening(screening([]), SOURCES, null);
  assert.ok(!("error" in zero) && zero.signals.length === 0);
  const four = validateScreening(screening([sig(["S1"]), sig(["S1"]), sig(["S1"]), sig(["S1"])]), SOURCES, null);
  assert.ok("error" in four);
  const noUnknowns = validateScreening(screening([{ ...sig(["S1"]), critical_unknowns: [] }]), SOURCES, null);
  assert.ok("error" in noUnknowns, "every signal must name critical unknowns");
});

test("parsePeopleHits keeps named people in relevant roles at the company only", () => {
  const people = parsePeopleHits(
    [
      hit("https://www.linkedin.com/in/ana-ruiz", { title: "Ana Ruiz - Founder & CEO - North Wool | LinkedIn" }),
      hit("https://www.linkedin.com/in/sam-lee", { title: "Sam Lee - Head of Ecommerce - North Wool" }),
      hit("https://www.linkedin.com/in/joe", { title: "Joe Bloggs - Accountant - North Wool" }),
      hit("https://www.linkedin.com/in/kim", { title: "Kim Park - Founder - Other Brand" }),
    ],
    { name: "North Wool", domain: "northwool.example" },
    "exa",
    "call-1",
  );
  assert.deepEqual(people.map((p) => [p.name, p.roleCategory]), [["Ana Ruiz", "founder"], ["Sam Lee", "ecommerce_lead"]]);
  assert.equal(people[0].profileUrl, "https://www.linkedin.com/in/ana-ruiz");
});

test("screenCompany runs searches and AI screening through the budget, then scores", async () => {
  const store = new MemoryProspectStore();
  const target = { ...(await store.createProspect({ name: "North Wool", domain: "northwool.example", origin: "exa_discovery", pilot: "p", runId: "r", description: null, geography: null, excludedReason: null, excludedRule: null })), description: null };
  const guard = new SpendGuard(new BudgetTracker(1), (r) => store.recordCall("r", r));
  const provider = new MockDiscoveryProvider((req) =>
    req.operation === "people_search"
      ? response([hit("https://www.linkedin.com/in/ana-ruiz", { title: "Ana Ruiz - Founder - North Wool" })])
      : response([hit("https://news.example/nw", { title: "North Wool launches kids line", excerpt: "North Wool will launch..." }), hit("https://news.example/other", { title: "Unrelated" })]),
  );
  const model = new MockModelClient(() => ({ toolInput: screening([sig(["S2"])]), outputTokens: 800 }));
  const site: SiteCheck = { status: "checked", url: "https://northwool.example/", title: "North Wool", description: null, platform: "Shopify", pageText: "Shop merino", facts: [], notes: [] };
  const out = await screenCompany(
    { provider, model, modelSettings: { provider: "openai", model: "gpt-6-sol", pricing: { inputUsdPerMTok: 2, outputUsdPerMTok: 10 }, maxOutputTokens: 2500, imageDetail: null, reasoningEffort: null, serviceTier: "default" }, inputCountMargin: 0.1, guard, store, logger: silentLogger, runId: "r", checkSite: async () => site },
    target,
    { evidenceMonths: 18 },
  );
  assert.equal(out.screened, true);
  assert.equal(out.evidenceSources, 1, "unrelated evidence is dropped");
  assert.equal(out.decisionMakers, 1);
  assert.equal(out.signals, 1);
  assert.deepEqual(store.calls.map((c) => c.operation), ["people_search", "evidence_search", "ai_screening"]);
  assert.equal(store.calls[2].costBasis, "computed_from_usage");
  assert.ok(store.calls[2].actualCostUsd > 0 && store.calls[2].actualCostUsd <= store.calls[2].worstCaseUsd);
  assert.equal(store.scores.get(target.id)!.components.find((c) => c.key === "decision_maker")!.evidence, 4);
});

test("screenCompany skips AI screening when the budget cannot cover it", async () => {
  const store = new MemoryProspectStore();
  const target = { ...(await store.createProspect({ name: "Fern", domain: "fern.example", origin: "exa_discovery", pilot: "p", runId: "r", description: null, geography: null, excludedReason: null, excludedRule: null })), description: null };
  const model = new MockModelClient(() => ({ toolInput: screening([]) }));
  const site: SiteCheck = { status: "checked", url: "https://fern.example/", title: "Fern", description: null, platform: null, pageText: "x", facts: [], notes: [] };
  const out = await screenCompany(
    { provider: new MockDiscoveryProvider(() => response([], 0.001), 0.001), model, modelSettings: { provider: "openai", model: "m", pricing: { inputUsdPerMTok: 2, outputUsdPerMTok: 10 }, maxOutputTokens: 2500, imageDetail: null, reasoningEffort: null, serviceTier: "default" }, inputCountMargin: 0.1, guard: new SpendGuard(new BudgetTracker(0.01), (r) => store.recordCall("r", r)), store, logger: silentLogger, runId: "r", checkSite: async () => site },
    target,
    { evidenceMonths: 18 },
  );
  assert.deepEqual(out.refused, ["ai_screening"]);
  assert.equal(model.requests.length, 0);
  assert.equal(out.screened, false);
  assert.ok(store.scores.has(target.id), "still scored so it stays visible");
});

test("trial compares company and general search on the same queries and writes no prospects", async () => {
  const store = new MemoryProspectStore();
  const provider = new MockDiscoveryProvider((req) =>
    req.operation === "company_search"
      ? response([hit("https://a.example/", { entity: entity() }), hit("https://b.example/", { entity: entity({ revenueAnnualUsd: null }) })])
      : response([hit("https://a.example/"), hit("https://c.example/"), hit("https://www.amazon.com/x")]),
  );
  const plan = { calibrationQueries: ["q one", "q two"], numResults: 5, sampleCompany: { name: "Kosas", domain: "kosas.com" } };
  assert.equal(trialRequests(plan).length, 6);
  const report = await runTrial(provider, new SpendGuard(new BudgetTracker(1), (r) => store.recordCall("r", r)), plan);
  assert.equal(report.calls.length, 6);
  assert.deepEqual(report.comparisons[0], { query: "q one", company: { candidates: 2, withRevenue: 1, withHeadcount: 2 }, general: { candidates: 2 }, overlap: 1 });
  assert.deepEqual(report.calls[0].resultFields, ["author", "entity", "excerpt", "publishedDate", "title", "url"]);
  assert.equal(store.companies.length, 0);
  assert.equal(store.calls.length, 6);
});

test("trial reports which company fields Exa actually returned", async () => {
  fakeFetch(EXA_COMPANY_RESULT, []);
  const store = new MemoryProspectStore();
  const report = await runTrial(exa(), new SpendGuard(new BudgetTracker(1), (r) => store.recordCall("r", r)), { calibrationQueries: ["q"], numResults: 5, sampleCompany: { name: "K", domain: "k.com" } });
  const first = report.calls[0];
  assert.equal(first.entityFields["financials.revenueAnnual"], 1);
  assert.equal(first.entityFields["workforce.total"], 1);
  assert.ok(first.resultFields.includes("entities") && first.topLevelFields.includes("costDollars"));
  assert.equal(report.totalReportedUsd.toFixed(3), (0.012 * 4).toFixed(3));
});

test("trial stops cleanly at the trial budget", async () => {
  const store = new MemoryProspectStore();
  const provider = new MockDiscoveryProvider(() => response([], 0.03), 0.03);
  const report = await runTrial(provider, new SpendGuard(new BudgetTracker(0.1), (r) => store.recordCall("r", r)), { calibrationQueries: ["a", "b"], numResults: 5, sampleCompany: { name: "K", domain: "k.com" } });
  assert.equal(report.calls.filter((c) => c.ok).length, 3);
  assert.match(report.calls.at(-1)!.error!, /^Refused/);
});

const company = (over: Partial<PilotCompany>): PilotCompany => ({
  id: "x",
  name: "X",
  domain: "x.example",
  origin: "exa_discovery",
  excludedReason: null,
  score: { evidenceScore: 40, potentialMax: 80, fitStatus: "needs_qualification", confidence: "low", coverage: 0.3, unresolved: ["Annual revenue: unknown"], reasonsToInvestigate: [], recommendedAction: "Find revenue." },
  scoreOverride: null,
  fitOverride: null,
  latestDecision: null,
  reviewSeconds: [],
  decisionMakers: { possible: 0, confirmed: 0 },
  verifiedIndependentTraits: 0,
  discoveredByCallIds: [],
  ...over,
});

test("pilot report measures fit share, cost per relevant candidate, review time and query yield", () => {
  const scored = (fitStatus: "verified_fit" | "probable_fit", evidenceScore: number) => ({ evidenceScore, potentialMax: 90, fitStatus, confidence: "medium" as const, coverage: 0.6, unresolved: [], reasonsToInvestigate: ["Launch"], recommendedAction: "Research." });
  const r = computePilotReport({
    pilot: "p",
    companies: [
      company({ id: "a", score: scored("verified_fit", 70), reviewSeconds: [120, 60], decisionMakers: { possible: 1, confirmed: 1 }, verifiedIndependentTraits: 6 }),
      company({ id: "b", score: scored("probable_fit", 55), reviewSeconds: [240] }),
      company({ id: "c", fitOverride: "probable_fit", latestDecision: "request_research" }),
      company({ id: "d", excludedReason: "agency" }),
      company({ id: "e", latestDecision: "reject", score: scored("probable_fit", 60) }),
    ],
    calls: [
      { id: "c1", operation: "company_search", method: "exa:auto:company", query: "q1", status: "succeeded", resultCount: 10, actualCostUsd: 0.017, costBasis: "provider_reported" },
      { id: "c2", operation: "ai_screening", method: "openai", query: null, status: "succeeded", resultCount: null, actualCostUsd: 0.04, costBasis: "computed_from_usage" },
    ],
    sourceOutcomes: [
      { providerCallId: "c1", companyId: "a", outcome: "new" },
      { providerCallId: "c1", companyId: "d", outcome: "excluded" },
      { providerCallId: "c1", companyId: "b", outcome: "duplicate" },
    ],
  });
  assert.equal(r.uniqueCompanies, 5);
  assert.equal(r.plausible, 3);
  assert.equal(r.plausibleShare, 0.6);
  assert.equal(r.evidenceBackedRate, 0.2);
  assert.equal(r.worthDeeperResearch, 3);
  assert.equal(r.costPerRelevantUsd!.toFixed(3), "0.019");
  assert.equal(r.review.medianMinutes, 3.5);
  assert.deepEqual(r.decisionMakers, { possible: 1, confirmed: 1 });
  assert.deepEqual(r.queries[0], { query: "q1", method: "exa:auto:company", results: 10, newCompanies: 1, duplicates: 1, excluded: 1, plausible: 1, costUsd: 0.017 });
  assert.deepEqual(r.topFive.map((t) => t.name && t.score), [70, 55, 40]);
  assert.deepEqual(r.targets.map((t) => t.met), [true, false, true, true]);
});

test("config enforces the $5 cap and needs the Exa key only for live runs", () => {
  const env = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x" };
  const dry = loadProspectingConfig(env, { live: false, needsExa: true, needsModel: true });
  assert.equal(dry.budgetUsd, 5);
  assert.equal(dry.screening.provider, "openai");
  assert.throws(() => loadProspectingConfig(env, { live: true, needsExa: true, needsModel: false }), /EXA_API_KEY/);
  assert.throws(() => loadProspectingConfig({ ...env, DISCOVERY_BUDGET_USD: "8" }, { live: false, needsExa: true, needsModel: false }), /at most 5/);
});

test("the shipped query file is valid and the trial uses the same calibration queries as discovery", () => {
  const q = loadQueries("config/discovery-queries.json");
  const discovery = new Set(q.discovery.filter((d) => d.operation === "company_search").map((d) => d.query));
  assert.ok(q.calibration.every((c) => discovery.has(c)));
  const reqs = trialRequests({ calibrationQueries: q.calibration, numResults: 5, sampleCompany: q.sampleCompany });
  const worst = reqs.reduce((s, r) => s + exa().worstCaseUsd(r.request), 0);
  assert.ok(worst <= 0.1, `trial worst case $${worst.toFixed(4)} should be about $0.10 or less`);
});
