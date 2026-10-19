import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetTracker } from "../src/analysis/budget.ts";
import { loadQueries } from "../src/prospecting/config.ts";
import { DISCOVERY_SEGMENTS, interleaveBySegment, runDiscovery, type DiscoveryQuery } from "../src/prospecting/discover.ts";
import { excludeCandidate } from "../src/prospecting/exclusion.ts";
import { MockDiscoveryProvider } from "../src/prospecting/provider.ts";
import { scoreProspect, type ProspectScore, type ProspectScoreInput } from "../src/prospecting/scoring.ts";
import { SpendGuard } from "../src/prospecting/spend.ts";
import { assessHit } from "../src/prospecting/trial.ts";
import type { DecisionMaker, Fact, Signal } from "../src/prospecting/types.ts";
import { entity, fact, hit, MemoryProspectStore, response, silentLogger } from "./helpers/prospectFixtures.ts";

const q = (id: string, segment: DiscoveryQuery["segment"]): DiscoveryQuery => ({ id, segment, operation: "company_search", query: id });

const base = (over: Partial<ProspectScoreInput> = {}): ProspectScoreInput => ({ facts: [], signals: [], decisionMakers: [], screened: false, excludedReason: null, ...over });

const coreFacts = (): Fact[] => [
  fact("category", "apparel", "inferred", { source: "ai_screening" }),
  fact("sells_dtc", "yes", "verified"),
  fact("hq_country", "United States", "provider_estimate"),
];

const withStaff = (n: number, extra: Fact[] = []): Fact[] => [...coreFacts(), fact("employee_count", String(n), "provider_estimate", { n }), ...extra];

const revenue = (n: number): Fact => fact("revenue_annual_usd", `$${n}`, "provider_estimate", { n });

const founder = (over: Partial<DecisionMaker> = {}): DecisionMaker => ({
  name: "Dana Reyes",
  title: "Founder & CEO",
  roleCategory: "founder",
  profileUrl: "https://linkedin.example/in/dana",
  sourceUrl: null,
  sourcePublishedAt: null,
  matchConfidence: "high",
  employmentStatus: "current",
  roleStartedOn: null,
  matchBasis: "company and role match",
  review: null,
  ...over,
});

const signal = (over: Partial<Signal> = {}): Signal => ({
  signalType: "visitor_experience",
  title: "Product pages bury sizing guidance",
  observedEvidence: "Size chart sits below reviews.",
  interpretation: "May raise returns.",
  businessRelevance: "Fit confidence drives conversion.",
  criticalUnknowns: [],
  nextValidation: "Check mobile PDP.",
  sourceUrls: ["https://brand.example/p/1"],
  confidence: "high",
  ...over,
});

const assessment = (s: ProspectScore, key: string) => s.assessments.find((a) => a.key === key)!;

test("segments are interleaved round-robin while keeping each segment's own order", () => {
  const out = interleaveBySegment([q("e1", "emerging"), q("e2", "emerging"), q("e3", "emerging"), q("g1", "growing"), q("s1", "established"), q("s2", "established")]);
  assert.deepEqual(out.map((x) => x.id), ["e1", "g1", "s1", "e2", "s2", "e3"]);
});

test("one segment cannot dominate discovery: it stops at its share and later queries are not called", async () => {
  const store = new MemoryProspectStore();
  const requested: string[] = [];
  let n = 0;
  const provider = new MockDiscoveryProvider((req) => {
    requested.push(req.query);
    return response(Array.from({ length: 5 }, () => hit(`https://brand${n++}.example/`)));
  }, 0.001);
  const summary = await runDiscovery(
    { provider, guard: new SpendGuard(new BudgetTracker(1), (r) => store.recordCall("r", r)), store, logger: silentLogger, runId: "r", pilot: "p" },
    [q("e1", "emerging"), q("e2", "emerging"), q("e3", "emerging"), q("g1", "growing")],
    { numResults: 10, targetCompanies: 10, maxSegmentShare: 0.4 },
  );
  assert.equal(summary.segmentCap, 4);
  assert.equal(summary.bySegment.emerging.newCompanies, 4);
  assert.equal(summary.bySegment.emerging.capped, true);
  assert.equal(summary.bySegment.growing.newCompanies, 4);
  assert.deepEqual(requested, ["e1", "g1"]);
  const created = store.sources.filter((s) => s.outcome === "new");
  assert.deepEqual(DISCOVERY_SEGMENTS.map((seg) => created.filter((s) => s.discoverySegment === seg).length), [4, 4, 0]);
});

