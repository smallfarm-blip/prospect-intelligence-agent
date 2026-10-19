import { TARGET_CATEGORIES, type Confidence, type DecisionMaker, type Fact, type FactAttribute, type FactStatus, type FitStatus, type Signal } from "./types.ts";

export const SCORING_VERSION = "prospect-score-v1";

const STATUS_WEIGHT: Record<FactStatus, number> = { verified: 1, provider_estimate: 0.6, inferred: 0.5, contradicted: 0, unknown: 0 };
const STATUS_RANK: Record<FactStatus, number> = { verified: 3, provider_estimate: 2, inferred: 1, contradicted: 0, unknown: 0 };
const STATUS_LABEL: Record<FactStatus, string> = {
  verified: "verified",
  provider_estimate: "provider estimate only",
  inferred: "inferred only",
  contradicted: "sources disagree",
  unknown: "unknown",
};

export interface ResolvedAttribute {
  attribute: FactAttribute;
  status: FactStatus;
  valueText: string | null;
  valueNumber: number | null;
  sources: string[];
}

export type Match = "match" | "partial" | "mismatch" | "unknown";

interface Evaluation {
  match: Match;
  factor: number;
  label: string;
}

export interface ComponentItem {
  key: string;
  label: string;
  max: number;
  evidence: number;
  potential: number;
  status: FactStatus | "signal" | "decision_maker" | "coverage";
  note: string;
}

export interface ScoreComponent {
  key: "fit" | "need" | "commercial" | "decision_maker" | "confidence";
  label: string;
  max: number;
  evidence: number;
  potential: number;
  items: ComponentItem[];
}

export interface ProspectScoreInput {
  facts: Fact[];
  signals: Signal[];
  decisionMakers: DecisionMaker[];
  screened: boolean;
  excludedReason: string | null;
}

export interface ProspectScore {
  scoringVersion: string;
  evidenceScore: number;
  potentialMin: number;
  potentialMax: number;
  confidence: Confidence;
  coverage: number;
  fitStatus: FitStatus;
  components: ScoreComponent[];
  unresolved: string[];
  reasonsToInvestigate: string[];
  commercialRelevance: string;
  organizationalFit: string;
  recommendedAction: string;
}

const ICP_ATTRIBUTES: FactAttribute[] = ["category", "sells_dtc", "business_model", "hq_country", "revenue_annual_usd", "employee_count"];

const LABELS: Partial<Record<FactAttribute, string>> = {
  category: "Category",
  sells_dtc: "Sells direct to consumers",
  business_model: "Business model",
  hq_country: "Headquarters country",
  revenue_annual_usd: "Annual revenue",
  employee_count: "Team size",
  leadership_model: "Founder-led or lean team",
  experimentation_tools: "Experimentation maturity",
  promotion_tools: "Promotional tooling",
  catalog_size: "Active catalogue",
};

function agree(a: Fact, b: Fact): boolean {
  if (a.valueNumber !== null && b.valueNumber !== null) {
    const lo = Math.min(a.valueNumber, b.valueNumber);
    const hi = Math.max(a.valueNumber, b.valueNumber);
    return lo === hi || (lo > 0 && hi / lo <= 2);
  }
  return a.valueText.trim().toLowerCase() === b.valueText.trim().toLowerCase();
}

