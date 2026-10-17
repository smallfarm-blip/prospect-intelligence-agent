import type { PilotCompany, PilotData } from "./ports.ts";

export const PILOT_TARGETS = { plausibleIcpShare: 0.6, worthDeeperResearch: 5, costPerRelevantUsd: 0.2, reviewMinutesPerCompany: 5 };

const DISCOVERY_OPS = new Set(["company_search", "web_search"]);

export function effectiveFit(c: PilotCompany): string | null {
  return c.fitOverride ?? c.score?.fitStatus ?? null;
}

export function effectiveScore(c: PilotCompany): number | null {
  return c.scoreOverride ?? c.score?.evidenceScore ?? null;
}

/** Plausible ICP fit: verified or probable fit, or shortlisted / sent to research by a reviewer, and not rejected. */
export function isPlausible(c: PilotCompany): boolean {
  if (c.latestDecision === "reject") return false;
  if (c.latestDecision === "shortlist" || c.latestDecision === "request_research") return true;
  const fit = effectiveFit(c);
  return !c.excludedReason && (fit === "verified_fit" || fit === "probable_fit");
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface QueryEffectiveness {
  query: string;
  method: string;
  results: number;
  newCompanies: number;
  duplicates: number;
  excluded: number;
  plausible: number;
  costUsd: number;
}

export interface PilotReport {
  pilot: string;
  uniqueCompanies: number;
  candidates: number;
  excluded: number;
  plausible: number;
  plausibleShare: number | null;
  fitCounts: Record<string, number>;
  evidenceBackedRate: number | null;
  independentEvidenceCoverage: number | null;
  decisionMakers: { possible: number; confirmed: number };
  spend: { discoveryUsd: number; screeningUsd: number; totalUsd: number; uncertainUsd: number };
  costPerRelevantUsd: number | null;
  review: { companiesReviewed: number; medianMinutes: number | null };
  worthDeeperResearch: number;
  researchRequested: number;
  queries: QueryEffectiveness[];
  topFive: Array<{ name: string; domain: string; score: number; potentialMax: number; fit: string; why: string[]; unknown: string[]; next: string }>;
  targets: Array<{ label: string; target: string; actual: string; met: boolean | null }>;
}

export function computePilotReport(data: PilotData): PilotReport {
  const companies = data.companies;
  const byId = new Map(companies.map((c) => [c.id, c]));
  const candidates = companies.filter((c) => !c.excludedReason);
  const plausible = companies.filter(isPlausible);
  const fitCounts: Record<string, number> = {};
  for (const c of companies) {
    const f = c.excludedReason ? "set_aside" : effectiveFit(c) ?? "unscored";
    fitCounts[f] = (fitCounts[f] ?? 0) + 1;
  }
  const n = companies.length;
  const sum = (ops: (op: string) => boolean) => data.calls.filter((c) => ops(c.operation)).reduce((s, c) => s + c.actualCostUsd, 0);
  const discoveryUsd = sum((op) => DISCOVERY_OPS.has(op));
  const screeningUsd = sum((op) => !DISCOVERY_OPS.has(op));
  const totalUsd = discoveryUsd + screeningUsd;
  const reviewed = companies.filter((c) => c.reviewSeconds.length).length;
  const perCompanySeconds = companies.filter((c) => c.reviewSeconds.length).map((c) => c.reviewSeconds.reduce((a, b) => a + b, 0));
  const medianMinutes = median(perCompanySeconds);
  const worthDeeper = companies.filter((c) => c.latestDecision === "request_research" || (isPlausible(c) && (effectiveScore(c) ?? 0) >= 50)).length;

  const queries: QueryEffectiveness[] = data.calls
    .filter((c) => DISCOVERY_OPS.has(c.operation) && c.status === "succeeded")
    .map((call) => {
      const outcomes = data.sourceOutcomes.filter((o) => o.providerCallId === call.id);
      const newIds = outcomes.filter((o) => o.outcome === "new").map((o) => o.companyId);
      return {
        query: call.query ?? "",
        method: call.method,
        results: call.resultCount ?? 0,
        newCompanies: newIds.length,
        duplicates: outcomes.filter((o) => o.outcome === "duplicate").length,
        excluded: outcomes.filter((o) => o.outcome === "excluded").length,
        plausible: newIds.filter((id) => byId.get(id) && isPlausible(byId.get(id)!)).length,
        costUsd: call.actualCostUsd,
      };
    });

  const topFive = candidates
    .filter((c) => c.latestDecision !== "reject" && effectiveFit(c) !== "not_fit" && c.score)
    .sort((a, b) => (effectiveScore(b) ?? 0) - (effectiveScore(a) ?? 0) || (b.score?.potentialMax ?? 0) - (a.score?.potentialMax ?? 0))
    .slice(0, 5)
    .map((c) => ({
      name: c.name,
      domain: c.domain,
      score: effectiveScore(c) ?? 0,
      potentialMax: c.score?.potentialMax ?? 0,
      fit: effectiveFit(c) ?? "unscored",
      why: c.score?.reasonsToInvestigate ?? [],
      unknown: (c.score?.unresolved ?? []).slice(0, 3),
      next: c.score?.recommendedAction ?? "",
    }));

  const plausibleShare = n ? plausible.length / n : null;
  const costPerRelevantUsd = plausible.length ? totalUsd / plausible.length : null;
  const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
  return {
    pilot: data.pilot,
    uniqueCompanies: n,
    candidates: candidates.length,
    excluded: n - candidates.length,
    plausible: plausible.length,
    plausibleShare,
    fitCounts,
    evidenceBackedRate: n ? companies.filter((c) => effectiveFit(c) === "verified_fit").length / n : null,
    independentEvidenceCoverage: n ? companies.reduce((s, c) => s + c.verifiedIndependentTraits / 6, 0) / n : null,
    decisionMakers: {
      possible: companies.filter((c) => c.decisionMakers.possible > 0).length,
      confirmed: companies.filter((c) => c.decisionMakers.confirmed > 0).length,
    },
    spend: { discoveryUsd, screeningUsd, totalUsd, uncertainUsd: data.calls.filter((c) => c.costBasis === "uncertain_worst_case").reduce((s, c) => s + c.actualCostUsd, 0) },
    costPerRelevantUsd,
    review: { companiesReviewed: reviewed, medianMinutes: medianMinutes === null ? null : medianMinutes / 60 },
    worthDeeperResearch: worthDeeper,
    researchRequested: companies.filter((c) => c.latestDecision === "request_research").length,
    queries,
    topFive,
    targets: [
      { label: "Plausible ICP fit", target: `>= ${pct(PILOT_TARGETS.plausibleIcpShare)}`, actual: pct(plausibleShare), met: plausibleShare === null ? null : plausibleShare >= PILOT_TARGETS.plausibleIcpShare },
      { label: "Companies worth deeper research", target: `>= ${PILOT_TARGETS.worthDeeperResearch}`, actual: String(worthDeeper), met: worthDeeper >= PILOT_TARGETS.worthDeeperResearch },
      { label: "Cost per relevant candidate", target: `<= $${PILOT_TARGETS.costPerRelevantUsd.toFixed(2)}`, actual: costPerRelevantUsd === null ? "n/a" : `$${costPerRelevantUsd.toFixed(3)}`, met: costPerRelevantUsd === null ? null : costPerRelevantUsd <= PILOT_TARGETS.costPerRelevantUsd },
      { label: "Human review per company", target: `<= ${PILOT_TARGETS.reviewMinutesPerCompany} min`, actual: medianMinutes === null ? "not measured yet" : `${(medianMinutes / 60).toFixed(1)} min (median)`, met: medianMinutes === null ? null : medianMinutes / 60 <= PILOT_TARGETS.reviewMinutesPerCompany },
    ],
  };
}

export function formatPilotReport(r: PilotReport): string {
  const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
  const lines = [
    `# Pilot report: ${r.pilot}`,
    "",
    "Targets are evaluation targets, not pass/fail rules.",
    "",
    "| Measure | Target | Actual | Status |",
    "| --- | --- | --- | --- |",
    ...r.targets.map((t) => `| ${t.label} | ${t.target} | ${t.actual} | ${t.met === null ? "not measurable yet" : t.met ? "met" : "not met"} |`),
    "",
    "## Discovery",
    `- Unique companies: ${r.uniqueCompanies} (${r.candidates} candidates, ${r.excluded} set aside automatically)`,
    `- Fit status: ${Object.entries(r.fitCounts).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ") || "none"}`,
    `- Plausible ICP fit: ${r.plausible} (${pct(r.plausibleShare)})`,
    `- Evidence-backed (verified fit) rate: ${pct(r.evidenceBackedRate)}`,
    `- Independent evidence coverage (diagnostic): ${pct(r.independentEvidenceCoverage)}`,
    `- Decision-makers: possible for ${r.decisionMakers.possible} companies, confirmed for ${r.decisionMakers.confirmed}`,
    `- Worth deeper analysis: ${r.worthDeeperResearch} (research requested: ${r.researchRequested})`,
    `- Human review: ${r.review.companiesReviewed} companies reviewed, median ${r.review.medianMinutes === null ? "n/a" : `${r.review.medianMinutes.toFixed(1)} min`}`,
    "",
    "## Spend (actual, from provider usage)",
    `- Discovery $${r.spend.discoveryUsd.toFixed(4)}, screening $${r.spend.screeningUsd.toFixed(4)}, total $${r.spend.totalUsd.toFixed(4)}${r.spend.uncertainUsd ? ` (includes $${r.spend.uncertainUsd.toFixed(4)} counted at worst case for failed calls)` : ""}`,
    `- Cost per relevant candidate: ${r.costPerRelevantUsd === null ? "n/a" : `$${r.costPerRelevantUsd.toFixed(3)}`}`,
    "",
    "## Query effectiveness",
    "| Query | Method | Results | New | Duplicates | Excluded | Plausible | Cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...r.queries.map((q) => `| ${q.query.replace(/\|/g, "/")} | ${q.method} | ${q.results} | ${q.newCompanies} | ${q.duplicates} | ${q.excluded} | ${q.plausible} | $${q.costUsd.toFixed(4)} |`),
    "",
    "## Top 5",
    ...r.topFive.flatMap((t, i) => [
      `${i + 1}. ${t.name} (${t.domain}): score ${t.score}, potential up to ${t.potentialMax}, ${t.fit.replace(/_/g, " ")}`,
      `   - Why: ${t.why.join("; ") || "no specific reason recorded yet"}`,
      `   - Unknown: ${t.unknown.join("; ") || "nothing major"}`,
      `   - Next: ${t.next}`,
    ]),
  ];
  return lines.join("\n");
}
