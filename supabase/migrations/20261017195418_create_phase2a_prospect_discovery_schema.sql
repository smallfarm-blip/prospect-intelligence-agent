/*
# Phase 2A: prospect discovery, screening and qualification

## Plain-English summary
Adds the records needed to discover candidate companies (via a search provider such as Exa, or by
manual entry / CSV upload), screen them, score them against the ideal customer profile, and let a
reviewer qualify them. Company qualification is kept separate from Phase 1 finding review: nothing
in the Phase 0 or Phase 1 tables is changed, and no historical row is altered.

## 1. New tables
- `discovery_runs`: one local worker run (trial, discover or screen), with its pilot label, budget,
  actual spend, status and summary.
- `provider_calls`: every paid or free provider request: provider, operation, method, query, parameters,
  execution time, result count, worst-case cost checked beforehand, actual cost and how that cost was known.
- `prospects`: one row per company under consideration: how it entered (Phase 0 selection, provider
  discovery, manual entry, CSV upload), description, any automatic exclusion with its reason, screening time.
- `prospect_sources`: links and short excerpts (never full page text) that mention the company:
  discovery results with query rank and outcome (new / duplicate / excluded), news, the company site.
- `prospect_facts`: individual ICP facts (revenue, headcount, country, category, DTC, ...) each with a
  status: verified, provider_estimate, inferred, unknown or contradicted, plus source and check time.
  Provider figures are always stored as provider_estimate. Reviewers can add verified/contradicted facts.
- `decision_makers`: possible decision-makers: name, role, company, public profile URL, source and date
  only. No emails, phone numbers or photos.
- `decision_maker_reviews`: reviewer confirmation or rejection of a possible decision-maker (append-only).
- `screening_signals`: 0-3 AI screening signals per company, each separating observed evidence,
  interpretation, business relevance, critical unknowns and the next validation step.
- `prospect_scores`: versioned scores (100-point framework): evidence-backed score, potential range,
  confidence, coverage, ICP fit status, unresolved traits and recommended action (append-only).
- `prospect_overrides`: reviewer overrides of score or fit status with reason; the previous value is
  filled in by the database (append-only).
- `prospect_decisions`: reviewer pipeline decisions (shortlist, hold, defer, reject, reopen, request
  deeper research with expected cost) with reason and measured review time (append-only).

## 2. Modified tables
- None. Existing companies are added to `prospects` with origin `phase0_selection`; their records are untouched.

## 3. Functions
- `normalize_prospect_domain(text)`: lower-cases a domain and strips scheme, path, port and "www.".
- `effective_prospect_value(company, field)`: latest reviewer override, else latest computed score/fit.
- `import_prospects(origin, rows)`: reviewer-only manual entry / CSV import. Adds new companies,
  reports duplicates by canonical domain, never overwrites existing companies.
- Triggers fill override previous values, check research requests and keep history rows immutable.

## 4. Security
- RLS enabled on every new table. Only allowlisted reviewers (`is_reviewer()`) can read.
- Reviewers can insert only their own reviewer facts, decision-maker reviews, overrides and decisions,
  and only into the listed columns. Everything else is written by the local worker's service key.
- anon has no access. `import_prospects` checks `is_reviewer()` itself.

## 5. Important notes
1. Statuses verified_fit, probable_fit and needs_qualification are separate; not_fit is "set aside".
2. Missing revenue never removes a company; it is recorded as an unresolved trait.
3. A research request needs a saved score and a company that is not set aside.
*/

CREATE TABLE IF NOT EXISTS discovery_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot text NOT NULL CHECK (char_length(pilot) BETWEEN 1 AND 60),
  mode text NOT NULL CHECK (mode IN ('trial', 'discover', 'screen')),
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'stopped_budget', 'failed')),
  budget_usd numeric(10,4) NOT NULL CHECK (budget_usd >= 0),
  spent_usd numeric(10,6) NOT NULL DEFAULT 0,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  worker_version text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS discovery_runs_pilot_idx ON discovery_runs (pilot, started_at DESC);