/** Picks the strongest evidence for one attribute. Reviewer facts win; disagreement at the top rank is a contradiction. */
export function resolveAttribute(facts: Fact[], attribute: FactAttribute): ResolvedAttribute {
  const all = facts.filter((f) => f.attribute === attribute && f.status !== "unknown").sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  const unknown: ResolvedAttribute = { attribute, status: "unknown", valueText: null, valueNumber: null, sources: [] };
  if (!all.length) return unknown;
  const reviewer = all.find((f) => f.sourceType === "reviewer");
  if (reviewer) return { attribute, status: reviewer.status, valueText: reviewer.valueText, valueNumber: reviewer.valueNumber, sources: reviewer.sourceUrl ? [reviewer.sourceUrl] : [] };
  if (all.some((f) => f.status === "contradicted")) {
    return { attribute, status: "contradicted", valueText: all.map((f) => f.valueText).join(" vs "), valueNumber: null, sources: urls(all) };
  }
  const topRank = Math.max(...all.map((f) => STATUS_RANK[f.status]));
  const top = all.filter((f) => STATUS_RANK[f.status] === topRank);
  if (top.some((f) => !agree(f, top[0]))) {
    return { attribute, status: "contradicted", valueText: [...new Set(top.map((f) => f.valueText))].join(" vs "), valueNumber: null, sources: urls(top) };
  }
  return { attribute, status: top[0].status, valueText: top[0].valueText, valueNumber: top[0].valueNumber, sources: urls(top) };
}

function urls(facts: Fact[]): string[] {
  return [...new Set(facts.map((f) => f.sourceUrl).filter((u): u is string => !!u))];
}

export function normalizeCategory(raw: string): string {
  const v = raw.toLowerCase();
  if (TARGET_CATEGORIES.has(v) || v === "other") return v;
  if (/apparel|clothing|fashion|footwear|shoe|denim|outerwear|menswear|womenswear/.test(v)) return "apparel";
  if (/beauty|skin|cosmetic|makeup|hair|fragrance/.test(v)) return "beauty";
  if (/home|bedding|furniture|kitchen|decor|bath|linen|cookware/.test(v)) return "home";
  if (/wellness|supplement|fitness|health|nutrition|sleep/.test(v)) return "wellness";
  if (/goods|gift|stationery|pet|outdoor|toy|accessor|jewel|specialty/.test(v)) return "specialty_consumer_goods";
  return "other";
}

const isUs = (v: string) => /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/i.test(v.trim());

function evaluate(r: ResolvedAttribute): Evaluation {
  if (r.status === "unknown" || r.status === "contradicted" || r.valueText === null) return { match: "unknown", factor: 0, label: STATUS_LABEL[r.status] };
  const v = r.valueText.toLowerCase();
  const n = r.valueNumber;
  switch (r.attribute) {
    case "category": {
      const c = normalizeCategory(v);
      return TARGET_CATEGORIES.has(c) ? { match: "match", factor: 1, label: c.replace(/_/g, " ") } : { match: "mismatch", factor: 0, label: `${r.valueText} (outside target categories)` };
    }
    case "sells_dtc":
      return v === "yes" ? { match: "match", factor: 1, label: "sells direct" } : { match: "mismatch", factor: 0, label: "no direct store found" };
    case "business_model":
      if (v === "dtc_brand") return { match: "match", factor: 1, label: "DTC brand" };
      if (v === "retailer_multi_brand") return { match: "partial", factor: 0.4, label: "multi-brand retailer" };
      if (v === "unclear") return { match: "unknown", factor: 0, label: "unclear" };
      return { match: "mismatch", factor: 0, label: v.replace(/_/g, " ") };
    case "hq_country":
      return isUs(v) ? { match: "match", factor: 1, label: "United States" } : { match: "partial", factor: 0.3, label: `${r.valueText} (outside US-first focus)` };
    case "revenue_annual_usd":
      if (n === null) return { match: "unknown", factor: 0, label: "no figure" };
      if (n >= 5e6 && n <= 10e6) return { match: "match", factor: 1, label: `${money(n)} (sweet spot)` };
      if (n > 10e6 && n <= 25e6) return { match: "match", factor: 0.85, label: money(n) };
      if ((n >= 2e6 && n < 5e6) || (n > 25e6 && n <= 50e6)) return { match: "partial", factor: 0.4, label: `${money(n)} (edge of range)` };
      return { match: "mismatch", factor: 0, label: `${money(n)} (outside $5-25M)` };
    case "employee_count":
      if (n === null) return { match: "unknown", factor: 0, label: "no figure" };
      if (n >= 5 && n <= 150) return { match: "match", factor: 1, label: `${n} people (lean)` };
      if (n > 150 && n <= 400) return { match: "partial", factor: 0.4, label: `${n} people` };
      return { match: "mismatch", factor: 0, label: `${n} people (outside lean-team range)` };
    case "leadership_model":
      return /founder|lean/.test(v) ? { match: "match", factor: 1, label: r.valueText } : { match: "partial", factor: 0.4, label: r.valueText };
    case "experimentation_tools":
      if (v === "none detected") return { match: "match", factor: 1, label: "no testing tools detected" };
      return /,/.test(v) ? { match: "partial", factor: 0.3, label: `several tools: ${r.valueText}` } : { match: "partial", factor: 0.6, label: `uses ${r.valueText}` };
    case "promotion_tools":
      return v === "none detected" ? { match: "partial", factor: 0.3, label: "no pop-up or capture tools detected" } : { match: "match", factor: 1, label: r.valueText };
    case "catalog_size":
      if (n === null) return { match: "unknown", factor: 0, label: "no figure" };
      return n >= 30 ? { match: "match", factor: 1, label: `${n} products` } : n >= 10 ? { match: "partial", factor: 0.5, label: `${n} products` } : { match: "mismatch", factor: 0.2, label: `${n} products` };
    default:
      return { match: "unknown", factor: 0, label: r.valueText };
  }
}

