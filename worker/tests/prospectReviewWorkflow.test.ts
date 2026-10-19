import assert from "node:assert/strict";
import { test } from "node:test";
import {
  availableActions,
  buildViews,
  DEFAULT_PROSPECT_FILTERS,
  estimateResearchCost,
  filterViews,
  fitOverrideProblem,
  normalizeDomain,
  previewImport,
  queueCounts,
  reasonProblem,
  rowsFromCsv,
  scoreOverrideProblem,
  topRecommendations,
} from "../../src/lib/prospectView.ts";
import type { ProspectBoard, ProspectDecision, ProspectDecisionKind, ProspectRow, ProspectScore, ResearchRunSummary } from "../../src/lib/prospectTypes.ts";

let seq = 0;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString();

const prospect = (id: string, over: Partial<ProspectRow> = {}): ProspectRow => ({
  company_id: id,
  origin: "exa_discovery",
  pilot: null,
  description: null,
  excluded_reason: null,
  excluded_rule: null,
  screened_at: null,
  screening_summary: null,
  created_at: at(0),
  companies: { name: `Company ${id}`, canonical_domain: `${id}.com`, category: "home", geography: "US" },
  ...over,
});

const score = (id: string, evidence: number, fit: ProspectScore["fit_status"], over: Partial<ProspectScore> = {}): ProspectScore => ({
  id: `s${++seq}`,
  company_id: id,
  scoring_version: "prospect-score-v3",
  evidence_score: evidence,
  potential_min: evidence,
  potential_max: evidence + 30,
  confidence: "medium",
  coverage: 0.5,
  fit_status: fit,
  components: [],
  unresolved: ["Annual revenue: unknown"],
  reasons_to_investigate: [`Reason for ${id}`],
  commercial_relevance: "",
  organizational_fit: "",
  recommended_action: `Check ${id} revenue`,
  qualification: { assessments: [], tradeOffs: [], fitBasis: [`Basis for ${id}`] },
  computed_at: at(1),
  ...over,
});

const decision = (id: string, kind: ProspectDecisionKind, minute: number): ProspectDecision => ({
  id: `d${String(++seq).padStart(4, "0")}`,
  company_id: id,
  decision: kind,
  reason: "Recorded for the test",
  expected_cost_usd: kind === "request_research" ? 0.3 : null,
  review_seconds: 30,
  created_at: at(minute),
});

const board = (over: Partial<ProspectBoard>): ProspectBoard => ({ prospects: [], scores: [], overrides: [], decisions: [], segments: [], research: [], spentUsd: 0, ...over });

test("queues follow the effective fit, with unscored and set-aside companies kept separate", () => {
  const views = buildViews(
    board({
      prospects: [prospect("a"), prospect("b"), prospect("c"), prospect("d"), prospect("e", { excluded_reason: "Agency" }), prospect("f")],
      scores: [score("a", 70, "verified_fit"), score("b", 50, "probable_fit"), score("c", 30, "needs_qualification"), score("e", 40, "probable_fit"), score("f", 20, "not_fit")],
    }),
  );
  assert.deepEqual(queueCounts(views), { verified_fit: 1, probable_fit: 1, needs_qualification: 1, not_scored: 1, set_aside: 2 });
  assert.equal(views.find((v) => v.id === "d")!.scoreValue, null);
});

test("the latest reviewer override wins over the computed score and fit", () => {
  const [v] = buildViews(
    board({
      prospects: [prospect("a")],
      scores: [score("a", 40, "needs_qualification")],
      overrides: [
        { id: "o1", company_id: "a", field: "score", previous_value: "40", new_value: "55", reason: "First change", created_at: at(2) },
        { id: "o2", company_id: "a", field: "score", previous_value: "55", new_value: "62", reason: "Second change", created_at: at(3) },
        { id: "o3", company_id: "a", field: "fit_status", previous_value: "needs_qualification", new_value: "probable_fit", reason: "Checked the press", created_at: at(2) },
      ],
    }),
  );
  assert.equal(v.scoreValue, 62);
  assert.equal(v.fit, "probable_fit");
  assert.equal(v.queue, "probable_fit");
});

test("hold, defer and reject leave the active list and are recorded as the review state", () => {
  const views = buildViews(
    board({
      prospects: ["a", "b", "c", "d"].map((id) => prospect(id)),
      scores: ["a", "b", "c", "d"].map((id) => score(id, 50, "probable_fit")),
      decisions: [decision("a", "hold", 5), decision("b", "defer", 5), decision("c", "reject", 5), decision("d", "shortlist", 5)],
    }),
  );
  assert.deepEqual(filterViews(views, DEFAULT_PROSPECT_FILTERS).map((v) => v.id), ["d"]);
  assert.equal(views.find((v) => v.id === "c")!.queue, "set_aside");
  assert.deepEqual(filterViews(views, { ...DEFAULT_PROSPECT_FILTERS, state: "on_hold" }).map((v) => v.id), ["a"]);
});

