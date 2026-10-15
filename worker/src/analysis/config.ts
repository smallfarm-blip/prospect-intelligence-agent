import { num, required } from "../config.ts";

export interface ModelPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export interface ModelSettings {
  provider: "anthropic";
  model: string;
  pricing: ModelPricing;
  maxOutputTokens: number;
}

export interface AnalysisLimits {
  budgetUsd: number;
  /** Extra share added to the pre-call input count, because provider token counts are estimates. */
  inputCountMargin: number;
  maxImages: number;
  maxSectionsPerPage: number;
  maxPageTextChars: number;
  maxVerifierImages: number;
}

export interface AnalysisConfig {
  supabaseUrl: string;
  supabaseSecretKey: string;
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  modelTimeoutMs: number;
  analyst: ModelSettings;
  verifier: ModelSettings;
  limits: AnalysisLimits;
}

export function loadAnalysisConfig(env: NodeJS.ProcessEnv, opts: { live: boolean }): AnalysisConfig {
  const missing: string[] = [];
  const problems: string[] = [];
  const supabaseUrl = required(env, "SUPABASE_URL", missing);
  const supabaseSecretKey = required(env, "SUPABASE_SECRET_KEY", missing);
  const anthropicApiKey = opts.live ? required(env, "ANTHROPIC_API_KEY", missing) : env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (supabaseSecretKey.startsWith("sb_publishable_")) {
    problems.push("SUPABASE_SECRET_KEY holds a publishable key; the worker needs the secret key (sb_secret_...)");
  }

  const model = (prefix: "ANALYST" | "VERIFIER", maxOut: number): ModelSettings => ({
    provider: "anthropic",
    model: env[`${prefix}_MODEL`]?.trim() || "claude-sonnet-5-5",
    pricing: {
      inputUsdPerMTok: num(env, `${prefix}_INPUT_USD_PER_MTOK`, 2, problems),
      outputUsdPerMTok: num(env, `${prefix}_OUTPUT_USD_PER_MTOK`, 10, problems),
    },
    maxOutputTokens: num(env, `${prefix}_MAX_OUTPUT_TOKENS`, maxOut, problems),
  });

  const config: AnalysisConfig = {
    supabaseUrl,
    supabaseSecretKey,
    anthropicApiKey,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com",
    modelTimeoutMs: num(env, "MODEL_TIMEOUT_MS", 180_000, problems),
    analyst: model("ANALYST", 12_000),
    verifier: model("VERIFIER", 4_000),
    limits: {
      budgetUsd: num(env, "ANALYSIS_BUDGET_USD", 2.5, problems),
      inputCountMargin: num(env, "ANALYSIS_INPUT_COUNT_MARGIN", 0.1, problems),
      maxImages: num(env, "ANALYSIS_MAX_IMAGES", 40, problems),
      maxSectionsPerPage: num(env, "ANALYSIS_MAX_SECTIONS_PER_PAGE", 4, problems),
      maxPageTextChars: num(env, "ANALYSIS_MAX_PAGE_TEXT_CHARS", 6000, problems),
      maxVerifierImages: num(env, "VERIFIER_MAX_IMAGES", 8, problems),
    },
  };
  if (config.limits.budgetUsd <= 0) problems.push("ANALYSIS_BUDGET_USD must be greater than 0");

  if (missing.length) problems.unshift(`Missing required settings: ${missing.join(", ")}`);
  if (problems.length) throw new Error(`Configuration problems:\n- ${problems.join("\n- ")}\nSee .env.example.`);
  return config;
}