export function money(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : `${Math.round(n / 1e3)}K`;
}

/** Judges one provider-estimated value against the ICP using the same thresholds as scoring. */
export function evaluateEstimate(attribute: FactAttribute, valueText: string, valueNumber: number | null): { match: Match; label: string } {
  const e = evaluate({ attribute, status: "provider_estimate", valueText, valueNumber, sources: [] });
  return { match: e.match, label: e.label };
}

function factItem(r: ResolvedAttribute, max: number): ComponentItem {
  const e = evaluate(r);
  const evidence = max * STATUS_WEIGHT[r.status] * e.factor;
  let potential: number;
  if (r.status === "unknown" || r.status === "contradicted") potential = max;
  else if (r.status === "verified") potential = evidence;
  else potential = e.match === "mismatch" ? max * 0.3 : max * Math.max(e.factor, 0.4);
  return { key: r.attribute, label: LABELS[r.attribute] ?? r.attribute, max, evidence, potential: Math.max(potential, evidence), status: r.status, note: e.label };
}

const SIGNAL_POINTS: Record<Confidence, number> = { high: 6, medium: 4, low: 2 };

function signalItem(key: string, label: string, signals: Signal[], max: number, screened: boolean): ComponentItem {
  const evidence = Math.min(max, signals.reduce((s, sig) => s + SIGNAL_POINTS[sig.confidence], 0));
  const potential = screened ? Math.min(max, evidence + max * 0.25) : max;
  const note = signals.length ? signals.map((s) => s.title).join("; ") : screened ? "none found in screening" : "not screened yet";
  return { key, label, max, evidence, potential, status: "signal", note };
}

const TARGET_ROLES = new Set(["founder", "ecommerce_lead", "growth_marketing_lead", "digital_lead"]);

function decisionMakerItem(dms: DecisionMaker[]): ComponentItem {
  const max = 10;
  const confirmed = dms.filter((d) => d.review === "confirmed");
  const possible = dms.filter((d) => d.review === null && TARGET_ROLES.has(d.roleCategory) && d.matchConfidence !== "low");
  if (confirmed.some((d) => TARGET_ROLES.has(d.roleCategory))) return { key: "decision_maker", label: "Reachable decision-maker", max, evidence: 10, potential: 10, status: "decision_maker", note: `confirmed: ${confirmed[0].name}` };
  if (confirmed.length) return { key: "decision_maker", label: "Reachable decision-maker", max, evidence: 6, potential: 10, status: "decision_maker", note: `confirmed contact outside target roles: ${confirmed[0].name}` };
  if (possible.length) return { key: "decision_maker", label: "Reachable decision-maker", max, evidence: 4, potential: 10, status: "decision_maker", note: `possible, not confirmed: ${possible[0].name}${possible[0].title ? ` (${possible[0].title})` : ""}` };
  const weak = dms.find((d) => d.review === null && TARGET_ROLES.has(d.roleCategory));
  if (weak) return { key: "decision_maker", label: "Reachable decision-maker", max, evidence: 0, potential: 10, status: "decision_maker", note: `weak lead only (current role not established): ${weak.name}` };
  return { key: "decision_maker", label: "Reachable decision-maker", max, evidence: 0, potential: 10, status: "decision_maker", note: "not identified" };
}

