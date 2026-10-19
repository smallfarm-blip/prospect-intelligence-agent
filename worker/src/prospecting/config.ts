import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { loadModelSettings, type ModelSettings } from "../analysis/config.ts";
import { num, required } from "../config.ts";
import { normalizeDomain } from "../url.ts";
import { DISCOVERY_SEGMENTS, type DiscoveryQuery } from "./discover.ts";
import type { ExaPricing } from "./exa.ts";

export interface ProspectingConfig {
  supabaseUrl: string;
  supabaseSecretKey: string;
  pilot: string;
  exa: { apiKey: string; baseUrl: string; timeoutMs: number; pricing: ExaPricing };
  openaiApiKey: string;
  openaiBaseUrl: string;
  modelTimeoutMs: number;
  screening: ModelSettings;
  inputCountMargin: number;
  budgetUsd: number;
  trialBudgetUsd: number;
  targetCompanies: number;
  maxSegmentShare: number;
  resultsPerQuery: number;
  screenLimit: number;
  evidenceMonths: number;
  siteTimeoutMs: number;
  siteMaxTextChars: number;
  queriesFile: string;
}

const QueriesFileSchema = z.object({
  calibration: z.array(z.string().min(5).max(300)).min(1).max(3),
  sampleCompany: z.object({ name: z.string().min(1), domain: z.string().min(3) }),
  discovery: z
    .array(z.object({ id: z.string().min(1).max(40), segment: z.enum(DISCOVERY_SEGMENTS), operation: z.enum(["company_search", "web_search"]), query: z.string().min(5).max(300) }))
    .min(1)
    .max(40),
});

export interface QueriesFile {
  calibration: string[];
  sampleCompany: { name: string; domain: string };
  discovery: DiscoveryQuery[];
}

export function loadQueries(path: string): QueriesFile {
  const parsed = QueriesFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const ids = parsed.data.discovery.map((q) => q.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${path}: discovery query ids must be unique`);
  return { ...parsed.data, sampleCompany: { name: parsed.data.sampleCompany.name, domain: normalizeDomain(parsed.data.sampleCompany.domain) } };
}

/** Exa is used only with --live; the screening model key only for live screening. */
export function loadProspectingConfig(env: NodeJS.ProcessEnv, opts: { live: boolean; needsExa: boolean; needsModel: boolean }): ProspectingConfig {
  const missing: string[] = [];
  const problems: string[] = [];
  const supabaseUrl = required(env, "SUPABASE_URL", missing);
  const supabaseSecretKey = required(env, "SUPABASE_SECRET_KEY", missing);
  if (supabaseSecretKey.startsWith("sb_publishable_")) problems.push("SUPABASE_SECRET_KEY holds a publishable key; the worker needs the secret key (sb_secret_...)");
  const key = (name: string, needed: boolean) => (opts.live && needed ? required(env, name, missing) : env[name]?.trim() ?? "");

  const screening = loadModelSettings(env, "SCREENING", 2_500, problems, "openai");
  if (screening.provider !== "openai") problems.push("SCREENING_PROVIDER must be openai (the approved screening connection)");

  const config: ProspectingConfig = {
    supabaseUrl,
    supabaseSecretKey,
    pilot: env.DISCOVERY_PILOT?.trim() || "pilot-2a",
    exa: {
      apiKey: key("EXA_API_KEY", opts.needsExa),
      baseUrl: env.EXA_BASE_URL?.trim() || "https://api.exa.ai",
      timeoutMs: num(env, "EXA_TIMEOUT_MS", 30_000, problems),
      pricing: {
        searchUsdPer1k: num(env, "EXA_SEARCH_USD_PER_1K", 7, problems),
        extraResultUsdPer1k: num(env, "EXA_EXTRA_RESULT_USD_PER_1K", 1, problems),
        contentUsdPer1kPages: num(env, "EXA_CONTENT_USD_PER_1K", 1, problems),
        includedResults: num(env, "EXA_INCLUDED_RESULTS", 10, problems),
      },
    },
    openaiApiKey: key("OPENAI_API_KEY", opts.needsModel),
    openaiBaseUrl: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com",
    modelTimeoutMs: num(env, "MODEL_TIMEOUT_MS", 180_000, problems),
    screening,
    inputCountMargin: num(env, "ANALYSIS_INPUT_COUNT_MARGIN", 0.1, problems),
    budgetUsd: num(env, "DISCOVERY_BUDGET_USD", 5, problems),
    trialBudgetUsd: num(env, "TRIAL_BUDGET_USD", 0.15, problems),
    targetCompanies: num(env, "DISCOVERY_TARGET_COMPANIES", 25, problems),
    maxSegmentShare: num(env, "DISCOVERY_MAX_SEGMENT_SHARE", 0.4, problems),
    resultsPerQuery: num(env, "DISCOVERY_RESULTS_PER_QUERY", 10, problems),
    screenLimit: num(env, "SCREENING_MAX_COMPANIES", 25, problems),
    evidenceMonths: num(env, "SCREENING_EVIDENCE_MONTHS", 18, problems),
    siteTimeoutMs: num(env, "SITE_CHECK_TIMEOUT_MS", 20_000, problems),
    siteMaxTextChars: num(env, "SITE_CHECK_MAX_TEXT_CHARS", 3_000, problems),
    queriesFile: resolve(env.DISCOVERY_QUERIES_FILE?.trim() || "config/discovery-queries.json"),
  };
  if (config.budgetUsd <= 0 || config.budgetUsd > 5) problems.push("DISCOVERY_BUDGET_USD must be greater than 0 and at most 5 (the approved cap)");
  if (config.trialBudgetUsd <= 0 || config.trialBudgetUsd > 0.5) problems.push("TRIAL_BUDGET_USD must be greater than 0 and at most 0.50");
  if (config.targetCompanies < 1 || config.targetCompanies > 25) problems.push("DISCOVERY_TARGET_COMPANIES must be between 1 and 25");
  if (config.maxSegmentShare < 0.34 || config.maxSegmentShare > 1) problems.push("DISCOVERY_MAX_SEGMENT_SHARE must be between 0.34 and 1");
  if (config.resultsPerQuery < 1 || config.resultsPerQuery > 25) problems.push("DISCOVERY_RESULTS_PER_QUERY must be between 1 and 25");

  if (missing.length) problems.unshift(`Missing required settings: ${missing.join(", ")}`);
  if (problems.length) throw new Error(`Configuration problems:\n- ${problems.join("\n- ")}\nSee .env.example.`);
  return config;
}
