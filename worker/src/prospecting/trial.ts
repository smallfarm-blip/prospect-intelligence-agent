import { excludeCandidate, skipNonCandidate } from "./exclusion.ts";
import type { DiscoveryProvider, SearchRequest, SearchResponse } from "./provider.ts";
import type { SpendGuard } from "./spend.ts";
import { normalizeDomain } from "../url.ts";

export interface TrialPlan {
  calibrationQueries: string[];
  numResults: number;
  sampleCompany: { name: string; domain: string };
}

export interface TrialCall {
  label: string;
  request: SearchRequest;
  method: string;
  ok: boolean;
  error: string | null;
  worstCaseUsd: number;
  reportedCostUsd: number | null;
  estimatedCostUsd: number | null;
  domains: string[];
  candidateDomains: string[];
  withEntity: number;
  entityFields: Record<string, number>;
  resultFields: string[];
  topLevelFields: string[];
}

export interface TrialComparison {
  query: string;
  company: { candidates: number; withRevenue: number; withHeadcount: number };
  general: { candidates: number };
  overlap: number;
}

export interface TrialReport {
  calls: TrialCall[];
  comparisons: TrialComparison[];
  totalReportedUsd: number;
  totalEstimatedUsd: number;
  raw: Array<{ label: string; response: unknown }>;
}

export function trialRequests(plan: TrialPlan): Array<{ label: string; request: SearchRequest }> {
  const reqs: Array<{ label: string; request: SearchRequest }> = [];
  for (const [i, q] of plan.calibrationQueries.entries()) {
    reqs.push({ label: `Q${i + 1} company`, request: { operation: "company_search", query: q, numResults: plan.numResults } });
    reqs.push({ label: `Q${i + 1} general`, request: { operation: "web_search", query: q, numResults: plan.numResults } });
  }
  const c = plan.sampleCompany;
  reqs.push({ label: "people", request: { operation: "people_search", query: `${c.name} ${c.domain} founder OR "head of ecommerce" OR "director of ecommerce"`, numResults: plan.numResults } });
  const since = new Date(Date.now() - 548 * 86_400_000).toISOString().slice(0, 10);
  reqs.push({ label: "evidence", request: { operation: "evidence_search", query: `${c.name} (${c.domain}) launch, expansion, funding or new hire`, numResults: plan.numResults, startPublishedDate: since } });
  return reqs;
}

function fieldCounts(raw: unknown): { resultFields: string[]; topLevelFields: string[]; entityFields: Record<string, number> } {
  const data = (raw ?? {}) as Record<string, unknown>;
  const results = Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [];
  const resultFields = new Set<string>();
  const entityFields: Record<string, number> = {};
  const walk = (obj: unknown, prefix: string) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, path);
      else if (v !== null && v !== undefined && v !== "") entityFields[path] = (entityFields[path] ?? 0) + 1;
    }
  };
  for (const r of results) {
    for (const k of Object.keys(r)) resultFields.add(k);
    if (Array.isArray(r.entities)) for (const e of r.entities) walk((e as { properties?: unknown })?.properties, "");
  }
  return { resultFields: [...resultFields].sort(), topLevelFields: Object.keys(data).sort(), entityFields };
}

function candidates(res: SearchResponse): { domains: string[]; candidateDomains: string[] } {
  const domains: string[] = [];
  for (const h of res.hits) {
    try {
      domains.push(normalizeDomain(h.url));
    } catch {
      // ignore unparsable URL
    }
  }
  const candidateDomains = [...new Set(domains)].filter((d) => {
    const hit = res.hits.find((h) => h.url.includes(d));
    return !skipNonCandidate(d) && !excludeCandidate(`${hit?.title ?? ""} ${hit?.entity?.description ?? ""} ${hit?.excerpt ?? ""}`, hit?.entity ?? null);
  });
  return { domains: [...new Set(domains)], candidateDomains };
}

/**
 * Small controlled trial: the same ICP queries as company-category and general search, plus one
 * people and one evidence search. Nothing is added to the prospect list; calls and costs are logged.
 */
