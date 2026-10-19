import type { Match } from "./scoring.ts";
import { byKind, classifySignal, isServiceLinked, isStrongSignal } from "./signalEvidence.ts";
import type { Confidence, DecisionMaker, FactStatus, Signal } from "./types.ts";

export type AssessmentKey = "commercial_capacity" | "need_for_help" | "accessibility" | "opportunity_relevance";
export type AssessmentLevel = "strong" | "moderate" | "weak" | "unknown";

export interface Assessment {
  key: AssessmentKey;
  label: string;
  level: AssessmentLevel;
  strengths: string[];
  risks: string[];
  unknowns: string[];
}

/** One evaluated fact as seen by the assessments. */
export interface Reading {
  status: FactStatus;
  match: Match;
  label: string;
  value: number | null;
}

export interface QualificationInput {
  revenue: Reading;
  catalog: Reading;
  funding: Reading;
  employees: Reading;
  leadership: Reading;
  experimentation: Reading;
  promotion: Reading;
  experienceSignals: Signal[];
  businessSignals: Signal[];
  decisionMakers: DecisionMaker[];
  screened: boolean;
}

export const SMALL_TEAM_MAX = 25;
export const LARGE_ORG_MIN = 200;

export const TARGET_ROLES = new Set(["founder", "ecommerce_lead", "growth_marketing_lead", "digital_lead"]);
const known = (r: Reading) => r.status !== "unknown" && r.status !== "contradicted";
const viableRevenue = (r: Reading) => r.value !== null && r.value >= 1e6 && r.value <= 75e6;
const est = (r: Reading) => (r.status === "verified" ? "verified" : r.status === "provider_estimate" ? "provider estimate" : "inferred");
const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
const byConfidence = (xs: Signal[]) => [...xs].sort((a, b) => RANK[b.confidence] - RANK[a.confidence]);
const tag = (s: Signal) => `${s.title} (${s.confidence} confidence)`;

function level(strengths: string[], risks: string[], strongIf: boolean): AssessmentLevel {
  if (strongIf) return "strong";
  if (strengths.length) return "moderate";
  return risks.length ? "weak" : "unknown";
}

/** Can the company plausibly pay for a $4,500 sprint? Headcount is deliberately not used here. */
function commercialCapacity(i: QualificationInput): Assessment {
  const strengths: string[] = [];
  const risks: string[] = [];
  const unknowns: string[] = [];
  if (!known(i.revenue)) unknowns.push(i.revenue.status === "contradicted" ? "Revenue: sources disagree" : "Revenue unknown, so budget is not established");
  else if (i.revenue.match === "match" || viableRevenue(i.revenue)) strengths.push(`Revenue ${i.revenue.label} (${est(i.revenue)})`);
  else risks.push(`Revenue ${i.revenue.label} (${est(i.revenue)})`);
  if (known(i.catalog)) (i.catalog.match === "match" ? strengths : risks).push(`Store shows ${i.catalog.label}`);
  if (known(i.funding) && i.funding.match !== "unknown") (i.funding.match === "match" ? strengths : risks).push(`Outside funding ${i.funding.label} (${est(i.funding)})`);
  const verifiedRevenue = i.revenue.status === "verified" && i.revenue.match === "match";
  return { key: "commercial_capacity", label: "Commercial capacity", level: level(strengths, risks, verifiedRevenue || strengths.length >= 2), strengths, risks, unknowns };
}

/**
 * Strong needs direct evidence: an observed experience problem together with an organisational capability gap.
 * One supported problem or gap is Moderate. Triggers, promotional offers, neutral site facts and tools not being
 * detected never establish need on their own; they are listed as things to investigate.
 */
function needForHelp(i: QualificationInput): Assessment {
  const k = byKind([...i.experienceSignals, ...i.businessSignals]);
  const strengths = [
    ...byConfidence(k.experience_problem).map((s) => `Observed experience problem: ${tag(s)}`),
    ...byConfidence(k.capability_gap).map((s) => `Capability gap: ${tag(s)}`),
  ];
  const risks: string[] = [];
  const unknowns: string[] = [];
  for (const s of byConfidence(k.friction_hypothesis)) {
    unknowns.push(s.signalType === "promotional_orchestration"
      ? `To investigate: ${s.title}. Offer timing, targeting, relevance and orchestration are not yet assessed; several offers alone do not show harmful friction`
      : `Possible friction, not yet supported by direct observation: ${s.title}`);
  }
  for (const s of k.experience_fact) unknowns.push(`Observed on the site, but not shown to be a problem: ${s.title}`);

  let mature = false;
  if (!known(i.experimentation)) unknowns.push("Internal UX and experimentation capability unknown");
  else if (i.experimentation.match === "match") strengths.push(`No testing or personalisation tools in use (${est(i.experimentation)})`);
  else if (i.experimentation.match === "unknown") unknowns.push("Testing and personalisation maturity unknown: no tools were detected on the homepage, which does not show they are absent");
  else {
    mature = i.experimentation.label.startsWith("several");
    risks.push(mature ? `Mature experimentation stack (${i.experimentation.label}); may not need outside help` : `Already ${i.experimentation.label} for testing; check how actively it is used`);
  }
  if (known(i.promotion) && i.promotion.match === "match") unknowns.push(`Promotional tooling installed (${i.promotion.label}); how it is used and whether it helps or hurts visitors is unknown`);
  if (k.commercial_trigger.length && !strengths.length) unknowns.push("Business triggers add context but do not show a need for outside CRO, UX, experimentation or personalisation help");
  if (!i.screened) unknowns.push("Site experience not screened yet");
  else if (!i.experienceSignals.length) unknowns.push("Homepage screening found no specific experience problem; the wider site has not been reviewed");

  const strong = !mature && k.experience_problem.length > 0 && k.capability_gap.length > 0;
  return { key: "need_for_help", label: "Need for outside help", level: level(strengths, risks, strong), strengths, risks, unknowns };
}

