import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CostTracker } from "./cost.ts";
import type { StoredEvidence } from "./store.ts";
import type { VerificationReport } from "./verify.ts";
import { REQUIRED_SLOTS, REQUIRED_VIEWPORTS } from "./verify.ts";

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

export function writeReports(input: RunReportInput): { jsonPath: string; mdPath: string } {
  const cost = buildCostSummary(input);
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
  return { jsonPath, mdPath };
}

function cell(text: string | null | undefined): string {
  return (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderMarkdown(input: RunReportInput, cost: ReturnType<typeof buildCostSummary>): string {
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
    out.push("| Slot | Viewport | Status | HTTP | URL | Screenshot | Notes |", "|---|---|---|---|---|---|---|");
    const order = (slot: string) => {
      const i = (REQUIRED_SLOTS as readonly string[]).indexOf(slot);
      return i === -1 ? 99 : i;
    };
    const sorted = [...rows].sort(
      (a, b) =>
        order(a.page_slot) - order(b.page_slot) ||
        a.page_slot.localeCompare(b.page_slot) ||
        (REQUIRED_VIEWPORTS as readonly string[]).indexOf(a.viewport_name) - (REQUIRED_VIEWPORTS as readonly string[]).indexOf(b.viewport_name),
    );
    for (const e of sorted) {
      const shot = e.screenshot_path
        ? [
            input.signedUrls.get(e.screenshot_path) ? `[view](${input.signedUrls.get(e.screenshot_path)})` : "stored",
            e.full_page_screenshot_path && input.signedUrls.get(e.full_page_screenshot_path) ? `[full](${input.signedUrls.get(e.full_page_screenshot_path)})` : "",
          ]
            .filter(Boolean)
            .join(" ")
        : "-";
      const notes = [e.navigation_notes, e.error_message, (e.page_type_signals as { blockReason?: string }).blockReason].filter(Boolean).join(" | ");
      out.push(
        `| ${e.page_slot} | ${e.viewport_name} ${e.viewport_width}x${e.viewport_height} | ${e.access_status} | ${e.http_status ?? "-"} | ${cell(e.final_url ?? e.requested_url ?? "-")} | ${shot} | ${cell(notes)} |`,
      );
    }
  }
  out.push("", "Screenshot links are signed and expire after 7 days. Local copies are in the `screenshots/` folder next to this report.", "");
  return out.join("\n");
}
