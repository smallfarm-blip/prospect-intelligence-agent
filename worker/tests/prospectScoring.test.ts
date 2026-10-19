import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFit, rankProspects, resolveAttribute, scoreProspect, type ProspectScoreInput } from "../src/prospecting/scoring.ts";
import type { DecisionMaker, Fact, Signal } from "../src/prospecting/types.ts";
import { fact } from "./helpers/prospectFixtures.ts";

const base = (over: Partial<ProspectScoreInput> = {}): ProspectScoreInput => ({ facts: [], signals: [], decisionMakers: [], screened: false, excludedReason: null, ...over });

const signal = (over: Partial<Signal> = {}): Signal => ({
  signalType: "business_trigger",
  title: "Launched a new home category",
  observedEvidence: "Press release announces a bedding line.",
  interpretation: "May need help merchandising a new range.",
  businessRelevance: "New categories often change navigation needs.",
  criticalUnknowns: ["Launch size"],
  nextValidation: "Check the new category pages.",
  sourceUrls: ["https://news.example/a"],
  confidence: "high",
  ...over,
});

const probableFacts = (): Fact[] => [
  fact("category", "apparel", "inferred", { source: "ai_screening" }),
  fact("sells_dtc", "yes", "verified"),
  fact("hq_country", "United States", "provider_estimate"),
  fact("revenue_annual_usd", "$8,000,000", "provider_estimate", { n: 8e6 }),
];

const verifiedFacts = (): Fact[] => [
  fact("category", "apparel", "verified", { source: "reviewer" }),
  fact("sells_dtc", "yes", "verified"),
  fact("hq_country", "US", "verified", { source: "reviewer" }),
  fact("revenue_annual_usd", "$7M", "verified", { n: 7e6, source: "reviewer", url: "https://press.example/revenue" }),
];

test("unknown revenue keeps the company visible as needs qualification with full upside", () => {
  const s = scoreProspect(base({ facts: [fact("category", "beauty", "inferred"), fact("sells_dtc", "yes", "verified"), fact("hq_country", "US", "inferred")] }));
  assert.equal(s.fitStatus, "needs_qualification");
  assert.ok(s.potentialMax > s.evidenceScore + 30, `potential ${s.potentialMax} should far exceed evidence ${s.evidenceScore}`);
  assert.ok(s.unresolved.some((u) => u.startsWith("Annual revenue: unknown")));
  assert.equal(rankProspects([{ companyId: "a", score: s.evidenceScore, potentialMax: s.potentialMax, fitStatus: s.fitStatus, setAside: false }]).length, 1);
});

test("an uncorroborated provider revenue estimate alone stays needs qualification; a second independent support makes it probable, never verified", () => {
  assert.equal(scoreProspect(base({ facts: probableFacts() })).fitStatus, "needs_qualification");
  assert.match(scoreProspect(base({ facts: probableFacts() })).fitBasis[0], /Only one line of support/);
  const s = scoreProspect(base({ facts: [...probableFacts(), fact("catalog_size", "80", "inferred", { n: 80, source: "ai_screening" })] }));
  assert.equal(s.fitStatus, "probable_fit");
  assert.match(s.fitBasis[0], /2 independent supporting signals/);
  assert.match(s.recommendedAction, /Verify commercial capacity/);
  const revenue = s.components.find((c) => c.key === "commercial")!.items.find((i) => i.key === "revenue_annual_usd")!;
  assert.ok(revenue.evidence < revenue.max, "an estimate earns less than full credit");
});

test("verified fit needs verified category, direct sales, US base and size", () => {
  const s = scoreProspect(base({ facts: verifiedFacts() }));
  assert.equal(s.fitStatus, "verified_fit");
  assert.equal(s.confidence, "medium");
  const withoutSize = verifiedFacts().filter((f) => f.attribute !== "revenue_annual_usd");
  assert.notEqual(scoreProspect(base({ facts: withoutSize })).fitStatus, "verified_fit");
});

test("disagreeing sources are marked contradicted and block a fit status", () => {
  const facts = [...probableFacts(), fact("revenue_annual_usd", "$40,000,000", "provider_estimate", { n: 40e6 })];
  assert.equal(resolveAttribute(facts, "revenue_annual_usd").status, "contradicted");
  const s = scoreProspect(base({ facts }));
  assert.equal(s.fitStatus, "needs_qualification");
  assert.ok(s.unresolved.some((u) => u.includes("sources disagree")));
});

test("estimates within a factor of two agree", () => {
  const facts = [fact("employee_count", "40", "provider_estimate", { n: 40 }), fact("employee_count", "60", "provider_estimate", { n: 60 })];
  assert.equal(resolveAttribute(facts, "employee_count").status, "provider_estimate");
});

test("a reviewer fact overrides provider and AI facts", () => {
  const facts = [fact("category", "other", "inferred"), fact("category", "home", "verified", { source: "reviewer" })];
  const r = resolveAttribute(facts, "category");
  assert.equal(r.status, "verified");
  assert.equal(r.valueText, "home");
});

