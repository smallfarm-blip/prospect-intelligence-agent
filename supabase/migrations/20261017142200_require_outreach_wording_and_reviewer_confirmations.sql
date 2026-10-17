/*
# Require proposed outreach wording and reviewer confirmations

## Plain-English summary
Approving a finding for "Exploratory outreach" or "Ready" now requires the reviewer to write the
actual outreach wording they propose and to confirm three things about it. The wording is stored
with the decision so successful outreach angles can be evaluated and reused later.
This is an approval record only: nothing in this system sends or generates prospect messages.

## Modified tables
- `outreach_readiness_decisions` (append-only history; no rows existed when this was applied)
  - `proposed_wording` (text, nullable): the outreach wording the reviewer approves. Required
    (40 to 2000 characters, ignoring surrounding spaces) for 'exploratory' and 'ready'. Must be
    empty for 'not_ready'.
  - `decision_maker_relevance_confirmed` (boolean, default false): wording is relevant to a Head of
    eCommerce or similar decision-maker.
  - `evidence_grounded_confirmed` (boolean, default false): wording is grounded in this finding's
    specific evidence.
  - `no_overstatement_confirmed` (boolean, default false): wording does not overstate observed
    friction or business impact.
  - All three confirmations are required for 'exploratory' and 'ready'. The existing rule that
    'exploratory' also needs `uncertainty_confirmed` is unchanged.

## Security
- Reviewers gain INSERT on the four new columns only. There is still no UPDATE or DELETE grant or
  policy, and the existing trigger blocks edits and deletes, so the history stays immutable.
- RLS and existing policies are unchanged.

## Important notes
1. Nothing existing is removed or altered; the change is additive.
2. A finding with no decision is treated as "Not ready" by the review app.
*/

ALTER TABLE outreach_readiness_decisions ADD COLUMN IF NOT EXISTS proposed_wording text;
ALTER TABLE outreach_readiness_decisions ADD COLUMN IF NOT EXISTS decision_maker_relevance_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE outreach_readiness_decisions ADD COLUMN IF NOT EXISTS evidence_grounded_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE outreach_readiness_decisions ADD COLUMN IF NOT EXISTS no_overstatement_confirmed boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_readiness_wording_rules') THEN
    ALTER TABLE outreach_readiness_decisions ADD CONSTRAINT outreach_readiness_wording_rules CHECK (
      CASE
        WHEN readiness = 'not_ready' THEN proposed_wording IS NULL
        ELSE proposed_wording IS NOT NULL
          AND char_length(btrim(proposed_wording)) BETWEEN 40 AND 2000
          AND decision_maker_relevance_confirmed
          AND evidence_grounded_confirmed
          AND no_overstatement_confirmed
      END
    );
  END IF;
END $$;

GRANT INSERT (proposed_wording, decision_maker_relevance_confirmed, evidence_grounded_confirmed, no_overstatement_confirmed)
  ON outreach_readiness_decisions TO authenticated;
