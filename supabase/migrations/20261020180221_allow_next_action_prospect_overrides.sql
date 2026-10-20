/*
# Allow reviewers to override a prospect's primary next action

1. Plain-English summary
   - Each scored prospect now carries one recommended next qualification action
     (stored inside the latest score's `qualification.nextAction`).
   - Reviewers can replace that recommendation with their own choice. Every change
     is a new row in the existing append-only `prospect_overrides` history, with a
     required reason (10-2000 characters), so earlier recommendations and overrides
     are never lost.

2. Modified tables
   - `prospect_overrides`
     - `field` may now also be `next_action`.
     - For `next_action`, `new_value` must be one of: verify_commercial_capacity,
       validate_business_need, confirm_decision_maker, investigate_website, defer.

3. Modified functions
   - `effective_prospect_value(company_id, field)` now also resolves `next_action`:
     the latest override, otherwise the key from the latest score's qualification.
     The existing trigger therefore fills `previous_value` and rejects no-op changes
     for next actions exactly as it does for score and fit status.

4. Security
   - No policy changes. Existing RLS stays in force: only reviewers can read
     overrides, reviewers can only insert rows as themselves, and there are no
     update or delete policies, so history is append-only.

5. Notes
   1. No data is changed or removed; only constraints are widened.
*/

ALTER TABLE prospect_overrides DROP CONSTRAINT IF EXISTS prospect_overrides_field_check;
ALTER TABLE prospect_overrides ADD CONSTRAINT prospect_overrides_field_check
  CHECK (field IN ('score', 'fit_status', 'next_action'));

ALTER TABLE prospect_overrides DROP CONSTRAINT IF EXISTS prospect_overrides_check;
ALTER TABLE prospect_overrides ADD CONSTRAINT prospect_overrides_check CHECK (
  (field = 'score' AND new_value ~ '^(100|[1-9]?[0-9])$')
  OR (field = 'fit_status' AND new_value IN ('verified_fit', 'probable_fit', 'needs_qualification', 'not_fit'))
  OR (field = 'next_action' AND new_value IN ('verify_commercial_capacity', 'validate_business_need', 'confirm_decision_maker', 'investigate_website', 'defer'))
);

CREATE OR REPLACE FUNCTION public.effective_prospect_value(p_company_id uuid, p_field text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT o.new_value FROM public.prospect_overrides o
      WHERE o.company_id = p_company_id AND o.field = p_field
      ORDER BY o.created_at DESC, o.id DESC LIMIT 1),
    (SELECT CASE
              WHEN p_field = 'score' THEN s.evidence_score::text
              WHEN p_field = 'next_action' THEN s.qualification->'nextAction'->>'key'
              ELSE s.fit_status
            END
      FROM public.prospect_scores s WHERE s.company_id = p_company_id
      ORDER BY s.computed_at DESC, s.id DESC LIMIT 1)
  );
$$;
REVOKE EXECUTE ON FUNCTION public.effective_prospect_value(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.effective_prospect_value(uuid, text) TO authenticated;
