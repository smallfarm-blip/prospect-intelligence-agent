/*
# Phase 1: evidence analysis, verification and human review

## Plain-English summary
Adds private records for analysing stored Phase 0 evidence with a vision model, independently
verifying every finding, and letting one approved reviewer approve, reject or request revision.
Phase 0 tables keep their columns and data; the only change to them is read-only access for
approved reviewers (see Security).

## 1. New tables
- `reviewers`: allowlist of signed-in accounts that may use the review page (user_id, note, created_at).
- `analysis_runs`: one immutable analysis of one research run + company. Models, prompt versions,
  limits, the evidence manifest (exactly what was sent), warnings, assessment summary, zero-findings
  reason, token totals, estimated cost, budget, optional billed cost entered later, errors.
- `analysis_images`: every image or full-page section sent to a model, with its reference ID, source
  evidence row, capture state, source path, derived (prepared) path, crop box in source pixels,
  scaled size, estimated tokens and hash.
- `analysis_model_calls`: one row per analyst / verifier / revision call: provider, model, prompt
  version, pre-call counted input tokens, worst-case cost, actual usage, estimated cost, status
  (succeeded, invalid_output, failed, refused_budget), validated output, validation errors, error text.
- `analysis_findings`: candidate findings. Never updated after insert (trigger enforced).
  Full validated finding in `content`, plus traceability columns derived by the worker from cited
  references (evidence IDs, URLs, viewports, capture states). `revision_of` links a revised finding.
- `analysis_finding_evidence`: one row per cited fact/evidence link (fact ID, page evidence, image
  reference, capture state, viewport, URL, region, text excerpt).
- `analysis_verifications`: verification results per finding (automatic checks, per-claim verdicts,
  final status supported / needs_revision / rejected, reason). Append-only.
- `finding_reviews`: reviewer decisions (approved / rejected / revise), rejection reason, notes,
  reviewer, timestamp. Append-only; the latest row is the current decision.

## 2. Security
- RLS enabled on every new table; anon gets nothing.
- Writes from the worker use the server-side secret key (bypasses RLS).
- `is_reviewer()` (SECURITY INVOKER) checks the signed-in user is on the allowlist.
- Approved reviewers may SELECT analysis tables, and Phase 0 `companies`, `research_runs`,
  `page_evidence` (read-only), and read objects in the private `evidence-screenshots` bucket so the
  browser can request short-lived signed links.
- Reviewers may INSERT `finding_reviews` only as themselves. No UPDATE or DELETE policies exist on
  reviews, verifications or findings: history is append-only by design.
- A reviewer may read only their own `reviewers` row.

## 3. Notes
1. No Phase 0 columns, data or storage paths are changed.
2. Findings are immutable: a trigger rejects UPDATE on `analysis_findings`.
3. All statements are idempotent.
*/

CREATE TABLE IF NOT EXISTS reviewers (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_run_id uuid NOT NULL REFERENCES research_runs(id),
  company_id uuid NOT NULL REFERENCES companies(id),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'stopped_budget', 'failed')),
  analyst_provider text NOT NULL,
  analyst_model text NOT NULL,
  verifier_provider text NOT NULL,
  verifier_model text NOT NULL,
  prompt_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  assessment_summary text,
  no_findings_reason text,
  evidence_limitations jsonb NOT NULL DEFAULT '[]'::jsonb,
  finding_count integer NOT NULL DEFAULT 0,
  budget_usd numeric(10,4) NOT NULL,
  estimated_cost_usd numeric(10,4) NOT NULL DEFAULT 0,
  billed_cost_usd numeric(10,4),
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  model_call_count integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  worker_version text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS analysis_runs_research_company_idx ON analysis_runs (research_run_id, company_id);
CREATE INDEX IF NOT EXISTS analysis_runs_company_started_idx ON analysis_runs (company_id, started_at DESC);

