import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateEstimate, revenueBand, scoreProspect, type ProspectScoreInput } from "../src/prospecting/scoring.ts";
import type { Fact, Signal } from "../src/prospecting/types.ts";
import { fact } from "./helpers/prospectFixtures.ts";

const base = (over: Partial<ProspectScoreInput> = {}): ProspectScoreInput => ({ facts: [], signals: [], decisionMakers: [], screened: true, excludedReason: null, ...over });

const core = (): Fact[] => [
  fact("category", "home", "inferred", { source: "ai_screening" }),
  fact("sells_dtc", "yes", "verified"),
  fact("hq_country", "US", "provider_estimate"),
];

const rev = (n: number, status: Fact["status"] = "provider_estimate"): Fact => fact("revenue_annual_usd", String(n), status, status === "verified" ? { n, source: "reviewer", url: "https://press.example/r" } : { n });
const catalogue = fact("catalog_size", "120", "inferred", { n: 120, source: "ai_screening" });
const funding = fact("funding_total_usd", "4000000", "provider_estimate", { n: 4e6 });

const trigger = (over: Partial<Signal> = {}): Signal => ({
  signalType: "business_trigger",
  title: "Launching a new bedding category",
  observedEvidence: "Press release dated last month announces the bedding launch and a new site section.",
  interpretation: "New category pages and navigation will need merchandising.",
  businessRelevance: "A new category changes navigation and product discovery, which the sprint addresses directly.",
  criticalUnknowns: [],
  nextValidation: "Review the new category pages.",
  sourceUrls: ["https://news.example/launch"],
  confidence: "high",
  ...over,
});

const revenueItem = (facts: Fact[]) => scoreProspect(base({ facts })).components.find((c) => c.key === "commercial")!.items.find((i) => i.key === "revenue_annual_usd")!;

test("revenue bands: $5M-$25M is core, $5M-$10M the sweet spot; others are relative, never mismatches", () => {
  assert.equal(revenueBand(7e6), "core_sweet_spot");
  assert.equal(revenueBand(18e6), "core");
  assert.equal(revenueBand(3e6), "below_core");
  assert.equal(revenueBand(40e6), "above_core");
  assert.equal(revenueBand(120e6), "outside_primary");
  assert.equal(revenueBand(400e3), "well_below_core");
  for (const n of [400e3, 3e6, 40e6, 120e6, 2e9]) assert.notEqual(evaluateEstimate("revenue_annual_usd", String(n), n).match, "mismatch");
  assert.match(evaluateEstimate("revenue_annual_usd", "120000000", 120e6).label, /outside the primary ICP/);
});

test("revenue credit ranks the sweet spot highest and keeps viable bands above the outer bands", () => {
  const pts = (n: number) => revenueItem([...core(), rev(n)]).evidence;
  assert.ok(pts(7e6) > pts(18e6));
  assert.ok(pts(18e6) > pts(40e6));
  assert.equal(pts(40e6), pts(3e6));
  assert.ok(pts(3e6) > pts(120e6));
  const unknown = revenueItem(core());
  assert.equal(unknown.evidence, 0);
  assert.equal(unknown.potential, unknown.max);
});

test("headcount is never turned into a revenue figure", () => {
  const s = scoreProspect(base({ facts: [...core(), fact("employee_count", "500", "provider_estimate", { n: 500 })] }));
  assert.equal(s.components.find((c) => c.key === "commercial")!.items.find((i) => i.key === "revenue_annual_usd")!.status, "unknown");
  assert.ok(s.assessments.find((a) => a.key === "commercial_capacity")!.unknowns.some((u) => /Revenue unknown/.test(u)));
  assert.ok(s.unresolved.some((u) => u.startsWith("Annual revenue: unknown")));
});

test("one generic signal or one uncorroborated estimate is not enough for probable fit", () => {
  const one = (extra: Partial<ProspectScoreInput>) => scoreProspect(base({ facts: core(), ...extra })).fitStatus;
  assert.equal(one({ signals: [trigger({ confidence: "medium" })] }), "needs_qualification");
  assert.equal(one({ signals: [trigger({ sourceUrls: [] })] }), "needs_qualification", "unsourced");
  assert.equal(one({ signals: [trigger({ businessRelevance: "Relevant." })] }), "needs_qualification", "no explanation");
  assert.equal(one({ facts: [...core(), catalogue] }), "needs_qualification");
  assert.equal(one({ facts: [...core(), funding] }), "needs_qualification");
  assert.equal(one({ facts: [...core(), rev(8e6)] }), "needs_qualification");
  assert.equal(one({ signals: [trigger({ confidence: "medium" }), trigger({ confidence: "medium", title: "Opening a second warehouse" })] }), "needs_qualification", "same source type");
  assert.equal(one({ facts: [...core(), rev(8e6), funding] }), "needs_qualification", "both from the same provider record");
});

test("multiple independent supports, or one strong explained signal, give probable fit with the basis recorded", () => {
  const multi = scoreProspect(base({ facts: [...core(), rev(8e6), catalogue] }));
  assert.equal(multi.fitStatus, "probable_fit");
  assert.match(multi.fitBasis[0], /independent supporting signals/);
  assert.ok(multi.fitBasis.some((b) => /\[provider\]/.test(b)) && multi.fitBasis.some((b) => /\[company site\]/.test(b)));

  const mixed = scoreProspect(base({ facts: [...core(), funding], signals: [trigger({ confidence: "medium" })] }));
  assert.equal(mixed.fitStatus, "probable_fit");

  const strong = scoreProspect(base({ facts: core(), signals: [trigger()] }));
  assert.equal(strong.fitStatus, "needs_qualification", "a strong launch shows activity, not capacity");
  assert.match(strong.fitBasis[0], /no revenue or funding evidence yet/);

  const strongFunded = scoreProspect(base({ facts: [...core(), funding], signals: [trigger()] }));
  assert.equal(strongFunded.fitStatus, "probable_fit");
});

test("revenue outside $1M-$75M is not support, but never removes the company", () => {
  const s = scoreProspect(base({ facts: [...core(), rev(150e6), catalogue] }));
  assert.equal(s.fitStatus, "needs_qualification");
  assert.notEqual(s.fitStatus, "not_fit");
});

test("verified fit still requires independently verified traits including revenue in a viable band", () => {
  const verified = [
    fact("category", "home", "verified", { source: "reviewer", url: "https://x.example" }),
    fact("sells_dtc", "yes", "verified"),
    fact("hq_country", "US", "verified", { source: "reviewer", url: "https://x.example" }),
  ];
  assert.equal(scoreProspect(base({ facts: [...verified, rev(9e6, "verified")] })).fitStatus, "verified_fit");
  assert.equal(scoreProspect(base({ facts: [...verified, rev(9e6)] })).fitStatus, "needs_qualification", "provider estimate alone");
  assert.notEqual(scoreProspect(base({ facts: [...verified, rev(120e6, "verified")] })).fitStatus, "verified_fit");
  assert.equal(scoreProspect(base({ facts: [...core(), rev(9e6, "verified")] })).fitStatus, "probable_fit", "verified revenue is one strong support");
});
