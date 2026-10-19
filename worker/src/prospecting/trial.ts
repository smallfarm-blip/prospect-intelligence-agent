import { normalizeDomain } from "../url.ts";
import { companyNameFrom, excludeCandidate, skipNonCandidate } from "./exclusion.ts";
import type { DiscoveryProvider, SearchHit, SearchRequest, SearchResponse } from "./provider.ts";
import { evaluateEstimate, money } from "./scoring.ts";
import { matchPerson, mentionsCompany } from "./screening.ts";
import type { SpendGuard } from "./spend.ts";

export interface TrialPlan {
  calibrationQueries: string[];
  numResults: number;
  sampleCompany: { name: string; domain: string };
}

export interface TrialCompany {
  rank: number;
  name: string;
  domain: string;
  employees: number | null;
  revenueEstimateUsd: number | null;
  country: string | null;
  /** Why this result is not a candidate company at all (marketplace, agency, software vendor, enterprise...). */
  irrelevant: string | null;
  assessment: string;
  unknowns: string[];
}

export interface TrialPerson {
  name: string | null;
  title: string | null;
  kept: boolean;
  confidence: string | null;
  employment: string | null;
  note: string;
  url: string;
}

export interface TrialEvidence {
  title: string | null;
  url: string;
  publishedDate: string | null;
  mentionsCompany: boolean;
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
  companies: TrialCompany[];
  people: TrialPerson[];
  evidence: TrialEvidence[];
  withEntity: number;
  entityFields: Record<string, number>;
  resultFields: string[];
  topLevelFields: string[];
}

export interface TrialComparison {
  query: string;
  company: { relevant: number; withRevenue: number; withHeadcount: number };
  general: { relevant: number };
  both: string[];
  companyOnly: string[];
  generalOnly: string[];
}