CREATE TABLE IF NOT EXISTS analysis_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  ref text NOT NULL,
  page_evidence_id uuid NOT NULL REFERENCES page_evidence(id),
  capture_state text NOT NULL CHECK (capture_state IN ('initial_viewport', 'after_overlay_dismissal', 'full_page_section')),
  source_path text NOT NULL,
  derived_path text,
  crop jsonb NOT NULL,
  scaled_width integer NOT NULL,
  scaled_height integer NOT NULL,
  estimated_tokens integer NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (analysis_run_id, ref)
);
CREATE INDEX IF NOT EXISTS analysis_images_evidence_idx ON analysis_images (page_evidence_id);

CREATE TABLE IF NOT EXISTS analysis_model_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('analyst', 'verifier', 'revision')),
  finding_ref text,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  max_output_tokens integer NOT NULL,
  counted_input_tokens integer,
  worst_case_cost_usd numeric(10,4),
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric(10,4) NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('succeeded', 'invalid_output', 'failed', 'refused_budget')),
  stop_reason text,
  latency_ms integer,
  output jsonb,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analysis_model_calls_run_idx ON analysis_model_calls (analysis_run_id, created_at);

CREATE TABLE IF NOT EXISTS analysis_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  finding_ref text NOT NULL,
  revision_of uuid REFERENCES analysis_findings(id),
  research_run_id uuid NOT NULL REFERENCES research_runs(id),
  company_id uuid NOT NULL REFERENCES companies(id),
  short_title text NOT NULL,
  page_type text NOT NULL,
  content jsonb NOT NULL,
  source_evidence_ids uuid[] NOT NULL DEFAULT '{}',
  source_urls text[] NOT NULL DEFAULT '{}',
  viewports text[] NOT NULL DEFAULT '{}',
  capture_states text[] NOT NULL DEFAULT '{}',
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  evidence_quality text NOT NULL CHECK (evidence_quality IN ('strong', 'adequate', 'weak')),
  analyzer_model text NOT NULL,
  prompt_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (analysis_run_id, finding_ref)
);
CREATE INDEX IF NOT EXISTS analysis_findings_run_idx ON analysis_findings (analysis_run_id);

CREATE TABLE IF NOT EXISTS analysis_finding_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES analysis_findings(id) ON DELETE CASCADE,
  fact_id text NOT NULL,
  ref text NOT NULL,
  page_evidence_id uuid NOT NULL REFERENCES page_evidence(id),
  analysis_image_id uuid REFERENCES analysis_images(id),
  capture_state text NOT NULL,
  viewport text NOT NULL,
  url text,
  region jsonb,
  text_excerpt text
);
CREATE INDEX IF NOT EXISTS analysis_finding_evidence_finding_idx ON analysis_finding_evidence (finding_id);

