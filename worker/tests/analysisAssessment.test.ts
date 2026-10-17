import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEvidencePack, type EvidencePack, type PageView } from "../src/analysis/evidence.ts";
import { automaticChecks, combineVerdict, evidenceStatus, type AutomaticCheck } from "../src/analysis/checks.ts";
import { assignAssessment } from "../src/analysis/assessment.ts";
import { claimsOf } from "../src/analysis/claims.ts";
import { analystContent, citedEvidence } from "../src/analysis/context.ts";
import { findingRecord, runAnalysis } from "../src/analysis/pipeline.ts";
import { MockModelClient } from "../src/analysis/model.ts";
import { FindingSchema, SCHEMA_VERSION, type Finding } from "../src/analysis/schemas.ts";
import { COMPANY, evidenceRow, LIMITS, png, RUN, standardFixture } from "./helpers/evidenceFixtures.ts";
import { analystReply, finding, MemorySink, MODEL, PIPE_LIMITS, VERIFIER, verifierReply } from "./helpers/pipelineFixtures.ts";

/** Two mobile PDPs whose first-load screenshots are byte-identical (one promo takeover), a mobile PLP and a desktop PDP. */
async function multiPack(): Promise<EvidencePack> {
  const rows = [evidenceRow("pdp_1", "mobile"), evidenceRow("pdp_2", "mobile"), evidenceRow("plp_1", "mobile"), evidenceRow("pdp_1", "desktop")];
  const source = await standardFixture(rows);
  const shared = await png(100, 200, 99);
  source.files.set(rows[0].screenshot_path!, shared);
  source.files.set(rows[1].screenshot_path!, shared);
  return loadEvidencePack(source, { researchRunId: RUN, companyDomain: COMPANY.domain }, LIMITS);
}

const page = (p: EvidencePack, slot: string, viewport: string): PageView => p.pages.find((x) => x.slot === slot && x.viewport === viewport)!;
const img = (p: EvidencePack, pageRef: string, state: string) => p.images.find((i) => i.pageRef === pageRef && i.captureState === state)!.ref;
const check = (checks: AutomaticCheck[], name: string) => checks.find((c) => c.check === name)!;

function fact(pageRef: string, refs: string[], statement = "The page shows a shade selector and an Add to bag button.", device: "mobile" | "desktop" = "mobile"): Finding["observed_facts"][number] {
  return { fact_id: "F1", page_ref: pageRef, device, statement, evidence_refs: refs, region: null, text_excerpt: null, quote_kind: null };
}

test("a fact may cite a byte-identical image for a second page, but must also cite evidence that identifies that page", async () => {
  const p = await multiPack();
  const p1 = page(p, "pdp_1", "mobile");
  const p2 = page(p, "pdp_2", "mobile");
  const shared = img(p, p1.ref, "initial_viewport");
  assert.ok(p2.imageRefs.includes(shared));

  const onlyShared = automaticChecks(finding({ observed_facts: [fact(p2.ref, [shared], "A full-screen promotional pop-up covers the first load.")] }), p);
  assert.equal(check(onlyShared, "page_attribution").passed, true);
  const identity = check(onlyShared, "shared_image_page_identity");
  assert.equal(identity.passed, false);
  assert.equal(identity.severity, "revision");
  assert.match(identity.detail, new RegExp(`cite ${p2.textRef}`));
  assert.equal(combineVerdict(onlyShared, [], null).status, "needs_revision");

  const withText = automaticChecks(finding({ observed_facts: [fact(p2.ref, [shared, p2.textRef], "A full-screen promotional pop-up covers the first load.")] }), p);
  assert.equal(check(withText, "shared_image_page_identity").passed, true);
});

test("evidence links record the page each fact is about, including identical captures", async () => {
  const p = await multiPack();
  const p1 = page(p, "pdp_1", "mobile");
  const p2 = page(p, "pdp_2", "mobile");
  const shared = img(p, p1.ref, "initial_viewport");
  const f = finding({
    observed_facts: [
      { ...fact(p1.ref, [shared]), fact_id: "F1" },
      { ...fact(p2.ref, [shared, p2.textRef]), fact_id: "F2" },
    ],
  });
  const rec = findingRecord(f, null, p, "m");
  assert.equal(rec.schema_version, SCHEMA_VERSION);
  assert.equal(rec.finding_class, "research_hypothesis");
  assert.equal(rec.investigation_priority, "high");
  const byFact = (id: string, ref: string) => rec.links.find((l) => l.fact_id === id && l.ref === ref)!;
  assert.deepEqual([byFact("F1", shared).page_ref, byFact("F1", shared).attribution, byFact("F1", shared).page_evidence_id], [p1.ref, "direct", p1.evidenceId]);
  assert.deepEqual([byFact("F2", shared).page_ref, byFact("F2", shared).attribution, byFact("F2", shared).page_evidence_id], [p2.ref, "identical_capture", p2.evidenceId]);
  assert.deepEqual(new Set(rec.source_evidence_ids), new Set([p1.evidenceId, p2.evidenceId]));
});

