import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssessmentKey } from "../src/prospecting/qualification.ts";
import { scoreProspect, type ProspectScore, type ProspectScoreInput } from "../src/prospecting/scoring.ts";
import { classifySignal } from "../src/prospecting/signalEvidence.ts";
import type { DecisionMaker, Fact, Signal } from "../src/prospecting/types.ts";
import { fact } from "./helpers/prospectFixtures.ts";

const facts = (): Fact[] => [
  fact("revenue_annual_usd", "$23,000,000", "provider_estimate", { n: 23e6 }),
  fact("catalog_size", "250+", "verified", { n: 250, url: "https://unique-vintage.example/products.json" }),
  fact("sells_dtc", "yes", "verified"),
  fact("category", "apparel", "inferred", { source: "ai_screening" }),
  fact("hq_country", "United States", "provider_estimate"),
  fact("experimentation_tools", "none detected", "inferred"),
  fact("promotion_tools", "Klaviyo forms, Postscript", "inferred"),
];

const offers: Signal = {
  signalType: "promotional_orchestration",
  title: "Multiple offers visible on the homepage",
  observedEvidence: "The homepage text shows a 40%-off Halloween-styles offer, free shipping on orders over $130, and a buy-any-swing-dress-plus-petticoat offer saving 20%.",
  interpretation: "These offers may benefit from checking whether their timing and relevance match different visitor intents.",
  businessRelevance: "This could matter if offer sequencing affects revenue per visitor, margin or collection discovery.",
  criticalUnknowns: ["Which offers an individual visitor actually sees and when"],
  nextValidation: "Review a few live visitor journeys.",
  sourceUrls: ["https://unique-vintage.example/"],
  confidence: "high",
};

const launches: Signal = {
  signalType: "business_trigger",
  title: "Licensed apparel collection launches",
  observedEvidence: "An October 2025 article says the brand teamed with Disney for a Frozen collection arriving October 7 on its site. An August 2025 article reports a limited-edition Elvira collaboration.",
  interpretation: "The collection launches may create recurring moments to assess how shoppers discover new releases.",
  businessRelevance: "A growth sprint could matter if these launches are commercially significant and the team wants to improve launch performance.",
  criticalUnknowns: ["Whether similar launches are planned"],
  nextValidation: "Check the current collection landing pages.",
  sourceUrls: ["https://news.example/frozen", "https://news.example/elvira", "https://unique-vintage.example/"],
  confidence: "high",
};

const rachael: DecisionMaker = {
  name: "Rachael Kemp",
  title: "Director of Brand Marketing & Ecommerce",
  roleCategory: "ecommerce_lead",
  profileUrl: null,
  sourceUrl: "https://people.example/rachael",
  sourcePublishedAt: null,
  matchConfidence: "medium",
  employmentStatus: "current",
  roleStartedOn: null,
  matchBasis: null,
  review: null,
};

const input = (over: Partial<ProspectScoreInput> = {}): ProspectScoreInput => ({ facts: facts(), signals: [offers, launches], decisionMakers: [rachael], screened: true, excludedReason: null, ...over });
const a = (s: ProspectScore, key: AssessmentKey) => s.assessments.find((x) => x.key === key)!;
const item = (s: ProspectScore, component: string, key: string) => s.components.find((c) => c.key === component)!.items.find((i) => i.key === key)!;

test("Unique Vintage pattern: offers, a collection launch and undetected tools do not make need or relevance Strong", () => {
  const s = scoreProspect(input());
  const need = a(s, "need_for_help");
  assert.equal(need.level, "unknown");
  assert.equal(need.strengths.length, 0);
  assert.ok(need.unknowns.some((u) => /To investigate: Multiple offers.*timing, targeting, relevance and orchestration/.test(u)));
  assert.ok(need.unknowns.some((u) => /maturity unknown.*does not show they are absent/.test(u)));
  assert.ok(need.unknowns.some((u) => /Promotional tooling installed/.test(u)));
  assert.ok(!need.strengths.concat(need.unknowns, need.risks).some((x) => /^No testing or personalisation tools detected$/.test(x)));
  const rel = a(s, "opportunity_relevance");
  assert.equal(rel.level, "moderate");
  assert.ok(rel.strengths[0].startsWith("Business context: Licensed apparel collection launches"));
  assert.ok(rel.unknowns.some((u) => /No specific link yet/.test(u)));
  assert.ok(s.tradeOffs.some((t) => /need for outside help is not established/.test(t)));
});

