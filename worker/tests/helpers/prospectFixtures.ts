import type { Logger } from "../../src/logger.ts";
import type { CompanyRow, NewDecisionMaker, NewFact, NewProspect, NewSignal, NewSource, PilotData, ProspectStore, RunFinish, RunStart, ScoringSubject, ScreeningTarget } from "../../src/prospecting/ports.ts";
import type { SearchHit, SearchResponse } from "../../src/prospecting/provider.ts";
import type { ProspectScore } from "../../src/prospecting/scoring.ts";
import type { ProviderCallRecord } from "../../src/prospecting/spend.ts";
import type { CompanyEntity, Fact, FactAttribute, FactSourceType, FactStatus } from "../../src/prospecting/types.ts";

export const silentLogger: Logger = { log: () => {} };

let clock = 0;
export function fact(attribute: FactAttribute, valueText: string, status: FactStatus, opts: { n?: number; source?: FactSourceType; url?: string | null } = {}): Fact {
  clock++;
  return {
    attribute,
    valueText,
    valueNumber: opts.n ?? null,
    status,
    sourceType: opts.source ?? (status === "provider_estimate" ? "provider" : "company_site"),
    sourceUrl: opts.url === undefined ? "https://brand.example/" : opts.url,
    provider: null,
    excerpt: null,
    checkedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString(),
  };
}

export function entity(over: Partial<CompanyEntity> = {}): CompanyEntity {
  return { name: "Brand", description: "Direct-to-consumer apparel brand", foundedYear: 2016, employeeCount: 40, hqCity: "Austin", hqCountry: "United States", revenueAnnualUsd: 8e6, fundingTotalUsd: null, latestRound: null, ...over };
}

export function hit(url: string, over: Partial<SearchHit> = {}): SearchHit {
  return { url, title: null, publishedDate: null, author: null, excerpt: null, entity: null, person: null, ...over };
}

export function response(hits: SearchHit[], cost: number | null = 0.012): SearchResponse {
  return { hits, requestId: "req-1", reportedCostUsd: cost, raw: { results: hits } };
}

/** In-memory ProspectStore with the same dedup semantics as the database (unique canonical domain). */
export class MemoryProspectStore implements ProspectStore {
  calls: Array<ProviderCallRecord & { id: string; runId: string }> = [];
  companies: Array<CompanyRow & { prospect: NewProspect | null; screened: boolean; summary: string | null }> = [];
  sources: NewSource[] = [];
  facts = new Map<string, NewFact[]>();
  people = new Map<string, NewDecisionMaker[]>();
  signals = new Map<string, NewSignal[]>();
  scores = new Map<string, ProspectScore>();
  runs: Array<RunStart & { id: string; finish?: RunFinish }> = [];

  async preflight() {}
  async pilotSpendUsd(pilot: string) {
    const ids = new Set(this.runs.filter((r) => r.pilot === pilot).map((r) => r.id));
    return this.calls.filter((c) => ids.has(c.runId)).reduce((s, c) => s + c.actualCostUsd, 0);
  }
  async startRun(run: RunStart) {
    const id = `run-${this.runs.length + 1}`;
    this.runs.push({ ...run, id });
    return id;
  }
  async finishRun(runId: string, finish: RunFinish) {
    this.runs.find((r) => r.id === runId)!.finish = finish;
  }
  async recordCall(runId: string, record: ProviderCallRecord) {
    const id = `call-${this.calls.length + 1}`;
    this.calls.push({ ...record, id, runId });
    return id;
  }
  async findCompanies(domains: string[]) {
    return new Map(this.companies.filter((c) => domains.includes(c.domain)).map((c) => [c.domain, { id: c.id, name: c.name, domain: c.domain }]));
  }
  seed(name: string, domain: string): CompanyRow {
    const row = { id: `co-${this.companies.length + 1}`, name, domain };
    this.companies.push({ ...row, prospect: null, screened: false, summary: null });
    return row;
  }
  async createProspect(p: NewProspect) {
    if (this.companies.some((c) => c.domain === p.domain)) throw new Error(`duplicate key ${p.domain}`);
    const row = { id: `co-${this.companies.length + 1}`, name: p.name, domain: p.domain };
    this.companies.push({ ...row, prospect: p, screened: false, summary: null });
    return row;
  }
  async addSources(rows: NewSource[]) {
    this.sources.push(...rows);
  }
  async addFacts(companyId: string, facts: NewFact[]) {
    this.facts.set(companyId, [...(this.facts.get(companyId) ?? []), ...facts]);
  }
  async screeningTargets(pilot: string, limit: number): Promise<ScreeningTarget[]> {
    return this.companies.filter((c) => c.prospect?.pilot === pilot && !c.prospect.excludedReason && !c.screened).slice(0, limit).map((c) => ({ id: c.id, name: c.name, domain: c.domain, description: c.prospect?.description ?? null }));
  }
  async addDecisionMakers(companyId: string, rows: NewDecisionMaker[]) {
    this.people.set(companyId, [...(this.people.get(companyId) ?? []), ...rows]);
  }
  async addSignals(companyId: string, _runId: string, rows: NewSignal[]) {
    this.signals.set(companyId, [...(this.signals.get(companyId) ?? []), ...rows]);
  }
  async markScreened(companyId: string, summary: string | null) {
    const c = this.companies.find((x) => x.id === companyId)!;
    c.screened = true;
    c.summary = summary;
  }
  async scoringSubjects(ids: string[] | null): Promise<ScoringSubject[]> {
    return this.companies
      .filter((c) => !ids || ids.includes(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        domain: c.domain,
        input: {
          facts: this.facts.get(c.id) ?? [],
          signals: this.signals.get(c.id) ?? [],
          decisionMakers: (this.people.get(c.id) ?? []).map((d) => ({ ...d, review: null })),
          screened: c.screened,
          excludedReason: c.prospect?.excludedReason ?? null,
        },
      }));
  }
  async saveScore(companyId: string, _runId: string | null, score: ProspectScore) {
    this.scores.set(companyId, score);
  }
  async reportData(pilot: string): Promise<PilotData> {
    throw new Error(`not used in tests (${pilot})`);
  }
}