test("citing another page's own screenshot, or the wrong device, is blocked", async () => {
  const p = await multiPack();
  const p1 = page(p, "pdp_1", "mobile");
  const p2 = page(p, "pdp_2", "mobile");
  const wrongPage = automaticChecks(finding({ observed_facts: [fact(p2.ref, [img(p, p1.ref, "after_overlay_dismissal")])] }), p);
  assert.equal(check(wrongPage, "page_attribution").passed, false);
  assert.equal(combineVerdict(wrongPage, [], null).status, "rejected");

  const wrongText = automaticChecks(finding({ observed_facts: [fact(p2.ref, [p1.textRef])] }), p);
  assert.match(check(wrongText, "page_attribution").detail, /cites TXT-P\d from P\d/);

  const wrongDevice = automaticChecks(finding({ observed_facts: [fact(p1.ref, [img(p, p1.ref, "after_overlay_dismissal")], undefined, "desktop")] }), p);
  assert.match(check(wrongDevice, "page_attribution").detail, /says desktop but P\d was captured on mobile/);
});

test("'initial' wording on a first-clear-view screenshot needs revision; on a first-load screenshot it passes", async () => {
  const p = await multiPack();
  const p1 = page(p, "pdp_1", "mobile");
  const after = img(p, p1.ref, "after_overlay_dismissal");
  const bad = automaticChecks(finding({ observed_facts: [fact(p1.ref, [after], "The initial view shows the mascara with gallery thumbnails.")] }), p);
  const c = check(bad, "capture_state_wording");
  assert.equal(c.passed, false);
  assert.match(c.detail, /First clear view, after closing pop-ups/);
  assert.equal(combineVerdict(bad, [], null).status, "needs_revision");

  const ok = automaticChecks(finding({ observed_facts: [fact(p1.ref, [img(p, p1.ref, "initial_viewport"), p1.textRef], "On first load a promotional pop-up covers the page.")] }), p);
  assert.equal(check(ok, "capture_state_wording").passed, true);

  const reversed = automaticChecks(finding({ observed_facts: [fact(p1.ref, [img(p, p1.ref, "initial_viewport"), p1.textRef], "After closing the pop-up, the gallery is visible.")] }), p);
  assert.equal(check(reversed, "capture_state_wording").passed, false);
});

test("a cookie banner and a promotional pop-up described in one fact need to be separated", async () => {
  const p = await multiPack();
  const p1 = page(p, "pdp_1", "mobile");
  const merged = automaticChecks(
    finding({ observed_facts: [fact(p1.ref, [img(p, p1.ref, "initial_viewport"), p1.textRef], "On first load a cookie banner and a 15% off sign-up pop-up cover the page.")] }),
    p,
  );
  assert.equal(check(merged, "consent_and_promotion_separate").passed, false);
});

test("evidence from another page type needs a journey; a valid journey passes, a broken one does not", async () => {
  const p = await multiPack();
  const pdp = page(p, "pdp_1", "mobile");
  const plp = page(p, "plp_1", "mobile");
  const facts = [
    { ...fact(plp.ref, [img(p, plp.ref, "after_overlay_dismissal")]), fact_id: "F1" },
    { ...fact(pdp.ref, [img(p, pdp.ref, "after_overlay_dismissal")]), fact_id: "F2" },
  ];
  const noJourney = automaticChecks(finding({ observed_facts: facts }), p);
  assert.match(check(noJourney, "page_scope").detail, new RegExp(`${plp.ref} is plp`));

  const crossNoJourney = automaticChecks(finding({ page_type: "cross_page", observed_facts: facts }), p);
  assert.match(check(crossNoJourney, "page_scope").detail, /needs a journey/);

  const journey = {
    steps: [
      { page_ref: plp.ref, role_in_journey: "Compares mini and full sizes", fact_ids: ["F1"] },
      { page_ref: pdp.ref, role_in_journey: "Chooses a shade", fact_ids: ["F2"] },
    ],
    coherence: "A visitor browsing the category opens the product",
  };
  assert.equal(check(automaticChecks(finding({ page_type: "cross_page", observed_facts: facts, journey }), p), "page_scope").passed, true);

  const broken = { ...journey, steps: [journey.steps[0], { ...journey.steps[1], fact_ids: ["F1"] }] };
  const res = check(automaticChecks(finding({ page_type: "cross_page", observed_facts: facts, journey: broken }), p), "page_scope");
  assert.equal(res.passed, false);
  assert.match(res.detail, /cites F1, which is about/);
});

