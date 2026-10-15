import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { localScreenshotPath, type ScreenshotKind } from "./archive.ts";
import type { CostTracker } from "./cost.ts";
import { removedIn } from "./overlays.ts";
import { renderHtmlReport } from "./reportHtml.ts";
import type { StoredEvidence } from "./store.ts";
import type { VerificationReport } from "./verify.ts";
import { orderEvidence } from "./verify.ts";

export interface RunReportInput {
  runId: string;
  status: string;
  startedAt: string;
  endedAt: string;
  workerVersion: string;
  provider: string;
  unitPriceUsd: number;
  maxRunUnits: number;
  maxRunCostUsd: number;
  tracker: CostTracker;
  sites: Array<{ companyId: string; name: string; domain: string; category: string; robots: string }>;
  evidence: StoredEvidence[];
  verification: VerificationReport;
  errors: string[];
  signedUrls: Map<string, string>;
  outputDir: string;
}

export function buildCostSummary(input: Pick<RunReportInput, "tracker" | "unitPriceUsd" | "maxRunUnits" | "maxRunCostUsd" | "sites">) {
  const { tracker } = input;
  const perSite = input.sites.map((s) => {
    const sessions = tracker.sessions.filter((x) => x.label.startsWith(`${s.domain} `));
    const units = sessions.reduce((n, x) => n + x.estimatedUnits, 0);
    return {
      domain: s.domain,
      sessions: sessions.length,
      sessionSeconds: Math.round(sessions.reduce((n, x) => n + x.durationMs, 0) / 100) / 10,
      estimatedUnits: units,
      estimatedCostUsd: Math.round(units * input.unitPriceUsd * 10_000) / 10_000,
    };
  });
  return {
    basis: "ESTIMATE from session time measured by this worker (1 unit per started 30 s per browser session, rounded up per session). Browserless does not report usage back to the worker; check the Browserless account usage page for actual consumption.",
    browserSessions: tracker.sessions.length,
    measuredSessionSeconds: Math.round(tracker.sessionSeconds * 10) / 10,
    estimatedUnits: tracker.estimatedUnits,
    unitPriceUsd: input.unitPriceUsd,
    estimatedCostUsd: tracker.estimatedCostUsd,
    actualUnits: null,
    ceilings: { maxRunUnits: input.maxRunUnits, maxRunCostUsd: input.maxRunCostUsd, hit: tracker.ceilingHit },
    modelCostUsd: 0,
    perSite,
  };
}

export type CostSummary = ReturnType<typeof buildCostSummary>;
export type LocalImage = (e: StoredEvidence, kind: ScreenshotKind) => string | null;

/** Where each stored screenshot's local copy lives, relative to the run folder. */
export function localImageResolver(sites: RunReportInput["sites"]): LocalImage {
  const domains = new Map(sites.map((s) => [s.companyId, s.domain]));
  return (e, kind) => {
    const stored = kind === "initial" ? e.screenshot_path : kind === "after-dismissal" ? e.unobstructed_screenshot_path : e.full_page_screenshot_path;
    const domain = domains.get(e.company_id);
    return stored && domain ? localScreenshotPath(domain, e.page_slot, e.viewport_name, kind) : null;
  };
}

export function writeReports(input: RunReportInput): { jsonPath: string; mdPath: string; htmlPath: string } {
  const cost = buildCostSummary(input);
  const image = localImageResolver(input.sites);
  const json = {
    runId: input.runId,
    status: input.status,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    workerVersion: input.workerVersion,
    browserProvider: input.provider,
    scope: "Evidence capture only. No AI analysis, findings, scoring or contact research was performed.",
    cost,
    verification: input.verification,
    errors: input.errors,
    sites: input.sites.map((s) => ({
      ...s,
      captures: input.evidence
        .filter((e) => e.company_id === s.companyId)
        .map((e) => ({
          evidenceId: e.id,
          slot: e.page_slot,
          pageType: e.page_type,
          viewport: `${e.viewport_name} ${e.viewport_width}x${e.viewport_height}`,
          status: e.access_status,
          httpStatus: e.http_status,
          requestedUrl: e.requested_url,
          finalUrl: e.final_url,
          capturedAt: e.captured_at,
          title: e.page_title,
          screenshotPath: e.screenshot_path,
          fullPageScreenshotPath: e.full_page_screenshot_path,
          unobstructedScreenshotPath: e.unobstructed_screenshot_path,
          localScreenshots: { initial: image(e, "initial"), afterDismissal: image(e, "after-dismissal"), fullPage: image(e, "full-page") },
          overlayDismissalStatus: e.overlay_dismissal_status,
          captureStates: e.capture_states,
          discoveryMethod: e.discovery_method,
          signals: e.page_type_signals,
          notes: e.navigation_notes,
          error: e.error_message,
          loadMs: e.load_duration_ms,
        })),
    })),
  };
  const jsonPath = join(input.outputDir, "report.json");
  writeFileSync(jsonPath, JSON.stringify(json, null, 2));

  const mdPath = join(input.outputDir, "report.md");
  writeFileSync(mdPath, renderMarkdown(input, cost));

  const htmlPath = join(input.outputDir, "report.html");
  writeFileSync(htmlPath, renderHtmlReport(input, cost, image));
  return { jsonPath, mdPath, htmlPath };
}

