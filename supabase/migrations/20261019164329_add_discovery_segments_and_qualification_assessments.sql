/*
# Discovery segments and separate qualification assessments

Records which discovery segment surfaced each company, and stores four separate
qualification assessments plus plain-language trade-offs next to every prospect score.
Purely additive: no existing column, row or policy changes.

1. Modified Tables
- `prospect_sources`
  - `discovery_segment` (text, nullable): `emerging`, `growing` or `established` for
    discovery results; null for other source kinds. A company found by several segments
    has several sightings, so segments are discovery categories, not classifications.
- `prospect_scores`
  - `qualification` (jsonb, nullable): `{ assessments: [...], tradeOffs: [...] }` with
    commercial capacity, need for outside help, decision-maker accessibility and opportunity
    relevance, each with a level (strong / moderate / weak / unknown), strengths, risks and unknowns.
    Older score rows stay null.

2. Security
- No policy changes. Existing reviewer-only RLS on both tables applies to the new columns.

3. Notes
1. The 100-point score is unchanged in structure; these assessments explain it without replacing it.
2. Unknown budget, revenue or internal capability is stored as `unknown`, never as a weak level.
*/

ALTER TABLE prospect_sources ADD COLUMN IF NOT EXISTS discovery_segment text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prospect_sources_discovery_segment_check') THEN
    ALTER TABLE prospect_sources ADD CONSTRAINT prospect_sources_discovery_segment_check
      CHECK (discovery_segment IS NULL OR discovery_segment IN ('emerging', 'growing', 'established'));
  END IF;
END $$;

ALTER TABLE prospect_scores ADD COLUMN IF NOT EXISTS qualification jsonb;

CREATE INDEX IF NOT EXISTS prospect_sources_discovery_segment_idx ON prospect_sources (discovery_segment) WHERE discovery_segment IS NOT NULL;
