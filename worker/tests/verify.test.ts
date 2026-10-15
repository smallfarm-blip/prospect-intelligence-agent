import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredEvidence } from "../src/store.ts";
import { buildCaptureStates, type DismissalResult } from "../src/overlays.ts";
import { REQUIRED_SLOTS, REQUIRED_VIEWPORTS, verifyEvidence } from "../src/verify.ts";

const COMPANY = "c1";
const domains = new Map([[COMPANY, "x.com"]]);
let seq = 0;

function row(slot: string, viewport: "desktop" | "mobile", overrides: Partial<StoredEvidence> = {}): StoredEvidence {
  const pageType = slot.startsWith("pdp") ? "pdp" : slot === "homepage" ? "homepage" : "plp";
  const shot = `r1/x.com/${slot}-${viewport}.png`;
  const after = `r1/x.com/${slot}-${viewport}-unobstructed.png`;
  return {
    id: `id-${String(++seq).padStart(8, "0")}`,
    research_run_id: "r1",
    company_id: COMPANY,
    job_id: "j1",
    page_type: pageType,
    page_slot: slot,
    requested_url: `https://x.com/${slot}`,
    final_url: `https://x.com/${slot}`,
    viewport_name: viewport,
    viewport_width: viewport === "desktop" ? 1440 : 390,
    viewport_height: viewport === "desktop" ? 900 : 844,
    user_agent: "UA",
    captured_at: new Date().toISOString(),
    access_status: "captured",
    http_status: 200,
    page_title: slot,
    screenshot_path: shot,
    full_page_screenshot_path: null,
    unobstructed_screenshot_path: after,
    overlay_dismissal_status: "none_detected",
    capture_states: states(dismissal("none_detected"), shot, after),
    extracted_text: "text",
    extracted_text_length: 4,
    content_hash: "hash",
    discovery_method: "test",
    discovered_from_url: null,
    page_type_signals: { jsonLdTypes: pageType === "pdp" ? ["Product"] : [], ogType: null, addToCartControlVisible: false, visibleDialogCount: 0 },
    navigation_notes: null,
    error_message: null,
    load_duration_ms: 1000,
    ...overrides,
  };
}

function dismissal(status: DismissalResult["status"], remaining: DismissalResult["remainingOverlays"] = []): DismissalResult {
  return { status, initialOverlays: remaining, actions: [], removedOverlays: [], remainingOverlays: remaining, error: status === "error" ? "boom" : null };
}

function states(d: DismissalResult, shot: string | null, after: string | null) {
  return buildCaptureStates(d, { path: shot, at: "t1" }, { path: after, at: after ? "t2" : null });
}

function fullSet(): StoredEvidence[] {
  return REQUIRED_SLOTS.flatMap((s) => REQUIRED_VIEWPORTS.map((v) => row(s, v)));
}

const allExist = async () => true;

test("a complete, well-formed capture set passes every check", async () => {
  const report = await verifyEvidence(fullSet(), domains, allExist);
  assert.equal(report.allChecksPassed, true);
  assert.deepEqual(report.coverage, [{ domain: "x.com", captured: 8, required: 8, complete: true }]);
  assert.deepEqual(report.warnings, []);
});

test("missing fields, missing files and missing slots are reported", async () => {
  const rows = fullSet().filter((r) => !(r.page_slot === "pdp_2" && r.viewport_name === "mobile"));
  rows[0] = { ...rows[0], content_hash: null };
  const report = await verifyEvidence(rows, domains, async (p) => !p.includes("homepage-mobile"));
  assert.equal(report.allChecksPassed, false);
  const problems = report.checks.flatMap((c) => c.problems).join("\n");
  assert.match(problems, /missing content_hash/);
  assert.match(problems, /screenshot not found.*homepage-mobile/);
  assert.match(problems, /pdp_2\/mobile: expected 1 record, found 0/);
  assert.equal(report.coverage[0].complete, false);
});

test("non-captured pages must explain themselves, but still count as recorded", async () => {
  const rows = fullSet().map((r) =>
    r.page_slot === "pdp_2"
      ? { ...r, access_status: "not_observed" as const, screenshot_path: null, unobstructed_screenshot_path: null, overlay_dismissal_status: null, capture_states: [], navigation_notes: null }
      : r,
  );
  let report = await verifyEvidence(rows, domains, allExist);
  assert.match(report.checks.find((c) => c.name.includes("records why"))!.problems.join(), /not_observed with no explanation/);
  assert.equal(report.coverage[0].captured, 6);

  const explained = rows.map((r) => (r.page_slot === "pdp_2" ? { ...r, navigation_notes: "Only one product link found" } : r));
  report = await verifyEvidence(explained, domains, allExist);
  assert.equal(report.allChecksPassed, true);
  assert.equal(report.coverage[0].complete, false);
});

test("blocked pages need a recorded reason", async () => {
  const rows = fullSet().map((r) =>
    r.page_slot === "plp" ? { ...r, access_status: "blocked" as const, page_type_signals: { jsonLdTypes: [], ogType: null, addToCartControlVisible: false, visibleDialogCount: 0 } } : r,
  );
  const report = await verifyEvidence(rows, domains, allExist);
  assert.match(report.checks.flatMap((c) => c.problems).join(), /blocked without a recorded reason/);
});

