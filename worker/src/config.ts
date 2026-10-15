import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeDomain } from "./url.ts";

export interface SiteConfig {
  name: string;
  domain: string;
  category: string;
  geography: string;
  fallback: { plp: string | null; pdps: string[] };
}

export interface WorkerConfig {
  supabaseUrl: string;
  supabaseSecretKey: string;
  browserlessToken: string;
  browserlessEndpoint: string;
  sessionTimeoutMs: number;
  unitPriceUsd: number;
  maxRunUnits: number;
  maxRunCostUsd: number;
  rateLimitMs: number;
  pageTimeoutMs: number;
  maxPlpCandidates: number;
  jobStaleMinutes: number;
  sitesFile: string;
  sites: SiteConfig[];
}

const DENYLISTED_CATEGORIES = ["jewelry", "jewellery"];

export function required(env: NodeJS.ProcessEnv, key: string, missing: string[]): string {
  const value = env[key]?.trim();
  if (!value) missing.push(key);
  return value ?? "";
}

export function num(env: NodeJS.ProcessEnv, key: string, fallback: number, problems: string[]): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) problems.push(`${key} must be a non-negative number`);
  return n;
}

export function parseSites(raw: unknown): SiteConfig[] {
  const list = (raw as { sites?: unknown })?.sites;
  if (!Array.isArray(list) || list.length === 0) throw new Error("Sites file must contain a non-empty 'sites' array");
  return list.map((s, i) => {
    const site = s as Partial<SiteConfig>;
    if (!site.name || !site.domain || !site.category) {
      throw new Error(`Site #${i + 1} needs name, domain and category`);
    }
    if (DENYLISTED_CATEGORIES.includes(site.category.toLowerCase())) {
      throw new Error(`Site ${site.name} is in an excluded category (${site.category})`);
    }
    return {
      name: site.name,
      domain: normalizeDomain(site.domain),
      category: site.category,
      geography: site.geography ?? "unknown",
      fallback: { plp: site.fallback?.plp ?? null, pdps: site.fallback?.pdps ?? [] },
    };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const missing: string[] = [];
  const problems: string[] = [];
  const supabaseUrl = required(env, "SUPABASE_URL", missing);
  const supabaseSecretKey = required(env, "SUPABASE_SECRET_KEY", missing);
  const browserlessToken = required(env, "BROWSERLESS_TOKEN", missing);

  if (supabaseSecretKey.startsWith("sb_publishable_")) {
    problems.push("SUPABASE_SECRET_KEY holds a publishable key; the worker needs the secret key (sb_secret_...)");
  }

  const config: WorkerConfig = {
    supabaseUrl,
    supabaseSecretKey,
    browserlessToken,
    browserlessEndpoint: env.BROWSERLESS_ENDPOINT?.trim() || "wss://production-sfo.browserless.io",
    sessionTimeoutMs: num(env, "BROWSERLESS_SESSION_TIMEOUT_MS", 110_000, problems),
    unitPriceUsd: num(env, "BROWSERLESS_UNIT_PRICE_USD", 0.002, problems),
    maxRunUnits: num(env, "MAX_RUN_UNITS", 150, problems),
    maxRunCostUsd: num(env, "MAX_RUN_COST_USD", 1, problems),
    rateLimitMs: num(env, "RATE_LIMIT_MS", 4000, problems),
    pageTimeoutMs: num(env, "PAGE_TIMEOUT_MS", 30_000, problems),
    maxPlpCandidates: num(env, "MAX_PLP_CANDIDATES", 3, problems),
    jobStaleMinutes: num(env, "JOB_STALE_MINUTES", 30, problems),
    sitesFile: env.SITES_FILE?.trim() || "config/spike-sites.json",
    sites: [],
  };

  if (missing.length) problems.unshift(`Missing required settings: ${missing.join(", ")}`);
  if (problems.length) throw new Error(`Configuration problems:\n- ${problems.join("\n- ")}\nSee .env.example.`);

  config.sites = parseSites(JSON.parse(readFileSync(resolve(config.sitesFile), "utf8")));
  return config;
}
