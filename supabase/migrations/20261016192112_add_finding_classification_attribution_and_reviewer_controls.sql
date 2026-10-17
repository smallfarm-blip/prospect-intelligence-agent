/*
# Phase 1 refinements: attribution, classification, priority, reviewer overrides, outreach readiness

## Plain-English summary
Adds what the refined analysis needs, without changing or removing anything that already exists.
Historical analysis runs (including Kosas f29a764c) keep every value they had; new columns are
simply empty on those rows.

## 1. Modified tables (additive, nullable columns only)
- `analysis_images.also_captured_for_evidence_ids` (uuid[], default empty): other pages whose
  screenshot was byte-identical to this image, so one image can be attributed to several pages.
- `analysis_finding_evidence.page_ref` (text): the page reference (P1, P2...) a citation is about.
- `analysis_finding_evidence.attribution` (text): 'direct' when the image was captured for that page,
  'identical_capture' when it is a byte-identical copy captured for that page.
- `analysis_findings.schema_version` (text): finding format version ('finding-v1.1'); empty = earlier format.
- `analysis_findings.finding_class` (text): the analyst's proposed evidence maturity.
- `analysis_findings.investigation_priority` (text): the analyst's proposed investigation priority.
- `analysis_verifications.evidence_status` (text): factual/citation verification only.
- `analysis_verifications.opportunity_assessment` (jsonb): commercial / opportunity-quality judgement.
- `analysis_verifications.assigned_class` / `assigned_priority` (text): system values after the
  verifier and rules (class can only be lowered from the analyst's proposal).

## 2. New tables (append-only histories)
- `finding_assessment_overrides`: reviewer changes to a finding's class or priority.
  `previous_value` is filled by the database from the current effective value, never by the browser.
  A reason of at least 10 characters is required.
- `outreach_readiness_decisions`: human outreach-readiness decisions
  ('not_ready', 'exploratory', 'ready') with a required reason.
  'exploratory' requires the reviewer to confirm the wording states uncertainty.
  'ready' requires the effective class to be an evidence-backed opportunity;
  'exploratory' requires an evidence-backed opportunity or research hypothesis.

## 3. Security
- RLS enabled on both new tables. Approved reviewers can read all rows and insert rows as themselves.
- No UPDATE or DELETE grants or policies; triggers also block updates and deletes, so history is immutable.
- Reviewers still have no write access to evidence, findings, automatic checks or verifier results.
- `effective_assessment()` is SECURITY INVOKER and only reads tables reviewers may already read.

## 4. Notes
1. No existing column, constraint or row is altered or removed.
2. All statements are idempotent.
*/

ALTER TABLE analysis_images ADD COLUMN IF NOT EXISTS also_captured_for_evidence_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE analysis_finding_evidence ADD COLUMN IF NOT EXISTS page_ref text;
ALTER TABLE analysis_finding_evidence ADD COLUMN IF NOT EXISTS attribution text;

ALTER TABLE analysis_findings ADD COLUMN IF NOT EXISTS schema_version text;
ALTER TABLE analysis_findings ADD COLUMN IF NOT EXISTS finding_class text;
ALTER TABLE analysis_findings ADD COLUMN IF NOT EXISTS investigation_priority text;