test("warns about off-site redirects and product pages identified by URL only", async () => {
  const rows = fullSet().map((r) => {
    if (r.page_slot === "homepage" && r.viewport_name === "desktop") return { ...r, final_url: "https://other.com/" };
    if (r.page_slot === "pdp_1") return { ...r, page_type_signals: { jsonLdTypes: [], ogType: null, addToCartControlVisible: false, visibleDialogCount: 0 } };
    return r;
  });
  const report = await verifyEvidence(rows, domains, allExist);
  assert.equal(report.allChecksPassed, true);
  assert.equal(report.warnings.filter((w) => w.includes("off-site")).length, 1);
  assert.equal(report.warnings.filter((w) => w.includes("URL only")).length, 2);
});

const promo = {
  kind: "promotional" as const,
  label: "Get 15% off",
  tag: "div",
  isFrame: false,
  frameUrl: null,
  coverage: 1,
  box: { x: 0, y: 0, width: 390, height: 844 },
  controlsFound: [],
};

test("captured pages without both capture states, or with mismatched paths, fail", async () => {
  const rows = fullSet();
  rows[0] = { ...rows[0], overlay_dismissal_status: null, capture_states: [] };
  rows[1] = { ...rows[1], capture_states: [...rows[1].capture_states].reverse() };
  rows[2] = { ...rows[2], unobstructed_screenshot_path: null };
  rows[3] = { ...rows[3], capture_states: states(dismissal("none_detected"), "elsewhere.png", rows[3].unobstructed_screenshot_path) };
  const report = await verifyEvidence(rows, domains, allExist);
  const check = report.checks.find((c) => c.name.includes("initial and after-dismissal"))!;
  assert.equal(check.passed, false);
  const problems = check.problems.join("\n");
  assert.match(problems, /no overlay dismissal status/);
  assert.match(problems, /must be \[initial_viewport, after_overlay_dismissal\]/);
  assert.match(problems, /no after-dismissal screenshot/);
  assert.match(problems, /initial state does not point at the original screenshot/);
});

test("the after-dismissal screenshot must exist in storage", async () => {
  const report = await verifyEvidence(fullSet(), domains, async (p) => !p.endsWith("pdp_1-mobile-unobstructed.png"));
  assert.match(report.checks.find((c) => c.name.includes("exists in storage"))!.problems.join(), /pdp_1-mobile-unobstructed/);
});

test("overlays left in place, navigation and errors pass but are flagged for review", async () => {
  const rows = fullSet().map((r) => {
    if (r.page_slot === "pdp_1" && r.viewport_name === "mobile")
      return { ...r, overlay_dismissal_status: "partially_dismissed" as const, capture_states: states(dismissal("partially_dismissed", [promo]), r.screenshot_path, r.unobstructed_screenshot_path) };
    if (r.page_slot === "pdp_2" && r.viewport_name === "mobile")
      return { ...r, overlay_dismissal_status: "navigated_away" as const, unobstructed_screenshot_path: null, capture_states: states(dismissal("navigated_away"), r.screenshot_path, null) };
    if (r.page_slot === "plp" && r.viewport_name === "mobile")
      return { ...r, overlay_dismissal_status: "error" as const, unobstructed_screenshot_path: null, capture_states: states(dismissal("error"), r.screenshot_path, null) };
    return r;
  });
  const report = await verifyEvidence(rows, domains, allExist);
  assert.equal(report.allChecksPassed, true);
  assert.equal(report.warnings.length, 3);
  assert.match(report.warnings.join("\n"), /still visible .*partially_dismissed.*promotional "Get 15% off"/);
  assert.match(report.warnings.join("\n"), /navigated away/);
  assert.match(report.warnings.join("\n"), /errored: boom/);
});

test("a page cannot be marked all_dismissed while an overlay is still visible", async () => {
  const rows = fullSet().map((r) =>
    r.page_slot === "pdp_1" && r.viewport_name === "mobile"
      ? { ...r, overlay_dismissal_status: "all_dismissed" as const, capture_states: states(dismissal("all_dismissed", [promo]), r.screenshot_path, r.unobstructed_screenshot_path) }
      : r,
  );
  const report = await verifyEvidence(rows, domains, allExist);
  assert.equal(report.allChecksPassed, false);
  assert.match(report.checks.flatMap((c) => c.problems).join("\n"), /marked all_dismissed but overlays were still visible/);
});

test("a partially dismissed page still needs its after-dismissal screenshot", async () => {
  const rows = fullSet().map((r) =>
    r.page_slot === "pdp_1" && r.viewport_name === "mobile"
      ? { ...r, overlay_dismissal_status: "partially_dismissed" as const, unobstructed_screenshot_path: null, capture_states: states(dismissal("partially_dismissed", [promo]), r.screenshot_path, null) }
      : r,
  );
  const report = await verifyEvidence(rows, domains, allExist);
  assert.match(report.checks.flatMap((c) => c.problems).join("\n"), /pdp_1\/mobile.*no after-dismissal screenshot/);
});
