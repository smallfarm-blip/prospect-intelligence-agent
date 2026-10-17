import { parseEnv } from "node:util";
import { num, required } from "../config.ts";

export const PROVIDERS = ["anthropic", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const IMAGE_DETAILS = ["low", "high", "auto", "original"] as const;
export type ImageDetail = (typeof IMAGE_DETAILS)[number];

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];

/** Official standard-tier prices for each provider's default model. Any other model or tier needs explicit prices. */
const DEFAULT_MODELS: Record<Provider, { model: string; inputUsdPerMTok: number; outputUsdPerMTok: number }> = {
  anthropic: { model: "claude-sonnet-5-5", inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  openai: { model: "gpt-6-sol", inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
};

export interface ModelPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export interface ModelSettings {
  provider: Provider;
  model: string;
  pricing: ModelPricing;
  maxOutputTokens: number;
  /** OpenAI only; Anthropic receives the prepared image as-is. */
  imageDetail: ImageDetail | null;
  /** OpenAI only. Reasoning tokens are billed as output and count toward maxOutputTokens. */
  reasoningEffort: string | null;
  /** OpenAI processing tier; prices must match it. */
  serviceTier: string | null;
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
  openaiApiKey: string;
  openaiBaseUrl: string;
  modelTimeoutMs: number;
  analyst: ModelSettings;
  verifier: ModelSettings;
  limits: AnalysisLimits;
}

/**
 * Overlays a model settings profile on the environment. Profiles hold model choices only;
 * credentials must stay in .env so profiles can be shared and committed.
 */
export function applySettingsProfile(env: NodeJS.ProcessEnv, profileText: string): NodeJS.ProcessEnv {
  const profile = parseEnv(profileText);
  const secrets = Object.keys(profile).filter((k) => /API_KEY|SECRET/i.test(k));
  if (secrets.length) throw new Error(`Settings profiles must not contain credentials (${secrets.join(", ")}); keep them in .env`);
  return { ...env, ...profile };
}

/** Reads `<PREFIX>_PROVIDER`, `_MODEL`, prices, output cap and OpenAI options; problems are appended to `problems`. */
export function loadModelSettings(env: NodeJS.ProcessEnv, prefix: string, maxOut: number, problems: string[], defaultProvider: Provider = "anthropic"): ModelSettings {
  const set = (key: string) => !!env[key]?.trim();
  const providerRaw = env[`${prefix}_PROVIDER`]?.trim().toLowerCase() || defaultProvider;
  const provider = (PROVIDERS as readonly string[]).includes(providerRaw) ? (providerRaw as Provider) : defaultProvider;
  if (provider !== providerRaw) problems.push(`${prefix}_PROVIDER must be one of ${PROVIDERS.join(", ")}`);
  const defaults = DEFAULT_MODELS[provider];
  const modelId = env[`${prefix}_MODEL`]?.trim() || defaults.model;

  const tier = provider === "openai" ? env[`${prefix}_SERVICE_TIER`]?.trim() || "default" : null;
  if (provider !== "openai" && set(`${prefix}_SERVICE_TIER`)) problems.push(`${prefix}_SERVICE_TIER applies to OpenAI only`);
  const pricesExplicit = set(`${prefix}_INPUT_USD_PER_MTOK`) && set(`${prefix}_OUTPUT_USD_PER_MTOK`);
  const defaultPricesApply = modelId === defaults.model && (tier === null || tier === "default");
  if (!pricesExplicit && !defaultPricesApply) {
    problems.push(`${prefix}_INPUT_USD_PER_MTOK and ${prefix}_OUTPUT_USD_PER_MTOK are required for ${modelId}${tier && tier !== "default" ? ` on the ${tier} tier` : ""}`);
  }

  let imageDetail: ImageDetail | null = null;
  if (provider === "openai") {
    const raw = env[`${prefix}_IMAGE_DETAIL`]?.trim() || "high";
    if ((IMAGE_DETAILS as readonly string[]).includes(raw)) imageDetail = raw as ImageDetail;
    else problems.push(`${prefix}_IMAGE_DETAIL must be one of ${IMAGE_DETAILS.join(", ")}`);
  } else if (set(`${prefix}_IMAGE_DETAIL`)) problems.push(`${prefix}_IMAGE_DETAIL applies to OpenAI only`);

  const effort = env[`${prefix}_REASONING_EFFORT`]?.trim() || null;
  if (effort && provider !== "openai") problems.push(`${prefix}_REASONING_EFFORT applies to OpenAI only`);
  if (effort && !REASONING_EFFORTS.includes(effort)) problems.push(`${prefix}_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(", ")}`);

  return {
    provider,
    model: modelId,
    pricing: {
      inputUsdPerMTok: num(env, `${prefix}_INPUT_USD_PER_MTOK`, defaults.inputUsdPerMTok, problems),
      outputUsdPerMTok: num(env, `${prefix}_OUTPUT_USD_PER_MTOK`, defaults.outputUsdPerMTok, problems),
    },
    maxOutputTokens: num(env, `${prefix}_MAX_OUTPUT_TOKENS`, maxOut, problems),
    imageDetail,
    reasoningEffort: provider === "openai" ? effort : null,
    serviceTier: tier,
  };
}

export function loadAnalysisConfig(env: NodeJS.ProcessEnv, opts: { live: boolean }): AnalysisConfig {
  const missing: string[] = [];
  const problems: string[] = [];
  const supabaseUrl = required(env, "SUPABASE_URL", missing);
  const supabaseSecretKey = required(env, "SUPABASE_SECRET_KEY", missing);
  if (supabaseSecretKey.startsWith("sb_publishable_")) {
    problems.push("SUPABASE_SECRET_KEY holds a publishable key; the worker needs the secret key (sb_secret_...)");
  }

  const analyst = loadModelSettings(env, "ANALYST", 12_000, problems);
  const verifier = loadModelSettings(env, "VERIFIER", 4_000, problems);
  const uses = (p: Provider) => analyst.provider === p || verifier.provider === p;
  const key = (name: string, needed: boolean) => (opts.live && needed ? required(env, name, missing) : env[name]?.trim() ?? "");

  const config: AnalysisConfig = {
    supabaseUrl,
    supabaseSecretKey,
    anthropicApiKey: key("ANTHROPIC_API_KEY", uses("anthropic")),
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com",
    openaiApiKey: key("OPENAI_API_KEY", uses("openai")),
    openaiBaseUrl: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com",
    modelTimeoutMs: num(env, "MODEL_TIMEOUT_MS", 180_000, problems),
    analyst,
    verifier,
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