test("shipped discovery config spans all three segments without hard size filters", () => {
  const queries = loadQueries("config/discovery-queries.json").discovery;
  for (const seg of DISCOVERY_SEGMENTS) assert.ok(queries.filter((x) => x.segment === seg).length >= 3, seg);
  for (const x of queries) assert.ok(!/\d+\s*(to|-)\s*\d+\s*employees|(under|fewer than|less than|more than|over)\s+\$?\d/i.test(x.query), x.id);
});

test("a 3-person brand with evidence of scale stays a probable prospect, and headcount never changes the score", () => {
  const scores = [3, 100, 900].map((n) => scoreProspect(base({ facts: withStaff(n, [revenue(2e6)]) })));
  assert.equal(scores[0].fitStatus, "probable_fit");
  assert.deepEqual(new Set(scores.map((s) => s.evidenceScore)).size, 1);
  assert.deepEqual(new Set(scores.map((s) => s.potentialMax)).size, 1);

  assert.equal(scoreProspect(base({ facts: withStaff(4, [fact("catalog_size", "60", "inferred", { n: 60 })]) })).fitStatus, "probable_fit");
  assert.equal(scoreProspect(base({ facts: withStaff(2), signals: [signal({ signalType: "growth_initiative", title: "Opening wholesale" })], screened: true })).fitStatus, "probable_fit");
});

test("components still total 100, never score headcount, and count revenue only once", () => {
  const s = scoreProspect(base({ facts: withStaff(40, [revenue(5e6)]) }));
  assert.equal(s.components.reduce((t, c) => t + c.max, 0), 100);
  const keys = s.components.flatMap((c) => c.items.map((i) => i.key));
  assert.ok(!keys.includes("employee_count"));
  assert.equal(keys.filter((k) => k === "revenue_annual_usd").length, 1);
});

test("a 100-person company with a mature testing stack shows little need for outside help", () => {
  const s = scoreProspect(base({ facts: withStaff(100, [revenue(30e6), fact("experimentation_tools", "Optimizely, Dynamic Yield", "inferred")]), screened: true }));
  assert.equal(assessment(s, "need_for_help").level, "weak");
  assert.ok(assessment(s, "need_for_help").risks.some((r) => /Mature experimentation stack/.test(r)));
  assert.ok(s.tradeOffs.some((t) => /little demonstrated need/.test(t)));
});

test("unknown revenue and unknown internal capability stay unknown", () => {
  const s = scoreProspect(base({ facts: coreFacts() }));
  const cap = assessment(s, "commercial_capacity");
  assert.equal(cap.level, "unknown");
  assert.ok(cap.unknowns.some((u) => /Revenue unknown/.test(u)));
  assert.ok(assessment(s, "need_for_help").unknowns.some((u) => /experimentation capability unknown/.test(u)));
});

test("small founder-led brands are easy to reach; large ones flag layered access", () => {
  const small = scoreProspect(base({ facts: withStaff(4), decisionMakers: [founder()] }));
  assert.equal(assessment(small, "accessibility").level, "strong");
  assert.ok(small.tradeOffs.some((t) => /^Easy to reach, but it is not established/.test(t)));

  const large = scoreProspect(base({ facts: withStaff(450, [revenue(60e6)]) }));
  assert.ok(assessment(large, "accessibility").risks.some((r) => /several layers/.test(r)));
  assert.ok(large.tradeOffs.some((t) => /^Likely able to pay, but reaching someone/.test(t)));
});

test("clearly irrelevant businesses are still set aside with a recorded reason", () => {
  assert.equal(excludeCandidate("A Shopify agency for fashion brands", entity())?.rule, "agency");
  assert.equal(excludeCandidate("Apparel brand", entity({ employeeCount: 5000 }))?.rule, "enterprise_scale");
  const s = scoreProspect(base({ facts: withStaff(3, [revenue(2e6)]), excludedReason: "Describes itself as an agency or consultancy" }));
  assert.equal(s.fitStatus, "not_fit");
});

test("trial notes describe small-team access and unknown capacity without rejecting the brand", () => {
  const c = assessHit(hit("https://tiny.example/", { entity: entity({ employeeCount: 3, revenueAnnualUsd: null }) }), "tiny.example", 1);
  assert.equal(c.irrelevant, null);
  assert.match(c.assessment, /^Needs qualification/);
  assert.match(c.assessment, /capacity unknown/);
  assert.match(c.assessment, /small team, founder likely reachable/);
});