export async function runTrial(provider: DiscoveryProvider, guard: SpendGuard, plan: TrialPlan): Promise<TrialReport> {
  const calls: TrialCall[] = [];
  const raw: TrialReport["raw"] = [];
  const responses = new Map<string, SearchResponse>();
  for (const { label, request } of trialRequests(plan)) {
    const res = await guard.search(provider, request);
    const base = { label, request, method: provider.method(request), worstCaseUsd: provider.worstCaseUsd(request) };
    if (!res.ok) {
      calls.push({ ...base, ok: false, error: res.error, reportedCostUsd: null, estimatedCostUsd: null, domains: [], candidateDomains: [], withEntity: 0, entityFields: {}, resultFields: [], topLevelFields: [] });
      if (res.refused) break;
      continue;
    }
    responses.set(label, res.value);
    raw.push({ label, response: res.value.raw });
    calls.push({
      ...base,
      ok: true,
      error: null,
      reportedCostUsd: res.value.reportedCostUsd,
      estimatedCostUsd: provider.estimatedCostUsd(request, res.value.hits.length),
      ...candidates(res.value),
      withEntity: res.value.hits.filter((h) => h.entity).length,
      ...fieldCounts(res.value.raw),
    });
  }

  const comparisons: TrialComparison[] = plan.calibrationQueries.map((query, i) => {
    const company = responses.get(`Q${i + 1} company`);
    const general = responses.get(`Q${i + 1} general`);
    const c = company ? candidates(company).candidateDomains : [];
    const g = general ? candidates(general).candidateDomains : [];
    return {
      query,
      company: {
        candidates: c.length,
        withRevenue: company?.hits.filter((h) => h.entity?.revenueAnnualUsd !== null && h.entity?.revenueAnnualUsd !== undefined).length ?? 0,
        withHeadcount: company?.hits.filter((h) => h.entity?.employeeCount !== null && h.entity?.employeeCount !== undefined).length ?? 0,
      },
      general: { candidates: g.length },
      overlap: c.filter((d) => g.includes(d)).length,
    };
  });

  return {
    calls,
    comparisons,
    totalReportedUsd: calls.reduce((s, c) => s + (c.reportedCostUsd ?? 0), 0),
    totalEstimatedUsd: calls.reduce((s, c) => s + (c.estimatedCostUsd ?? 0), 0),
    raw,
  };
}

export function formatTrial(report: TrialReport, budgetUsd: number, spentUsd: number): string {
  const lines = ["Exa trial results", ""];
  for (const c of report.calls) {
    lines.push(`${c.label.padEnd(12)} ${c.method.padEnd(22)} ${c.ok ? `${c.domains.length} domains, ${c.candidateDomains.length} candidates, ${c.withEntity} with company data` : `FAILED: ${c.error}`}`);
    if (c.ok) {
      lines.push(`             cost reported $${c.reportedCostUsd?.toFixed(4) ?? "n/a"} | estimated $${c.estimatedCostUsd?.toFixed(4)} | worst case $${c.worstCaseUsd.toFixed(4)}`);
      lines.push(`             result fields: ${c.resultFields.join(", ") || "none"}`);
      const ef = Object.entries(c.entityFields).map(([k, n]) => `${k}(${n})`).join(", ");
      if (ef) lines.push(`             company fields: ${ef}`);
    }
  }
  lines.push("", "Company-category vs general search (same query):");
  for (const cmp of report.comparisons) {
    lines.push(`- "${cmp.query}": company ${cmp.company.candidates} candidates (${cmp.company.withRevenue} with revenue, ${cmp.company.withHeadcount} with headcount) | general ${cmp.general.candidates} candidates | overlap ${cmp.overlap}`);
  }
  lines.push("", `Total: reported $${report.totalReportedUsd.toFixed(4)}, estimated $${report.totalEstimatedUsd.toFixed(4)}. Trial budget $${budgetUsd.toFixed(2)}, recorded spend $${spentUsd.toFixed(4)}.`);
  return lines.join("\n");
}
