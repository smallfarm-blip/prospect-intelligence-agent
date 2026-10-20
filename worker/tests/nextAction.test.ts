import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreProspect, type ProspectScoreInput } from "../src/prospecting/scoring.ts";
import type { DecisionMaker, Fact, Signal } from "../src/prospecting/types.ts";
import { fact } from "./helpers/prospectFixtures.ts";

const signal = (over: Partial<Signal>): Signal => ({
  signalType: "business_trigger",
  title: "Signal",
  observedEvidence: "Observed on the homepage.",
  interpretation: "May matter.",
  businessRelevance: "Could affect how shoppers discover products.",
  criticalUnknowns: [],
  nextValidation: "Review the page.",
  sourceUrls: ["https://brand.example/"],
  confidence: "high",
  ...over,
});

const person = (over: Partial<DecisionMaker>): DecisionMaker => ({
  name: "Alex Doe",
  title: "Head of Ecommerce",
  roleCategory: "ecommerce_lead",
  profileUrl: null,
  sourceUrl: "https://people.example/alex",
  sourcePublishedAt: null,
  matchConfidence: "medium",
  employmentStatus: "current",
  roleStartedOn: null,
  matchBasis: null,
  review: null,
  ...over,
});

const marineLayerFacts = (): Fact[] => [
  fact("category", "apparel", "inferred", { source: "ai_screening" }),
  fact("sells_dtc", "yes", "verified"),
  fact("hq_country", "United States", "provider_estimate"),
  fact("revenue_annual_usd", "$35,000,000", "provider_estimate", { n: 35e6 }),
  fact("funding_total_usd", "3700000", "provider_estimate", { n: 3.7e6 }),
  fact("employee_count", "360", "provider_estimate", { n: 360 }),
  fact("catalog_size", "250", "verified", { n: 250, url: "https://marinelayer.example/products.json" }),
  fact("experimentation_tools", "Nosto", "inferred"),
];

const marineLayer = (over: Partial<ProspectScoreInput> = {}): ProspectScoreInput => ({
  facts: marineLayerFacts(),
  signals: [
    signal({ title: "Retail expansion beyond 55 stores", observedEvidence: "A 2025 article reports new store openings beyond 55 locations." }),
    signal({ signalType: "promotional_orchestration", title: "Customisation bar pop-ups promoted", observedEvidence: "Homepage promotes pop-up customisation bars in stores.", confidence: "low" }),
  ],
  decisionMakers: [person({ name: "Katie Malone", title: "Senior Director of E-commerce" })],
  screened: true,
  excludedReason: null,
  ...over,
});

const buckle = (): ProspectScoreInput => ({
  facts: [
    fact("category", "accessories", "inferred", { source: "ai_screening" }),
    fact("sells_dtc", "yes", "verified"),
    fact("hq_country", "United States", "inferred", { source: "ai_screening" }),
    fact("catalog_size", "98", "verified", { n: 98, url: "https://bucklescrunchies.example/products.json" }),
    fact("employee_count", "2", "provider_estimate", { n: 2 }),
  ],
  signals: [
    signal({ signalType: "growth_initiative", title: "Buckle Hair Ties launch", observedEvidence: "The homepage announces the new Buckle Hair Ties product." }),
    signal({ signalType: "visitor_experience", title: "NYC pickup offered at checkout", observedEvidence: "The homepage says NYC pickup is available at checkout." }),
  ],
  decisionMakers: [],
  screened: true,
  excludedReason: null,
});

test("Marine Layer: established brand with a plausible buyer but no demonstrated need -> Validate business need", () => {
  const s = scoreProspect(marineLayer());
  assert.equal(s.fitStatus, "probable_fit");
  assert.equal(s.nextAction.key, "validate_business_need");
  assert.match(s.nextAction.explanation, /commercially established and has a plausible buyer/);
  assert.match(s.nextAction.keyUnknown, /Nosto/);
  assert.ok(s.nextAction.evidence.some((e) => /Revenue \$35M/.test(e)));
  assert.ok(s.nextAction.evidence.some((e) => /Katie Malone/.test(e)));
  assert.match(s.recommendedAction, /^Validate business need/);
  assert.doesNotMatch(s.recommendedAction, /annual revenue/i);
});

test("Buckle Scrunchies: catalogue plus a generic launch stays Needs qualification with a lightweight capacity check", () => {
  const s = scoreProspect(buckle());
  assert.equal(s.fitStatus, "needs_qualification");
  assert.match(s.fitBasis[0], /commercial activity, but no revenue or funding evidence/);
  assert.equal(s.nextAction.key, "verify_commercial_capacity");
  assert.match(s.nextAction.step, /^Lightweight check only/);
  assert.match(s.nextAction.explanation, /No buyer is identified/);
  assert.ok(s.nextAction.evidence.some((e) => /98 products/.test(e)));
  assert.match(s.nextAction.keyUnknown, /Revenue unknown/);
});

test("investigation value ranks Marine Layer well above Buckle Scrunchies", () => {
  assert.ok(scoreProspect(marineLayer()).nextAction.priority > scoreProspect(buckle()).nextAction.priority + 15);
});

test("a shown need with only a possible buyer -> Confirm decision-maker; once confirmed -> Investigate website", () => {
  const soldOut = signal({ signalType: "visitor_experience", title: "Sold-out products shown in featured sections", observedEvidence: "The New Arrivals section lists three bags, each marked sold out." });
  const possible = scoreProspect(marineLayer({ signals: [soldOut] }));
  assert.equal(possible.nextAction.key, "confirm_decision_maker");
  assert.match(possible.nextAction.keyUnknown, /Katie Malone.*unconfirmed/);
  const confirmed = scoreProspect(marineLayer({ signals: [soldOut], decisionMakers: [person({ name: "Katie Malone", review: "confirmed" })] }));
  assert.equal(confirmed.nextAction.key, "investigate_website");
});

test("credible fit plus a specific sourced experience hypothesis -> targeted website investigation", () => {
  const offers = signal({ signalType: "promotional_orchestration", title: "Multiple offers visible on the homepage", observedEvidence: "40% off, free shipping over $130 and a bundle offer are all shown.", criticalUnknowns: ["Which offers a visitor actually sees and when"] });
  const s = scoreProspect(marineLayer({ signals: [offers] }));
  assert.equal(s.nextAction.key, "investigate_website");
  assert.match(s.nextAction.step, /Multiple offers visible on the homepage/);
  assert.equal(s.nextAction.keyUnknown, "Which offers a visitor actually sees and when");
});

test("clearly unsuitable companies are deferred with zero investigation value", () => {
  const excluded = scoreProspect(marineLayer({ excludedReason: "Enterprise scale (1,993 employees)" }));
  assert.equal(excluded.nextAction.key, "defer");
  assert.equal(excluded.nextAction.priority, 0);
  const mature = scoreProspect(marineLayer({
    facts: [...marineLayerFacts().filter((f) => f.attribute !== "revenue_annual_usd" && f.attribute !== "experimentation_tools"), fact("revenue_annual_usd", "$342,000,000", "provider_estimate", { n: 342e6 }), fact("experimentation_tools", "Convert, Intelligems, Rebuy", "inferred")],
  }));
  assert.equal(mature.nextAction.key, "defer");
  assert.match(mature.nextAction.explanation, /mature testing stack/);
});

test("an unscreened company gets a website screen before anything else", () => {
  const s = scoreProspect(marineLayer({ signals: [], screened: false }));
  assert.equal(s.nextAction.key, "investigate_website");
  assert.match(s.nextAction.step, /screening/);
});
