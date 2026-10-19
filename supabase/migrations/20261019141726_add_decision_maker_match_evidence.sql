/*
# Record how each possible decision-maker was matched

Additive only. Existing rows keep NULL in every new column.

1. Modified tables
- `decision_makers`
  - `match_confidence` (text, nullable): high, medium or low. How strongly the source ties this person to
    this company in a relevant role. Not a judgement of the person or of the prospect.
  - `employment_status` (text, nullable):
    - `current`: a dated work-history role with no end date;
    - `undated`: a matching role without dates, so current employment is not established;
    - `unverified`: matched only from a page title or snippet, with no structured work history.
  - `role_started_on` (date, nullable): start of the matching role when the provider gives one.
  - `match_basis` (text, nullable, at most 300 chars): one-line explanation shown to the reviewer.

2. Security
- No policy changes. The existing reviewer-only read policy and worker-only writes cover the new columns.

3. Notes
1. Retention scope is unchanged: name, role, company, profile URL, source, dates and match metadata only.
   Location, education and full work history are not stored.
*/

ALTER TABLE decision_makers ADD COLUMN IF NOT EXISTS match_confidence text;
ALTER TABLE decision_makers ADD COLUMN IF NOT EXISTS employment_status text;
ALTER TABLE decision_makers ADD COLUMN IF NOT EXISTS role_started_on date;
ALTER TABLE decision_makers ADD COLUMN IF NOT EXISTS match_basis text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_makers_match_confidence_check') THEN
    ALTER TABLE decision_makers ADD CONSTRAINT decision_makers_match_confidence_check CHECK (match_confidence IS NULL OR match_confidence IN ('high', 'medium', 'low'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_makers_employment_status_check') THEN
    ALTER TABLE decision_makers ADD CONSTRAINT decision_makers_employment_status_check CHECK (employment_status IS NULL OR employment_status IN ('current', 'undated', 'unverified'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'decision_makers_match_basis_check') THEN
    ALTER TABLE decision_makers ADD CONSTRAINT decision_makers_match_basis_check CHECK (match_basis IS NULL OR char_length(match_basis) <= 300);
  END IF;
END $$;
