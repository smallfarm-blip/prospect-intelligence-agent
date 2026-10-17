/*
# Harden prospect source history

## Plain-English summary
Every search result, news item, company-site check and manual import that mentions a prospect is
kept in `prospect_sources`, together with the search that produced it and its outcome
(new, duplicate or excluded). This record backs the pilot report's "which query worked" figures,
so once written it must not change. This migration locks those rows the same way facts, scores,
provider calls and reviewer decisions are already locked, and adds an index for looking sources
up by the search that produced them.

## 1. Modified tables
- `prospect_sources`
  - New trigger `prospect_sources_immutable`: blocks UPDATE and DELETE on existing rows
    (reuses the existing `prevent_history_change()` function). Inserts are unchanged.
  - New index `prospect_sources_call_idx` on `provider_call_id` (query effectiveness reporting).

## 2. Security
- No policy or grant changes. Reviewers still only read sources; only the local worker
  (and the reviewer-only import function) add them.

## 3. Important notes
1. Purely additive; no existing rows are modified or removed.
2. Safe to re-run.
*/

DROP TRIGGER IF EXISTS prospect_sources_immutable ON prospect_sources;
CREATE TRIGGER prospect_sources_immutable
  BEFORE UPDATE OR DELETE ON prospect_sources
  FOR EACH ROW EXECUTE FUNCTION prevent_history_change();

CREATE INDEX IF NOT EXISTS prospect_sources_call_idx ON prospect_sources (provider_call_id);
