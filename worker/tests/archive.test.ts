import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { latestTarget, listRuns, localScreenshotPath, runFolderName, updateLatestLink, writeRunIndex } from "../src/archive.ts";
import { CostTracker } from "../src/cost.ts";
import { buildCaptureStates, type DismissalResult } from "../src/overlays.ts";
import { writeReports, type RunReportInput } from "../src/report.ts";
import type { StoredEvidence } from "../src/store.ts";

const RUN_A = "3f2b9c1e-0000-4000-8000-000000000001";
const RUN_B = "a91d77f0-0000-4000-8000-000000000002";

const tempRoot = () => mkdtempSync(join(tmpdir(), "worker-output-"));

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = `${statSync(p).mtimeMs}:${readFileSync(p, "utf8")}`;
    }
  };
  walk(dir);
  return out;
}

function fakeRun(root: string, startedAt: string, runId: string, status = "completed", withReport = true): string {
  const dir = join(root, runFolderName(new Date(startedAt), runId));
  mkdirSync(dir, { recursive: true });
  if (withReport) {
    writeFileSync(
      join(dir, "report.json"),
      JSON.stringify({ runId, status, startedAt, endedAt: startedAt, cost: { estimatedCostUsd: 0.12 }, verification: { coverage: [{ domain: "kosas.com", captured: 8, required: 8 }] } }),
    );
    writeFileSync(join(dir, "report.html"), "<html></html>");
  }
  return dir;
}

test("run folders are readable, sort by time and carry a short run ID suffix", () => {
  const a = runFolderName(new Date("2026-10-15T09:04:05.678Z"), RUN_A);
  const b = runFolderName(new Date("2026-10-15T09:04:05.999Z"), RUN_B);
  const later = runFolderName(new Date("2026-10-15T21:00:00Z"), RUN_A);
  assert.equal(a, "2026-10-15_09-04-05Z_3f2b9c1e");
  assert.notEqual(a, b, "same second, different runs, different folders");
  assert.deepEqual([later, a].sort(), [a, later]);
  assert.match(a, /^[\w-]+$/, "safe on every file system");
});

test("screenshots are grouped by company and page with descriptive names", () => {
  assert.equal(localScreenshotPath("kosas.com", "pdp_1", "mobile", "initial"), "screenshots/kosas.com/pdp-1/mobile-initial.png");
  assert.equal(localScreenshotPath("kosas.com", "pdp_1", "mobile", "after-dismissal"), "screenshots/kosas.com/pdp-1/mobile-after-dismissal.png");
  assert.equal(localScreenshotPath("kosas.com", "homepage", "desktop", "full-page"), "screenshots/kosas.com/homepage/desktop-full-page.jpg");
  assert.equal(localScreenshotPath("Shop.Example.com", "plp_candidate_2", "desktop", "initial"), "screenshots/shop.example.com/plp-candidate-2/desktop-initial.png");
  assert.equal(localScreenshotPath("../evil", "x/../../y", "mobile", "initial"), "screenshots/evil/x-..-..-y/mobile-initial.png", "no separators survive, so no path traversal");
});

test("latest is a shortcut (not a copy) and moves to the newest completed run", () => {
  const root = tempRoot();
  const older = fakeRun(root, "2026-10-14T10:00:00Z", RUN_A);
  const newer = fakeRun(root, "2026-10-15T10:00:00Z", RUN_B);

  assert.equal(updateLatestLink(root, older).ok, true);
  assert.equal(latestTarget(root), older);
  assert.equal(updateLatestLink(root, newer).ok, true);
  assert.equal(latestTarget(root), newer);

  assert.equal(lstatSync(join(root, "latest")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(root, "latest", "report.html"), "utf8"), "<html></html>");
  assert.deepEqual(readdirSync(root).filter((n) => n.startsWith(".latest")), [], "no temporary links left behind");
  assert.equal(existsSync(join(older, "report.html")), true, "re-pointing never touches the previous run");
});

test("a real folder named latest is never replaced", () => {
  const root = tempRoot();
  mkdirSync(join(root, "latest"));
  writeFileSync(join(root, "latest", "keep.txt"), "mine");
  const r = updateLatestLink(root, fakeRun(root, "2026-10-15T10:00:00Z", RUN_A));
  assert.equal(r.ok, false);
  assert.match(r.detail, /not a shortcut/);
  assert.equal(readFileSync(join(root, "latest", "keep.txt"), "utf8"), "mine");
  assert.equal(latestTarget(root), null);
});