CREATE TABLE IF NOT EXISTS prospects (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  origin text NOT NULL CHECK (origin IN ('phase0_selection', 'exa_discovery', 'provider_discovery', 'manual_entry', 'csv_import')),
  pilot text,
  description text CHECK (description IS NULL OR char_length(description) <= 1000),
  excluded_reason text CHECK (excluded_reason IS NULL OR char_length(excluded_reason) <= 500),
  excluded_rule text,
  first_discovery_run_id uuid REFERENCES discovery_runs(id) ON DELETE SET NULL,
  screened_at timestamptz,
  screening_summary text CHECK (screening_summary IS NULL OR char_length(screening_summary) <= 1500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_run_id uuid REFERENCES discovery_runs(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  provider text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('company_search', 'web_search', 'people_search', 'evidence_search', 'ai_screening', 'site_check')),
  method text NOT NULL,
  query text,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'refused_budget')),
  result_count integer,
  worst_case_usd numeric(10,6) NOT NULL DEFAULT 0,
  actual_cost_usd numeric(10,6) NOT NULL DEFAULT 0,
  cost_basis text NOT NULL CHECK (cost_basis IN ('provider_reported', 'computed_from_usage', 'uncertain_worst_case', 'not_billed')),
  request_id text,
  error text,
  executed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_calls_run_idx ON provider_calls (discovery_run_id);
CREATE INDEX IF NOT EXISTS provider_calls_company_idx ON provider_calls (company_id);

CREATE TABLE IF NOT EXISTS prospect_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider_call_id uuid REFERENCES provider_calls(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('discovery_result', 'news', 'company_site', 'person_profile', 'manual')),
  url text,
  title text CHECK (title IS NULL OR char_length(title) <= 300),
  published_at timestamptz,
  excerpt text CHECK (excerpt IS NULL OR char_length(excerpt) <= 600),
  rank integer,
  outcome text CHECK (outcome IS NULL OR outcome IN ('new', 'duplicate', 'excluded')),
  provider_record jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prospect_sources_company_idx ON prospect_sources (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS prospect_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  attribute text NOT NULL CHECK (attribute IN (
    'revenue_annual_usd', 'employee_count', 'hq_country', 'category', 'business_model', 'sells_dtc',
    'founded_year', 'funding_total_usd', 'ecommerce_platform', 'experimentation_tools', 'promotion_tools',
    'catalog_size', 'leadership_model')),
  value_text text NOT NULL CHECK (char_length(value_text) BETWEEN 1 AND 300),
  value_number numeric,
  status text NOT NULL CHECK (status IN ('verified', 'provider_estimate', 'inferred', 'unknown', 'contradicted')),
  source_type text NOT NULL DEFAULT 'reviewer' CHECK (source_type IN ('provider', 'company_site', 'third_party', 'ai_screening', 'manual_import', 'reviewer')),
  source_url text CHECK (source_url IS NULL OR source_url ~* '^https?://'),
  provider text,
  excerpt text CHECK (excerpt IS NULL OR char_length(excerpt) <= 600),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  provider_call_id uuid REFERENCES provider_calls(id) ON DELETE SET NULL,
  reviewer_id uuid DEFAULT auth.uid() REFERENCES auth.users(id),
  checked_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'verified' OR source_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS prospect_facts_company_idx ON prospect_facts (company_id, attribute, checked_at DESC);

CREATE TABLE IF NOT EXISTS decision_makers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  title text CHECK (title IS NULL OR char_length(title) <= 200),
  role_category text NOT NULL CHECK (role_category IN ('founder', 'ecommerce_lead', 'growth_marketing_lead', 'digital_lead', 'executive', 'other')),
  profile_url text CHECK (profile_url IS NULL OR profile_url ~* '^https?://'),
  source_url text CHECK (source_url IS NULL OR source_url ~* '^https?://'),
  provider text,
  source_published_at timestamptz,
  provider_call_id uuid REFERENCES provider_calls(id) ON DELETE SET NULL,
  discovered_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS decision_makers_company_profile_idx ON decision_makers (company_id, profile_url);

CREATE TABLE IF NOT EXISTS decision_maker_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_maker_id uuid NOT NULL REFERENCES decision_makers(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('confirmed', 'rejected')),
  source_url text CHECK (source_url IS NULL OR source_url ~* '^https?://'),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  reviewer_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (decision <> 'confirmed' OR source_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS decision_maker_reviews_dm_idx ON decision_maker_reviews (decision_maker_id, created_at DESC);

CREATE TABLE IF NOT EXISTS screening_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  discovery_run_id uuid REFERENCES discovery_runs(id) ON DELETE SET NULL,
  provider_call_id uuid REFERENCES provider_calls(id) ON DELETE SET NULL,
  signal_type text NOT NULL CHECK (signal_type IN ('business_trigger', 'growth_initiative', 'organizational_change', 'visitor_experience', 'promotional_orchestration')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  observed_evidence text NOT NULL,
  interpretation text NOT NULL,
  business_relevance text NOT NULL,
  critical_unknowns text[] NOT NULL DEFAULT '{}',
  next_validation text NOT NULL,
  source_urls text[] NOT NULL DEFAULT '{}',
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  model text,
  prompt_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS screening_signals_company_idx ON screening_signals (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS prospect_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  discovery_run_id uuid REFERENCES discovery_runs(id) ON DELETE SET NULL,
  scoring_version text NOT NULL,
  evidence_score integer NOT NULL CHECK (evidence_score BETWEEN 0 AND 100),
  potential_min integer NOT NULL CHECK (potential_min BETWEEN 0 AND 100),
  potential_max integer NOT NULL CHECK (potential_max BETWEEN 0 AND 100),
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  coverage numeric(4,3) NOT NULL CHECK (coverage BETWEEN 0 AND 1),
  fit_status text NOT NULL CHECK (fit_status IN ('verified_fit', 'probable_fit', 'needs_qualification', 'not_fit')),
  components jsonb NOT NULL,
  unresolved text[] NOT NULL DEFAULT '{}',
  reasons_to_investigate text[] NOT NULL DEFAULT '{}',
  commercial_relevance text NOT NULL,
  organizational_fit text NOT NULL,
  recommended_action text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (potential_min <= potential_max)
);
CREATE INDEX IF NOT EXISTS prospect_scores_company_idx ON prospect_scores (company_id, computed_at DESC);

CREATE TABLE IF NOT EXISTS prospect_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  field text NOT NULL CHECK (field IN ('score', 'fit_status')),
  previous_value text,
  new_value text NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 2000),
  reviewer_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (field = 'score' AND new_value ~ '^(100|[1-9]?[0-9])$')
    OR (field = 'fit_status' AND new_value IN ('verified_fit', 'probable_fit', 'needs_qualification', 'not_fit'))
  )
);
CREATE INDEX IF NOT EXISTS prospect_overrides_company_idx ON prospect_overrides (company_id, field, created_at DESC);

