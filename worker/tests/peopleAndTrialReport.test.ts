import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExaResponse, parsePersonEntity } from "../src/prospecting/exa.ts";
import { matchPerson, parsePeopleHits } from "../src/prospecting/screening.ts";
import { assessHit, formatTrial, replayTrial } from "../src/prospecting/trial.ts";
import { hit } from "./helpers/prospectFixtures.ts";

const TAYLOR = { name: "Taylor Stitch", domain: "taylorstitch.com" };

const role = (title: string, company: string | null, from: string | null, to: string | null, id: string | null = null) => ({
  title,
  location: "San Francisco, CA",
  dates: from || to ? { from, to } : null,
  company: company ? { id, name: company } : null,
});

function personResult(url: string, props: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id: url,
    url,
    title: `${props.name ?? "Profile"} | LinkedIn`,
    publishedDate: "2025-08-14T00:00:00.000Z",
    author: null,
    highlights: ["Experienced leader in apparel and direct-to-consumer retail."],
    entities: [
      {
        id: `https://exa.ai/library/person/${String(url).split("/").pop()}`,
        type: "person",
        version: 1,
        properties: {
          location: "San Francisco Bay Area",
          educationHistory: [{ degree: "BA", institution: { name: "UC Berkeley" }, dates: { from: "2004", to: "2008" } }],
          ...props,
        },
      },
    ],
    ...over,
  };
}

const PEOPLE_RESPONSE = {
  requestId: "req-people",
  costDollars: { total: 0.007 },
  results: [
    personResult("https://www.linkedin.com/in/mike-maher", {
      name: "Mike Maher",
      firstName: "Mike",
      lastName: "Maher",
      workHistory: [role("Co-Founder & CEO", "Taylor Stitch", "2008-06", null, "https://www.linkedin.com/company/taylor-stitch"), role("Analyst", "Deloitte", "2005-01", "2008-05")],
    }),
    personResult("https://www.linkedin.com/in/jo-alvarez", {
      name: "Jo Alvarez",
      workHistory: [role("Director of Ecommerce", "Taylor Stitch", "2018-02", "2021-06"), role("VP Digital", "Outerknown", "2021-07", null)],
    }),
    personResult("https://www.linkedin.com/in/priya-shah", {
      firstName: "Priya",
      lastName: "Shah",
      workHistory: [role("Head of Digital", "Taylor Stitch Inc.", null, null)],
    }),
    personResult("https://www.linkedin.com/in/dana-wu", {
      name: "Dana Wu",
      workHistory: [role("Senior Accountant", "Taylor Stitch", "2022-01", null)],
    }),
    personResult("https://www.linkedin.com/in/lee-ortiz", {
      name: "Lee Ortiz",
      workHistory: [role("Growth Marketing Lead", "Taylor Stitch Workshop", "2023-03", null)],
    }),
    personResult("https://www.linkedin.com/in/kim-park", {
      name: "Kim Park",
      workHistory: [role("Founder", "Other Brand", "2019-01", null)],
    }),
  ],
};

test("Exa person entities are parsed from structured fields, without location or education", () => {
  const res = parseExaResponse(PEOPLE_RESPONSE);
  const mike = res.hits[0]!.person!;
  assert.deepEqual(Object.keys(mike).sort(), ["name", "workHistory"]);
  assert.deepEqual(mike.workHistory[0], { title: "Co-Founder & CEO", companyName: "Taylor Stitch", companyRef: "https://www.linkedin.com/company/taylor-stitch", from: "2008-06", to: null });
  assert.ok(!Object.keys(mike.workHistory[0]!).includes("location"));
  assert.equal(res.hits[2]!.person!.name, "Priya Shah", "name built from firstName + lastName");
  assert.equal(res.hits[0]!.entity, null, "a person entity is not mistaken for a company");
  assert.equal(parsePersonEntity([{ type: "company", properties: { name: "X" } }]), null);
});

