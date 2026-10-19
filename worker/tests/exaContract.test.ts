import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ModelCallError } from "../src/analysis/model.ts";
import { loadQueries } from "../src/prospecting/config.ts";
import { ExaProvider, parseExaResponse } from "../src/prospecting/exa.ts";

const pricing = { searchUsdPer1k: 7, extraResultUsdPer1k: 1, contentUsdPer1kPages: 1, includedResults: 10 };
const exa = () => new ExaProvider({ apiKey: "test-key", baseUrl: "https://api.exa.ai/", timeoutMs: 1000, pricing });
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const DOCUMENTED_RESPONSE = {
  requestId: "b5947044c4b78efa9552a7c89b306d95",
  resolvedSearchType: "neural",
  searchTime: 812,
  costDollars: { total: 0.012, search: { neural: 0.007 }, contents: { highlights: 0.005 } },
  results: [
    {
      title: "Acme Goods | Organic bedding",
      url: "https://www.acmegoods.com/",
      id: "https://www.acmegoods.com/",
      publishedDate: null,
      author: null,
      highlights: ["Acme Goods makes organic bedding.", "Free shipping over $100."],
      highlightScores: [0.4, 0.3],
      entities: [
        {
          id: "e1",
          type: "company",
          version: 2,
          properties: {
            name: "Acme Goods",
            foundedYear: 2016,
            description: "Organic bedding brand",
            workforce: { total: 42 },
            headquarters: { address: "1 Main St", city: "Austin", postalCode: "78701", country: "United States" },
            financials: { revenueAnnual: 8_000_000, fundingTotal: 3_000_000, fundingLatestRound: { name: "Seed", date: "2023-04-01", amount: 3_000_000 } },
            webTraffic: { visitsMonthly: 120000 },
          },
        },
      ],
    },
    { title: "bad", url: "ftp://nope", highlights: [] },
  ],
};

test("Exa request bodies follow the documented /search contract per category", () => {
  const p = exa();
  const company = p.params({ operation: "company_search", query: "q", numResults: 10, startPublishedDate: "2025-01-01" });
  assert.deepEqual(company, { query: "q", type: "auto", numResults: 10, contents: { highlights: { maxCharacters: 300 } }, category: "company" });
  const people = p.params({ operation: "people_search", query: "q", numResults: 5, startPublishedDate: "2025-01-01" });
  for (const body of [company, people]) {
    // Exa rejects date filters and excludeDomains for company and people categories with a 400.
    for (const banned of ["startPublishedDate", "endPublishedDate", "excludeDomains", "userLocation"]) assert.ok(!(banned in body), banned);
  }
  assert.equal(people.category, "people");
  const evidence = p.params({ operation: "evidence_search", query: "q", numResults: 5, startPublishedDate: "2025-01-01" });
  assert.equal(evidence.category, "news");
  assert.equal(evidence.startPublishedDate, "2025-01-01");
  const web = p.params({ operation: "web_search", query: "q", numResults: 5 });
  assert.ok(!("category" in web));
  for (const body of [company, people, evidence, web]) {
    for (const deprecated of ["numSentences", "highlightsPerUrl", "livecrawl", "includeText", "excludeText"]) assert.ok(!JSON.stringify(body).includes(deprecated));
    assert.ok((body.numResults as number) >= 1 && (body.numResults as number) <= 100);
  }
});

test("Exa search posts to /search with the api key header and parses a documented response", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify(DOCUMENTED_RESPONSE), { status: 200 });
  }) as typeof fetch;
  const res = await exa().search({ operation: "company_search", query: "bedding", numResults: 10 });
  assert.equal(seen!.url, "https://api.exa.ai/search");
  assert.equal((seen!.init.headers as Record<string, string>)["x-api-key"], "test-key");
  assert.equal(res.requestId, DOCUMENTED_RESPONSE.requestId);
  assert.equal(res.reportedCostUsd, 0.012);
  assert.equal(res.hits.length, 1, "non-http result skipped");
  const hit = res.hits[0]!;
  assert.equal(hit.excerpt, "Acme Goods makes organic bedding. ... Free shipping over $100.");
  assert.deepEqual(hit.entity, {
    name: "Acme Goods",
    description: "Organic bedding brand",
    foundedYear: 2016,
    employeeCount: 42,
    hqCity: "Austin",
    hqCountry: "United States",
    revenueAnnualUsd: 8_000_000,
    fundingTotalUsd: 3_000_000,
    latestRound: { name: "Seed", date: "2023-04-01", amountUsd: 3_000_000 },
  });
});

test("Parsed hits keep only the approved retention scope", () => {
  const long = "x".repeat(2000);
  const res = parseExaResponse({ results: [{ url: "https://a.com", title: "A", highlights: [long], text: long, entities: [{ type: "company", properties: { name: "A", description: long } }] }] });
  const hit = res.hits[0]!;
  assert.equal(hit.excerpt!.length, 600);
  assert.ok(hit.entity!.description!.length <= 1000);
  assert.deepEqual(Object.keys(hit).sort(), ["author", "entity", "excerpt", "person", "publishedDate", "title", "url"]);
  assert.ok(!("address" in hit.entity!) && !("webTraffic" in hit.entity!));
});

test("Exa error bodies surface the message and tag, and only 5xx counts as possibly billed", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ requestId: "r", error: "Invalid request body", tag: "INVALID_REQUEST_BODY" }), { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(exa().search({ operation: "company_search", query: "q", numResults: 5 }), (err: unknown) => {
    assert.ok(err instanceof ModelCallError);
    assert.match(err.message, /400: Invalid request body \(INVALID_REQUEST_BODY\)/);
    assert.equal(err.possiblyBilled, false);
    return true;
  });
  globalThis.fetch = (async () => new Response("upstream", { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(exa().search({ operation: "company_search", query: "q", numResults: 5 }), (err: unknown) => (err as ModelCallError).possiblyBilled === true);
});

test("Exa cost estimates follow published Auto pricing and the worst case covers every requested result", () => {
  const p = exa();
  const req = { operation: "company_search" as const, query: "q", numResults: 25 };
  assert.equal(p.worstCaseUsd(req), (7 + 15 + 25) / 1000);
  assert.equal(p.estimatedCostUsd(req, 3), (7 + 15 + 3) / 1000);
  assert.ok(p.estimatedCostUsd(req, 3) <= p.worstCaseUsd(req));
});

test("Discovery queries cover all three segments with trigger strategies and no hard size filters", () => {
  const queries = loadQueries("config/discovery-queries.json").discovery;
  const ids = queries.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const seg of ["emerging", "growing", "established"]) {
    const own = queries.filter((q) => q.segment === seg);
    assert.ok(own.length >= 4, `${seg} needs enough queries to fill its share`);
    assert.ok(own.some((q) => q.operation === "company_search"), `${seg} uses structured company search`);
  }
  for (const id of ["growing-funded-company", "growing-category-company", "growing-hire-company", "established-retail-company"]) assert.ok(ids.includes(id), id);
  for (const q of queries) {
    assert.ok(!/ OR |"/.test(q.query), `natural-language query expected: ${q.id}`);
    assert.ok(!/\b(under|over|fewer than|more than|less than)\s+\$?\d|\d+\s*(to|-)\s*\d+\s*employees|\bsmall team\b/i.test(q.query), `no hard size filter: ${q.id}`);
  }
});