test("Unique Vintage pattern: buyer capacity, fit and accessibility keep their positive readings", () => {
  const s = scoreProspect(input());
  assert.equal(a(s, "commercial_capacity").level, "strong");
  assert.equal(a(s, "accessibility").level, "moderate");
  assert.equal(s.fitStatus, "probable_fit");
  assert.equal(item(s, "decision_maker", "decision_maker").evidence, 4);
  assert.ok(s.evidenceScore >= 35, `evidence ${s.evidenceScore} should not be crushed`);
  assert.ok(s.potentialMax >= 85, `potential ${s.potentialMax} keeps the upside of unresearched areas`);
});

test("undetected testing tools earn no credit but keep their full upside; a verified absence does earn credit", () => {
  const s = scoreProspect(input());
  const tools = item(s, "need", "experimentation_tools");
  assert.equal(tools.evidence, 0);
  assert.equal(tools.potential, tools.max);
  const verified = scoreProspect(input({ facts: [...facts().filter((f) => f.attribute !== "experimentation_tools"), fact("experimentation_tools", "none detected", "verified", { source: "reviewer" })] }));
  assert.equal(item(verified, "need", "experimentation_tools").evidence, 6);
});

test("promotional offers alone are an investigation item with token credit, and the upside stays open", () => {
  assert.equal(classifySignal(offers), "friction_hypothesis");
  const s = scoreProspect(input({ signals: [offers] }));
  const exp = item(s, "need", "experience_signals");
  assert.equal(exp.evidence, 1);
  assert.ok(exp.potential >= 9);
  assert.match(exp.note, /to investigate/);
  const conflicting = { ...offers, observedEvidence: "Two discount codes on the homepage contradict each other: 20% off sitewide versus 15% off first orders only." };
  assert.equal(classifySignal(conflicting), "experience_problem");
});

test("a commercial trigger alone never establishes need", () => {
  const s = scoreProspect(input({ signals: [launches] }));
  assert.equal(a(s, "need_for_help").level, "unknown");
  assert.ok(a(s, "need_for_help").unknowns.some((u) => /do not show a need for outside/.test(u)));
  assert.equal(item(s, "need", "experience_signals").evidence, 0);
  assert.equal(item(s, "need", "capability_gap").evidence, 0);
});

test("a specific supported experience problem is Moderate; adding a capability gap makes need Strong", () => {
  const soldOut: Signal = { ...offers, signalType: "visitor_experience", title: "Sold-out products shown in featured sections", observedEvidence: "The New Arrivals section lists three bags, each marked sold out." };
  assert.equal(a(scoreProspect(input({ signals: [soldOut] })), "need_for_help").level, "moderate");
  const gap: Signal = { ...launches, signalType: "organizational_change", title: "Ecommerce lead departed", observedEvidence: "The head of ecommerce left the company in March and the role is vacant, per a trade report." };
  assert.equal(classifySignal(gap), "capability_gap");
  const s = scoreProspect(input({ signals: [soldOut, gap] }));
  assert.equal(a(s, "need_for_help").level, "strong");
  assert.equal(a(s, "opportunity_relevance").level, "strong");
});

test("a neutral site feature is not a problem", () => {
  const pickup: Signal = { ...offers, signalType: "visitor_experience", title: "NYC pickup offered at checkout", observedEvidence: "The homepage says NYC pickup is available at checkout." };
  assert.equal(classifySignal(pickup), "experience_fact");
  assert.equal(a(scoreProspect(input({ signals: [pickup] })), "need_for_help").level, "unknown");
});

test("Strong relevance needs a trigger whose observed evidence ties to our services", () => {
  const replatform: Signal = { ...launches, title: "Site relaunch on Shopify Plus", observedEvidence: "A March 2026 release says the brand is migrating to Shopify Plus with a storefront redesign this spring." };
  const s = scoreProspect(input({ signals: [replatform] }));
  assert.equal(a(s, "opportunity_relevance").level, "strong");
  assert.ok(a(s, "opportunity_relevance").strengths[0].startsWith("Linked to our services"));
  assert.equal(a(s, "need_for_help").level, "unknown", "relevance never doubles as need");
});