export interface TrialReport {
  calls: TrialCall[];
  comparisons: TrialComparison[];
  irrelevantByReason: Record<string, string[]>;
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
  reqs.push({ label: "people", request: { operation: "people_search", query: `${c.name} (${c.domain}) founder, CEO, head of ecommerce or director of digital`, numResults: plan.numResults } });
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

function domainOf(url: string): string | null {
  try {
    return normalizeDomain(url);
  } catch {
    return null;
  }
}

/** Preliminary ICP read from provider estimates only. Category and direct selling stay unverified until screening. */
export function assessHit(hit: SearchHit, domain: string, rank: number): TrialCompany {
  const e = hit.entity;
  const employees = e?.employeeCount ?? null;
  const revenue = e?.revenueAnnualUsd ?? null;
  const country = e?.hqCountry ?? null;
  const irrelevant = skipNonCandidate(domain) ?? excludeCandidate(`${hit.title ?? ""} ${e?.description ?? ""} ${hit.excerpt ?? ""}`, e)?.reason ?? null;
  const unknowns = [revenue === null && "revenue", employees === null && "headcount", country === null && "country"].filter((u): u is string => !!u);
  const company = { rank, name: companyNameFrom(e?.name ?? null, hit.title, domain), domain, employees, revenueEstimateUsd: revenue, country, irrelevant, unknowns };
  if (irrelevant) return { ...company, assessment: "Not a candidate" };

  const checks = [
    revenue !== null ? evaluateEstimate("revenue_annual_usd", String(revenue), revenue) : null,
    employees !== null ? evaluateEstimate("employee_count", String(employees), employees) : null,
    country ? evaluateEstimate("hq_country", country, null) : null,
  ].filter((c): c is NonNullable<typeof c> => !!c);
  const mismatch = checks.find((c) => c.match === "mismatch");
  if (mismatch) return { ...company, assessment: `Unlikely fit: ${mismatch.label}` };
  const caveats = checks.filter((c) => c.match === "partial").map((c) => c.label);
  const sizeMatch = checks.slice(0, 2).some((c) => c.match === "match");
  const head = sizeMatch ? "Possible fit on size" : "Needs qualification";
  return { ...company, assessment: caveats.length ? `${head}; ${caveats.join("; ")}` : head };
}

function summarize(
  base: Pick<TrialCall, "label" | "request" | "method" | "worstCaseUsd" | "estimatedCostUsd">,
  res: SearchResponse,
  sample: { name: string; domain: string },
  providerName: string,
): TrialCall {
  const op = base.request.operation;
  const companies: TrialCompany[] = [];
  const seen = new Set<string>();
  if (op === "company_search" || op === "web_search") {
    for (const [i, hit] of res.hits.entries()) {
      const domain = domainOf(hit.url);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      companies.push(assessHit(hit, domain, i + 1));
    }
  }
  const people: TrialPerson[] =
    op === "people_search"
      ? res.hits.map((hit) => {
          const m = matchPerson(hit, sample, providerName, null);
          return m.ok
            ? { name: m.dm.name, title: m.dm.title, kept: true, confidence: m.dm.matchConfidence, employment: m.dm.employmentStatus, note: m.dm.matchBasis ?? "", url: hit.url }
            : { name: m.name, title: null, kept: false, confidence: null, employment: null, note: m.reason, url: hit.url };
        })
      : [];
  const evidence: TrialEvidence[] = op === "evidence_search" ? res.hits.map((h) => ({ title: h.title, url: h.url, publishedDate: h.publishedDate, mentionsCompany: mentionsCompany(h, sample) })) : [];
  return {
    ...base,
    ok: true,
    error: null,
    reportedCostUsd: res.reportedCostUsd,
    companies,
    people,
    evidence,
    withEntity: res.hits.filter((h) => h.entity || h.person).length,
    ...fieldCounts(res.raw),
  };
}

function finish(calls: TrialCall[], plan: Pick<TrialPlan, "calibrationQueries">, raw: TrialReport["raw"]): TrialReport {
  const byLabel = new Map(calls.map((c) => [c.label, c]));
  const relevantDomains = (c: TrialCall | undefined) => (c?.companies ?? []).filter((x) => !x.irrelevant).map((x) => x.domain);
  const comparisons = plan.calibrationQueries.map((query, i): TrialComparison => {
    const company = byLabel.get(`Q${i + 1} company`);
    const c = relevantDomains(company);
    const g = relevantDomains(byLabel.get(`Q${i + 1} general`));
    return {
      query,
      company: {
        relevant: c.length,
        withRevenue: company?.companies.filter((x) => x.revenueEstimateUsd !== null).length ?? 0,
        withHeadcount: company?.companies.filter((x) => x.employees !== null).length ?? 0,
      },
      general: { relevant: g.length },
      both: c.filter((d) => g.includes(d)),
      companyOnly: c.filter((d) => !g.includes(d)),
      generalOnly: g.filter((d) => !c.includes(d)),
    };
  });
  const irrelevantByReason: Record<string, string[]> = {};
  for (const call of calls) {
    for (const x of call.companies) {
      if (!x.irrelevant) continue;
      const list = (irrelevantByReason[x.irrelevant] ??= []);
      if (!list.includes(x.domain)) list.push(x.domain);
    }
  }
  return {
    calls,
    comparisons,
    irrelevantByReason,
    totalReportedUsd: calls.reduce((s, c) => s + (c.reportedCostUsd ?? 0), 0),
    totalEstimatedUsd: calls.reduce((s, c) => s + (c.estimatedCostUsd ?? 0), 0),
    raw,
  };
}

const emptyCall = { companies: [], people: [], evidence: [], withEntity: 0, entityFields: {}, resultFields: [], topLevelFields: [], reportedCostUsd: null, estimatedCostUsd: null };

/**
 * Small controlled trial: the same ICP queries as company-category and general search, plus one
 * people and one evidence search. Nothing is added to the prospect list; calls and costs are logged.
 */
export async function runTrial(provider: DiscoveryProvider, guard: SpendGuard, plan: TrialPlan): Promise<TrialReport> {
  const calls: TrialCall[] = [];
  const raw: TrialReport["raw"] = [];
  for (const { label, request } of trialRequests(plan)) {
    const res = await guard.search(provider, request);
    const base = { label, request, method: provider.method(request), worstCaseUsd: provider.worstCaseUsd(request) };
    if (!res.ok) {
      calls.push({ ...base, ...emptyCall, ok: false, error: res.error });
      if (res.refused) break;
      continue;
    }
    raw.push({ label, response: res.value.raw });
    calls.push(summarize({ ...base, estimatedCostUsd: provider.estimatedCostUsd(request, res.value.hits.length) }, res.value, plan.sampleCompany, provider.name));
  }
  return finish(calls, plan, raw);
}

interface SavedTrial {
  calls: Array<{ label: string; request: SearchRequest; method: string; ok: boolean; error: string | null; worstCaseUsd: number; estimatedCostUsd: number | null }>;
  raw: Array<{ label: string; response: unknown }>;
}

/** Rebuilds the report from a saved trial file without calling the provider. */
export function replayTrial(saved: unknown, parse: (raw: unknown) => SearchResponse, providerName: string, plan: Pick<TrialPlan, "calibrationQueries" | "sampleCompany">): TrialReport {
  const s = saved as Partial<SavedTrial> | null;
  if (!s || !Array.isArray(s.calls) || !Array.isArray(s.raw)) throw new Error("Not a saved trial file: expected `calls` and `raw` arrays");
  const rawByLabel = new Map(s.raw.map((r) => [r.label, r.response]));
  const calls = s.calls.map((c): TrialCall => {
    const base = { label: c.label, request: c.request, method: c.method, worstCaseUsd: c.worstCaseUsd, estimatedCostUsd: c.estimatedCostUsd ?? null };
    const response = rawByLabel.get(c.label);
    if (!c.ok || response === undefined) return { ...base, ...emptyCall, estimatedCostUsd: base.estimatedCostUsd, ok: false, error: c.error ?? "No saved response" };
    return summarize(base, parse(response), plan.sampleCompany, providerName);
  });
  return finish(calls, plan, s.raw);
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const usd = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `$${n.toFixed(4)}`);

function companyLine(x: TrialCompany): string {
  const size = x.employees !== null ? `${x.employees.toLocaleString("en-US")} staff` : "staff ?";
  const rev = x.revenueEstimateUsd !== null ? "rev " + "\u0024" + money(x.revenueEstimateUsd) + " (provider est.)" : "rev ?";
  const head = `  ${String(x.rank).padStart(2)}. ${pad(x.name, 26)} ${pad(x.domain, 26)}`;
  if (x.irrelevant) return `${head} !! NOT A CANDIDATE: ${x.irrelevant}`;
  const unknown = x.unknowns.length ? ` | unknown: ${x.unknowns.join(", ")}` : "";
  return `${head} ${pad(size, 12)} ${pad(rev, 28)} ${pad(x.country ?? "country ?", 15)} -> ${x.assessment}${unknown}`;
}

export function formatTrial(report: TrialReport, budgetUsd: number, spentUsd: number): string {
  const lines = ["Exa trial results", "Revenue and headcount are provider estimates. Category, direct selling and decision-makers stay unverified until screening.", ""];
  for (const c of report.calls) {
    lines.push(`${c.label}  ${c.method}  "${c.request.query}"`);
    if (!c.ok) {
      lines.push(`  FAILED: ${c.error}`, "");
      continue;
    }
    lines.push(`  cost reported ${usd(c.reportedCostUsd)} | estimated ${usd(c.estimatedCostUsd)} | worst case ${usd(c.worstCaseUsd)} | ${c.withEntity} with structured data`);
    for (const x of c.companies) lines.push(companyLine(x));
    for (const p of c.people) {
      const who = `${p.name ?? "(no name)"}${p.title ? `, ${p.title}` : ""}`;
      lines.push(p.kept ? `  + ${pad(who, 50)} ${p.confidence} confidence, ${p.employment}: ${p.note}` : `  - ${pad(who, 50)} dropped: ${p.note}`);
    }
    for (const e of c.evidence) lines.push(`  ${e.mentionsCompany ? "+" : "-"} ${e.publishedDate?.slice(0, 10) ?? "undated   "} ${pad(e.title ?? e.url, 70)}${e.mentionsCompany ? "" : " (does not name the company; ignored)"}`);
    lines.push("");
  }

  lines.push("Company search vs general search (same query, candidate companies only):");
  for (const cmp of report.comparisons) {
    lines.push(`- "${cmp.query.length > 70 ? `${cmp.query.slice(0, 69)}…` : cmp.query}"`);
    lines.push(`    company ${cmp.company.relevant} (${cmp.company.withHeadcount} with headcount, ${cmp.company.withRevenue} with revenue) | general ${cmp.general.relevant} | in both ${cmp.both.length}${cmp.both.length ? `: ${cmp.both.join(", ")}` : ""}`);
    if (cmp.companyOnly.length) lines.push(`    company only: ${cmp.companyOnly.join(", ")}`);
    if (cmp.generalOnly.length) lines.push(`    general only: ${cmp.generalOnly.join(", ")}`);
  }
  const irrelevant = Object.entries(report.irrelevantByReason);
  lines.push("", irrelevant.length ? "Not candidates (filtered before any prospect is created):" : "Not candidates: none returned.");
  for (const [reason, domains] of irrelevant) lines.push(`- ${reason}: ${domains.join(", ")}`);

  lines.push("", `Total: reported ${usd(report.totalReportedUsd)} (Exa's estimate), estimated ${usd(report.totalEstimatedUsd)}. Trial budget $${budgetUsd.toFixed(2)}, recorded spend ${usd(spentUsd)}.`);
  return lines.join("\n");
}
