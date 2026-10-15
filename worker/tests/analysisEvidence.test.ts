import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { estimateImageTokens, fitWithinLimits, MAX_LONG_EDGE, MAX_PIXELS, planSections, prepareRegion } from "../src/analysis/images.ts";
import { imageLabel, loadEvidencePack, manifestOf, overlaysOf } from "../src/analysis/evidence.ts";
import { blankPng, captureStates, COMPANY, evidenceRow, FakeSource, LIMITS, png, RUN, standardFixture } from "./helpers/evidenceFixtures.ts";

test("fitWithinLimits keeps long edge and pixel count inside provider limits", () => {
  for (const [w, h] of [[1170, 2532], [2880, 1800], [390, 844], [5000, 300]]) {
    const s = fitWithinLimits(w, h);
    assert.ok(Math.max(s.width, s.height) <= MAX_LONG_EDGE, `${w}x${h}`);
    assert.ok(s.width * s.height <= MAX_PIXELS, `${w}x${h}`);
  }
  assert.deepEqual(fitWithinLimits(390, 844), { width: 390, height: 844 });
  assert.equal(estimateImageTokens(750, 1000), 1000);
});

test("prepareRegion crops and scales to JPEG with token estimate", async () => {
  const buf = await png(1200, 3000, 3);
  const out = await prepareRegion(buf, { x: 0, y: 1000, width: 1200, height: 1600 });
  const meta = await sharp(out.jpeg).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.width, out.scaledWidth);
  assert.equal(meta.height, out.scaledHeight);
  assert.ok(out.scaledWidth * out.scaledHeight <= MAX_PIXELS);
  assert.equal(out.estimatedTokens, estimateImageTokens(out.scaledWidth, out.scaledHeight));
});

test("planSections skips the first screen, overlaps, and reports what is left over", () => {
  const all = planSections(100, 500, 100, 10);
  assert.equal(all.sections[0].y, 100);
  assert.equal(all.sections[1].y, 190);
  assert.equal(all.sections.at(-1)!.y, 400);
  assert.ok(all.sections.every((s) => s.height === 100));
  assert.equal(all.unanalysed, null);

  const capped = planSections(100, 1000, 100, 2);
  assert.equal(capped.sections.length, 2);
  assert.deepEqual(capped.unanalysed, { fromY: 290, toY: 1000 });

  const short = planSections(100, 80, 100, 4);
  assert.equal(short.sections.length, 0);
  assert.equal(short.unanalysed, null);

  const none = planSections(100, 500, 100, 0);
  assert.deepEqual(none.unanalysed, { fromY: 100, toY: 500 });
});

test("loader orders PDP before PLP before homepage, mobile first, and builds references", async () => {
  const rows = [evidenceRow("homepage", "desktop"), evidenceRow("plp_1", "mobile"), evidenceRow("pdp_1", "desktop"), evidenceRow("pdp_1", "mobile")];
  const pack = await loadEvidencePack(await standardFixture(rows), { researchRunId: RUN, companyDomain: COMPANY.domain }, LIMITS);
  assert.deepEqual(
    pack.pages.map((p) => `${p.ref}:${p.slot}:${p.viewport}`),
    ["P1:pdp_1:mobile", "P2:pdp_1:desktop", "P3:plp_1:mobile", "P4:homepage:desktop"],
  );
  assert.equal(pack.pages[0].textRef, "TXT-P1");
  const p1 = pack.images.filter((i) => i.pageRef === "P1");
  assert.deepEqual(p1.map((i) => i.captureState), ["initial_viewport", "after_overlay_dismissal", "full_page_section", "full_page_section", "full_page_section"]);
  assert.equal(p1[4].crop.y + p1[4].crop.height, 600);
  assert.equal(pack.images[0].ref, "IMG-01");
  assert.match(imageLabel(p1[2], pack.pages[0]), /full-page section, source pixels y 200-400 of 600/);
});

test("loader never re-visits the site: it only downloads stored paths", async () => {
  const rows = [evidenceRow("pdp_1", "mobile")];
  const source = await standardFixture(rows);
  await loadEvidencePack(source, { researchRunId: RUN, companyDomain: COMPANY.domain }, LIMITS);
  assert.deepEqual(new Set(source.downloads), new Set([rows[0].screenshot_path, rows[0].unobstructed_screenshot_path, rows[0].full_page_screenshot_path]));
});

