/*
# Keep a reviewer "reopen" in effect until the company is rejected again

## Plain-English summary
Reviewers can reopen a company that screening set aside (or that scored as not a fit) so they can
look at it more closely. Previously the database only honoured that reopen if it was the very latest
decision, so a later "hold" or "shortlist" silently put the company back into the set-aside state and
blocked a deeper-research request. Now a reopen stays in effect until a later rejection.

## Modified functions
1. `public.check_prospect_decision()` (trigger on `prospect_decisions`)
   - Still requires a score before deeper research is requested.
   - Still blocks a second research request in a row.
   - Still blocks research for rejected companies.
   - Set-aside (excluded or not fit) companies may request research once reopened, where "reopened"
     means a reopen decision exists that is newer than every reject decision.

## Security
- No changes to RLS, grants or policies. The function remains non-callable by app roles directly;
  it only runs as a trigger. History tables stay immutable.

## Notes
1. Idempotent: CREATE OR REPLACE on the same function signature; the existing trigger keeps using it.
*/

CREATE OR REPLACE FUNCTION public.check_prospect_decision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  last_decision text;
  excluded boolean;
  reopened boolean;
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
  SELECT EXISTS (
    SELECT 1 FROM public.prospect_decisions o
    WHERE o.company_id = NEW.company_id AND o.decision = 'reopen'
      AND NOT EXISTS (
        SELECT 1 FROM public.prospect_decisions r
        WHERE r.company_id = o.company_id AND r.decision = 'reject'
          AND (r.created_at, r.id) > (o.created_at, o.id)
      )
  ) INTO reopened;
  IF last_decision = 'request_research' THEN
    RAISE EXCEPTION 'Deeper research has already been requested for this company';
  END IF;
  IF last_decision = 'reject' OR (NOT reopened AND (coalesce(excluded, false) OR fit = 'not_fit')) THEN
    RAISE EXCEPTION 'This company is set aside; reopen it before requesting deeper research';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.check_prospect_decision() FROM PUBLIC, anon, authenticated;
