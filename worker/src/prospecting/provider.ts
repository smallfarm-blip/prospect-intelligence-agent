import type { CompanyEntity, PersonEntity } from "./types.ts";

export type SearchOperation = "company_search" | "web_search" | "people_search" | "evidence_search";

export interface SearchRequest {
  operation: SearchOperation;
  query: string;
  numResults: number;
  /** Evidence searches only; company and people searches reject date filters. */
  startPublishedDate?: string;
  highlightChars?: number;
}

export interface SearchHit {
  url: string;
  title: string | null;
  publishedDate: string | null;
  author: string | null;
  excerpt: string | null;
  entity: CompanyEntity | null;
  person: PersonEntity | null;
}

export interface SearchResponse {
  hits: SearchHit[];
  requestId: string | null;
  /** Cost reported by the provider for this request, when it reports one. */
  reportedCostUsd: number | null;
  raw: unknown;
}

/**
 * Every discovery source (Exa today, Tavily or others later) implements this, so the pipeline,
 * cost tracking and pilot report can compare providers on the same queries.
 */
export interface DiscoveryProvider {
  readonly name: string;
  method(req: SearchRequest): string;
  params(req: SearchRequest): Record<string, unknown>;
  worstCaseUsd(req: SearchRequest): number;
  estimatedCostUsd(req: SearchRequest, resultCount: number): number;
  search(req: SearchRequest): Promise<SearchResponse>;
}

/** Scripted provider for tests and dry runs. */
export class MockDiscoveryProvider implements DiscoveryProvider {
  readonly name = "mock";
  readonly requests: SearchRequest[] = [];

  constructor(
    private readonly responder: (req: SearchRequest, index: number) => SearchResponse | Error,
    private readonly perCallUsd = 0.01,
  ) {}

  method(req: SearchRequest): string {
    return `mock:${req.operation}`;
  }

  params(req: SearchRequest): Record<string, unknown> {
    return { numResults: req.numResults };
  }

  worstCaseUsd(): number {
    return this.perCallUsd;
  }

  estimatedCostUsd(): number {
    return this.perCallUsd;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const index = this.requests.push(req) - 1;
    const reply = this.responder(req, index);
    if (reply instanceof Error) throw reply;
    return reply;
  }
}