test("actions offered match the database rules for set-aside, reopened and scored companies", () => {
  const views = buildViews(
    board({
      prospects: [prospect("x", { excluded_reason: "Agency" }), prospect("y", { excluded_reason: "Agency" }), prospect("z"), prospect("u"), prospect("r")],
      scores: [score("x", 30, "needs_qualification"), score("y", 30, "needs_qualification"), score("z", 30, "needs_qualification"), score("r", 30, "probable_fit")],
      decisions: [decision("y", "reopen", 5), decision("y", "hold", 6), decision("r", "request_research", 5)],
    }),
  );
  const acts = (id: string) => availableActions(views.find((v) => v.id === id)!);
  assert.deepEqual(acts("x"), ["reopen", "reject"]);
  assert.ok(acts("y").includes("request_research"), "a later hold does not undo the reopen");
  assert.ok(acts("z").includes("request_research"));
  assert.ok(!acts("u").includes("request_research"), "unscored companies cannot request research");
  assert.ok(!acts("r").includes("request_research"), "no duplicate request");

  const rejectedAgain = buildViews(board({ prospects: [prospect("y", { excluded_reason: "Agency" })], scores: [score("y", 30, "needs_qualification")], decisions: [decision("y", "reopen", 5), decision("y", "reject", 6)] }));
  assert.deepEqual(availableActions(rejectedAgain[0]), ["reopen"]);
});

test("reasons and overrides are validated before saving", () => {
  assert.match(reasonProblem("too short")!, /at least 10/);
  assert.equal(reasonProblem("Revenue confirmed in the press release"), null);
  assert.match(scoreOverrideProblem("70", null)!, /not been scored/);
  assert.match(scoreOverrideProblem("101", 50)!, /0 to 100/);
  assert.match(scoreOverrideProblem("50", 50)!, /already/);
  assert.equal(scoreOverrideProblem("64", 50), null);
  assert.match(fitOverrideProblem("probable_fit", "probable_fit")!, /already/);
});

test("top recommendations take the highest open scores and carry the reason and next action", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const views = buildViews(
    board({
      prospects: [...ids.map((id) => prospect(id)), prospect("x", { excluded_reason: "Agency" })],
      scores: [...ids.map((id, i) => score(id, 10 + i * 5, "probable_fit")), score("x", 99, "probable_fit")],
      decisions: [decision("h", "hold", 5)],
    }),
  );
  const top = topRecommendations(views);
  assert.deepEqual(top.map((r) => r.view.id), ["g", "f", "e", "d", "c"]);
  assert.deepEqual(top[0].reasons, ["Basis for g", "Reason for g"]);
  assert.equal(top[0].nextAction, "Check g revenue");
  assert.equal(topRecommendations(buildViews(board({ prospects: [prospect("a")] }))).length, 0, "nothing unscored is recommended");
});

test("research cost estimate averages earlier completed runs and never triggers anything", () => {
  const run = (est: number, billed: number | null, capture: number | null, status = "completed"): ResearchRunSummary => ({
    id: `r${++seq}`, company_id: "a", status, finding_count: 3, analyst_model: "m", estimated_cost_usd: est, billed_cost_usd: billed, started_at: at(0), research_runs: capture === null ? null : { estimated_cost_usd: capture },
  });
  const e = estimateResearchCost([run(0.25, null, 0.05), run(0.2, 0.3, 0.05), run(5, null, null, "failed")]);
  assert.equal(e.usd, 0.33);
  assert.equal(e.samples, 2);
  const none = estimateResearchCost([]);
  assert.equal(none.samples, 0);
  assert.match(none.basis, /default allowance/);
});

test("CSV import preview flags existing companies, repeats within the file and invalid rows", () => {
  const csv = '\uFEFFCompany Name,Website,Category,Notes\n"Acme, Inc",https://www.Acme.com/shop,home,"says ""hi"""\nBeta,beta.co\nAcme again,acme.com\nKnown,known.com\n,missing.com\nBad,not a domain\n';
  const parsed = rowsFromCsv(csv);
  assert.equal(parsed.error, null);
  assert.equal(parsed.rows[0].row.name, "Acme, Inc");
  assert.equal(parsed.rows[0].row.notes, 'says "hi"');
  const preview = previewImport(parsed.rows, new Map([["known.com", "Known Co"]]));
  assert.deepEqual(preview.map((c) => c.status), ["new", "new", "repeat", "existing", "invalid", "invalid"]);
  assert.equal(preview[0].domain, "acme.com");
  assert.match(preview[2].note!, /line 2/);
  assert.match(preview[3].note!, /Known Co/);
  assert.match(rowsFromCsv("brand,notes\nA,b").error!, /website or domain/);
  assert.equal(normalizeDomain(" HTTP://www.Shop.Example.com:8080/x?y "), "shop.example.com");
});

test("segment filter and search use persisted discovery data only", () => {
  const views = buildViews(
    board({
      prospects: [prospect("a", { description: "Organic bedding brand" }), prospect("b"), prospect("c")],
      segments: [{ company_id: "a", discovery_segment: "emerging" }, { company_id: "a", discovery_segment: "emerging" }, { company_id: "b", discovery_segment: "established" }],
    }),
  );
  assert.deepEqual(views.find((v) => v.id === "a")!.segments, ["emerging"]);
  const ids = (f: Partial<typeof DEFAULT_PROSPECT_FILTERS>) => filterViews(views, { ...DEFAULT_PROSPECT_FILTERS, sort: "name", ...f }).map((v) => v.id);
  assert.deepEqual(ids({ segment: "established" }), ["b"]);
  assert.deepEqual(ids({ segment: "none" }), ["c"]);
  assert.deepEqual(ids({ search: "organic bedding" }), ["a"]);
});