test("Only a dated role with no end date counts as current employment", () => {
  const hits = parseExaResponse(PEOPLE_RESPONSE).hits;
  const results = hits.map((h) => matchPerson(h, TAYLOR, "exa", "call-1"));
  const [mike, jo, priya, dana, lee, kim] = results;

  assert.ok(mike!.ok);
  assert.equal(mike.dm.matchConfidence, "high");
  assert.equal(mike.dm.employmentStatus, "current");
  assert.equal(mike.dm.roleStartedOn, "2008-06-01");
  assert.equal(mike.dm.roleCategory, "founder");
  assert.equal(mike.dm.sourceUrl, "https://www.linkedin.com/in/mike-maher");
  assert.equal(mike.dm.profileUrl, "https://www.linkedin.com/in/mike-maher");
  assert.equal(mike.dm.sourcePublishedAt, "2025-08-14T00:00:00.000Z");
  assert.equal(mike.dm.providerCallId, "call-1");
  assert.match(mike.dm.matchBasis!, /since 2008-06, no end date/);

  assert.ok(!jo!.ok, "a former role is never treated as current");
  assert.equal(jo.reason, "only former roles at this company");

  assert.ok(priya!.ok);
  assert.equal(priya.dm.matchConfidence, "low");
  assert.equal(priya.dm.employmentStatus, "undated");
  assert.equal(priya.dm.roleStartedOn, null);
  assert.match(priya.dm.matchBasis!, /current employment not confirmed/);

  assert.ok(!dana!.ok);
  assert.match(dana.reason, /role not relevant/);

  assert.ok(lee!.ok);
  assert.equal(lee.dm.matchConfidence, "medium", "loose company-name match");

  assert.ok(!kim!.ok);
  assert.equal(kim.reason, "work history shows no role at this company");
});

test("A former role is not rescued by a page title that still names the company", () => {
  const h = hit("https://www.linkedin.com/in/jo", {
    title: "Jo Alvarez - Director of Ecommerce - Taylor Stitch | LinkedIn",
    person: { name: "Jo Alvarez", workHistory: [{ title: "Director of Ecommerce", companyName: "Taylor Stitch", companyRef: null, from: "2018-02", to: "2021-06" }] },
  });
  assert.deepEqual(parsePeopleHits([h], TAYLOR, "exa", null), []);
});

test("parsePeopleHits keeps the strongest matches first and stores only the approved fields", () => {
  const people = parsePeopleHits(parseExaResponse(PEOPLE_RESPONSE).hits, TAYLOR, "exa", "call-1");
  assert.deepEqual(
    people.map((p) => [p.name, p.matchConfidence, p.employmentStatus]),
    [
      ["Mike Maher", "high", "current"],
      ["Lee Ortiz", "medium", "current"],
      ["Priya Shah", "low", "undated"],
    ],
  );
  assert.deepEqual(Object.keys(people[0]!).sort(), [
    "employmentStatus",
    "matchBasis",
    "matchConfidence",
    "name",
    "profileUrl",
    "provider",
    "providerCallId",
    "roleCategory",
    "roleStartedOn",
    "sourcePublishedAt",
    "sourceUrl",
    "title",
  ]);
});

test("Results without structured history fall back to the title at low confidence", () => {
  const [p] = parsePeopleHits([hit("https://www.linkedin.com/in/ana", { title: "Ana Ruiz - Founder & CEO - Taylor Stitch | LinkedIn" })], TAYLOR, "exa", null);
  assert.equal(p!.name, "Ana Ruiz");
  assert.equal(p!.matchConfidence, "low");
  assert.equal(p!.employmentStatus, "unverified");
});

const companyEntity = (name: string, employees: number | null, revenue: number | null, country: string | null, description = "Apparel brand") => ({
  type: "company",
  properties: {
    name,
    description,
    workforce: employees === null ? undefined : { total: employees },
    financials: revenue === null ? undefined : { revenueAnnual: revenue },
    headquarters: country ? { country } : undefined,
  },
});

