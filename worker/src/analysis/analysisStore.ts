import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SCREENSHOT_BUCKET, type StoredEvidence } from "../store.ts";
import type { CompanyRef, EvidencePack, EvidenceSource, PackImage } from "./evidence.ts";
import { PROMPT_VERSIONS } from "./prompts.ts";
import type { AnalysisSink, CallRecord, FindingRecord, RunFinish, RunStart, VerificationRecord } from "./pipeline.ts";

function check<T>(result: { data: T; error: { message: string } | null }, action: string): T {
  if (result.error) throw new Error(`${action} failed: ${result.error.message}`);
  return result.data;
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** Reads Phase 0 evidence and writes Phase 1 analysis records with the server-side secret key. */
export class AnalysisStore implements EvidenceSource, AnalysisSink {
  private readonly db: SupabaseClient;
  private readonly imageIds = new Map<string, string>();

  constructor(url: string, secretKey: string) {
    this.db = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async preflight(): Promise<void> {
    check(await this.db.from("analysis_runs").select("id").limit(1), "Analysis schema check (is the Phase 1 migration applied and the secret key correct?)");
  }

  /** Accepts a full research run ID or the 8-character prefix used in reports. */
  async resolveResearchRun(idOrPrefix: string): Promise<string> {
    const runs = check(await this.db.from("research_runs").select("id").order("started_at", { ascending: false }).limit(500), "List research runs") as Array<{ id: string }>;
    const matches = runs.filter((r) => r.id.startsWith(idOrPrefix.toLowerCase()));
    if (matches.length !== 1) throw new Error(matches.length ? `Research run prefix ${idOrPrefix} is ambiguous` : `No research run matches ${idOrPrefix}`);
    return matches[0].id;
  }

  async findCompany(domain: string): Promise<CompanyRef | null> {
    const row = check(await this.db.from("companies").select("id, name, canonical_domain").eq("canonical_domain", domain).maybeSingle(), "Find company") as {
      id: string;
      name: string;
      canonical_domain: string;
    } | null;
    return row ? { id: row.id, name: row.name, domain: row.canonical_domain } : null;
  }

  async loadEvidence(researchRunId: string, companyId: string): Promise<StoredEvidence[]> {
    return check(
      await this.db.from("page_evidence").select("*").eq("research_run_id", researchRunId).eq("company_id", companyId).order("created_at"),
      "Load evidence",
    ) as StoredEvidence[];
  }

  async download(path: string): Promise<Buffer | null> {
    const { data, error } = await this.db.storage.from(SCREENSHOT_BUCKET).download(path);
    return error || !data ? null : Buffer.from(await data.arrayBuffer());
  }

  async createRun(row: RunStart): Promise<string> {
    const data = check(
      await this.db
        .from("analysis_runs")
        .insert({
          research_run_id: row.research_run_id,
          company_id: row.company_id,
          analyst_provider: row.analyst.provider,
          analyst_model: row.analyst.model,
          verifier_provider: row.verifier.provider,
          verifier_model: row.verifier.model,
          prompt_versions: row.prompt_versions,
          config: row.config,
          evidence_manifest: row.evidence_manifest,
          evidence_warnings: row.evidence_warnings,
          budget_usd: row.budget_usd,
          worker_version: row.worker_version,
        })
        .select("id")
        .single(),
      "Create analysis run",
    ) as { id: string };
    return data.id;
  }

  async saveImages(runId: string, images: PackImage[]): Promise<void> {
    for (const img of images) {
      const derived = `analysis/${runId}/${img.ref}.jpg`;
      check(await this.db.storage.from(SCREENSHOT_BUCKET).upload(derived, img.jpeg, { contentType: "image/jpeg", upsert: false }), `Upload ${derived}`);
      const row = check(
        await this.db
          .from("analysis_images")
          .insert({
            analysis_run_id: runId,
            ref: img.ref,
            page_evidence_id: img.evidenceId,
            capture_state: img.captureState,
            source_path: img.sourcePath,
            derived_path: derived,
            crop: img.crop,
            scaled_width: img.scaledWidth,
            scaled_height: img.scaledHeight,
            estimated_tokens: img.estimatedTokens,
            sha256: img.sha256,
          })
          .select("id")
          .single(),
        `Save image ${img.ref}`,
      ) as { id: string };
      this.imageIds.set(`${runId}:${img.ref}`, row.id);
    }
  }

  async recordCall(runId: string, c: CallRecord): Promise<string> {
    const row = check(
      await this.db
        .from("analysis_model_calls")
        .insert({
          ...c,
          analysis_run_id: runId,
          worst_case_cost_usd: c.worst_case_cost_usd === null ? null : round(c.worst_case_cost_usd),
          estimated_cost_usd: round(c.estimated_cost_usd),
        })
        .select("id")
        .single(),
      "Record model call",
    ) as { id: string };
    return row.id;
  }

  async saveFinding(runId: string, pack: EvidencePack, f: FindingRecord): Promise<string> {
    const { links, ...fields } = f;
    const row = check(
      await this.db
        .from("analysis_findings")
        .insert({ ...fields, analysis_run_id: runId, research_run_id: pack.researchRunId, company_id: pack.company.id, prompt_versions: PROMPT_VERSIONS })
        .select("id")
        .single(),
      `Save finding ${f.finding_ref}`,
    ) as { id: string };
    if (links.length) {
      check(
        await this.db.from("analysis_finding_evidence").insert(
          links.map(({ image_ref, ...l }) => ({ ...l, finding_id: row.id, analysis_image_id: image_ref ? this.imageIds.get(`${runId}:${image_ref}`) ?? null : null })),
        ),
        `Save evidence links for ${f.finding_ref}`,
      );
    }
    return row.id;
  }

  async saveVerification(findingId: string, v: VerificationRecord): Promise<void> {
    check(await this.db.from("analysis_verifications").insert({ ...v, finding_id: findingId }), "Save verification");
  }

  async finishRun(runId: string, f: RunFinish): Promise<void> {
    check(
      await this.db
        .from("analysis_runs")
        .update({ ...f, estimated_cost_usd: round(f.estimated_cost_usd), ended_at: new Date().toISOString() })
        .eq("id", runId),
      "Finish analysis run",
    );
  }
}