test("the run index lists new and older UUID runs, newest first, without modifying old folders", () => {
  const root = tempRoot();
  const legacy = join(root, RUN_A);
  mkdirSync(join(legacy, "screenshots", "kosas.com"), { recursive: true });
  writeFileSync(join(legacy, "report.json"), JSON.stringify({ runId: RUN_A, status: "completed_with_failures", startedAt: "2026-10-13T08:00:00Z", cost: { estimatedCostUsd: 0.2 } }));
  writeFileSync(join(legacy, "report.md"), "# old");
  writeFileSync(join(legacy, "screenshots", "kosas.com", "pdp_1-mobile.png"), "png");
  const before = snapshot(legacy);

  const aborted = fakeRun(root, "2026-10-14T08:00:00Z", "deadbeef-0000-4000-8000-000000000003", "", false);
  const newest = fakeRun(root, "2026-10-15T08:00:00Z", RUN_B);
  mkdirSync(join(root, "not-a-run"));
  updateLatestLink(root, newest);

  const runs = listRuns(root);
  assert.deepEqual(
    runs.map((r) => [r.folder, r.legacy, r.reportFile]),
    [
      ["2026-10-15_08-00-00Z_a91d77f0", false, "report.html"],
      [aborted.split(/[\\/]/).pop(), false, null],
      [RUN_A, true, "report.md"],
    ],
  );
  assert.equal(runs[0].captured, 8);

  const html = readFileSync(writeRunIndex(root), "utf8");
  assert.match(html, /href="2026-10-15_08-00-00Z_a91d77f0\/report.html"/);
  assert.match(html, new RegExp(`href="${RUN_A}/report.md"`));
  assert.match(html, /class="badge ok">latest</);
  assert.match(html, /older format/);
  assert.match(html, /no report \(run aborted or still running\)/);
  assert.match(html, /href="latest\/report.html"/);
  assert.ok(html.indexOf("a91d77f0") < html.indexOf(RUN_A), "newest first");
  assert.deepEqual(snapshot(legacy), before, "historical folder untouched");
});

const COMPANY = "co-1";

function evidence(slot: string, viewport: "desktop" | "mobile", overrides: Partial<StoredEvidence> = {}): StoredEvidence {
  const base = `${RUN_B}/kosas.com/${slot}-${viewport}`;
  const dismissal: DismissalResult = {
    status: "all_dismissed",
    initialOverlays: [],
    actions: [
      {
        overlay: { kind: "promotional", label: "Get 15% off <b>now</b>", tag: "div", isFrame: false, frameUrl: null, coverage: 1, box: { x: 0, y: 0, width: 390, height: 844 }, controlsFound: [] },
        firstSeen: "initial",
        control: { label: "×", intent: "close", tag: "button" },
        method: "tap",
        outcome: "dismissed",
        detail: "Overlay no longer visible after pressing the control",
      },
    ],
    removedOverlays: [],
    remainingOverlays: [],
    error: null,
  };
  dismissal.removedOverlays = [dismissal.actions[0].overlay];
  return {
    id: `${slot}-${viewport}-0000`,
    research_run_id: RUN_B,
    company_id: COMPANY,
    job_id: "j1",
    page_type: slot.startsWith("pdp") ? "pdp" : slot === "homepage" ? "homepage" : "plp",
    page_slot: slot,
    requested_url: `https://kosas.com/${slot}`,
    final_url: `https://kosas.com/${slot}`,
    viewport_name: viewport,
    viewport_width: viewport === "desktop" ? 1440 : 390,
    viewport_height: viewport === "desktop" ? 900 : 844,
    user_agent: "UA",
    captured_at: "2026-10-15T08:00:00Z",
    access_status: "captured",
    http_status: 200,
    page_title: "Kosas",
    screenshot_path: `${base}.png`,
    full_page_screenshot_path: `${base}-full.jpg`,
    unobstructed_screenshot_path: `${base}-unobstructed.png`,
    overlay_dismissal_status: "all_dismissed",
    capture_states: buildCaptureStates(dismissal, { path: `${base}.png`, at: "t1" }, { path: `${base}-unobstructed.png`, at: "t2" }),
    extracted_text: "text",
    extracted_text_length: 4,
    content_hash: "hash",
    discovery_method: "test",
    discovered_from_url: null,
    page_type_signals: {} as StoredEvidence["page_type_signals"],
    navigation_notes: null,
    error_message: null,
    load_duration_ms: 1000,
    ...overrides,
  };
}

