import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BudgetTracker, worstCaseUsd } from "../analysis/budget.ts";
import { estimateInputTokens } from "../analysis/model.ts";
import { ESTIMATE_SAFETY_FACTOR, OpenAIClient } from "../analysis/openai.ts";
import { createLogger } from "../logger.ts";
import { normalizeDomain } from "../url.ts";
import { loadProspectingConfig, loadQueries, type ProspectingConfig } from "./config.ts";
import { runDiscovery } from "./discover.ts";
import { ExaProvider } from "./exa.ts";
import { SupabaseProspectStore } from "./prospectStore.ts";
import type { SearchRequest } from "./provider.ts";
import { computePilotReport, formatPilotReport } from "./report.ts";
import { rescore, screenCompany, screeningRequest } from "./screen.ts";
import { checkSite } from "./siteCheck.ts";
import { SpendGuard } from "./spend.ts";
import { formatTrial, runTrial, trialRequests } from "./trial.ts";

const USAGE = `Usage (every command is free unless --live is given):
  npm run prospect -- trial    [--live]                            Small Exa trial: company vs general search, people, evidence (no prospects written)
  npm run prospect -- discover [--live]                            Find up to DISCOVERY_TARGET_COMPANIES new companies
  npm run prospect -- screen   [--live] [--limit N] [--company D]  Site check, people + evidence search, AI screening, scoring
  npm run prospect -- rescore                                      Recompute scores from stored facts (free)
  npm run prospect -- report                                       Pilot report (free)`;

const TRIAL_RESULTS = 5;

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function exaProvider(config: ProspectingConfig): ExaProvider {
  return new ExaProvider({ apiKey: config.exa.apiKey, baseUrl: config.exa.baseUrl, timeoutMs: config.exa.timeoutMs, pricing: config.exa.pricing });
}

