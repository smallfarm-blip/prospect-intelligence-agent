/*
# Atomic job claiming functions + private screenshot storage

## Plain-English summary
Adds database functions the research worker uses to take exactly one work item
at a time, so two workers running at once can never process the same company
twice. Also creates a private storage area for page screenshots.

## 1. New functions (callable only by the trusted server role)
- `claim_next_job(p_run_id, p_stage, p_worker_id)`: atomically picks the oldest
  pending job (row lock with SKIP LOCKED), marks it in_progress, increments attempts,
  records which worker claimed it, and returns it. Returns nothing if no job is free.
- `complete_job(p_job_id, p_result)`: marks a claimed job completed.
- `fail_job(p_job_id, p_error)`: returns the job to pending if attempts remain,
  otherwise marks it failed. Records the error.
- `reclaim_stale_jobs(p_timeout_minutes)`: returns in_progress jobs whose claim is
  older than the timeout to pending (or failed if out of attempts). Returns count.

## 2. Storage
- Private bucket `evidence-screenshots` (not public). No storage policies are added,
  so only the trusted server role can read/write. Files are shared via short-lived
  signed links.

## 3. Security
1. EXECUTE on all functions revoked from PUBLIC, anon, authenticated; granted to service_role.
2. Functions are SECURITY INVOKER with a fixed search_path.
*/

CREATE OR REPLACE FUNCTION public.claim_next_job(p_run_id uuid, p_stage text, p_worker_id text)
RETURNS SETOF public.research_jobs
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  UPDATE public.research_jobs j
  SET status = 'in_progress',
      attempts = j.attempts + 1,
      claimed_by = p_worker_id,
      claimed_at = now(),
      error = NULL
  WHERE j.id = (
    SELECT id FROM public.research_jobs
    WHERE research_run_id = p_run_id
      AND stage = p_stage
      AND status = 'pending'
      AND attempts < max_attempts
    ORDER BY created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING j.*;
$$;

CREATE OR REPLACE FUNCTION public.complete_job(p_job_id uuid, p_result jsonb)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  UPDATE public.research_jobs
  SET status = 'completed', completed_at = now(), result = p_result
  WHERE id = p_job_id AND status = 'in_progress';
$$;

CREATE OR REPLACE FUNCTION public.fail_job(p_job_id uuid, p_error text)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  UPDATE public.research_jobs
  SET status = CASE WHEN attempts < max_attempts THEN 'pending' ELSE 'failed' END,
      completed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END,
      claimed_by = NULL,
      error = p_error
  WHERE id = p_job_id AND status = 'in_progress';
$$;

CREATE OR REPLACE FUNCTION public.reclaim_stale_jobs(p_timeout_minutes integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.research_jobs
  SET status = CASE WHEN attempts < max_attempts THEN 'pending' ELSE 'failed' END,
      claimed_by = NULL,
      error = coalesce(error, 'reclaimed: claim expired')
  WHERE status = 'in_progress'
    AND claimed_at < now() - make_interval(mins => p_timeout_minutes);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_next_job(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_job(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_job(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reclaim_stale_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_job(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_job(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_job(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reclaim_stale_jobs(integer) TO service_role;

INSERT INTO storage.buckets (id, name, public)
VALUES ('evidence-screenshots', 'evidence-screenshots', false)
ON CONFLICT (id) DO UPDATE SET public = false;
