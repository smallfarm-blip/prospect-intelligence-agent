import type { Match } from "./scoring.ts";
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
const est = (r: Reading) => (r.status === "verified" ? "verified" : r.status === "provider_estimate" ? "provider estimate" : "inferred");
const strongSignal = (s: Signal) => s.confidence === "high" || s.confidence === "medium";
const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

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
  else if (i.revenue.match === "match") strengths.push(`Revenue ${i.revenue.label} (${est(i.revenue)})`);
  else risks.push(`Revenue ${i.revenue.label} (${est(i.revenue)})`);
  if (known(i.catalog)) (i.catalog.match === "match" ? strengths : risks).push(`Store shows ${i.catalog.label}`);
  if (known(i.funding) && i.funding.match !== "unknown") (i.funding.match === "match" ? strengths : risks).push(`Outside funding ${i.funding.label} (${est(i.funding)})`);
  const verifiedRevenue = i.revenue.status === "verified" && i.revenue.match === "match";
  return { key: "commercial_capacity", label: "Commercial capacity", level: level(strengths, risks, verifiedRevenue || strengths.length >= 2), strengths, risks, unknowns };
}

/** Is there a visible opportunity, and is there room for outside help? */
function needForHelp(i: QualificationInput): Assessment {
  const strengths = i.experienceSignals.map((s) => `${s.title} (${s.confidence} confidence)`);
  const risks: string[] = [];
  const unknowns: string[] = [];
  let mature = false;
  if (!known(i.experimentation)) unknowns.push("Internal UX and experimentation capability unknown");
  else if (i.experimentation.match === "match") strengths.push("No testing or personalisation tools detected");
  else {
    mature = i.experimentation.label.startsWith("several");
    risks.push(mature ? `Mature experimentation stack (${i.experimentation.label}); may not need outside help` : `Already ${i.experimentation.label} for testing; check how actively it is used`);
  }
  if (known(i.promotion) && i.promotion.match === "match") strengths.push(`Promotional tooling in use (${i.promotion.label})`);
  if (!i.screened) unknowns.push("Site experience not screened yet");
  else if (!i.experienceSignals.length) risks.push("Screening found no visitor-experience opportunity");
  const strong = !mature && i.experienceSignals.some(strongSignal);
  const lvl: AssessmentLevel = mature && !i.experienceSignals.some(strongSignal) ? "weak" : level(strengths, risks, strong);
  return { key: "need_for_help", label: "Need for outside help", level: lvl, strengths, risks, unknowns };
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

/** Do the company's current priorities connect to our services? */
function opportunityRelevance(i: QualificationInput): Assessment {
  const sorted = [...i.businessSignals].sort((a, b) => RANK[b.confidence] - RANK[a.confidence]);
  const strengths = sorted.map((s) => `${s.title} (${s.confidence} confidence)`);
  const risks = i.screened && !sorted.length ? ["Screening found no current business priority such as a launch, expansion or relaunch"] : [];
  const unknowns = i.screened ? [] : ["Business priorities not screened yet"];
  const strong = sorted.some((s) => s.confidence === "high") || sorted.length >= 2;
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
  return out;
}

/** Four separate views of the same evidence; each fact feeds exactly one assessment. */
export function assessQualification(i: QualificationInput): { assessments: Assessment[]; tradeOffs: string[] } {
  const byKey = { commercial_capacity: commercialCapacity(i), need_for_help: needForHelp(i), accessibility: accessibility(i), opportunity_relevance: opportunityRelevance(i) };
  return { assessments: Object.values(byKey), tradeOffs: tradeOffs(byKey) };
}