CREATE TABLE IF NOT EXISTS prospect_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('shortlist', 'hold', 'defer', 'reject', 'reopen', 'request_research')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 2000),
  expected_cost_usd numeric(8,2) CHECK (expected_cost_usd IS NULL OR expected_cost_usd BETWEEN 0 AND 100),
  review_seconds integer CHECK (review_seconds IS NULL OR review_seconds BETWEEN 0 AND 86400),
  reviewer_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (decision <> 'request_research' OR expected_cost_usd IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS prospect_decisions_company_idx ON prospect_decisions (company_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.normalize_prospect_domain(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT regexp_replace(
    regexp_replace(
      regexp_replace(regexp_replace(lower(btrim(coalesce(p, ''))), '^[a-z][a-z0-9+.-]*://', ''), '[/?#].*$', ''),
      ':[0-9]+$', ''),
    '^www\.', '');
$$;

CREATE OR REPLACE FUNCTION public.effective_prospect_value(p_company_id uuid, p_field text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT o.new_value FROM public.prospect_overrides o
      WHERE o.company_id = p_company_id AND o.field = p_field
      ORDER BY o.created_at DESC, o.id DESC LIMIT 1),
    (SELECT CASE WHEN p_field = 'score' THEN s.evidence_score::text ELSE s.fit_status END
      FROM public.prospect_scores s WHERE s.company_id = p_company_id
      ORDER BY s.computed_at DESC, s.id DESC LIMIT 1)
  );
$$;
REVOKE EXECUTE ON FUNCTION public.effective_prospect_value(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.effective_prospect_value(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.fill_prospect_override_previous_value()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.previous_value := public.effective_prospect_value(NEW.company_id, NEW.field);
  IF NEW.previous_value IS NULL THEN
    RAISE EXCEPTION 'This company has not been scored yet';
  END IF;
  IF NEW.previous_value = NEW.new_value THEN
    RAISE EXCEPTION 'The % is already %', replace(NEW.field, '_', ' '), NEW.new_value;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.fill_prospect_override_previous_value() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.check_prospect_decision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  last_decision text;
  excluded boolean;
  fit text := public.effective_prospect_value(NEW.company_id, 'fit_status');
BEGIN
  IF NEW.decision <> 'request_research' THEN
    RETURN NEW;
  END IF;
  IF fit IS NULL THEN
    RAISE EXCEPTION 'Score the company before requesting deeper research';
  END IF;
  SELECT d.decision INTO last_decision FROM public.prospect_decisions d
    WHERE d.company_id = NEW.company_id ORDER BY d.created_at DESC, d.id DESC LIMIT 1;
  SELECT p.excluded_reason IS NOT NULL INTO excluded FROM public.prospects p WHERE p.company_id = NEW.company_id;
  IF last_decision = 'request_research' THEN
    RAISE EXCEPTION 'Deeper research has already been requested for this company';
  END IF;
  IF last_decision = 'reject' OR (last_decision IS DISTINCT FROM 'reopen' AND (coalesce(excluded, false) OR fit = 'not_fit')) THEN
    RAISE EXCEPTION 'This company is set aside; reopen it before requesting deeper research';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.check_prospect_decision() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.import_prospects(p_origin text, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r jsonb;
  v_name text;
  v_domain text;
  v_category text;
  v_country text;
  v_notes text;
  v_id uuid;
  v_existing text;
  results jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.is_reviewer() THEN
    RAISE EXCEPTION 'Only reviewers can import companies';
  END IF;
  IF p_origin NOT IN ('manual_entry', 'csv_import') THEN
    RAISE EXCEPTION 'Unknown import origin';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 200 THEN
    RAISE EXCEPTION 'Provide between 1 and 200 companies';
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_name := left(btrim(coalesce(r->>'name', '')), 200);
    v_domain := public.normalize_prospect_domain(r->>'domain');
    v_category := nullif(left(btrim(coalesce(r->>'category', '')), 80), '');
    v_country := nullif(left(btrim(coalesce(r->>'country', '')), 80), '');
    v_notes := nullif(left(btrim(coalesce(r->>'notes', '')), 1000), '');

    IF v_name = '' OR v_domain !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' THEN
      results := results || jsonb_build_object('domain', v_domain, 'name', v_name, 'outcome', 'invalid');
      CONTINUE;
    END IF;

    SELECT name INTO v_existing FROM public.companies WHERE canonical_domain = v_domain;
    IF FOUND THEN
      results := results || jsonb_build_object('domain', v_domain, 'name', v_existing, 'outcome', 'duplicate');
      CONTINUE;
    END IF;

    INSERT INTO public.companies (name, canonical_domain, category, geography, source, source_notes)
      VALUES (v_name, v_domain, v_category, v_country, p_origin, v_notes)
      ON CONFLICT (canonical_domain) DO NOTHING
      RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      results := results || jsonb_build_object('domain', v_domain, 'name', v_name, 'outcome', 'duplicate');
      CONTINUE;
    END IF;

    INSERT INTO public.prospects (company_id, origin, description) VALUES (v_id, p_origin, v_notes);
    INSERT INTO public.prospect_sources (company_id, kind, url, title, excerpt, outcome)
      VALUES (v_id, 'manual', 'https://' || v_domain, v_name, v_notes, 'new');
    IF v_category IS NOT NULL THEN
      INSERT INTO public.prospect_facts (company_id, attribute, value_text, status, source_type, notes, reviewer_id)
        VALUES (v_id, 'category', v_category, 'inferred', 'manual_import', 'Entered by reviewer at import', auth.uid());
    END IF;
    IF v_country IS NOT NULL THEN
      INSERT INTO public.prospect_facts (company_id, attribute, value_text, status, source_type, notes, reviewer_id)
        VALUES (v_id, 'hq_country', v_country, 'inferred', 'manual_import', 'Entered by reviewer at import', auth.uid());
    END IF;
    results := results || jsonb_build_object('domain', v_domain, 'name', v_name, 'outcome', 'new', 'company_id', v_id);
    v_id := NULL;
  END LOOP;
  RETURN results;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.import_prospects(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_prospects(text, jsonb) TO authenticated;

DROP TRIGGER IF EXISTS prospect_overrides_fill_previous ON prospect_overrides;
CREATE TRIGGER prospect_overrides_fill_previous BEFORE INSERT ON prospect_overrides
  FOR EACH ROW EXECUTE FUNCTION public.fill_prospect_override_previous_value();

DROP TRIGGER IF EXISTS prospect_decisions_check ON prospect_decisions;
CREATE TRIGGER prospect_decisions_check BEFORE INSERT ON prospect_decisions
  FOR EACH ROW EXECUTE FUNCTION public.check_prospect_decision();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['provider_calls', 'prospect_facts', 'decision_maker_reviews', 'prospect_scores', 'prospect_overrides', 'prospect_decisions', 'screening_signals'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_immutable', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION public.prevent_history_change()', t || '_immutable', t);
  END LOOP;
END $$;

ALTER TABLE discovery_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_makers ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_maker_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE screening_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_decisions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON discovery_runs, prospects, provider_calls, prospect_sources, prospect_facts, decision_makers,
  decision_maker_reviews, screening_signals, prospect_scores, prospect_overrides, prospect_decisions FROM anon, authenticated;
GRANT SELECT ON discovery_runs, prospects, provider_calls, prospect_sources, prospect_facts, decision_makers,
  decision_maker_reviews, screening_signals, prospect_scores, prospect_overrides, prospect_decisions TO authenticated;
GRANT INSERT (company_id, attribute, value_text, value_number, status, source_url, excerpt, notes) ON prospect_facts TO authenticated;
GRANT INSERT (decision_maker_id, decision, source_url, notes) ON decision_maker_reviews TO authenticated;
GRANT INSERT (company_id, field, new_value, reason) ON prospect_overrides TO authenticated;
GRANT INSERT (company_id, decision, reason, expected_cost_usd, review_seconds) ON prospect_decisions TO authenticated;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['discovery_runs', 'prospects', 'provider_calls', 'prospect_sources', 'prospect_facts', 'decision_makers',
    'decision_maker_reviews', 'screening_signals', 'prospect_scores', 'prospect_overrides', 'prospect_decisions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'reviewers_read_' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (public.is_reviewer())', 'reviewers_read_' || t, t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "reviewers_add_own_fact" ON prospect_facts;
CREATE POLICY "reviewers_add_own_fact" ON prospect_facts FOR INSERT TO authenticated
  WITH CHECK (public.is_reviewer() AND reviewer_id = auth.uid() AND source_type = 'reviewer'
    AND status IN ('verified', 'contradicted', 'inferred'));

DROP POLICY IF EXISTS "reviewers_add_own_dm_review" ON decision_maker_reviews;
CREATE POLICY "reviewers_add_own_dm_review" ON decision_maker_reviews FOR INSERT TO authenticated
  WITH CHECK (public.is_reviewer() AND reviewer_id = auth.uid());

DROP POLICY IF EXISTS "reviewers_add_own_prospect_override" ON prospect_overrides;
CREATE POLICY "reviewers_add_own_prospect_override" ON prospect_overrides FOR INSERT TO authenticated
  WITH CHECK (public.is_reviewer() AND reviewer_id = auth.uid());

DROP POLICY IF EXISTS "reviewers_add_own_prospect_decision" ON prospect_decisions;
CREATE POLICY "reviewers_add_own_prospect_decision" ON prospect_decisions FOR INSERT TO authenticated
  WITH CHECK (public.is_reviewer() AND reviewer_id = auth.uid());

INSERT INTO prospects (company_id, origin, pilot)
  SELECT c.id, 'phase0_selection', NULL FROM companies c
  WHERE NOT EXISTS (SELECT 1 FROM prospects p WHERE p.company_id = c.id);
