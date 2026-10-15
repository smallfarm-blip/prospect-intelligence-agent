import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLogger } from "../logger.ts";
import { AnalysisStore } from "./analysisStore.ts";
import { AnthropicClient } from "./anthropic.ts";
import { worstCaseUsd } from "./budget.ts";
import { loadAnalysisConfig } from "./config.ts";
import { analystContent } from "./context.ts";
import { loadEvidencePack } from "./evidence.ts";
import { estimateInputTokens } from "./model.ts";
import { runAnalysis } from "./pipeline.ts";
import { ANALYST_SYSTEM } from "./prompts.ts";
import { AnalystOutputSchema, toolSchema } from "./schemas.ts";

const USAGE = `Usage:
  npm run analyse -- --run <research run id or 8-char prefix> --company <domain>            (free: prepares evidence, prints estimate)
  npm run analyse -- --run <id> --company <domain> --live [--revise]                         (PAID: calls the model)`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { run: { type: "string" }, company: { type: "string" }, live: { type: "boolean", default: false }, revise: { type: "boolean", default: false } },
  });
  if (!values.run || !values.company) {
    console.error(USAGE);
    return 2;
  }
  const config = loadAnalysisConfig(process.env, { live: values.live });
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { name: string; version: string };
  const logger = createLogger(join(resolve("output"), "analysis", `${new Date().toISOString().replace(/[:.]/g, "-")}.log.jsonl`));
  const store = new AnalysisStore(config.supabaseUrl, config.supabaseSecretKey);
  await store.preflight();

  const researchRunId = await store.resolveResearchRun(values.run);
  const pack = await loadEvidencePack(store, { researchRunId, companyDomain: values.company }, config.limits);
  const imageTokens = pack.images.reduce((s, i) => s + i.estimatedTokens, 0);
  const estInput = estimateInputTokens({
    system: ANALYST_SYSTEM,
    content: analystContent(pack),
    tool: { name: "x", description: "", inputSchema: toolSchema(AnalystOutputSchema) },
  });
  logger.log("info", "evidence_prepared", {
    researchRunId,
    company: pack.company.domain,
    pages: pack.pages.length,
    images: pack.images.length,
    imageTokens,
    skipped: pack.skipped.length,
    unanalysed: pack.unanalysed.length,
  });
  for (const w of pack.warnings) logger.log("warn", "evidence_warning", { warning: w });
  const analystWorst = worstCaseUsd(config.analyst.pricing, estInput, config.limits.inputCountMargin, config.analyst.maxOutputTokens);
  logger.log("info", "estimate", {
    analystInputTokensApprox: estInput,
    analystWorstCaseUsd: analystWorst.toFixed(3),
    budgetUsd: config.limits.budgetUsd,
    note: "Live runs count tokens with the provider before every call and refuse any call whose worst case would exceed the budget.",
  });

  if (!values.live) {
    logger.log("info", "dry_run_complete", { note: "No model was called and nothing was written. Add --live to run the paid analysis." });
    return 0;
  }

  const client = new AnthropicClient({ apiKey: config.anthropicApiKey, baseUrl: config.anthropicBaseUrl, timeoutMs: config.modelTimeoutMs });
  const result = await runAnalysis(pack, client, store, {
    analyst: config.analyst,
    verifier: config.verifier,
    limits: config.limits,
    workerVersion: `${pkg.name}@${pkg.version}`,
    revise: values.revise,
    log: (event, data) => logger.log("info", event, data),
  });
  logger.log(result.status === "completed" ? "info" : "warn", "analysis_finished", {
    analysisRunId: result.analysisRunId,
    status: result.status,
    findings: result.findings.map((f) => `${f.ref}:${f.status}`),
    estimatedCostUsd: result.spentUsd.toFixed(4),
    modelCalls: result.calls,
  });
  for (const e of result.errors) logger.log("warn", "analysis_issue", { issue: e });
  return result.status === "failed" ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