ALTER TABLE analysis_verifications ADD COLUMN IF NOT EXISTS evidence_status text;
ALTER TABLE analysis_verifications ADD COLUMN IF NOT EXISTS opportunity_assessment jsonb;
ALTER TABLE analysis_verifications ADD COLUMN IF NOT EXISTS assigned_class text;
ALTER TABLE analysis_verifications ADD COLUMN IF NOT EXISTS assigned_priority text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analysis_finding_evidence_attribution_check') THEN
    ALTER TABLE analysis_finding_evidence ADD CONSTRAINT analysis_finding_evidence_attribution_check
      CHECK (attribution IS NULL OR attribution IN ('direct', 'identical_capture'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analysis_findings_class_check') THEN
    ALTER TABLE analysis_findings ADD CONSTRAINT analysis_findings_class_check
      CHECK (finding_class IS NULL OR finding_class IN ('evidence_backed_opportunity', 'research_hypothesis', 'low_value_observation'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analysis_findings_priority_check') THEN
    ALTER TABLE analysis_findings ADD CONSTRAINT analysis_findings_priority_check
      CHECK (investigation_priority IS NULL OR investigation_priority IN ('high', 'medium', 'low'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analysis_verifications_evidence_status_check') THEN
    ALTER TABLE analysis_verifications ADD CONSTRAINT analysis_verifications_evidence_status_check
      CHECK (evidence_status IS NULL OR evidence_status IN ('supported', 'needs_revision', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analysis_verifications_assigned_class_check') THEN
    ALTER TABLE analysis_verifications ADD CONSTRAINT analysis_verifications_assigned_class_check
      CHECK (assigned_class IS NULL OR assigned_class IN ('evidence_backed_opportunity', 'research_hypothesis', 'low_value_observation'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analysis_verifications_assigned_priority_check') THEN
    ALTER TABLE analysis_verifications ADD CONSTRAINT analysis_verifications_assigned_priority_check
      CHECK (assigned_priority IS NULL OR assigned_priority IN ('high', 'medium', 'low'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS finding_assessment_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES analysis_findings(id) ON DELETE CASCADE,
  field text NOT NULL CHECK (field IN ('finding_class', 'investigation_priority')),
  previous_value text,
  new_value text NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 2000),
  reviewer_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (field = 'finding_class' AND new_value IN ('evidence_backed_opportunity', 'research_hypothesis', 'low_value_observation'))
    OR (field = 'investigation_priority' AND new_value IN ('high', 'medium', 'low'))
  )
);
CREATE INDEX IF NOT EXISTS finding_assessment_overrides_finding_idx ON finding_assessment_overrides (finding_id, field, created_at DESC);

CREATE TABLE IF NOT EXISTS outreach_readiness_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES analysis_findings(id) ON DELETE CASCADE,
  readiness text NOT NULL CHECK (readiness IN ('not_ready', 'exploratory', 'ready')),
  uncertainty_confirmed boolean NOT NULL DEFAULT false,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 2000),
  reviewer_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (readiness <> 'exploratory' OR uncertainty_confirmed)
);
CREATE INDEX IF NOT EXISTS outreach_readiness_decisions_finding_idx ON outreach_readiness_decisions (finding_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.effective_assessment(p_finding_id uuid, p_field text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT o.new_value FROM public.finding_assessment_overrides o
      WHERE o.finding_id = p_finding_id AND o.field = p_field
      ORDER BY o.created_at DESC, o.id DESC LIMIT 1),
    (SELECT CASE WHEN p_field = 'finding_class' THEN v.assigned_class ELSE v.assigned_priority END
      FROM public.analysis_verifications v
      WHERE v.finding_id = p_finding_id
      ORDER BY v.created_at DESC, v.id DESC LIMIT 1),
    (SELECT CASE WHEN p_field = 'finding_class' THEN f.finding_class ELSE f.investigation_priority END
      FROM public.analysis_findings f WHERE f.id = p_finding_id)
  );
$$;
REVOKE EXECUTE ON FUNCTION public.effective_assessment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.effective_assessment(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.fill_override_previous_value()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.previous_value := public.effective_assessment(NEW.finding_id, NEW.field);
  IF NEW.previous_value IS NOT DISTINCT FROM NEW.new_value THEN
    RAISE EXCEPTION 'The % is already %', replace(NEW.field, '_', ' '), NEW.new_value;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.fill_override_previous_value() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.check_outreach_readiness()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  cls text := public.effective_assessment(NEW.finding_id, 'finding_class');
BEGIN
  IF NEW.readiness = 'ready' AND cls IS DISTINCT FROM 'evidence_backed_opportunity' THEN
    RAISE EXCEPTION 'Only an evidence-backed opportunity can be marked ready for outreach';
  END IF;
  IF NEW.readiness = 'exploratory' AND (cls IS NULL OR cls NOT IN ('evidence_backed_opportunity', 'research_hypothesis')) THEN
    RAISE EXCEPTION 'Exploratory outreach needs an evidence-backed opportunity or research hypothesis';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.check_outreach_readiness() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.prevent_history_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION '% rows are an immutable history; add a new decision instead', TG_TABLE_NAME;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.prevent_history_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS finding_assessment_overrides_fill_previous ON finding_assessment_overrides;
CREATE TRIGGER finding_assessment_overrides_fill_previous BEFORE INSERT ON finding_assessment_overrides
  FOR EACH ROW EXECUTE FUNCTION public.fill_override_previous_value();

DROP TRIGGER IF EXISTS finding_assessment_overrides_immutable ON finding_assessment_overrides;
CREATE TRIGGER finding_assessment_overrides_immutable BEFORE UPDATE OR DELETE ON finding_assessment_overrides
  FOR EACH ROW EXECUTE FUNCTION public.prevent_history_change();

DROP TRIGGER IF EXISTS outreach_readiness_decisions_check ON outreach_readiness_decisions;
CREATE TRIGGER outreach_readiness_decisions_check BEFORE INSERT ON outreach_readiness_decisions
  FOR EACH ROW EXECUTE FUNCTION public.check_outreach_readiness();

DROP TRIGGER IF EXISTS outreach_readiness_decisions_immutable ON outreach_readiness_decisions;
CREATE TRIGGER outreach_readiness_decisions_immutable BEFORE UPDATE OR DELETE ON outreach_readiness_decisions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_history_change();

ALTER TABLE finding_assessment_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_readiness_decisions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON finding_assessment_overrides, outreach_readiness_decisions FROM anon, authenticated;
GRANT SELECT ON finding_assessment_overrides, outreach_readiness_decisions TO authenticated;
GRANT INSERT (finding_id, field, new_value, reason) ON finding_assessment_overrides TO authenticated;
GRANT INSERT (finding_id, readiness, uncertainty_confirmed, reason) ON outreach_readiness_decisions TO authenticated;

DROP POLICY IF EXISTS "reviewers_read_overrides" ON finding_assessment_overrides;
CREATE POLICY "reviewers_read_overrides" ON finding_assessment_overrides FOR SELECT
  TO authenticated USING (public.is_reviewer());

DROP POLICY IF EXISTS "reviewers_add_own_override" ON finding_assessment_overrides;
CREATE POLICY "reviewers_add_own_override" ON finding_assessment_overrides FOR INSERT
  TO authenticated WITH CHECK (public.is_reviewer() AND reviewer_id = auth.uid());

DROP POLICY IF EXISTS "reviewers_read_readiness" ON outreach_readiness_decisions;
CREATE POLICY "reviewers_read_readiness" ON outreach_readiness_decisions FOR SELECT
  TO authenticated USING (public.is_reviewer());

DROP POLICY IF EXISTS "reviewers_add_own_readiness" ON outreach_readiness_decisions;
CREATE POLICY "reviewers_add_own_readiness" ON outreach_readiness_decisions FOR INSERT
  TO authenticated WITH CHECK (public.is_reviewer() AND reviewer_id = auth.uid());
