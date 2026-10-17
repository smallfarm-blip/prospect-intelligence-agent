import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEvidencePack, type EvidencePack, type PageView } from "../src/analysis/evidence.ts";
import { automaticChecks, type AutomaticCheck } from "../src/analysis/checks.ts";
import { claimsOf } from "../src/analysis/claims.ts";
import { MockModelClient } from "../src/analysis/model.ts";
import { runAnalysis } from "../src/analysis/pipeline.ts";
import { FindingSchema, type Finding, type VerifierOutput } from "../src/analysis/schemas.ts";
import { COMPANY, evidenceRow, LIMITS, RUN, standardFixture } from "./helpers/evidenceFixtures.ts";
import { analystReply, finding, MemorySink, MODEL, PIPE_LIMITS, VERIFIER, verifierReply } from "./helpers/pipelineFixtures.ts";

type Fact = Finding["observed_facts"][number];

/** Two mobile PDPs. Page text holds the product copy only; overlay wording is visible in screenshots alone, as on Kosas. */
async function pack(): Promise<EvidencePack> {
  const rows = [evidenceRow("pdp_1", "mobile"), evidenceRow("pdp_2", "mobile")];
  return loadEvidencePack(await standardFixture(rows), { researchRunId: RUN, companyDomain: COMPANY.domain }, LIMITS);
}

const page = (p: EvidencePack, slot: string): PageView => p.pages.find((x) => x.slot === slot)!;
const img = (p: EvidencePack, pageRef: string, state: string) => p.images.find((i) => i.pageRef === pageRef && i.captureState === state)!.ref;
const check = (checks: AutomaticCheck[], name: string) => checks.find((c) => c.check === name)!;
const blockers = (checks: AutomaticCheck[]) => checks.filter((c) => !c.passed && c.severity === "blocker").map((c) => c.check);

function fact(over: Partial<Fact> & Pick<Fact, "page_ref" | "evidence_refs">): Fact {
  return { fact_id: "F1", device: "mobile", statement: "On first load a promotional pop-up covers the product page.", region: null, text_excerpt: null, quote_kind: null, ...over };
}

/** Kosas F-1: promo and cookie wording visible in the first-load screenshot, with the page text also cited. */
function kosasF1(p: EvidencePack, promoQuote = "Reveal Your Reward; Swipe to uncover exclusive savings.") {
  const p1 = page(p, "pdp_1");
  const first = img(p, p1.ref, "initial_viewport");
  const clear = img(p, p1.ref, "after_overlay_dismissal");
  return finding({
    observed_facts: [
      fact({ fact_id: "F1", page_ref: p1.ref, evidence_refs: [first, p1.textRef, clear], region: { image_ref: first, x: 0.05, y: 0.2, width: 0.9, height: 0.5 }, text_excerpt: promoQuote, quote_kind: "screenshot_verbatim" }),
      fact({
        fact_id: "F2",
        page_ref: p1.ref,
        statement: "On first load a separate cookie consent banner sits across the lower portion of the promotional layer, with its own Accept control.",
        evidence_refs: [first, p1.textRef, clear],
        text_excerpt: "This website uses cookies to ensure you get the best experience on our website.",
        quote_kind: "screenshot_verbatim",
      }),
      fact({ fact_id: "F3", page_ref: p1.ref, statement: "In the first clear view, after closing pop-ups, the product title and Add to bag are visible.", evidence_refs: [clear, p1.textRef], text_excerpt: "Add to bag $28", quote_kind: "page_text_verbatim" }),
    ],
  });
}

