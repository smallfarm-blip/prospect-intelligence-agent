import type { z } from "zod";
import type { AnalysisLimits, ModelSettings } from "./config.ts";
import { manifestOf, type EvidencePack, type PackImage } from "./evidence.ts";
import { BudgetTracker, costUsd, worstCaseUsd } from "./budget.ts";
import { automaticChecks, combineVerdict, hasBlocker, resolveRef, type AutomaticCheck, type VerificationStatus } from "./checks.ts";
import { claimsOf } from "./claims.ts";
import { analystContent, revisionContent, verifierContent } from "./context.ts";
import { ModelCallError, type CallRole, type ContentBlock, type ModelClient } from "./model.ts";
import { ANALYST_SYSTEM, PROMPT_VERSIONS, REVISION_SYSTEM, VERIFIER_SYSTEM } from "./prompts.ts";
import {
  AnalystOutputSchema,
  RevisionOutputSchema,
  VerifierOutputSchema,
  formatIssues,
  toolSchema,
  type AnalystOutput,
  type Finding,
  type VerifierOutput,
} from "./schemas.ts";

export type CallStatus = "succeeded" | "invalid_output" | "failed" | "refused_budget";
export type RunStatus = "completed" | "stopped_budget" | "failed";

export interface CallRecord {
  role: CallRole;
  finding_ref: string | null;
  provider: string;
  model: string;
  prompt_version: string;
  max_output_tokens: number;
  counted_input_tokens: number | null;
  worst_case_cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number;
  status: CallStatus;
  stop_reason: string | null;
  latency_ms: number | null;
  output: unknown;
  validation_errors: string[];
  error: string | null;
}

export interface FindingEvidenceLink {
  fact_id: string;
  ref: string;
  page_evidence_id: string;
  image_ref: string | null;
  capture_state: string;
  viewport: string;
  url: string;
  region: unknown;
  text_excerpt: string | null;
}

export interface FindingRecord {
  finding_ref: string;
  revision_of: string | null;
  short_title: string;
  page_type: string;
  content: Finding;
  source_evidence_ids: string[];
  source_urls: string[];
  viewports: string[];
  capture_states: string[];
  confidence: Finding["confidence"];
  evidence_quality: Finding["evidence_quality"];
  analyzer_model: string;
  links: FindingEvidenceLink[];
}

export interface VerificationRecord {
  model_call_id: string | null;
  verifier_model: string | null;
  automatic_checks: AutomaticCheck[];
  claim_checks: unknown[];
  model_verdict: VerifierOutput | null;
  status: VerificationStatus;
  reason: string;
}

export interface RunStart {
  research_run_id: string;
  company_id: string;
  analyst: ModelSettings;
  verifier: ModelSettings;
  provider: string;
  prompt_versions: typeof PROMPT_VERSIONS;
  config: Record<string, unknown>;
  evidence_manifest: unknown;
  evidence_warnings: string[];
  budget_usd: number;
  worker_version: string;
}

export interface RunFinish {
  status: RunStatus;
  assessment_summary: string | null;
  no_findings_reason: string | null;
  evidence_limitations: string[];
  finding_count: number;
  estimated_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  model_call_count: number;
  errors: string[];
}

/** Where an analysis is persisted. The Supabase implementation lives in analysisStore.ts. */
export interface AnalysisSink {
  createRun(row: RunStart): Promise<string>;
  saveImages(runId: string, images: PackImage[]): Promise<void>;
  recordCall(runId: string, call: CallRecord): Promise<string>;
  saveFinding(runId: string, pack: EvidencePack, finding: FindingRecord): Promise<string>;
  saveVerification(findingId: string, v: VerificationRecord): Promise<void>;
  finishRun(runId: string, fields: RunFinish): Promise<void>;
}