function describeRequests(provider: ExaProvider, reqs: Array<{ label: string; request: SearchRequest }>): { lines: string[]; worst: number } {
  let worst = 0;
  const lines = reqs.map(({ label, request }) => {
    const w = provider.worstCaseUsd(request);
    worst += w;
    return `  ${label.padEnd(18)} ${provider.method(request).padEnd(22)} ${request.numResults} results  worst $${w.toFixed(4)}  "${request.query.slice(0, 90)}"`;
  });
  return { lines, worst };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { live: { type: "boolean", default: false }, limit: { type: "string" }, company: { type: "string" } },
  });
  const command = positionals[0];
  if (!command || !["trial", "discover", "screen", "rescore", "report"].includes(command)) {
    console.error(USAGE);
    return 2;
  }
  const paid = command === "trial" || command === "discover" || command === "screen";
  const config = loadProspectingConfig(process.env, { live: values.live && paid, needsExa: paid, needsModel: command === "screen" });
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { name: string; version: string };
  const workerVersion = `${pkg.name}@${pkg.version}`;
  const outDir = resolve("output", "prospecting");
  mkdirSync(outDir, { recursive: true });
  const logger = createLogger(join(outDir, `${stamp()}-${command}.log.jsonl`));
  const store = new SupabaseProspectStore(config.supabaseUrl, config.supabaseSecretKey);
  await store.preflight();

  if (command === "rescore") {
    const n = await rescore(store, null, null);
    logger.log("info", "rescored", { companies: n });
    return 0;
  }
  if (command === "report") {
    const report = computePilotReport(await store.reportData(config.pilot));
    const text = formatPilotReport(report);
    const path = join(outDir, `report-${config.pilot}.md`);
    writeFileSync(path, text);
    writeFileSync(join(outDir, `report-${config.pilot}.json`), JSON.stringify(report, null, 2));
    console.log(text);
    logger.log("info", "report_written", { path });
    return 0;
  }

  const priorSpend = await store.pilotSpendUsd(config.pilot);
  const remaining = Math.max(0, config.budgetUsd - priorSpend);
  const budgetUsd = command === "trial" ? Math.min(config.trialBudgetUsd, remaining) : remaining;
  logger.log("info", "budget", { pilot: config.pilot, capUsd: config.budgetUsd, priorSpendUsd: Number(priorSpend.toFixed(4)), thisRunBudgetUsd: Number(budgetUsd.toFixed(4)) });
  if (budgetUsd <= 0) {
    logger.log("warn", "budget_exhausted", { note: `The $${config.budgetUsd.toFixed(2)} pilot cap is used up; nothing was called.` });
    return 1;
  }
  const provider = exaProvider(config);
  const queries = loadQueries(config.queriesFile);

  if (command === "trial") {
    const plan = { calibrationQueries: queries.calibration, numResults: TRIAL_RESULTS, sampleCompany: queries.sampleCompany };
    const { lines, worst } = describeRequests(provider, trialRequests(plan));
    console.log(`Trial plan (${lines.length} Exa calls, worst case $${worst.toFixed(4)}, budget $${budgetUsd.toFixed(2)}):\n${lines.join("\n")}`);
    if (!values.live) {
      logger.log("info", "dry_run_complete", { note: "Nothing was called. Add --live to run the trial." });
      return 0;
    }
    const runId = await store.startRun({ pilot: config.pilot, mode: "trial", provider: provider.name, budgetUsd, config: { plan, pricing: config.exa.pricing }, workerVersion });
    const guard = new SpendGuard(new BudgetTracker(budgetUsd), (r) => store.recordCall(runId, r));
    const report = await runTrial(provider, guard, plan);
    const { raw, ...summary } = report;
    writeFileSync(join(outDir, `${stamp()}-trial.json`), JSON.stringify(report, null, 2));
    const refused = report.calls.some((c) => c.error?.startsWith("Refused"));
    await store.finishRun(runId, { status: refused ? "stopped_budget" : "completed", spentUsd: guard.budget.spentUsd, summary: { ...summary, rawResponses: raw.length } });
    console.log(formatTrial(report, budgetUsd, guard.budget.spentUsd));
    return report.calls.every((c) => !c.ok) ? 1 : 0;
  }

  if (command === "discover") {
    const reqs = queries.discovery.map((q) => ({ label: q.id, request: { operation: q.operation, query: q.query, numResults: config.resultsPerQuery } as SearchRequest }));
    const { lines, worst } = describeRequests(provider, reqs);
    console.log(`Discovery plan: up to ${config.targetCompanies} new companies, ${lines.length} queries (worst case $${worst.toFixed(4)} if all run), budget $${budgetUsd.toFixed(2)}:\n${lines.join("\n")}`);
    if (!values.live) {
      logger.log("info", "dry_run_complete", { note: "Nothing was called. Add --live to run discovery." });
      return 0;
    }
    const runId = await store.startRun({ pilot: config.pilot, mode: "discover", provider: provider.name, budgetUsd, config: { targetCompanies: config.targetCompanies, resultsPerQuery: config.resultsPerQuery, queries: queries.discovery }, workerVersion });
    const guard = new SpendGuard(new BudgetTracker(budgetUsd), (r) => store.recordCall(runId, r));
    try {
      const summary = await runDiscovery({ provider, guard, store, logger, runId, pilot: config.pilot }, queries.discovery, { numResults: config.resultsPerQuery, targetCompanies: config.targetCompanies });
      const scored = await rescore(store, null, runId);
      await store.finishRun(runId, { status: summary.stoppedBy === "budget" ? "stopped_budget" : "completed", spentUsd: guard.budget.spentUsd, summary: { ...summary, scored } });
      logger.log("info", "discovery_finished", { ...summary, skipped: summary.skipped.length, spentUsd: guard.budget.spentUsd.toFixed(4) });
      return 0;
    } catch (err) {
      await store.finishRun(runId, { status: "failed", spentUsd: guard.budget.spentUsd, summary: { error: (err as Error).message } });
      throw err;
    }
  }

  const limit = values.limit ? Number(values.limit) : config.screenLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("--limit must be a whole number from 1 to 25");
  let targets;
  if (values.company) {
    const domain = normalizeDomain(values.company);
    const found = (await store.findCompanies([domain])).get(domain);
    if (!found) throw new Error(`No company with domain ${domain}`);
    targets = [{ ...found, description: null }];
  } else targets = await store.screeningTargets(config.pilot, limit);
  const sampleReq = screeningRequest(config.screening, "x".repeat(config.siteMaxTextChars + 6 * 700));
  const aiWorst = worstCaseUsd(config.screening.pricing, Math.ceil(estimateInputTokens(sampleReq) * ESTIMATE_SAFETY_FACTOR), config.inputCountMargin, config.screening.maxOutputTokens);
  const searchWorst = provider.worstCaseUsd({ operation: "people_search", query: "", numResults: 5 }) + provider.worstCaseUsd({ operation: "evidence_search", query: "", numResults: 5 });
  console.log(
    `Screening plan: ${targets.length} companies, about $${(searchWorst + aiWorst).toFixed(4)} worst case each ($${searchWorst.toFixed(4)} Exa + ~$${aiWorst.toFixed(4)} ${config.screening.model}), budget $${budgetUsd.toFixed(2)}:\n${targets.map((t) => `  ${t.domain}`).join("\n") || "  (no unscreened candidates in this pilot)"}`,
  );
  if (!values.live || !targets.length) {
    logger.log("info", "dry_run_complete", { note: values.live ? "Nothing to screen." : "Nothing was called. Add --live to screen." });
    return 0;
  }
  const runId = await store.startRun({ pilot: config.pilot, mode: "screen", provider: provider.name, budgetUsd, config: { model: config.screening.model, limit, company: values.company ?? null }, workerVersion });
  const guard = new SpendGuard(new BudgetTracker(budgetUsd), (r) => store.recordCall(runId, r));
  const model = new OpenAIClient({ apiKey: config.openaiApiKey, baseUrl: config.openaiBaseUrl, timeoutMs: config.modelTimeoutMs });
  const deps = {
    provider,
    model,
    modelSettings: config.screening,
    inputCountMargin: config.inputCountMargin,
    guard,
    store,
    logger,
    runId,
    checkSite: (d: string) => checkSite(d, { timeoutMs: config.siteTimeoutMs, maxTextChars: config.siteMaxTextChars }),
  };
  let budgetStopped = false;
  const outcomes = [];
  try {
    for (const t of targets) {
      const o = await screenCompany(deps, t, { evidenceMonths: config.evidenceMonths });
      outcomes.push(o);
      if (o.refused.length) {
        budgetStopped = true;
        logger.log("warn", "screening_budget_stop", { company: t.domain, refused: o.refused });
        break;
      }
    }
    await store.finishRun(runId, { status: budgetStopped ? "stopped_budget" : "completed", spentUsd: guard.budget.spentUsd, summary: { screened: outcomes.filter((o) => o.screened).length, outcomes } });
  } catch (err) {
    await store.finishRun(runId, { status: "failed", spentUsd: guard.budget.spentUsd, summary: { error: (err as Error).message, outcomes } });
    throw err;
  }
  logger.log("info", "screening_finished", { companies: outcomes.length, screened: outcomes.filter((o) => o.screened).length, spentUsd: guard.budget.spentUsd.toFixed(4) });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