function cell(text: string | null | undefined): string {
  return (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function link(urls: Map<string, string>, path: string | null, text: string): string {
  if (!path) return "";
  const url = urls.get(path);
  return url ? `[${text}](${url})` : `${text} (stored)`;
}

function overlayLines(e: StoredEvidence): string[] {
  const after = e.capture_states?.find((s) => s.state === "after_overlay_dismissal");
  const initial = e.capture_states?.find((s) => s.state === "initial_viewport");
  if (!after || !initial || e.overlay_dismissal_status === "none_detected") return [];
  const lines = [`- **${e.page_slot} / ${e.viewport_name}**: ${e.overlay_dismissal_status}; ${initial.overlays_visible.length} overlay(s) in the initial viewport`];
  for (const a of after.actions ?? []) {
    const how = a.control ? `${a.method} "${a.control.label}" (${a.control.intent})` : "no action";
    lines.push(`  - ${a.overlay.kind} "${cell(a.overlay.label.slice(0, 60))}" (${a.firstSeen}): ${how} -> ${a.outcome}. ${cell(a.detail)}`);
  }
  const names = (list: typeof after.overlays_visible) => list.map((o) => `${o.kind} "${cell(o.label.slice(0, 60))}"`).join("; ") || "none";
  lines.push(`  - removed: ${names(removedIn(after))}`);
  lines.push(`  - still visible after final check: ${names(after.overlays_visible)}`);
  if (after.error) lines.push(`  - error: ${cell(after.error)}`);
  return lines;
}

function renderMarkdown(input: RunReportInput, cost: CostSummary): string {
  const v = input.verification;
  const out: string[] = [];
  out.push(`# Evidence capture report`, "");
  out.push(`- Run: \`${input.runId}\``, `- Status: **${input.status}**`, `- Started: ${input.startedAt}`, `- Ended: ${input.endedAt}`);
  out.push(`- Worker: ${input.workerVersion}, browser provider: ${input.provider}`);
  out.push("", "> Scope: captures only. No analysis, findings, scores or contacts were generated. \"Not observed\" means the worker could not find or reach the page; it does not mean the page or feature does not exist.", "");

  out.push(`## Coverage`, "", "| Site | Captured | Required | Complete |", "|---|---|---|---|");
  for (const c of v.coverage) out.push(`| ${c.domain} | ${c.captured} | ${c.required} | ${c.complete ? "yes" : "no"} |`);

  out.push("", `## Cost (estimate)`, "", cost.basis, "");
  out.push(`- Browser sessions: ${cost.browserSessions}`, `- Measured session time: ${cost.measuredSessionSeconds} s`);
  out.push(`- Estimated units: ${cost.estimatedUnits} (ceiling ${cost.ceilings.maxRunUnits})`);
  out.push(`- Estimated cost: $${cost.estimatedCostUsd} at $${cost.unitPriceUsd}/unit (ceiling $${cost.ceilings.maxRunCostUsd})`);
  out.push(`- Ceiling reached: ${cost.ceilings.hit ? "YES, run stopped early" : "no"}`, `- AI model cost: $0 (no model used)`, "");
  out.push("| Site | Sessions | Seconds | Est. units | Est. cost |", "|---|---|---|---|---|");
  for (const s of cost.perSite) out.push(`| ${s.domain} | ${s.sessions} | ${s.sessionSeconds} | ${s.estimatedUnits} | $${s.estimatedCostUsd} |`);

  out.push("", `## Verification`, "");
  for (const c of v.checks) {
    out.push(`- ${c.passed ? "PASS" : "FAIL"}: ${c.name}`);
    for (const p of c.problems) out.push(`  - ${p}`);
  }
  if (v.warnings.length) {
    out.push("", "Warnings (need human review):");
    for (const w of v.warnings) out.push(`- ${w}`);
  }
  if (input.errors.length) {
    out.push("", "## Run errors", "");
    for (const e of input.errors) out.push(`- ${e}`);
  }

  for (const site of input.sites) {
    const rows = input.evidence.filter((e) => e.company_id === site.companyId);
    out.push("", `## ${site.name} (${site.domain}, ${site.category})`, "", `robots.txt: ${site.robots}`, "");
    out.push("| Slot | Viewport | Status | HTTP | URL | Screenshots | Overlays | Notes |", "|---|---|---|---|---|---|---|---|");
    const sorted = orderEvidence(rows);
    for (const e of sorted) {
      const shot = e.screenshot_path
        ? [
            link(input.signedUrls, e.screenshot_path, "initial"),
            link(input.signedUrls, e.unobstructed_screenshot_path, "after dismissal"),
            link(input.signedUrls, e.full_page_screenshot_path, "full"),
          ]
            .filter(Boolean)
            .join(" ")
        : "-";
      const notes = [e.navigation_notes, e.error_message, (e.page_type_signals as { blockReason?: string }).blockReason].filter(Boolean).join(" | ");
      out.push(
        `| ${e.page_slot} | ${e.viewport_name} ${e.viewport_width}x${e.viewport_height} | ${e.access_status} | ${e.http_status ?? "-"} | ${cell(e.final_url ?? e.requested_url ?? "-")} | ${shot} | ${e.overlay_dismissal_status ?? "-"} | ${cell(notes)} |`,
      );
    }
    const overlays = sorted.flatMap(overlayLines);
    if (overlays.length) out.push("", `### Overlays`, "", "Detected from the first-visit viewport. The initial screenshot is untouched; the after-dismissal screenshot was taken only after pressing each overlay's own visible control.", "", ...overlays);
  }
  out.push("", "Screenshot links are signed and expire after 7 days. Local copies are in the `screenshots/` folder next to this report (grouped by company and page), and `report.html` shows them all.", "");
  return out.join("\n");
}