test("Kosas F-1: screenshot wording that page text lacks passes the automatic checks and goes to the verifier", async () => {
  const p = await pack();
  const f = kosasF1(p);
  assert.equal(FindingSchema.safeParse(f).success, true);
  const checks = automaticChecks(f, p);
  assert.deepEqual(blockers(checks), []);
  assert.match(check(checks, "quotes_match_page_text").detail, /1 page-text quote.*2 screenshot quote\(s\) sent to the verifier/);
  assert.equal(check(checks, "consent_and_promotion_separate").passed, true, "a spatial relation between two separate overlays is not a merge");

  const visual = claimsOf(f).filter((c) => c.text.includes("Screenshot wording"));
  assert.equal(visual.length, 2);
  assert.ok(visual.every((c) => c.type === "observed_fact" && c.evidenceRefs.every((r) => r.startsWith("IMG-"))), "visual quotes are checked against screenshots only");
  assert.match(visual[0].text, /"Reveal Your Reward; Swipe to uncover exclusive savings\."/);
});

test("Kosas F-2: a set of interface labels is checked label by label, not as one sentence", async () => {
  const p = await pack();
  const p1 = page(p, "pdp_1");
  const labels = (excerpt: string, kind: Fact["quote_kind"]) =>
    automaticChecks(finding({ observed_facts: [fact({ page_ref: p1.ref, statement: "The product page shows the product name and an Add to bag control.", evidence_refs: [img(p, p1.ref, "after_overlay_dismissal"), p1.textRef], text_excerpt: excerpt, quote_kind: kind })] }), p);

  assert.equal(check(labels("Revealer Concealer; Add to bag $28", "page_text_verbatim"), "quotes_match_page_text").passed, false, "joined labels are not one passage");
  assert.equal(check(labels("Revealer Concealer | Add to bag $28", "page_text_labels"), "quotes_match_page_text").passed, true);
  const invented = check(labels("Revealer Concealer | Find your recommended shade", "page_text_labels"), "quotes_match_page_text");
  assert.equal(invented.passed, false, "every label must be found");
  assert.match(invented.detail, /"Find your recommended shade" not found/);

  const shot = finding({ observed_facts: [fact({ page_ref: p1.ref, evidence_refs: [img(p, p1.ref, "after_overlay_dismissal"), p1.textRef], text_excerpt: "Translucent Candy; ULTRA SHEER PINK; Find your recommended shade", quote_kind: "screenshot_labels" })] });
  assert.deepEqual(blockers(automaticChecks(shot, p)), []);
  assert.match(claimsOf(shot)[1].text, /"Translucent Candy"; "ULTRA SHEER PINK"; "Find your recommended shade"/);
});

test("a fabricated page-text quote is still blocked, and a quote without a declared source needs revision", async () => {
  const p = await pack();
  const p1 = page(p, "pdp_1");
  const base = { page_ref: p1.ref, evidence_refs: [img(p, p1.ref, "after_overlay_dismissal"), p1.textRef] };
  assert.equal(check(automaticChecks(finding({ observed_facts: [fact({ ...base, text_excerpt: "Rated #1 concealer by 10,000 reviewers", quote_kind: "page_text_verbatim" })] }), p), "quotes_match_page_text").severity, "blocker");
  const undeclared = check(automaticChecks(finding({ observed_facts: [fact({ ...base, text_excerpt: "Add to bag $28" })] }), p), "quote_source_declared");
  assert.equal(undeclared.passed, false);
  assert.equal(undeclared.severity, "revision");
});

test("a quote attributed to the wrong page still fails", async () => {
  const p = await pack();
  const p1 = page(p, "pdp_1");
  const p2 = page(p, "pdp_2");
  const textOnOther = finding({ observed_facts: [fact({ page_ref: p1.ref, evidence_refs: [img(p, p1.ref, "after_overlay_dismissal"), p2.textRef], text_excerpt: "pdp_2", quote_kind: "page_text_verbatim" })] });
  const t = automaticChecks(textOnOther, p);
  assert.ok(blockers(t).includes("quotes_match_page_text"), "the other page's text does not count");
  assert.ok(blockers(t).includes("page_attribution"));

  const shotOnOther = finding({ observed_facts: [fact({ page_ref: p1.ref, evidence_refs: [img(p, p2.ref, "initial_viewport"), p1.textRef], text_excerpt: "Reveal Your Reward", quote_kind: "screenshot_verbatim" })] });
  assert.ok(blockers(automaticChecks(shotOnOther, p)).includes("quotes_match_page_text"), "a screenshot quote needs a screenshot of its own page");

  const noImage = finding({ observed_facts: [fact({ page_ref: p1.ref, evidence_refs: [p1.textRef], text_excerpt: "Reveal Your Reward", quote_kind: "screenshot_verbatim" })] });
  assert.ok(blockers(automaticChecks(noImage, p)).includes("quotes_match_page_text"));
});

