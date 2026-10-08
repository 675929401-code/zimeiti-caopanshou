-- Deliver completed videos immediately through the authenticated provider
-- proxy, then archive them asynchronously to COS for the advertised history
-- window. The archive queue never submits a provider generation request and
-- never changes billing records.
BEGIN;

CREATE TABLE IF NOT EXISTS public.video_history_archive_jobs (
  task_id text PRIMARY KEY REFERENCES public.video_tasks(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  storage_url text,
  last_error_code text,
  source_expired_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT video_history_archive_jobs_state_check CHECK (
    state IN ('queued', 'leased', 'retry', 'completed', 'source_expired', 'dead_letter')
  ),
  CONSTRAINT video_history_archive_jobs_attempt_check CHECK (attempt_count >= 0),
  CONSTRAINT video_history_archive_jobs_completed_check CHECK (
    state <> 'completed'
    OR (storage_url ~ '^object://tencent_cos/[^?#]+$' AND archived_at IS NOT NULL)
  ),
  CONSTRAINT video_history_archive_jobs_expired_check CHECK (
    state <> 'source_expired' OR source_expired_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS video_history_archive_jobs_ready_idx
  ON public.video_history_archive_jobs(next_attempt_at, created_at, task_id)
  WHERE state IN ('queued', 'retry');
CREATE INDEX IF NOT EXISTS video_history_archive_jobs_lease_idx
  ON public.video_history_archive_jobs(lease_until, task_id)
  WHERE state = 'leased';

ALTER TABLE public.video_history_archive_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_history_archive_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.video_history_archive_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.video_history_archive_jobs TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_video_history_archive_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'completed'
     AND nullif(trim(coalesce(NEW.storage_url, '')), '') IS NULL
     AND nullif(trim(coalesce(NEW.provider_result_url, NEW.video_url, '')), '') IS NOT NULL THEN
    INSERT INTO public.video_history_archive_jobs(task_id)
    VALUES (NEW.id::text)
    ON CONFLICT (task_id) DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS video_tasks_enqueue_history_archive ON public.video_tasks;
CREATE TRIGGER video_tasks_enqueue_history_archive
AFTER INSERT OR UPDATE OF status, storage_url, provider_result_url, video_url
ON public.video_tasks
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_video_history_archive_job();

-- Existing direct-delivery rows inside the visible history window become
-- recoverable work. Rows outside the window are recorded as expired without
-- downloading or uploading anything.
INSERT INTO public.video_history_archive_jobs(task_id, state, next_attempt_at, source_expired_at)
SELECT
  task.id::text,
  CASE
    WHEN coalesce(task.completed_at, task.created_at) <= now() - interval '3 days'
      THEN 'source_expired'
    ELSE 'queued'
  END,
  now(),
  CASE
    WHEN coalesce(task.completed_at, task.created_at) <= now() - interval '3 days'
      THEN now()
    ELSE NULL
  END
FROM public.video_tasks task
WHERE task.status = 'completed'
  AND nullif(trim(coalesce(task.storage_url, '')), '') IS NULL
  AND nullif(trim(coalesce(task.provider_result_url, task.video_url, '')), '') IS NOT NULL
ON CONFLICT (task_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.claim_video_history_archive_batch(
  p_worker_id text,
  p_limit integer DEFAULT 4,
  p_lease_seconds integer DEFAULT 600
) RETURNS TABLE(
  task_id text,
  owner_user_id text,
  internal_model_id text,
  provider_task_id text,
  provider_result_url text,
  attempt_no integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_worker text := left(trim(coalesce(p_worker_id, '')), 160);
  v_limit integer := greatest(1, least(coalesce(p_limit, 4), 16));
  v_lease integer := greatest(60, least(coalesce(p_lease_seconds, 600), 1800));
BEGIN
  IF v_worker = '' THEN
    RAISE EXCEPTION 'VIDEO_HISTORY_ARCHIVE_WORKER_REQUIRED' USING ERRCODE = '22023';
  END IF;

  UPDATE public.video_history_archive_jobs job
     SET state = 'source_expired',
         source_expired_at = coalesce(job.source_expired_at, now()),
         lease_owner = NULL,
         lease_until = NULL,
         last_error_code = coalesce(job.last_error_code, 'HISTORY_WINDOW_EXPIRED'),
         updated_at = now()
    FROM public.video_tasks task
   WHERE task.id::text = job.task_id
     AND job.state IN ('queued', 'retry', 'leased')
     AND coalesce(task.completed_at, task.created_at) <= now() - interval '3 days';

  RETURN QUERY
  WITH candidates AS (
    SELECT job.task_id
      FROM public.video_history_archive_jobs job
      JOIN public.video_tasks task ON task.id::text = job.task_id
     WHERE job.state IN ('queued', 'retry', 'leased')
       AND job.next_attempt_at <= now()
       AND (job.lease_until IS NULL OR job.lease_until <= now())
       AND task.status = 'completed'
       AND nullif(trim(coalesce(task.storage_url, '')), '') IS NULL
       AND nullif(trim(coalesce(task.provider_result_url, task.video_url, '')), '') IS NOT NULL
       AND coalesce(task.completed_at, task.created_at) > now() - interval '3 days'
     ORDER BY job.next_attempt_at, job.created_at, job.task_id
     FOR UPDATE OF job SKIP LOCKED
     LIMIT v_limit
  ), claimed AS (
    UPDATE public.video_history_archive_jobs job
       SET state = 'leased',
           attempt_count = job.attempt_count + 1,
           lease_owner = v_worker,
           lease_until = now() + make_interval(secs => v_lease),
           updated_at = now()
      FROM candidates
     WHERE job.task_id = candidates.task_id
     RETURNING job.task_id, job.attempt_count
  )
  SELECT
    claimed.task_id,
    task.user_id::text,
    task.model_id::text,
    coalesce(task.task_id_external, '')::text,
    coalesce(nullif(trim(task.provider_result_url), ''), nullif(trim(task.video_url), ''), '')::text,
    claimed.attempt_count
  FROM claimed
  JOIN public.video_tasks task ON task.id::text = claimed.task_id
  ORDER BY claimed.task_id;
END
$$;

CREATE OR REPLACE FUNCTION public.complete_video_history_archive_job(
  p_task_id text,
  p_worker_id text,
  p_storage_url text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.video_history_archive_jobs%ROWTYPE;
  v_task public.video_tasks%ROWTYPE;
  v_storage_url text := trim(coalesce(p_storage_url, ''));
  v_storage_key text;
BEGIN
  IF v_storage_url !~ '^object://tencent_cos/[^?#]+$' THEN
    RAISE EXCEPTION 'VIDEO_HISTORY_ARCHIVE_STORAGE_URL_INVALID' USING ERRCODE = '22023';
  END IF;
  v_storage_key := replace(substring(v_storage_url from length('object://tencent_cos/') + 1), '%2F', '/');
  v_storage_key := replace(v_storage_key, '%2f', '/');

  SELECT * INTO v_job
    FROM public.video_history_archive_jobs
   WHERE task_id = trim(coalesce(p_task_id, ''))
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VIDEO_HISTORY_ARCHIVE_JOB_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.state = 'completed' AND v_job.storage_url = v_storage_url THEN
    RETURN jsonb_build_object('completed', true, 'already_completed', true, 'storage_url', v_storage_url);
  END IF;
  IF v_job.state <> 'leased'
     OR v_job.lease_owner IS DISTINCT FROM trim(coalesce(p_worker_id, ''))
     OR v_job.lease_until IS NULL
     OR v_job.lease_until <= now() THEN
    RAISE EXCEPTION 'VIDEO_HISTORY_ARCHIVE_LEASE_INVALID' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_task
    FROM public.video_tasks
   WHERE id::text = v_job.task_id
   FOR UPDATE;
  IF NOT FOUND OR v_task.status <> 'completed' THEN
    RAISE EXCEPTION 'VIDEO_HISTORY_ARCHIVE_TASK_INVALID' USING ERRCODE = '55000';
  END IF;
  IF nullif(trim(coalesce(v_task.storage_url, '')), '') IS NOT NULL
     AND v_task.storage_url IS DISTINCT FROM v_storage_url THEN
    RAISE EXCEPTION 'VIDEO_HISTORY_ARCHIVE_STORAGE_CONFLICT' USING ERRCODE = '23505';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.user_files asset
     WHERE asset.user_id::text = v_task.user_id::text
       AND asset.storage_provider = 'tencent_cos'
       AND asset.storage_key = v_storage_key
       AND asset.file_category = 'video'
       AND asset.meta->>'taskId' = v_task.id::text
  ) THEN
    RAISE EXCEPTION 'VIDEO_HISTORY_ARCHIVE_ASSET_OWNERSHIP_MISSING' USING ERRCODE = '55000';
  END IF;

  UPDATE public.video_tasks
     SET storage_url = v_storage_url,
         video_url = v_storage_url,
         needs_proxy = false
   WHERE id = v_task.id;

  UPDATE public.video_history_archive_jobs
     SET state = 'completed',
         storage_url = v_storage_url,
         archived_at = now(),
         lease_owner = NULL,
         lease_until = NULL,
         last_error_code = NULL,
         updated_at = now()
   WHERE task_id = v_job.task_id;

  RETURN jsonb_build_object('completed', true, 'already_completed', false, 'storage_url', v_storage_url);
END
$$;

CREATE OR REPLACE FUNCTION public.fail_video_history_archive_attempt(
  p_task_id text,
  p_worker_id text,
  p_error_code text,
  p_source_expired boolean DEFAULT false,
  p_retry_seconds integer DEFAULT 60
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.video_history_archive_jobs%ROWTYPE;
  v_state text;
  v_retry integer := greatest(15, least(coalesce(p_retry_seconds, 60), 3600));
BEGIN
  SELECT * INTO v_job
    FROM public.video_history_archive_jobs
   WHERE task_id = trim(coalesce(p_task_id, ''))
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VIDEO_HISTORY_ARCHIVE_JOB_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.state <> 'leased'
     OR v_job.lease_owner IS DISTINCT FROM trim(coalesce(p_worker_id, '')) THEN
    RAISE EXCEPTION 'VIDEO_HISTORY_ARCHIVE_LEASE_INVALID' USING ERRCODE = '55000';
  END IF;

  v_state := CASE
    WHEN coalesce(p_source_expired, false) THEN 'source_expired'
    WHEN v_job.attempt_count >= 5 THEN 'dead_letter'
    ELSE 'retry'
  END;
  UPDATE public.video_history_archive_jobs
     SET state = v_state,
         next_attempt_at = CASE WHEN v_state = 'retry' THEN now() + make_interval(secs => v_retry) ELSE next_attempt_at END,
         lease_owner = NULL,
         lease_until = NULL,
         last_error_code = left(regexp_replace(coalesce(p_error_code, 'ARCHIVE_FAILED'), '[^A-Za-z0-9_.:-]', '_', 'g'), 120),
         source_expired_at = CASE WHEN v_state = 'source_expired' THEN now() ELSE source_expired_at END,
         updated_at = now()
   WHERE task_id = v_job.task_id;

  RETURN jsonb_build_object('state', v_state, 'attempt_count', v_job.attempt_count);
END
$$;

REVOKE ALL ON FUNCTION public.enqueue_video_history_archive_job() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_video_history_archive_batch(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_video_history_archive_job(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_video_history_archive_attempt(text, text, text, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_video_history_archive_batch(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_video_history_archive_job(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_video_history_archive_attempt(text, text, text, boolean, integer) TO service_role;

COMMIT;