test("exclusions and verified mismatches are not a fit; large revenue is never an automatic exclusion", () => {
  assert.equal(scoreProspect(base({ facts: verifiedFacts(), excludedReason: "Describes itself as an agency" })).fitStatus, "not_fit");
  const notDtc = [...verifiedFacts().filter((f) => f.attribute !== "sells_dtc"), fact("sells_dtc", "no", "verified", { source: "reviewer" })];
  assert.equal(scoreProspect(base({ facts: notDtc })).fitStatus, "not_fit");
  const big = [...verifiedFacts().filter((f) => f.attribute !== "revenue_annual_usd"), fact("revenue_annual_usd", "$400M", "verified", { n: 400e6, source: "reviewer" })];
  assert.equal(scoreProspect(base({ facts: big })).fitStatus, "needs_qualification");
  const est = [...probableFacts().filter((f) => f.attribute !== "revenue_annual_usd"), fact("revenue_annual_usd", "$400M", "provider_estimate", { n: 400e6 })];
  assert.equal(scoreProspect(base({ facts: est })).fitStatus, "needs_qualification");
});

test("business triggers count toward commercial relevance, not observable need", () => {
  const s = scoreProspect(base({ facts: probableFacts(), signals: [signal()], screened: true }));
  const commercial = s.components.find((c) => c.key === "commercial")!;
  const need = s.components.find((c) => c.key === "need")!;
  assert.equal(commercial.items[0].evidence, 3, "a generic trigger earns half credit");
  assert.equal(need.items[0].evidence, 0);
  assert.match(s.commercialRelevance, /1 business trigger/);
  assert.ok(s.reasonsToInvestigate[0].startsWith("Launched a new home category"));
  const linked = scoreProspect(base({ facts: probableFacts(), signals: [signal({ title: "Replatforming to Shopify Plus", observedEvidence: "The company announced it is migrating to Shopify Plus this spring." })], screened: true }));
  assert.equal(linked.components.find((c) => c.key === "commercial")!.items[0].evidence, 6, "a trigger tied to our services earns full credit");
});

test("a visible UX issue alone does not create commercial relevance", () => {
  const ux = signal({ signalType: "visitor_experience", title: "Pop-up covers product images on mobile", confidence: "high" });
  const s = scoreProspect(base({ facts: probableFacts(), signals: [ux], screened: true }));
  assert.equal(s.components.find((c) => c.key === "commercial")!.items[0].evidence, 0);
  assert.match(s.commercialRelevance, /No business trigger found yet/);
});

test("decision-maker points: confirmed target role 10, possible 4, none 0", () => {
  const dm = { name: "Ana Ruiz", title: "Founder", roleCategory: "founder" as const, profileUrl: null, sourceUrl: "https://x.example", sourcePublishedAt: null, matchConfidence: "high" as const, employmentStatus: "current" as const, roleStartedOn: "2016-01-01", matchBasis: null };
  const pts = (review: "confirmed" | "rejected" | null) => scoreProspect(base({ decisionMakers: [{ ...dm, review }] })).components.find((c) => c.key === "decision_maker")!.evidence;
  assert.equal(pts("confirmed"), 10);
  assert.equal(pts(null), 4);
  assert.equal(pts("rejected"), 0);
});

test("an unconfirmed low-confidence match (undated or title-only role) earns no decision-maker points", () => {
  const dm: DecisionMaker = { name: "Ana Ruiz", title: "Founder", roleCategory: "founder", profileUrl: null, sourceUrl: "https://x.example", sourcePublishedAt: null, matchConfidence: null, employmentStatus: null, roleStartedOn: null, matchBasis: null, review: null };
  const item = (d: Pick<DecisionMaker, "matchConfidence" | "employmentStatus">) => scoreProspect(base({ decisionMakers: [{ ...dm, ...d }] })).components.find((c) => c.key === "decision_maker")!.items[0]!;
  const weak = item({ matchConfidence: "low", employmentStatus: "undated" });
  assert.equal(weak.evidence, 0);
  assert.match(weak.note, /weak lead only/);
  assert.equal(item({ matchConfidence: null, employmentStatus: null }).evidence, 4, "records stored before match evidence keep their previous treatment");
});

test("the score stays within 0-100 and the score range is ordered", () => {
  const s = scoreProspect(base({ facts: verifiedFacts(), signals: [signal(), signal({ title: "B" }), signal({ signalType: "promotional_orchestration", title: "C" })], screened: true }));
  assert.ok(s.evidenceScore >= 0 && s.evidenceScore <= 100);
  assert.ok(s.potentialMin <= s.potentialMax && s.potentialMax <= 100);
});

test("classifyFit treats a missing direct store as unknown, not a mismatch", () => {
  const r = Object.fromEntries((["category", "sells_dtc", "business_model", "hq_country", "revenue_annual_usd", "employee_count", "funding_total_usd", "leadership_model", "experimentation_tools", "promotion_tools", "catalog_size"] as const).map((a) => [a, resolveAttribute([], a)])) as Parameters<typeof classifyFit>[0];
  assert.equal(classifyFit(r, null), "needs_qualification");
});

test("rankProspects skips set-aside and not-fit companies and orders by score then upside", () => {
  const ranked = rankProspects([
    { companyId: "a", score: 40, potentialMax: 60, fitStatus: "probable_fit", setAside: false },
    { companyId: "b", score: 40, potentialMax: 90, fitStatus: "needs_qualification", setAside: false },
    { companyId: "c", score: 80, potentialMax: 80, fitStatus: "not_fit", setAside: false },
    { companyId: "d", score: 70, potentialMax: 70, fitStatus: "verified_fit", setAside: true },
    { companyId: "e", score: 55, potentialMax: 55, fitStatus: "verified_fit", setAside: false },
  ]);
  assert.deepEqual(ranked.map((r) => r.companyId), ["e", "b", "a"]);
});