test("a quote on a screenshot in the wrong capture state still fails", async () => {
  const p = await pack();
  const p1 = page(p, "pdp_1");
  const clearOnly = finding({ observed_facts: [fact({ page_ref: p1.ref, evidence_refs: [img(p, p1.ref, "after_overlay_dismissal")], text_excerpt: "Reveal Your Reward", quote_kind: "screenshot_verbatim" })] });
  assert.equal(check(automaticChecks(clearOnly, p), "capture_state_wording").passed, false, "first-load wording on a clear-view screenshot");
});

async function runWithQuoteVerdict(f: Finding, quoteVerdict: VerifierOutput["claim_checks"][number]["verdict"]) {
  const p = await pack();
  const claims = claimsOf(f);
  const base = verifierReply(claims.length);
  const verdictFor = (id: string) => {
    const c = claims.find((x) => x.id === id)!;
    if (c.text.includes("Screenshot wording")) return quoteVerdict;
    return c.type === "observed_fact" ? "demonstrated" : "appropriately_framed";
  };
  const reply: VerifierOutput = { ...base, claim_checks: base.claim_checks.map((c) => ({ ...c, verdict: verdictFor(c.claim_id) })) };
  const client = new MockModelClient((_req, i) => ({ toolInput: i === 0 ? analystReply([f]) : reply }));
  const sink = new MemorySink();
  await runAnalysis(p, { analyst: client, verifier: client }, sink, { analyst: MODEL, verifier: VERIFIER, limits: PIPE_LIMITS, workerVersion: "test", revise: false });
  return sink.verifications[0];
}

test("a fabricated screenshot quote is rejected by the visual verifier; a confirmed one is not", async () => {
  const p = await pack();
  const fabricated = kosasF1(p, "Get 50% off everything today");
  const rejected = await runWithQuoteVerdict(fabricated, "not_demonstrated");
  assert.ok(rejected.model_call_id, "the verifier ran: the screenshot quote was not decided automatically");
  assert.equal(rejected.evidence_status, "rejected");
  assert.equal(rejected.status, "rejected");

  const confirmed = await runWithQuoteVerdict(kosasF1(p), "demonstrated");
  assert.notEqual(confirmed.evidence_status, "rejected");
});

test("genuine conflation of consent and promotion is still flagged", async () => {
  const p = await pack();
  const p1 = page(p, "pdp_1");
  const ref = [img(p, p1.ref, "initial_viewport"), p1.textRef];
  const merged = (statements: string[]) =>
    check(automaticChecks(finding({ observed_facts: statements.map((s, i) => fact({ fact_id: `F${i + 1}`, page_ref: p1.ref, evidence_refs: ref, statement: s })) }), p), "consent_and_promotion_separate");

  assert.equal(merged(["On first load a cookie and newsletter sign-up pop-up covers the page."]).passed, false);
  assert.equal(merged(["On first load a pop-up offering 15% off asks visitors to accept cookies."]).passed, false);
  assert.equal(merged(["On first load a separate cookie banner sits below the promotional pop-up."]).passed, false, "no overlay has a fact of its own");
  assert.equal(merged(["On first load a promotional pop-up covers the page.", "On first load a separate cookie banner sits below the promotional pop-up."]).passed, true);
});