function reportInput(outputDir: string, rows: StoredEvidence[]): RunReportInput {
  return {
    runId: RUN_B,
    status: "completed_with_failures",
    startedAt: "2026-10-15T08:00:00Z",
    endedAt: "2026-10-15T08:10:00Z",
    workerVersion: "prospect-research-worker@0.1.0",
    provider: "browserless",
    unitPriceUsd: 0.002,
    maxRunUnits: 400,
    maxRunCostUsd: 1,
    tracker: new CostTracker(400, 1, 0.002, 110_000),
    sites: [{ companyId: COMPANY, name: "Kosas", domain: "kosas.com", category: "beauty", robots: "ok, 0 disallow rule(s)" }],
    evidence: rows,
    verification: {
      checks: [{ name: "Every referenced screenshot file exists in storage", passed: true, problems: [] }],
      warnings: ["kosas.com pdp_2/mobile overlays still visible"],
      coverage: [{ domain: "kosas.com", captured: 2, required: 8, complete: false }],
      allChecksPassed: true,
    },
    errors: [],
    signedUrls: new Map(),
    outputDir,
  };
}

test("the HTML report links local screenshots for both states and shows statuses, overlays and cost", () => {
  const dir = tempRoot();
  const rows = [
    evidence("pdp_1", "mobile"),
    evidence("pdp_1", "desktop", { page_title: "<script>alert(1)</script>" }),
    evidence("pdp_2", "mobile", {
      access_status: "blocked",
      screenshot_path: null,
      unobstructed_screenshot_path: null,
      full_page_screenshot_path: null,
      overlay_dismissal_status: null,
      capture_states: [],
      final_url: "javascript:alert(1)",
      requested_url: null,
      page_type_signals: { blockReason: "HTTP 403" } as StoredEvidence["page_type_signals"],
    }),
  ];
  const { htmlPath, jsonPath, mdPath } = writeReports(reportInput(dir, rows));
  assert.ok(existsSync(mdPath));
  const html = readFileSync(htmlPath, "utf8");

  assert.match(html, /<a class="shot" href="screenshots\/kosas.com\/pdp-1\/mobile-initial.png"[^>]*><img src="screenshots\/kosas.com\/pdp-1\/mobile-initial.png"/);
  assert.match(html, /href="screenshots\/kosas.com\/pdp-1\/mobile-after-dismissal.png"/);
  assert.match(html, /href="screenshots\/kosas.com\/pdp-1\/desktop-full-page.jpg"/);
  assert.match(html, /overlays dismissed/);
  assert.match(html, /tap &quot;×&quot; \(close\)/);
  assert.match(html, /blocked/);
  assert.match(html, /HTTP 403/);
  assert.match(html, /\$0 · |Estimated cost/);
  assert.match(html, /kosas.com pdp_2\/mobile overlays still visible/);
  assert.match(html, /href="\.\.\/index.html"/);
  assert.match(html, />removed<\/span> <b>promotional<\/b> “Get 15% off &lt;b&gt;now/);
  assert.match(html, />still visible<\/span> none/);
  const md = readFileSync(mdPath, "utf8");
  assert.match(md, /removed: promotional "Get 15% off/);
  assert.match(md, /still visible after final check: none/);

  assert.doesNotMatch(html, /<script>/, "page content is escaped");
  assert.match(html, /Get 15% off &lt;b&gt;now&lt;\/b&gt;/);
  assert.doesNotMatch(html, /href="javascript:/i, "unsafe URLs are not linked");
  assert.doesNotMatch(html, /pdp-2\/mobile-initial.png/, "no links to screenshots that were never taken");
  assert.ok(html.indexOf("pdp 1") < html.indexOf("pdp 2"));

  const json = JSON.parse(readFileSync(jsonPath, "utf8"));
  const capture = json.sites[0].captures.find((c: { slot: string; viewport: string }) => c.slot === "pdp_1" && c.viewport.startsWith("mobile"));
  assert.deepEqual(capture.localScreenshots, {
    initial: "screenshots/kosas.com/pdp-1/mobile-initial.png",
    afterDismissal: "screenshots/kosas.com/pdp-1/mobile-after-dismissal.png",
    fullPage: "screenshots/kosas.com/pdp-1/mobile-full-page.jpg",
  });
  assert.equal(capture.screenshotPath, `${RUN_B}/kosas.com/pdp_1-mobile.png`, "storage references are unchanged");
});
