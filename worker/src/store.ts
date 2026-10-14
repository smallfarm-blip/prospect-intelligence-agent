import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SiteConfig } from "./config.ts";
import type { AccessStatus, PageSignals } from "./capture.ts";

export const SCREENSHOT_BUCKET = "evidence-screenshots";
export const COLLECT_STAGE = "collect_pages";

export interface EvidenceRow {
  research_run_id: string;
  company_id: string;
  job_id: string;
  page_type: "homepage" | "plp" | "pdp";
  page_slot: string;
  requested_url: string | null;
  final_url: string | null;
  viewport_name: "desktop" | "mobile";
  viewport_width: number;
  viewport_height: number;
  user_agent: string | null;
  captured_at: string;
  access_status: AccessStatus;
  http_status: number | null;
  page_title: string | null;
  screenshot_path: string | null;
  full_page_screenshot_path: string | null;
  extracted_text: string | null;
  extracted_text_length: number | null;
  content_hash: string | null;
  discovery_method: string | null;
  discovered_from_url: string | null;
  page_type_signals: PageSignals | Record<string, never>;
  navigation_notes: string | null;
  error_message: string | null;
  load_duration_ms: number | null;
}

export interface StoredEvidence extends EvidenceRow {
  id: string;
}

export interface JobRow {
  id: string;
  company_id: string;
  attempts: number;
}

function check<T>(result: { data: T; error: { message: string } | null }, action: string): T {
  if (result.error) throw new Error(`${action} failed: ${result.error.message}`);
  return result.data;
}

function checkRow<T>(result: { data: T; error: { message: string } | null }, action: string): NonNullable<T> {
  const data = check(result, action);
  if (data === null || data === undefined) throw new Error(`${action} failed: no row returned`);
  return data;
}

export class EvidenceStore {
  private readonly db: SupabaseClient;

  constructor(url: string, secretKey: string) {
    this.db = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async preflight(): Promise<void> {
    check(await this.db.from("research_runs").select("id").limit(1), "Database access check (is the secret key correct?)");
    check(await this.db.storage.from(SCREENSHOT_BUCKET).list("", { limit: 1 }), "Screenshot storage access check");
  }

  async reclaimStaleJobs(minutes: number): Promise<number> {
    return check(await this.db.rpc("reclaim_stale_jobs", { p_timeout_minutes: minutes }), "Reclaim stale jobs") as number;
  }

  async createRun(row: {
    id: string;
    worker_version: string;
    worker_host: string;
    config: Record<string, unknown>;
    browser_provider: string;
    cost_ceiling_usd: number;
  }): Promise<void> {
    check(await this.db.from("research_runs").insert(row), "Create run");
  }

  async finishRun(id: string, fields: Record<string, unknown>): Promise<void> {
    check(await this.db.from("research_runs").update({ ...fields, ended_at: new Date().toISOString() }).eq("id", id), "Finish run");
  }

  async upsertCompany(site: SiteConfig): Promise<string> {
    const data = checkRow(
      await this.db
        .from("companies")
        .upsert(
          {
            name: site.name,
            canonical_domain: site.domain,
            category: site.category,
            geography: site.geography,
            source: "spike_manual_selection",
            source_notes: "Selected for Phase 0 capture feasibility; ICP fit not assessed.",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "canonical_domain" },
        )
        .select("id")
        .single(),
      `Save company ${site.domain}`,
    );
    return data.id as string;
  }

  async createJob(runId: string, companyId: string): Promise<void> {
    check(
      await this.db.from("research_jobs").insert({ research_run_id: runId, company_id: companyId, stage: COLLECT_STAGE, max_attempts: 1 }),
      "Create job",
    );
  }

  async claimNextJob(runId: string, workerId: string): Promise<JobRow | null> {
    const rows = check(
      await this.db.rpc("claim_next_job", { p_run_id: runId, p_stage: COLLECT_STAGE, p_worker_id: workerId }),
      "Claim job",
    ) as JobRow[] | null;
    return rows && rows.length ? rows[0] : null;
  }

  async completeJob(jobId: string, result: Record<string, unknown>): Promise<void> {
    check(await this.db.rpc("complete_job", { p_job_id: jobId, p_result: result }), "Complete job");
  }

  async failJob(jobId: string, message: string): Promise<void> {
    check(await this.db.rpc("fail_job", { p_job_id: jobId, p_error: message }), "Fail job");
  }

  async uploadScreenshot(path: string, body: Buffer, contentType: string): Promise<string> {
    check(await this.db.storage.from(SCREENSHOT_BUCKET).upload(path, body, { contentType, upsert: false }), `Upload ${path}`);
    return path;
  }

  async insertEvidence(row: EvidenceRow): Promise<string> {
    const data = checkRow(await this.db.from("page_evidence").insert(row).select("id").single(), "Save evidence");
    return data.id as string;
  }

  async runEvidence(runId: string): Promise<StoredEvidence[]> {
    return check(
      await this.db.from("page_evidence").select("*").eq("research_run_id", runId).order("created_at"),
      "Load run evidence",
    ) as StoredEvidence[];
  }

  async screenshotExists(path: string): Promise<boolean> {
    const slash = path.lastIndexOf("/");
    const { data, error } = await this.db.storage
      .from(SCREENSHOT_BUCKET)
      .list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 10 });
    return !error && !!data?.some((f) => f.name === path.slice(slash + 1));
  }

  async signedUrl(path: string, expiresInSeconds: number): Promise<string | null> {
    const { data, error } = await this.db.storage.from(SCREENSHOT_BUCKET).createSignedUrl(path, expiresInSeconds);
    return error ? null : data.signedUrl;
  }
}