test("inferences and existing-support entries must rest on facts in the finding", async () => {
  const p = await multiPack();
  const p1 = page(p, "pdp_1", "mobile");
  const base = { observed_facts: [fact(p1.ref, [img(p, p1.ref, "after_overlay_dismissal")])] };
  const ok = finding({
    ...base,
    behavioral_inferences: [{ inference_id: "I1", statement: "A visitor unsure of their shade may look for guidance first.", basis_fact_ids: ["F1"] }],
    existing_site_support: [{ support: "A shade finder link", fact_ids: ["F1"], how_it_affects_hypothesis: "Guidance exists, so the question is whether it is found" }],
  });
  assert.equal(check(automaticChecks(ok, p), "fact_links_valid").passed, true);
  const bad = finding({ ...base, behavioral_inferences: [{ inference_id: "I1", statement: "A visitor may hesitate at the selector.", basis_fact_ids: ["F7"] }] });
  assert.match(check(automaticChecks(bad, p), "fact_links_valid").detail, /I1 rests on F7/);
});

test("behavioural inferences and existing support become claims the verifier checks, with page and device", () => {
  const f = finding({
    behavioral_inferences: [{ inference_id: "I1", statement: "A visitor unsure of their shade may look for guidance first.", basis_fact_ids: ["F1"] }],
    existing_site_support: [{ support: "A shade finder link", fact_ids: ["F1"], how_it_affects_hypothesis: "Guidance already exists" }],
  });
  const claims = claimsOf(f);
  assert.match(claims[0].text, /^\[F1 \| page P1 \| mobile\]/);
  assert.equal(claims[1].type, "behavioral_inference");
  assert.match(claims[1].text, /Based on: F1/);
  assert.ok(claims.some((c) => c.type === "hypothesis" && /shade finder link/.test(c.text)));
});

test("class can only be lowered from the analyst's proposal; priority is judged separately", () => {
  const verdict = verifierReply(5);
  const up = assignAssessment(finding(), "supported", { ...verdict, opportunity_assessment: { ...verdict.opportunity_assessment, recommended_class: "evidence_backed_opportunity" } });
  assert.equal(up.finding_class, "research_hypothesis");

  const ebo = finding({ finding_class: "evidence_backed_opportunity" });
  const capped = assignAssessment(
    { ...ebo, critical_unknowns: [{ ...ebo.critical_unknowns[0], severity: "could_invalidate" }] },
    "supported",
    { ...verdict, opportunity_assessment: { ...verdict.opportunity_assessment, recommended_class: "evidence_backed_opportunity" } },
  );
  assert.equal(capped.finding_class, "research_hypothesis");
  assert.ok(capped.notes.some((n) => /could invalidate/.test(n)));

  const notBacked = assignAssessment(ebo, "needs_revision", null);
  assert.equal(notBacked.finding_class, "research_hypothesis");

  const generic = assignAssessment(finding(), "supported", { ...verdict, generic_check: { generic: true, reason: "Applies anywhere" } });
  assert.equal(generic.finding_class, "low_value_observation");
  assert.equal(generic.investigation_priority, "high", "priority is not derived from class");

  const missedSupport = assignAssessment(ebo, "supported", { ...verdict, opportunity_assessment: { ...verdict.opportunity_assessment, recommended_class: "evidence_backed_opportunity", existing_support_considered: false } });
  assert.equal(missedSupport.finding_class, "research_hypothesis");

  const lowered = assignAssessment(finding(), "supported", { ...verdict, opportunity_assessment: { ...verdict.opportunity_assessment, recommended_priority: "low" } });
  assert.equal(lowered.investigation_priority, "low");
  assert.equal(assignAssessment(finding(), "supported", null).investigation_priority, "high");
});