test("byte-identical initial screenshots are sent once and flagged as overlay-only", async () => {
  const rows = [evidenceRow("pdp_1", "mobile"), evidenceRow("pdp_2", "mobile")];
  const source = await standardFixture(rows);
  const shared = await png(100, 200, 99);
  const files = source.files;
  files.set(rows[0].screenshot_path!, shared);
  files.set(rows[1].screenshot_path!, shared);
  const pack = await loadEvidencePack(source, { researchRunId: RUN, companyDomain: COMPANY.domain }, LIMITS);
  const initial = pack.images.filter((i) => i.captureState === "initial_viewport");
  assert.equal(initial.length, 1);
  assert.deepEqual(initial[0].alsoShownFor, ["P2"]);
  assert.ok(pack.pages[1].imageRefs.includes(initial[0].ref));
  assert.ok(pack.warnings.some((w) => /byte-identical/.test(w) && /overlay-only/.test(w)));
});

test("missing, unreadable and blank screenshots are warned about and not sent", async () => {
  const row = evidenceRow("pdp_1", "mobile");
  const files = new Map<string, Buffer>([
    [row.unobstructed_screenshot_path!, Buffer.from("not an image")],
    [row.full_page_screenshot_path!, await blankPng(100, 600)],
  ]);
  const pack = await loadEvidencePack(new FakeSource([row], files), { researchRunId: RUN, companyDomain: COMPANY.domain }, LIMITS);
  assert.equal(pack.images.length, 0);
  assert.ok(pack.warnings.some((w) => /initial screenshot could not be downloaded/.test(w)));
  assert.ok(pack.warnings.some((w) => /after-dismissal screenshot is not a readable image/.test(w)));
  assert.ok(pack.warnings.some((w) => /full-page screenshot is blank/.test(w)));
});

test("pages without a capture are skipped and recorded", async () => {
  const rows = [evidenceRow("pdp_1", "mobile"), evidenceRow("pdp_2", "mobile", { access_status: "blocked" as never })];
  const pack = await loadEvidencePack(await standardFixture(rows), { researchRunId: RUN, companyDomain: COMPANY.domain }, LIMITS);
  assert.equal(pack.pages.length, 1);
  assert.equal(pack.skipped.length, 1);
  assert.match(pack.skipped[0].reason, /blocked/);
});

test("image limit stops sending and reports unanalysed regions", async () => {
  const rows = [evidenceRow("pdp_1", "mobile"), evidenceRow("pdp_1", "desktop"), evidenceRow("plp_1", "mobile")];
  const pack = await loadEvidencePack(await standardFixture(rows, 5), { researchRunId: RUN, companyDomain: COMPANY.domain }, { ...LIMITS, maxImages: 5 });
  assert.equal(pack.images.length, 5);
  assert.ok(pack.warnings.some((w) => /image limit was reached/.test(w)));
  assert.ok(pack.unanalysed.length >= 1);
  assert.ok(pack.unanalysed.every((u) => u.toY > u.fromY));
});

test("legacy overlay records are noted and do not claim a cookie banner was removed", async () => {
  const row = evidenceRow("pdp_1", "mobile", { capture_states: captureStates({ legacy: true }) });
  const o = overlaysOf(row);
  assert.equal(o.legacyFormat, true);
  assert.deepEqual(o.removed.map((r) => r.kind), ["promotional"]);
  assert.ok(!o.removed.some((r) => r.kind === "consent"));
  const pack = await loadEvidencePack(await standardFixture([row]), { researchRunId: RUN, companyDomain: COMPANY.domain }, LIMITS);
  assert.ok(pack.pages[0].notes.some((n) => /earlier format/.test(n)));
  assert.ok(pack.warnings.some((w) => /may omit cookie banners/.test(w)));
});

test("current overlay records keep promo and cookie banner distinct", () => {
  const o = overlaysOf(evidenceRow("pdp_1", "mobile"));
  assert.equal(o.legacyFormat, false);
  assert.deepEqual(o.removed.map((r) => r.kind).sort(), ["consent", "promotional"]);
});

test("text excerpt is limited and the full text is kept for quote checks, but not in the manifest", async () => {
  const long = "word ".repeat(3000);
  const row = evidenceRow("pdp_1", "mobile", { extracted_text: long });
  const pack = await loadEvidencePack(await standardFixture([row]), { researchRunId: RUN, companyDomain: COMPANY.domain }, { ...LIMITS, maxPageTextChars: 100 });
  assert.equal(pack.pages[0].textExcerpt.length, 100);
  assert.equal(pack.pages[0].fullText, long);
  const manifest = JSON.stringify(manifestOf(pack));
  assert.ok(!manifest.includes(long));
  assert.ok(!manifest.includes('"jpeg"'));
});

test("unknown company or empty run fails clearly", async () => {
  const source = await standardFixture([evidenceRow("pdp_1", "mobile")]);
  await assert.rejects(loadEvidencePack(source, { researchRunId: RUN, companyDomain: "nope.com" }, LIMITS), /No company/);
  await assert.rejects(loadEvidencePack(source, { researchRunId: "other", companyDomain: COMPANY.domain }, LIMITS), /no evidence/);
});