function component(key: ScoreComponent["key"], label: string, max: number, items: ComponentItem[]): ScoreComponent {
  return { key, label, max, evidence: items.reduce((s, i) => s + i.evidence, 0), potential: Math.min(max, items.reduce((s, i) => s + i.potential, 0)), items };
}

const BUSINESS_SIGNALS = new Set(["business_trigger", "growth_initiative", "organizational_change"]);

export function scoreProspect(input: ProspectScoreInput): ProspectScore {
  const r = Object.fromEntries(
    (["category", "sells_dtc", "business_model", "hq_country", "revenue_annual_usd", "employee_count", "leadership_model", "experimentation_tools", "promotion_tools", "catalog_size"] as FactAttribute[]).map((a) => [a, resolveAttribute(input.facts, a)]),
  ) as Record<FactAttribute, ResolvedAttribute>;

  const teamItem = (() => {
    const staff = factItem(r.employee_count, 5);
    const lead = factItem(r.leadership_model, 5);
    const best = lead.evidence > staff.evidence ? lead : staff;
    return { ...best, key: "team", label: "Founder-led or lean team", potential: Math.max(staff.potential, lead.potential) };
  })();
  const fit = component("fit", "Organisational fit", 35, [
    factItem(r.category, 8),
    factItem(r.sells_dtc, 5),
    factItem(r.business_model, 3),
    factItem(r.hq_country, 5),
    factItem(r.revenue_annual_usd, 9),
    teamItem,
  ]);

  const experienceSignals = input.signals.filter((s) => !BUSINESS_SIGNALS.has(s.signalType));
  const businessSignals = input.signals.filter((s) => BUSINESS_SIGNALS.has(s.signalType));
  const need = component("need", "Observable need", 25, [
    signalItem("experience_signals", "Visitor-experience and promotion signals", experienceSignals, 15, input.screened),
    factItem(r.experimentation_tools, 5),
    factItem(r.promotion_tools, 5),
  ]);

  const affordability = factItem(r.revenue_annual_usd, 4);
  const commercial = component("commercial", "Commercial relevance", 20, [
    signalItem("business_signals", "Business triggers and growth initiatives", businessSignals, 12, input.screened),
    factItem(r.catalog_size, 4),
    { ...affordability, key: "affordability", label: "Can fund a $4,500 sprint" },
  ]);

  const dm = decisionMakerItem(input.decisionMakers);
  const decisionMaker = component("decision_maker", "Reachable decision-maker", 10, [dm]);

  const coverage = ICP_ATTRIBUTES.reduce((s, a) => s + STATUS_WEIGHT[r[a].status], 0) / ICP_ATTRIBUTES.length;
  const verifiedCount = ICP_ATTRIBUTES.filter((a) => r[a].status === "verified").length;
  const confidenceComponent = component("confidence", "Research confidence", 10, [
    { key: "coverage", label: "Evidence coverage of ICP traits", max: 10, evidence: 10 * coverage, potential: 10, status: "coverage", note: `${Math.round(coverage * 100)}% coverage, ${verifiedCount} of ${ICP_ATTRIBUTES.length} traits verified` },
  ]);

  const components = [fit, need, commercial, decisionMaker, confidenceComponent].map((c) => ({
    ...c,
    evidence: round1(c.evidence),
    potential: round1(Math.max(c.potential, c.evidence)),
    items: c.items.map((i) => ({ ...i, evidence: round1(i.evidence), potential: round1(i.potential) })),
  }));
  const evidenceScore = clamp(Math.round(components.reduce((s, c) => s + c.evidence, 0)));
  const potentialMax = Math.max(evidenceScore, clamp(Math.round(components.reduce((s, c) => s + c.potential, 0))));
  const confidence: Confidence = coverage >= 0.7 && verifiedCount >= 3 ? "high" : coverage >= 0.4 ? "medium" : "low";

  const fitStatus = classifyFit(r, input.excludedReason);
  const unresolved = unresolvedTraits(r, input);
  const reasonsToInvestigate = reasons(r, businessSignals, experienceSignals);

  return {
    scoringVersion: SCORING_VERSION,
    evidenceScore,
    potentialMin: evidenceScore,
    potentialMax,
    confidence,
    coverage: Math.round(coverage * 1000) / 1000,
    fitStatus,
    components,
    unresolved,
    reasonsToInvestigate,
    commercialRelevance: commercialText(r, businessSignals),
    organizationalFit: organisationalText(r),
    recommendedAction: recommendAction(fitStatus, unresolved, input),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

const ok = (r: ResolvedAttribute, min: FactStatus) => STATUS_RANK[r.status] >= STATUS_RANK[min] && evaluate(r).match === "match";

export function classifyFit(r: Record<FactAttribute, ResolvedAttribute>, excludedReason: string | null): FitStatus {
  if (excludedReason) return "not_fit";
  const verifiedMismatch = (["category", "sells_dtc", "business_model", "revenue_annual_usd"] as FactAttribute[]).some(
    (a) => r[a].status === "verified" && evaluate(r[a]).match === "mismatch",
  );
  if (verifiedMismatch) return "not_fit";

  const dtcVerified = ok(r.sells_dtc, "verified") || ok(r.business_model, "verified");
  const dtcLikely = ok(r.sells_dtc, "inferred") || ok(r.business_model, "inferred");
  const coreContradicted = (["category", "sells_dtc", "hq_country", "revenue_annual_usd", "employee_count"] as FactAttribute[]).some((a) => r[a].status === "contradicted");
  const sizeEval = (a: FactAttribute) => evaluate(r[a]).match;
  const sizeVerified = (r.revenue_annual_usd.status === "verified" && ["match", "partial"].includes(sizeEval("revenue_annual_usd"))) || ok(r.employee_count, "verified");
  const sizeLikely = ok(r.revenue_annual_usd, "provider_estimate") || ok(r.employee_count, "provider_estimate");
  const estimateMismatch = (["revenue_annual_usd", "employee_count", "business_model", "category"] as FactAttribute[]).some(
    (a) => r[a].status !== "verified" && r[a].status !== "unknown" && evaluate(r[a]).match === "mismatch",
  );

  if (!coreContradicted && ok(r.category, "verified") && dtcVerified && ok(r.hq_country, "verified") && sizeVerified) return "verified_fit";
  if (!coreContradicted && !estimateMismatch && ok(r.category, "inferred") && dtcLikely && ok(r.hq_country, "inferred") && sizeLikely) return "probable_fit";
  return "needs_qualification";
}

function unresolvedTraits(r: Record<FactAttribute, ResolvedAttribute>, input: ProspectScoreInput): string[] {
  const out: string[] = [];
  for (const a of ICP_ATTRIBUTES) {
    const res = r[a];
    const e = evaluate(res);
    if (res.status === "verified" && e.match !== "unknown") continue;
    const value = res.valueText && res.status !== "unknown" && res.status !== "contradicted" ? ` (${e.label})` : res.status === "contradicted" ? ` (${res.valueText})` : "";
    out.push(`${LABELS[a]}: ${STATUS_LABEL[res.status]}${value}`);
  }
  if (!input.decisionMakers.some((d) => d.review === "confirmed")) out.push(input.decisionMakers.some((d) => d.review === null) ? "Decision-maker: possible match not yet confirmed" : "Decision-maker: not identified");
  if (!input.screened) out.push("Business triggers: not screened yet");
  return out;
}

function reasons(r: Record<FactAttribute, ResolvedAttribute>, business: Signal[], experience: Signal[]): string[] {
  const out: string[] = [];
  for (const s of [...business, ...experience].sort((a, b) => SIGNAL_POINTS[b.confidence] - SIGNAL_POINTS[a.confidence])) out.push(`${s.title} (${s.confidence} confidence)`);
  const rev = evaluate(r.revenue_annual_usd);
  if (rev.match === "match") out.push(`Revenue ${rev.label}, ${STATUS_LABEL[r.revenue_annual_usd.status]}`);
  if (ok(r.sells_dtc, "inferred")) out.push(`Sells direct to consumers (${STATUS_LABEL[r.sells_dtc.status]})`);
  if (evaluate(r.experimentation_tools).match === "match") out.push("No testing or personalisation tools detected on the homepage");
  return out.slice(0, 4);
}

function commercialText(r: Record<FactAttribute, ResolvedAttribute>, business: Signal[]): string {
  const parts: string[] = [];
  parts.push(business.length ? `${business.length} business trigger${business.length > 1 ? "s" : ""}: ${business.map((s) => s.title).join("; ")}.` : "No business trigger found yet, so a reason to buy now is unproven.");
  const rev = r.revenue_annual_usd;
  parts.push(rev.status === "unknown" ? "Revenue unknown." : `Revenue ${evaluate(rev).label} (${STATUS_LABEL[rev.status]}).`);
  const cat = r.catalog_size;
  if (cat.status !== "unknown") parts.push(`Store shows ${evaluate(cat).label}.`);
  return parts.join(" ");
}

function organisationalText(r: Record<FactAttribute, ResolvedAttribute>): string {
  const describe = (a: FactAttribute) => (r[a].status === "unknown" ? `${LABELS[a]} unknown` : `${LABELS[a]}: ${evaluate(r[a]).label} (${STATUS_LABEL[r[a].status]})`);
  return [describe("category"), describe("business_model"), describe("hq_country"), describe("employee_count")].join("; ") + ".";
}

function recommendAction(fit: FitStatus, unresolved: string[], input: ProspectScoreInput): string {
  if (fit === "not_fit") return input.excludedReason ? `Set aside: ${input.excludedReason}. Reopen only with new evidence.` : "Set aside: verified evidence places it outside the ICP. Reopen only with new evidence.";
  const sizeGap = unresolved.find((u) => u.startsWith("Annual revenue") || u.startsWith("Team size"));
  const dmConfirmed = input.decisionMakers.some((d) => d.review === "confirmed");
  if (fit === "verified_fit") return dmConfirmed ? "Request deeper site research." : "Confirm a decision-maker from a public source, then request deeper site research.";
  if (fit === "probable_fit") return sizeGap ? `Verify size with an independent source (${sizeGap.split(":")[0].toLowerCase()}).` : "Verify the remaining ICP traits, then consider deeper research.";
  if (!input.screened) return "Run screening to look for business triggers and site signals.";
  const top = unresolved.slice(0, 2).map((u) => u.split(":")[0].toLowerCase());
  return `Find independent evidence for ${top.join(" and ")}.`;
}

export interface RankedProspect {
  companyId: string;
  score: number;
  potentialMax: number;
  fitStatus: FitStatus;
  setAside: boolean;
}

/** Highest evidence-backed score first, then the largest upside. Set-aside companies are never ranked. */
export function rankProspects<T extends RankedProspect>(items: T[], limit = 5): T[] {
  return items
    .filter((i) => !i.setAside && i.fitStatus !== "not_fit")
    .sort((a, b) => b.score - a.score || b.potentialMax - a.potentialMax)
    .slice(0, limit);
}
