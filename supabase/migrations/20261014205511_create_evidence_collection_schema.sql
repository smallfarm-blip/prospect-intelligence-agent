/*
# Evidence collection schema (Phase 0 spike)

## Plain-English summary
Creates the private tables that the external research worker uses to record
research runs, the companies it visits, the work items it claims, and every
page capture (screenshot + metadata) it produces. All tables are private:
row level security is ON and NO policies are granted to anonymous or signed-in
browser users. Only trusted server-side code using the project's secret key
can read or write. A future dashboard will get access through sign-in policies.

## 1. New tables
- `companies`: one row per target brand (name, canonical domain unique, category,
  geography, discovery source, revenue band + revenue_status verified/estimated/unknown,
  exclusion flags).
- `research_runs`: one row per worker execution (status, worker version, config,
  measured browser session seconds, estimated units/cost, cost ceiling, summary, errors).
- `research_jobs`: claimable work items (run, company, stage, status, attempts,
  claimed_by, claimed_at, result, error). Unique per run + company + stage.
- `page_evidence`: one row per page capture attempt per viewport. Includes
  research_run_id, company, job, page type/slot, requested + final URL, viewport
  name/width/height, user agent, captured_at, access_status, HTTP status, title,
  screenshot paths, extracted text excerpt, content hash, discovery method/source,
  page-type signals, navigation notes, error message, load duration.

## 2. Security
- RLS enabled on all four tables, no policies => no anon/authenticated access.
- Table privileges for anon/authenticated revoked explicitly.

## 3. Important notes
1. access_status `not_observed` means the worker could not find/reach a page of that
   type. It never means the page or feature does not exist.
2. Evidence rows are append-only per run so runs can be compared over time.
*/

CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  canonical_domain text NOT NULL UNIQUE,
  category text,
  geography text,
  source text NOT NULL,
  source_notes text,
  revenue_band text,
  revenue_status text NOT NULL DEFAULT 'unknown' CHECK (revenue_status IN ('verified','estimated','unknown')),
  revenue_source_url text,
  exclusion_flags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS research_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','completed_with_failures','stopped_cost_ceiling','failed')),
  worker_version text NOT NULL,
  worker_host text,
  config jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  browser_provider text NOT NULL,
  browser_session_seconds numeric NOT NULL DEFAULT 0,
  estimated_units integer NOT NULL DEFAULT 0,
  estimated_cost_usd numeric NOT NULL DEFAULT 0,
  actual_units integer,
  cost_ceiling_usd numeric NOT NULL,
  cost_ceiling_hit boolean NOT NULL DEFAULT false,
  model_cost_usd numeric NOT NULL DEFAULT 0,
  summary jsonb NOT NULL DEFAULT '{}',
  errors jsonb NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS research_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stage text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 2,
  claimed_by text,
  claimed_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (research_run_id, company_id, stage)
);

CREATE TABLE IF NOT EXISTS page_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_id uuid REFERENCES research_jobs(id) ON DELETE SET NULL,
  page_type text NOT NULL CHECK (page_type IN ('homepage','plp','pdp')),
  page_slot text NOT NULL,
  requested_url text,
  final_url text,
  viewport_name text NOT NULL CHECK (viewport_name IN ('desktop','mobile')),
  viewport_width integer NOT NULL,
  viewport_height integer NOT NULL,
  user_agent text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  access_status text NOT NULL CHECK (access_status IN ('captured','blocked','timeout','error','not_observed','disallowed_by_robots','skipped_cost_ceiling')),
  http_status integer,
  page_title text,
  screenshot_path text,
  full_page_screenshot_path text,
  extracted_text text,
  extracted_text_length integer,
  content_hash text,
  discovery_method text,
  discovered_from_url text,
  page_type_signals jsonb NOT NULL DEFAULT '{}',
  navigation_notes text,
  error_message text,
  load_duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_page_evidence_run ON page_evidence(research_run_id);
CREATE INDEX IF NOT EXISTS idx_page_evidence_company ON page_evidence(company_id);
CREATE INDEX IF NOT EXISTS idx_page_evidence_status ON page_evidence(access_status);
CREATE INDEX IF NOT EXISTS idx_research_jobs_status ON research_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_research_jobs_company ON research_jobs(company_id);

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_evidence ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON companies, research_runs, research_jobs, page_evidence FROM anon, authenticated;
