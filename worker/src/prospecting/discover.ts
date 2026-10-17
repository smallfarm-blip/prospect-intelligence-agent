import type { Logger } from "../logger.ts";
import { normalizeDomain } from "../url.ts";
import { companyNameFrom, excludeCandidate, skipNonCandidate } from "./exclusion.ts";
import type { NewFact, NewSource, ProspectStore } from "./ports.ts";
import type { DiscoveryProvider, SearchHit } from "./provider.ts";
import type { SpendGuard } from "./spend.ts";
import type { CompanyEntity } from "./types.ts";

export interface DiscoveryQuery {
  id: string;
  operation: "company_search" | "web_search";
  query: string;
}

export interface DiscoveryDeps {
  provider: DiscoveryProvider;
  guard: SpendGuard;
  store: ProspectStore;
  logger: Logger;
  runId: string;
  pilot: string;
}

export interface DiscoverySummary {
  queriesRun: number;
  queriesRefused: number;
  queriesFailed: number;
  results: number;
  newCompanies: number;
  excludedCompanies: number;
  duplicates: number;
  skipped: Array<{ domain: string; reason: string; queryId: string }>;
  stoppedBy: "target_reached" | "queries_exhausted" | "budget";
}

/** Facts a provider returned about a company. Provider figures are never treated as verified. */
export function entityFacts(entity: CompanyEntity, provider: string, sourceUrl: string, providerCallId: string | null, checkedAt: string): NewFact[] {
  const base = { status: "provider_estimate" as const, sourceType: "provider" as const, sourceUrl, provider, excerpt: null, providerCallId, checkedAt };
  const facts: NewFact[] = [];
  const add = (attribute: NewFact["attribute"], valueText: string, valueNumber: number | null) => facts.push({ ...base, attribute, valueText, valueNumber });
  if (entity.revenueAnnualUsd !== null) add("revenue_annual_usd", `$${Math.round(entity.revenueAnnualUsd).toLocaleString("en-US")}`, entity.revenueAnnualUsd);
  if (entity.employeeCount !== null) add("employee_count", String(entity.employeeCount), entity.employeeCount);
  if (entity.hqCountry) add("hq_country", entity.hqCountry, null);
  if (entity.foundedYear !== null) add("founded_year", String(entity.foundedYear), entity.foundedYear);
  if (entity.fundingTotalUsd !== null) add("funding_total_usd", `$${Math.round(entity.fundingTotalUsd).toLocaleString("en-US")}`, entity.fundingTotalUsd);
  return facts;
}

function hitDomain(hit: SearchHit): string | null {
  try {
    return normalizeDomain(hit.url);
  } catch {
    return null;
  }
}

/**
 * Runs queries in order until `targetCompanies` new candidates (deduplicated by canonical domain)
 * are stored, the queries run out, or the budget refuses the next call. Every result is recorded
 * as a sighting with its rank and outcome; nothing is ever overwritten.
 */
export async function runDiscovery(deps: DiscoveryDeps, queries: DiscoveryQuery[], opts: { numResults: number; targetCompanies: number }): Promise<DiscoverySummary> {
  const s: DiscoverySummary = { queriesRun: 0, queriesRefused: 0, queriesFailed: 0, results: 0, newCompanies: 0, excludedCompanies: 0, duplicates: 0, skipped: [], stoppedBy: "queries_exhausted" };
  const seen = new Map<string, string>();

  for (const q of queries) {
    if (s.newCompanies >= opts.targetCompanies) {
      s.stoppedBy = "target_reached";
      break;
    }
    const req = { operation: q.operation, query: q.query, numResults: opts.numResults };
    const res = await deps.guard.search(deps.provider, req);
    if (!res.ok) {
      if (res.refused) {
        s.queriesRefused++;
        s.stoppedBy = "budget";
        deps.logger.log("warn", "discovery_budget_stop", { queryId: q.id, error: res.error });
        break;
      }
      s.queriesFailed++;
      deps.logger.log("error", "discovery_query_failed", { queryId: q.id, error: res.error });
      continue;
    }
    s.queriesRun++;
    s.results += res.value.hits.length;
    const checkedAt = new Date().toISOString();
    const domains = res.value.hits.map(hitDomain).filter((d): d is string => !!d);
    const existing = await deps.store.findCompanies(domains);
    const sources: NewSource[] = [];

    for (const [i, hit] of res.value.hits.entries()) {
      const domain = hitDomain(hit);
      if (!domain) continue;
      const skip = skipNonCandidate(domain);
      if (skip) {
        s.skipped.push({ domain, reason: skip, queryId: q.id });
        continue;
      }
      const source = (companyId: string, outcome: NewSource["outcome"]): NewSource => ({
        companyId,
        providerCallId: res.callId,
        kind: "discovery_result",
        url: hit.url,
        title: hit.title?.slice(0, 300) ?? null,
        publishedAt: hit.publishedDate,
        excerpt: hit.excerpt,
        rank: i + 1,
        outcome,
        providerRecord: hit.entity ? { ...hit.entity } : null,
      });
      const known = existing.get(domain)?.id ?? seen.get(domain);
      if (known) {
        s.duplicates++;
        sources.push(source(known, "duplicate"));
        continue;
      }
      if (s.newCompanies >= opts.targetCompanies) continue;

      const exclusion = excludeCandidate(`${hit.title ?? ""} ${hit.entity?.description ?? ""} ${hit.excerpt ?? ""}`, hit.entity);
      const company = await deps.store.createProspect({
        name: companyNameFrom(hit.entity?.name ?? null, hit.title, domain),
        domain,
        origin: deps.provider.name === "exa" ? "exa_discovery" : "provider_discovery",
        pilot: deps.pilot,
        runId: deps.runId,
        description: hit.entity?.description ?? hit.excerpt?.slice(0, 1000) ?? null,
        geography: hit.entity?.hqCountry ?? null,
        excludedReason: exclusion?.reason ?? null,
        excludedRule: exclusion?.rule ?? null,
      });
      seen.set(domain, company.id);
      if (exclusion) s.excludedCompanies++;
      else s.newCompanies++;
      sources.push(source(company.id, exclusion ? "excluded" : "new"));
      if (hit.entity) await deps.store.addFacts(company.id, entityFacts(hit.entity, deps.provider.name, hit.url, res.callId, checkedAt));
    }
    if (sources.length) await deps.store.addSources(sources);
    deps.logger.log("info", "discovery_query_done", { queryId: q.id, method: deps.provider.method(req), results: res.value.hits.length, newCompanies: s.newCompanies });
  }
  if (s.newCompanies >= opts.targetCompanies) s.stoppedBy = "target_reached";
  return s;
}