/** How realistically we can reach someone able to hire a consultant. */
function accessibility(i: QualificationInput): Assessment {
  const strengths: string[] = [];
  const risks: string[] = [];
  const unknowns: string[] = [];
  const who = (d: DecisionMaker) => `${d.name}${d.title ? ` (${d.title})` : ""}`;
  const confirmed = i.decisionMakers.find((d) => d.review === "confirmed" && TARGET_ROLES.has(d.roleCategory));
  const possible = i.decisionMakers.find((d) => d.review === null && TARGET_ROLES.has(d.roleCategory) && d.matchConfidence !== "low");
  const weakLead = i.decisionMakers.find((d) => d.review === null && TARGET_ROLES.has(d.roleCategory) && d.matchConfidence === "low");
  if (confirmed) strengths.push(`Confirmed decision-maker: ${who(confirmed)}`);
  else if (possible) strengths.push(`Likely current decision-maker, not yet confirmed: ${who(possible)}`);
  else if (weakLead) risks.push(`Only an unconfirmed lead: ${who(weakLead)}; current role not established`);
  else unknowns.push("No decision-maker identified yet");

  const founderLed = known(i.leadership) && i.leadership.match === "match";
  if (founderLed) strengths.push(`Founder-led or lean leadership (${i.leadership.label})`);
  const n = known(i.employees) ? i.employees.value : null;
  if (n === null) unknowns.push("Team size unknown");
  else if (n <= SMALL_TEAM_MAX) strengths.push(`Small reported team (${n}); leadership is usually reachable directly`);
  else if (n >= LARGE_ORG_MIN) risks.push(`Larger organisation (${n} people); likely several layers before a budget holder`);

  const strong = !!confirmed || (!!possible && (founderLed || (n !== null && n <= SMALL_TEAM_MAX)));
  return { key: "accessibility", label: "Decision-maker accessibility", level: level(strengths, risks, strong), strengths, risks, unknowns };
}

/**
 * Do the company's current priorities connect to our services? Any trigger is business context (Moderate);
 * Strong needs a strong signal whose observed evidence ties directly to the work we do.
 */
function opportunityRelevance(i: QualificationInput): Assessment {
  const sorted = byConfidence(i.businessSignals);
  const linked = sorted.filter((s) => isServiceLinked(s) || classifySignal(s) === "capability_gap");
  const strengths = sorted.map((s) => (linked.includes(s) ? `Linked to our services: ${tag(s)}` : `Business context: ${tag(s)}`));
  const risks = i.screened && !sorted.length ? ["Screening found no current business priority such as a launch, expansion or relaunch"] : [];
  const unknowns = i.screened ? [] : ["Business priorities not screened yet"];
  if (sorted.length && !linked.length) unknowns.push("No specific link yet between this business activity and conversion, UX, experimentation or personalisation work");
  const strong = linked.some(isStrongSignal) || linked.length >= 2;
  return { key: "opportunity_relevance", label: "Opportunity relevance", level: level(strengths, risks, strong), strengths, risks, unknowns };
}

function tradeOffs(a: Record<AssessmentKey, Assessment>): string[] {
  const good = (x: Assessment) => x.level === "strong" || x.level === "moderate";
  const shaky = (x: Assessment) => x.level === "weak" || x.level === "unknown";
  const name = (x: Assessment) => x.label.toLowerCase();
  const all = Object.values(a);
  const out: string[] = [];
  const promising = all.filter(good).map((x) => `${name(x)} ${x.level}`);
  const concerns = all.filter(shaky).map((x) => `${name(x)} ${x.level}`);
  out.push(`${promising.length ? `Promising: ${promising.join(", ")}.` : "Nothing promising established yet."} ${concerns.length ? `Risks: ${concerns.join(", ")}.` : "No weak or unknown area."}`);
  const { commercial_capacity: cap, need_for_help: need, accessibility: access, opportunity_relevance: rel } = a;
  if (good(access) && shaky(cap)) out.push("Easy to reach, but it is not established that they can fund a $4,500 sprint.");
  if (good(cap) && shaky(access)) out.push("Likely able to pay, but reaching someone with authority to hire a consultant may be hard.");
  if (good(cap) && need.level === "weak") out.push("Has commercial capacity, but little demonstrated need for outside help.");
  if (good(need) && shaky(rel)) out.push("Visible site opportunities, but no evidence they are a current business priority.");
  if (good(rel) && shaky(need)) out.push("Current business activity gives context, but a need for outside help is not established yet.");
  return out;
}

/** Four separate views of the same evidence; each fact feeds exactly one assessment. */
export function assessQualification(i: QualificationInput): { assessments: Assessment[]; tradeOffs: string[] } {
  const byKey = { commercial_capacity: commercialCapacity(i), need_for_help: needForHelp(i), accessibility: accessibility(i), opportunity_relevance: opportunityRelevance(i) };
  return { assessments: Object.values(byKey), tradeOffs: tradeOffs(byKey) };
}
