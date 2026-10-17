import type { ProspectScore, ProspectScoreInput } from "./scoring.ts";
import type { ProviderCallRecord } from "./spend.ts";
import type { DecisionMaker, Fact, Signal } from "./types.ts";

export interface CompanyRow {
  id: string;
  name: string;
  domain: string;
}

export interface ScreeningTarget extends CompanyRow {
  description: string | null;
}

export interface ScoringSubject extends CompanyRow {
  input: ProspectScoreInput;
}

export interface NewSource {
  companyId: string;
  providerCallId: string | null;
  kind: "discovery_result" | "news" | "company_site" | "person_profile";
  url: string | null;
  title: string | null;
  publishedAt: string | null;
  excerpt: string | null;
  rank: number | null;
  outcome: "new" | "duplicate" | "excluded" | null;
  providerRecord: Record<string, unknown> | null;
}

export interface NewFact extends Fact {
  providerCallId: string | null;
}

export interface NewSignal extends Signal {
  providerCallId: string | null;
  model: string;
  promptVersion: string;
}

export interface NewDecisionMaker extends Omit<DecisionMaker, "review"> {
  provider: string;
  providerCallId: string | null;
}

export interface NewProspect {
  name: string;
  domain: string;
  origin: "exa_discovery" | "provider_discovery";
  pilot: string;
  runId: string;
  description: string | null;
  geography: string | null;
  excludedReason: string | null;
  excludedRule: string | null;
}

export interface RunStart {
  pilot: string;
  mode: "trial" | "discover" | "screen";
  provider: string;
  budgetUsd: number;
  config: Record<string, unknown>;
  workerVersion: string;
}

export interface RunFinish {
  status: "completed" | "stopped_budget" | "failed";
  spentUsd: number;
  summary: Record<string, unknown>;
}

/** Pilot-level records the report needs, already joined per company. */
export interface PilotCompany extends CompanyRow {
  origin: string;
  excludedReason: string | null;
  score: Pick<ProspectScore, "evidenceScore" | "potentialMax" | "fitStatus" | "confidence" | "coverage" | "unresolved" | "reasonsToInvestigate" | "recommendedAction"> | null;
  scoreOverride: number | null;
  fitOverride: string | null;
  latestDecision: string | null;
  reviewSeconds: number[];
  decisionMakers: { possible: number; confirmed: number };
  verifiedIndependentTraits: number;
  discoveredByCallIds: string[];
}

export interface PilotCall {
  id: string;
  operation: string;
  method: string;
  query: string | null;
  status: string;
  resultCount: number | null;
  actualCostUsd: number;
  costBasis: string;
}

export interface PilotData {
  pilot: string;
  companies: PilotCompany[];
  calls: PilotCall[];
  sourceOutcomes: Array<{ providerCallId: string; companyId: string; outcome: string }>;
}

/** Persistence used by the prospecting pipelines. The worker writes with the server-side secret key. */
export interface ProspectStore {
  preflight(): Promise<void>;
  pilotSpendUsd(pilot: string): Promise<number>;
  startRun(run: RunStart): Promise<string>;
  finishRun(runId: string, finish: RunFinish): Promise<void>;
  recordCall(runId: string, record: ProviderCallRecord): Promise<string>;
  findCompanies(domains: string[]): Promise<Map<string, CompanyRow>>;
  createProspect(p: NewProspect): Promise<CompanyRow>;
  addSources(rows: NewSource[]): Promise<void>;
  addFacts(companyId: string, facts: NewFact[]): Promise<void>;
  screeningTargets(pilot: string, limit: number): Promise<ScreeningTarget[]>;
  addDecisionMakers(companyId: string, rows: NewDecisionMaker[]): Promise<void>;
  addSignals(companyId: string, runId: string, rows: NewSignal[]): Promise<void>;
  markScreened(companyId: string, summary: string | null): Promise<void>;
  scoringSubjects(companyIds: string[] | null): Promise<ScoringSubject[]>;
  saveScore(companyId: string, runId: string | null, score: ProspectScore): Promise<void>;
  reportData(pilot: string): Promise<PilotData>;
}