test("assessHit labels revenue as a provider estimate and flags irrelevant categories", () => {
  const [brand, agency] = parseExaResponse({
    results: [
      { url: "https://www.taylorstitch.com/", title: "Taylor Stitch", entities: [companyEntity("Taylor Stitch", 120, 30_000_000, "United States")] },
      { url: "https://growthagency.example/", title: "Growth Agency", entities: [companyEntity("Growth Agency", 40, null, "United States", "Shopify Plus digital marketing agency for DTC brands")] },
    ],
  }).hits;
  const a = assessHit(brand!, "taylorstitch.com", 1);
  assert.equal(a.employees, 120);
  assert.equal(a.revenueEstimateUsd, 30_000_000);
  assert.equal(a.irrelevant, null);
  assert.deepEqual(a.unknowns, []);
  const b = assessHit(agency!, "growthagency.example", 2);
  assert.equal(b.assessment, "Not a candidate");
  assert.ok(b.irrelevant);
});

test("A saved trial file replays offline into a compact per-query report with overlap", () => {
  const company = (label: string, query: string) => ({ label, request: { operation: "company_search", query, numResults: 5 }, method: "exa company search", ok: true, error: null, worstCaseUsd: 0.012, estimatedCostUsd: 0.012 });
  const saved = {
    calls: [
      company("Q1 company", "independent apparel brands"),
      { ...company("Q1 general", "independent apparel brands"), request: { operation: "web_search", query: "independent apparel brands", numResults: 5 }, method: "exa general search" },
      { label: "People", request: { operation: "people_search", query: "Taylor Stitch founder", numResults: 5 }, method: "exa people search", ok: true, error: null, worstCaseUsd: 0.012, estimatedCostUsd: 0.007 },
    ],
    raw: [
      {
        label: "Q1 company",
        response: {
          costDollars: { total: 0.012 },
          results: [
            { url: "https://www.taylorstitch.com/", title: "Taylor Stitch", entities: [companyEntity("Taylor Stitch", 120, 30_000_000, "United States")] },
            { url: "https://outerknown.com/", title: "Outerknown", entities: [companyEntity("Outerknown", 80, null, null)] },
          ],
        },
      },
      {
        label: "Q1 general",
        response: {
          results: [
            { url: "https://www.taylorstitch.com/blog", title: "Taylor Stitch journal" },
            { url: "https://www.amazon.com/s?k=apparel", title: "Amazon apparel" },
          ],
        },
      },
      { label: "People", response: PEOPLE_RESPONSE },
    ],
  };
  const report = replayTrial(saved, parseExaResponse, "exa", { calibrationQueries: ["independent apparel brands"], sampleCompany: TAYLOR });
  assert.deepEqual(report.comparisons[0]!.both, ["taylorstitch.com"]);
  assert.deepEqual(report.comparisons[0]!.companyOnly, ["outerknown.com"]);
  assert.deepEqual(Object.values(report.irrelevantByReason).flat(), ["amazon.com"]);
  assert.equal(report.calls[2]!.people.filter((p) => p.kept).length, 3);

  const text = formatTrial(report, 0.15, 0.031);
  assert.match(text, /Q1 company {2}exa company search {2}"independent apparel brands"/);
  assert.match(text, /taylorstitch\.com.*120 staff.*rev \$30M \(provider est\.\).*United States/);
  assert.match(text, /outerknown\.com.*unknown: revenue, country/);
  assert.match(text, /amazon\.com.*!! NOT A CANDIDATE/);
  assert.match(text, /\+ Mike Maher, Co-Founder & CEO .*high confidence, current/);
  assert.match(text, /- Jo Alvarez .*dropped: only former roles at this company/);
  assert.match(text, /company only: outerknown\.com/);
  assert.ok(text.split("\n").every((l) => l.length <= 220), "lines stay terminal-sized");
});

test("replayTrial rejects files that are not saved trials", () => {
  assert.throws(() => replayTrial({ foo: 1 }, parseExaResponse, "exa", { calibrationQueries: [], sampleCompany: TAYLOR }), /Not a saved trial file/);
});