export interface PipelineOptions {
  analyst: ModelSettings;
  verifier: ModelSettings;
  limits: AnalysisLimits;
  workerVersion: string;
  revise: boolean;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface PipelineResult {
  analysisRunId: string;
  status: RunStatus;
  findings: Array<{ id: string; ref: string; status: VerificationStatus | "not_verified"; revisionOf: string | null }>;
  spentUsd: number;
  calls: number;
  errors: string[];
}

class BudgetStop extends Error {}

export async function runAnalysis(pack: EvidencePack, client: ModelClient, sink: AnalysisSink, opts: PipelineOptions): Promise<PipelineResult> {
  const log = opts.log ?? (() => {});
  const budget = new BudgetTracker(opts.limits.budgetUsd);
  const errors: string[] = [];
  let calls = 0;
  const runId = await sink.createRun({
    research_run_id: pack.researchRunId,
    company_id: pack.company.id,
    analyst: opts.analyst,
    verifier: opts.verifier,
    provider: client.provider,
    prompt_versions: PROMPT_VERSIONS,
    config: { limits: opts.limits, analyst: opts.analyst, verifier: opts.verifier, revise: opts.revise },
    evidence_manifest: manifestOf(pack),
    evidence_warnings: pack.warnings,
    budget_usd: opts.limits.budgetUsd,
    worker_version: opts.workerVersion,
  });
  await sink.saveImages(runId, pack.images);

  async function call<T>(
    role: CallRole,
    findingRef: string | null,
    settings: ModelSettings,
    system: string,
    content: ContentBlock[],
    schema: z.ZodType<T>,
    extraValidation: (out: T) => string[] = () => [],
  ): Promise<{ output: T | null; callId: string; status: CallStatus }> {
    const promptVersion = PROMPT_VERSIONS[role];
    const req = {
      role,
      settings,
      system,
      content,
      tool: { name: `submit_${role}_result`, description: `Submit the ${role} result. Call exactly once.`, inputSchema: toolSchema(schema) },
    };
    const base = {
      role,
      finding_ref: findingRef,
      provider: client.provider,
      model: settings.model,
      prompt_version: promptVersion,
      max_output_tokens: settings.maxOutputTokens,
    };
    const record = async (r: Omit<CallRecord, keyof typeof base | "status">, status: CallStatus) => {
      calls++;
      const id = await sink.recordCall(runId, { ...base, ...r, status });
      log("model_call", { role, finding: findingRef, status, cost: r.estimated_cost_usd.toFixed(4), spent: budget.spentUsd.toFixed(4) });
      return id;
    };
    const empty = { input_tokens: null, output_tokens: null, stop_reason: null, latency_ms: null, output: null, validation_errors: [] };

    let counted: number;
    try {
      counted = await client.countInputTokens(req);
    } catch (err) {
      const id = await record({ ...empty, counted_input_tokens: null, worst_case_cost_usd: null, estimated_cost_usd: 0, error: `Token count failed: ${(err as Error).message}` }, "failed");
      return { output: null, callId: id, status: "failed" };
    }
    const worst = worstCaseUsd(settings.pricing, counted, opts.limits.inputCountMargin, settings.maxOutputTokens);
    if (!budget.allows(worst)) {
      const msg = `Refused: worst case $${worst.toFixed(4)} would take spend from $${budget.spentUsd.toFixed(4)} past the $${budget.budgetUsd.toFixed(2)} budget`;
      await record({ ...empty, counted_input_tokens: counted, worst_case_cost_usd: worst, estimated_cost_usd: 0, error: msg }, "refused_budget");
      errors.push(msg);
      throw new BudgetStop(msg);
    }

    try {
      const res = await client.complete(req);
      const cost = costUsd(settings.pricing, res.inputTokens, res.outputTokens);
      budget.recordUsage(cost, res.inputTokens, res.outputTokens);
      const usage = {
        counted_input_tokens: counted,
        worst_case_cost_usd: worst,
        input_tokens: res.inputTokens,
        output_tokens: res.outputTokens,
        estimated_cost_usd: cost,
        stop_reason: res.stopReason,
        latency_ms: res.latencyMs,
      };
      let problems: string[] = [];
      let output: T | null = null;
      if (res.stopReason === "max_tokens") problems.push(`Output stopped at the ${settings.maxOutputTokens}-token limit and is incomplete`);
      if (res.toolInput === null || res.toolInput === undefined) problems.push("The model did not call the result tool");
      if (!problems.length) {
        const parsed = schema.safeParse(res.toolInput);
        if (parsed.success) {
          problems = extraValidation(parsed.data);
          if (!problems.length) output = parsed.data;
        } else problems = formatIssues(parsed.error);
      }
      const status: CallStatus = output ? "succeeded" : "invalid_output";
      const id = await record({ ...usage, output: res.toolInput ?? null, validation_errors: problems, error: null }, status);
      return { output, callId: id, status };
    } catch (err) {
      const e = err instanceof ModelCallError ? err : new ModelCallError("network", (err as Error).message);
      if (e.possiblyBilled) budget.recordUncertain(worst);
      const note = e.possiblyBilled ? " Billing unknown; the worst case was counted against the budget." : "";
      const id = await record(
        { ...empty, counted_input_tokens: counted, worst_case_cost_usd: worst, estimated_cost_usd: e.possiblyBilled ? worst : 0, error: `${e.kind}: ${e.message}.${note}` },
        "failed",
      );
      return { output: null, callId: id, status: "failed" };
    }
  }

  const findings: PipelineResult["findings"] = [];
  let analysis: AnalystOutput | null = null;
  let status: RunStatus = "completed";

  async function verify(finding: Finding, findingId: string): Promise<{ status: VerificationStatus | "not_verified"; verdict: VerifierOutput | null; reason: string }> {
    const checks = automaticChecks(finding, pack);
    const claims = claimsOf(finding);
    if (hasBlocker(checks)) {
      const combined = combineVerdict(checks, claims, null);
      await sink.saveVerification(findingId, { model_call_id: null, verifier_model: null, automatic_checks: checks, claim_checks: [], model_verdict: null, ...combined });
      return { status: combined.status, verdict: null, reason: combined.reason };
    }
    const ids = new Set(claims.map((c) => c.id));
    const res = await call("verifier", finding.finding_ref, opts.verifier, VERIFIER_SYSTEM, verifierContent(pack, finding, claims, opts.limits), VerifierOutputSchema, (out) => {
      const seen = new Set(out.claim_checks.map((c) => c.claim_id));
      const missing = [...ids].filter((id) => !seen.has(id));
      return missing.length ? [`No verdict for claim(s) ${missing.join(", ")}`] : [];
    });
    if (!res.output) {
      errors.push(`Verifier ${res.status} for ${finding.finding_ref}; finding left unverified`);
      return { status: "not_verified", verdict: null, reason: "Verifier did not return a valid result" };
    }
    const combined = combineVerdict(checks, claims, res.output);
    await sink.saveVerification(findingId, {
      model_call_id: res.callId,
      verifier_model: opts.verifier.model,
      automatic_checks: checks,
      claim_checks: res.output.claim_checks.map((cc) => ({ ...cc, claim: claims.find((c) => c.id === cc.claim_id) ?? null })),
      model_verdict: res.output,
      ...combined,
    });
    return { status: combined.status, verdict: res.output, reason: combined.reason };
  }

  try {
    let result = await call("analyst", null, opts.analyst, ANALYST_SYSTEM, analystContent(pack), AnalystOutputSchema);
    if (result.status === "invalid_output") {
      log("analyst_retry", { reason: "invalid output" });
      const retryContent: ContentBlock[] = [
        ...analystContent(pack),
        { type: "text", text: "A previous attempt returned output that failed validation. Follow the tool schema exactly." },
      ];
      result = await call("analyst", null, opts.analyst, ANALYST_SYSTEM, retryContent, AnalystOutputSchema);
    }
    if (!result.output) {
      status = "failed";
      errors.push(`Analyst ${result.status}; no findings produced`);
    } else {
      analysis = result.output;
      for (const finding of analysis.findings) {
        const id = await sink.saveFinding(runId, pack, findingRecord(finding, null, pack, opts.analyst.model));
        const entry: PipelineResult["findings"][number] = { id, ref: finding.finding_ref, status: "not_verified", revisionOf: null };
        findings.push(entry);
        const v = await verify(finding, id);
        entry.status = v.status;

        if (opts.revise && v.status === "needs_revision" && v.verdict) {
          const rev = await call("revision", finding.finding_ref, opts.analyst, REVISION_SYSTEM, revisionContent(pack, finding, v.verdict, v.reason, opts.limits), RevisionOutputSchema, (out) =>
            out.revised && !out.finding ? ["revised is true but no finding was returned"] : !out.revised && !out.withdrawal_reason ? ["withdrawal_reason is required when not revised"] : [],
          );
          if (rev.output?.revised && rev.output.finding) {
            const revised = { ...rev.output.finding, finding_ref: finding.finding_ref };
            const revId = await sink.saveFinding(runId, pack, findingRecord(revised, id, pack, opts.analyst.model));
            const revEntry: PipelineResult["findings"][number] = { id: revId, ref: `${finding.finding_ref}-r1`, status: "not_verified", revisionOf: id };
            findings.push(revEntry);
            revEntry.status = (await verify(revised, revId)).status;
          } else if (rev.output) {
            log("revision_withdrawn", { finding: finding.finding_ref, reason: rev.output.withdrawal_reason });
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof BudgetStop) status = "stopped_budget";
    else {
      status = "failed";
      errors.push(`Unexpected error: ${(err as Error).message}`);
    }
  }

  await sink.finishRun(runId, {
    status,
    assessment_summary: analysis?.assessment_summary ?? null,
    no_findings_reason: analysis?.no_findings_reason ?? null,
    evidence_limitations: analysis?.evidence_limitations ?? [],
    finding_count: findings.length,
    estimated_cost_usd: budget.spentUsd,
    input_tokens: budget.inputTokens,
    output_tokens: budget.outputTokens,
    model_call_count: calls,
    errors,
  });
  return { analysisRunId: runId, status, findings, spentUsd: budget.spentUsd, calls, errors };
}

export function findingRecord(f: Finding, revisionOf: string | null, pack: EvidencePack, model: string): FindingRecord {
  const links: FindingEvidenceLink[] = [];
  for (const fact of f.observed_facts) {
    for (const ref of fact.evidence_refs) {
      const r = resolveRef(pack, ref);
      if (!r) continue;
      links.push({
        fact_id: fact.fact_id,
        ref,
        page_evidence_id: r.page.evidenceId,
        image_ref: r.image?.ref ?? null,
        capture_state: r.image?.captureState ?? "extracted_text",
        viewport: r.page.viewport,
        url: r.page.url,
        region: fact.region?.image_ref === ref ? fact.region : null,
        text_excerpt: fact.text_excerpt,
      });
    }
  }
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    finding_ref: revisionOf ? `${f.finding_ref}-r1` : f.finding_ref,
    revision_of: revisionOf,
    short_title: f.short_title,
    page_type: f.page_type,
    content: f,
    source_evidence_ids: uniq(links.map((l) => l.page_evidence_id)),
    source_urls: uniq(links.map((l) => l.url)),
    viewports: uniq(links.map((l) => l.viewport)),
    capture_states: uniq(links.map((l) => l.capture_state)),
    confidence: f.confidence,
    evidence_quality: f.evidence_quality,
    analyzer_model: model,
    links,
  };
}
