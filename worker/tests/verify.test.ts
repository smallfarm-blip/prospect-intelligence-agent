import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredEvidence } from "../src/store.ts";
import { REQUIRED_SLOTS, REQUIRED_VIEWPORTS, verifyEvidence } from "../src/verify.ts";

const COMPANY = "c1";
const domains = new Map([[COMPANY, "x.com"]]);
let seq = 0;

function row(slot: string, viewport: "desktop" | "mobile", overrides: Partial<StoredEvidence> = {}): StoredEvidence {
  const pageType = slot.startsWith("pdp") ? "pdp" : slot === "homepage" ? "homepage" : "plp";
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
    screenshot_path: `r1/x.com/${slot}-${viewport}.png`,
    full_page_screenshot_path: null,
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
    r.page_slot === "pdp_2" ? { ...r, access_status: "not_observed" as const, screenshot_path: null, navigation_notes: null } : r,
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