CREATE TABLE IF NOT EXISTS analysis_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES analysis_findings(id) ON DELETE CASCADE,
  model_call_id uuid REFERENCES analysis_model_calls(id),
  verifier_model text,
  automatic_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  claim_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  model_verdict jsonb,
  status text NOT NULL CHECK (status IN ('supported', 'needs_revision', 'rejected')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analysis_verifications_finding_idx ON analysis_verifications (finding_id, created_at DESC);

CREATE TABLE IF NOT EXISTS finding_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES analysis_findings(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'revise')),
  rejection_reason text CHECK (rejection_reason IN ('unsupported', 'generic', 'commercially_weak', 'wrong_interpretation', 'duplicate', 'other')),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 4000),
  reviewer_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((decision = 'rejected') = (rejection_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS finding_reviews_finding_idx ON finding_reviews (finding_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.prevent_finding_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'analysis_findings rows are immutable; create a revision instead';
END;
$$;
REVOKE EXECUTE ON FUNCTION public.prevent_finding_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS analysis_findings_immutable ON analysis_findings;
CREATE TRIGGER analysis_findings_immutable BEFORE UPDATE ON analysis_findings
  FOR EACH ROW EXECUTE FUNCTION public.prevent_finding_update();

CREATE OR REPLACE FUNCTION public.is_reviewer()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.reviewers WHERE user_id = auth.uid());
$$;
REVOKE EXECUTE ON FUNCTION public.is_reviewer() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_reviewer() TO authenticated;

ALTER TABLE reviewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_model_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_finding_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE finding_reviews ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON reviewers, analysis_runs, analysis_images, analysis_model_calls, analysis_findings,
  analysis_finding_evidence, analysis_verifications, finding_reviews FROM anon, authenticated;

GRANT SELECT ON reviewers, analysis_runs, analysis_images, analysis_model_calls, analysis_findings,
  analysis_finding_evidence, analysis_verifications, finding_reviews TO authenticated;
GRANT INSERT (finding_id, decision, rejection_reason, notes) ON finding_reviews TO authenticated;
GRANT SELECT ON companies, research_runs, page_evidence TO authenticated;

DROP POLICY IF EXISTS "reviewer_reads_own_row" ON reviewers;
CREATE POLICY "reviewer_reads_own_row" ON reviewers FOR SELECT
  TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "reviewers_read_analysis_runs" ON analysis_runs;
CREATE POLICY "reviewers_read_analysis_runs" ON analysis_runs FOR SELECT
  TO authenticated USING (public.is_reviewer());

DROP POLICY IF EXISTS "reviewers_read_analysis_images" ON analysis_images;
CREATE POLICY "reviewers_read_analysis_images" ON analysis_images FOR SELECT
  TO authenticated USING (public.is_reviewer());

DROP POLICY IF EXISTS "reviewers_read_model_calls" ON analysis_model_calls;
CREATE POLICY "reviewers_read_model_calls" ON analysis_model_calls FOR SELECT
  TO authenticated USING (public.is_reviewer());

DROP POLICY IF EXISTS "reviewers_read_findings" ON analysis_findings;
CREATE POLICY "reviewers_read_findings" ON analysis_findings FOR SELECT
  TO authenticated USING (public.is_reviewer());

DROP POLICY IF EXISTS "reviewers_read_finding_evidence" ON analysis_finding_evidence;
CREATE POLICY "reviewers_read_finding_evidence" ON analysis_finding_evidence FOR SELECT
  TO authenticated USING (public.is_reviewer());

DROP POLICY IF EXISTS "reviewers_read_verifications" ON analysis_verifications;
CREATE POLICY "reviewers_read_verifications" ON analysis_verifications FOR SELECT
  TO authenticated USING (public.is_reviewer());

DROP POLICY IF EXISTS "reviewers_read_reviews" ON finding_reviews;
CREATE POLICY "reviewers_read_reviews" ON finding_reviews FOR SELECT
  TO authenticated USING (public.is_reviewer());

DROP POLICY IF EXISTS "reviewers_add_own_review" ON finding_reviews;
CREATE POLICY "reviewers_add_own_review" ON finding_reviews FOR INSERT
  TO authenticated WITH CHECK (public.is_reviewer() AND reviewer_id = auth.uid());

DROP POLICY IF EXISTS "reviewers_read_companies" ON companies;
CREATE POLICY "reviewers_read_companies" ON companies FOR SELECT
  TO authenticated USING (public.is_reviewer());

DROP POLICY IF EXISTS "reviewers_read_research_runs" ON research_runs;
CREATE POLICY "reviewers_read_research_runs" ON research_runs FOR SELECT
  TO authenticated USING (public.is_reviewer());

DROP POLICY IF EXISTS "reviewers_read_page_evidence" ON page_evidence;
CREATE POLICY "reviewers_read_page_evidence" ON page_evidence FOR SELECT
  TO authenticated USING (public.is_reviewer());

DROP POLICY IF EXISTS "reviewers_read_evidence_screenshots" ON storage.objects;
CREATE POLICY "reviewers_read_evidence_screenshots" ON storage.objects FOR SELECT
  TO authenticated USING (bucket_id = 'evidence-screenshots' AND public.is_reviewer());