test("evidence verification stays strict and separate from opportunity quality", () => {
  const claims = claimsOf(finding());
  const strongOpportunity = verifierReply(5, {}, "not_demonstrated");
  assert.equal(evidenceStatus([], claims, strongOpportunity), "rejected");
  assert.equal(combineVerdict([], claims, strongOpportunity).status, "rejected");

  const weakOpportunity = verifierReply(5, {
    opportunity_assessment: { ...verifierReply(5).opportunity_assessment, recommended_class: "low_value_observation", commercial_relevance: "weak" },
  });
  assert.equal(evidenceStatus([], claims, weakOpportunity), "supported");
  assert.equal(assignAssessment(finding(), "supported", weakOpportunity).finding_class, "low_value_observation");

  assert.equal(evidenceStatus([], claims, verifierReply(5, { evidence_verdict: "needs_revision" })), "needs_revision");
  assert.equal(combineVerdict([], claims, verifierReply(5, { evidence_verdict: "rejected" })).status, "rejected");
  assert.equal(evidenceStatus([], claims, verifierReply(5, { page_and_state_check: { correct: false, reason: "Wrong state" } })), "needs_revision");
});

test("critical unknowns may name figures to collect; invented outcomes elsewhere are still blocked", async () => {
  const p = await multiPack();
  const p1 = page(p, "pdp_1", "mobile");
  const base = finding({ observed_facts: [fact(p1.ref, [img(p, p1.ref, "after_overlay_dismissal")])] });
  const unknown = { ...base.critical_unknowns[0], unknown: "Whether more than 20% of mobile visitors open the shade finder" };
  assert.equal(check(automaticChecks({ ...base, critical_unknowns: [unknown] }, p), "no_invented_figures").passed, true);
  const invented = { ...base, rpv_pathway: { ...base.rpv_pathway, mechanism: "Fixing this would lift revenue by 12% per visitor." } };
  assert.equal(check(automaticChecks(invented, p), "no_invented_figures").passed, false);
});

test("the analyst sees each page's attributed images and a page-identity note for shared copies", async () => {
  const p = await multiPack();
  const p2 = page(p, "pdp_2", "mobile");
  const text = analystContent(p).filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
  assert.match(text, new RegExp(`Images attributed to ${p2.ref}: IMG-\\d+ \\(First load, as served; byte-identical copy of the image first stored under P\\d\\)`));
  assert.match(text, new RegExp(`cannot by itself show which page this is; when citing it for ${p2.ref}, also cite something that establishes this page's identity \\(${p2.textRef}`));
  assert.doesNotMatch(text, /after overlay dismissal screenshot/);
});

test("the verifier sees the page a fact names, including its own first clear view, when a shared image is cited", async () => {
  const p = await multiPack();
  const p1 = page(p, "pdp_1", "mobile");
  const p2 = page(p, "pdp_2", "mobile");
  const shared = img(p, p1.ref, "initial_viewport");
  const blocks = citedEvidence(p, [shared], [p2.ref], { maxVerifierImages: 8, maxPageTextChars: 6000 });
  const text = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
  assert.match(text, new RegExp(`### ${p2.ref} \\|`));
  assert.match(text, new RegExp(`${img(p, p2.ref, "after_overlay_dismissal")} \\| ${p2.ref}`));
});

test("the pipeline stores evidence status, the verifier's opportunity assessment and the assigned class and priority", async () => {
  const p = await multiPack();
  const p1 = page(p, "pdp_1", "mobile");
  const f = finding({ finding_class: "evidence_backed_opportunity", observed_facts: [fact(p1.ref, [img(p, p1.ref, "after_overlay_dismissal")])] });
  assert.equal(FindingSchema.safeParse(f).success, true);
  const sink = new MemorySink();
  const reply = verifierReply(5, { opportunity_assessment: { ...verifierReply(5).opportunity_assessment, recommended_priority: "medium" } });
  const client = new MockModelClient((_req, i) => ({ toolInput: i === 0 ? analystReply([f]) : reply }));
  await runAnalysis(p, { analyst: client, verifier: client }, sink, { analyst: MODEL, verifier: VERIFIER, limits: PIPE_LIMITS, workerVersion: "test", revise: false });
  const v = sink.verifications[0];
  assert.equal(v.status, "supported");
  assert.equal(v.evidence_status, "supported");
  assert.equal(v.assigned_class, "research_hypothesis");
  assert.equal(v.assigned_priority, "medium");
  assert.equal(v.opportunity_assessment!.recommended_class, "research_hypothesis");
  assert.ok(v.opportunity_assessment!.assignment_notes.length >= 1);
  assert.equal(sink.findings[0].finding_class, "evidence_backed_opportunity", "the analyst's proposal is kept on the finding");
});
