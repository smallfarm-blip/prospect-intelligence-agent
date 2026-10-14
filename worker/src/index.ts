import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { BrowserlessProvider } from "./browser/browserless.ts";
import { CompanyCollector, type SlotSummary } from "./collector.ts";
import { loadConfig } from "./config.ts";
import { CostTracker } from "./cost.ts";
import { createLogger } from "./logger.ts";
import { DomainRateLimiter } from "./rateLimiter.ts";
import { writeReports } from "./report.ts";
import { fetchRobots, type RobotsRules } from "./robots.ts";
import { EvidenceStore } from "./store.ts";
import { verifyEvidence } from "./verify.ts";

const SIGNED_URL_SECONDS = 7 * 24 * 3600;

async function main(): Promise<number> {
  const config = loadConfig();
  const runId = randomUUID();
  const workerId = `${hostname()}:${process.pid}`;
  const workerVersion = `${pkg.name}@${pkg.version}`;
  const outputDir = resolve("output", runId);
  mkdirSync(outputDir, { recursive: true });
  const logger = createLogger(join(outputDir, "worker.log.jsonl"));
  const startedAt = new Date().toISOString();
  const errors: string[] = [];

  const store = new EvidenceStore(config.supabaseUrl, config.supabaseSecretKey);
  await store.preflight();

  const provider = new BrowserlessProvider(config.browserlessEndpoint, config.browserlessToken, config.sessionTimeoutMs);
  const tracker = new CostTracker(config.maxRunUnits, config.maxRunCostUsd, config.unitPriceUsd, config.sessionTimeoutMs);
  const limiter = new DomainRateLimiter(config.rateLimitMs);

  const reclaimed = await store.reclaimStaleJobs(config.jobStaleMinutes);
  if (reclaimed) logger.log("warn", "jobs.reclaimed", { count: reclaimed });

  const runConfig = {
    sites: config.sites.map((s) => s.domain),
    endpoint: new URL(config.browserlessEndpoint).host,
    sessionTimeoutMs: config.sessionTimeoutMs,
    rateLimitMs: config.rateLimitMs,
    pageTimeoutMs: config.pageTimeoutMs,
    maxRunUnits: config.maxRunUnits,
    unitPriceUsd: config.unitPriceUsd,
  };
  await store.createRun({
    id: runId,
    worker_version: workerVersion,
    worker_host: workerId,
    config: runConfig,
    browser_provider: provider.name,
    cost_ceiling_usd: config.maxRunCostUsd,
  });
  logger.log("info", "run.start", { runId, ...runConfig });

  const sites: Array<{ companyId: string; name: string; domain: string; category: string; robots: string }> = [];
  const robotsByCompany = new Map<string, RobotsRules>();
  for (const site of config.sites) {
    const companyId = await store.upsertCompany(site);
    await store.createJob(runId, companyId);
    const robots = await fetchRobots(site.domain);
    robotsByCompany.set(companyId, robots);
    sites.push({
      companyId,
      name: site.name,
      domain: site.domain,
      category: site.category,
      robots: `${robots.status}${robots.crawlDelaySeconds ? `, crawl-delay ${robots.crawlDelaySeconds}s` : ""}, ${robots.disallow.length} disallow rule(s)`,
    });
  }

  const summaries: SlotSummary[] = [];
  for (let job = await store.claimNextJob(runId, workerId); job; job = await store.claimNextJob(runId, workerId)) {
    const site = config.sites[sites.findIndex((s) => s.companyId === job!.company_id)];
    try {
      const collector = new CompanyCollector(
        { provider, store, tracker, limiter, logger, pageTimeoutMs: config.pageTimeoutMs, maxPlpCandidates: config.maxPlpCandidates, outputDir },
        { runId, jobId: job.id, companyId: job.company_id, site, robots: robotsByCompany.get(job.company_id)! },
      );
      const result = await collector.run();
      summaries.push(...result);
      await store.completeJob(job.id, { captured: result.filter((r) => r.status === "captured").length, slots: result.length });
    } catch (err) {
      const msg = `${site.domain}: ${(err as Error).message}`;
      errors.push(msg);
      logger.log("error", "company.failed", { error: msg });
      await store.failJob(job.id, msg).catch(() => undefined);
    }
  }

  const evidence = await store.runEvidence(runId);
  const domainByCompany = new Map(sites.map((s) => [s.companyId, s.domain]));
  const verification = await verifyEvidence(evidence, domainByCompany, (p) => store.screenshotExists(p));

  const signedUrls = new Map<string, string>();
  for (const e of evidence) {
    for (const path of [e.screenshot_path, e.full_page_screenshot_path]) {
      if (!path) continue;
      const url = await store.signedUrl(path, SIGNED_URL_SECONDS);
      if (url) signedUrls.set(path, url);
    }
  }

  const failures = summaries.filter((s) => s.status !== "captured").length;
  const status = errors.length
    ? "failed"
    : tracker.ceilingHit
      ? "stopped_cost_ceiling"
      : failures || !verification.allChecksPassed
        ? "completed_with_failures"
        : "completed";
  const endedAt = new Date().toISOString();

  const { mdPath } = writeReports({
    runId,
    status,
    startedAt,
    endedAt,
    workerVersion,
    provider: provider.name,
    unitPriceUsd: config.unitPriceUsd,
    maxRunUnits: config.maxRunUnits,
    maxRunCostUsd: config.maxRunCostUsd,
    tracker,
    sites,
    evidence,
    verification,
    errors,
    signedUrls,
    outputDir,
  });

  await store.finishRun(runId, {
    status,
    browser_session_seconds: tracker.sessionSeconds,
    estimated_units: tracker.estimatedUnits,
    estimated_cost_usd: tracker.estimatedCostUsd,
    cost_ceiling_hit: tracker.ceilingHit,
    summary: {
      coverage: verification.coverage,
      checks: verification.checks.map((c) => ({ name: c.name, passed: c.passed, problems: c.problems.length })),
      warnings: verification.warnings,
      evidenceRecords: evidence.length,
      costBasis: "estimate_from_measured_session_time",
    },
    errors,
  });

  logger.log("info", "run.done", { runId, status, estUnits: tracker.estimatedUnits, estCostUsd: tracker.estimatedCostUsd, report: mdPath });
  console.log(`\nReport: ${mdPath}`);
  return status === "failed" ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\nRun aborted: ${(err as Error).message}`);
    process.exit(1);
  },
);
