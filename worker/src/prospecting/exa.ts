import { ModelCallError, postJson } from "../analysis/model.ts";
import type { DiscoveryProvider, SearchHit, SearchRequest, SearchResponse } from "./provider.ts";
import type { CompanyEntity, PersonEntity, WorkRole } from "./types.ts";

export interface ExaPricing {
  searchUsdPer1k: number;
  /** Charged per result beyond `includedResults`. */
  extraResultUsdPer1k: number;
  /** Highlights are priced as page contents. */
  contentUsdPer1kPages: number;
  includedResults: number;
}

export interface ExaOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  pricing: ExaPricing;
}

const CATEGORY: Record<SearchRequest["operation"], string | null> = {
  company_search: "company",
  people_search: "people",
  evidence_search: "news",
  web_search: null,
};

export class ExaProvider implements DiscoveryProvider {
  readonly name = "exa";

  constructor(private readonly opts: ExaOptions) {}

  method(req: SearchRequest): string {
    return `exa:auto:${CATEGORY[req.operation] ?? "general"}`;
  }

  params(req: SearchRequest): Record<string, unknown> {
    const category = CATEGORY[req.operation];
    const body: Record<string, unknown> = {
      query: req.query,
      type: "auto",
      numResults: req.numResults,
      contents: { highlights: { maxCharacters: req.highlightChars ?? 300 } },
    };
    if (category) body.category = category;
    if (req.operation === "evidence_search" && req.startPublishedDate) body.startPublishedDate = req.startPublishedDate;
    if (req.operation === "web_search" || req.operation === "evidence_search") body.userLocation = "US";
    return body;
  }

  estimatedCostUsd(req: SearchRequest, resultCount: number): number {
    const p = this.opts.pricing;
    const n = Math.min(resultCount, req.numResults);
    return (p.searchUsdPer1k + Math.max(0, req.numResults - p.includedResults) * p.extraResultUsdPer1k + n * p.contentUsdPer1kPages) / 1000;
  }

  worstCaseUsd(req: SearchRequest): number {
    return this.estimatedCostUsd(req, req.numResults);
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const raw = await postJson(`${this.opts.baseUrl.replace(/\/$/, "")}/search`, { "x-api-key": this.opts.apiKey }, this.params(req), this.opts.timeoutMs);
    return parseExaResponse(raw);
  }
}

export function parseExaResponse(raw: unknown): SearchResponse {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { results?: unknown }).results)) {
    throw new ModelCallError("malformed", "Exa response had no results array");
  }
  const data = raw as { results: unknown[]; requestId?: unknown; costDollars?: { total?: unknown } };
  const hits: SearchHit[] = [];
  for (const item of data.results) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.url !== "string" || !/^https?:\/\//i.test(r.url)) continue;
    const highlights = Array.isArray(r.highlights) ? r.highlights.filter((h): h is string => typeof h === "string") : [];
    const excerpt = highlights.join(" ... ") || (typeof r.summary === "string" ? r.summary : null);
    hits.push({
      url: r.url,
      title: str(r.title),
      publishedDate: str(r.publishedDate),
      author: str(r.author),
      excerpt: excerpt ? excerpt.slice(0, 600) : null,
      entity: parseCompanyEntity(r.entities),
      person: parsePersonEntity(r.entities),
    });
  }
  const total = numberish(data.costDollars?.total);
  return { hits, requestId: str(data.requestId), reportedCostUsd: total, raw };
}

export function parseCompanyEntity(entities: unknown): CompanyEntity | null {
  if (!Array.isArray(entities)) return null;
  const company = entities.find((e) => e && typeof e === "object" && (e as { type?: unknown }).type === "company") as { properties?: Record<string, unknown> } | undefined;
  const p = company?.properties;
  if (!p || typeof p !== "object") return null;
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const hq = obj(p.headquarters);
  const fin = obj(p.financials);
  const round = obj(fin.fundingLatestRound);
  const hasRound = Object.keys(round).length > 0;
  return {
    name: str(p.name),
    description: str(p.description)?.slice(0, 1000) ?? null,
    foundedYear: numberish(p.foundedYear),
    employeeCount: numberish(obj(p.workforce).total),
    hqCity: str(hq.city),
    hqCountry: str(hq.country),
    revenueAnnualUsd: numberish(fin.revenueAnnual),
    fundingTotalUsd: numberish(fin.fundingTotal),
    latestRound: hasRound ? { name: str(round.name), date: str(round.date), amountUsd: numberish(round.amount) } : null,
  };
}

/** Reads Exa `type: "person"` entities (name, firstName/lastName, workHistory). Location and education are dropped. */
export function parsePersonEntity(entities: unknown): PersonEntity | null {
  if (!Array.isArray(entities)) return null;
  const person = entities.find((e) => e && typeof e === "object" && (e as { type?: unknown }).type === "person") as { properties?: Record<string, unknown> } | undefined;
  const p = person?.properties;
  if (!p || typeof p !== "object") return null;
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const joined = [str(p.firstName), str(p.lastName)].filter(Boolean).join(" ");
  const workHistory: WorkRole[] = (Array.isArray(p.workHistory) ? p.workHistory : []).map((w) => {
    const entry = obj(w);
    const company = obj(entry.company);
    const dates = obj(entry.dates);
    return { title: str(entry.title), companyName: str(company.name), companyRef: str(company.id), from: str(dates.from), to: str(dates.to) };
  });
  return { name: str(p.name) ?? (joined || null), workHistory };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Accepts plain numbers, numeric strings and `{ value }` wrappers, since provider shapes vary by version. */
function numberish(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  if (v && typeof v === "object" && "value" in v) return numberish((v as { value: unknown }).value);
  return null;
}
