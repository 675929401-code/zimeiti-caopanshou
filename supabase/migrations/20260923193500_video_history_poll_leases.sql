-- Shard ordinary video provider polling across independent media workers.
-- A short lease is recoverable after worker exit; terminal tasks are never
-- eligible, and browser status reads remain passive.

BEGIN;

ALTER TABLE public.video_tasks
  ADD COLUMN IF NOT EXISTS provider_poll_lease_owner text,
  ADD COLUMN IF NOT EXISTS provider_poll_lease_until timestamptz;

CREATE INDEX IF NOT EXISTS video_tasks_provider_poll_claim_idx
  ON public.video_tasks (
    provider_poll_lease_until ASC NULLS FIRST,
    provider_last_polled_at ASC NULLS FIRST,
    created_at ASC,
    id ASC
  )
  WHERE status IN ('pending', 'queued', 'processing', 'generating', 'finalizing')
    AND task_id_external IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_video_history_poll_batch(
  p_worker_id text,
  p_limit integer DEFAULT 16,
  p_lease_seconds integer DEFAULT 180
) RETURNS TABLE (
  task_id text,
  owner_user_id text,
  internal_model_id text,
  provider_task_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_worker_id text := trim(coalesce(p_worker_id, ''));
  v_limit integer := greatest(1, least(coalesce(p_limit, 16), 64));
  v_lease_seconds integer := greatest(15, least(coalesce(p_lease_seconds, 180), 600));
BEGIN
  IF length(v_worker_id) < 8 OR length(v_worker_id) > 200 THEN
    RAISE EXCEPTION 'VIDEO_HISTORY_POLL_WORKER_INVALID' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT t.id
      FROM public.video_tasks t
     WHERE t.status IN ('pending', 'queued', 'processing', 'generating', 'finalizing')
       AND nullif(trim(coalesce(t.task_id_external, '')), '') IS NOT NULL
       AND left(t.task_id_external, 4) <> 'h3q_'
       AND (t.task_label IS NULL OR t.task_label NOT LIKE 'digital-human:%')
       AND (t.provider_poll_lease_until IS NULL OR t.provider_poll_lease_until <= now())
     ORDER BY t.provider_last_polled_at ASC NULLS FIRST, t.created_at ASC, t.id ASC
     LIMIT v_limit
     FOR UPDATE OF t SKIP LOCKED
  ), claimed AS (
    UPDATE public.video_tasks t
       SET provider_poll_lease_owner = v_worker_id,
           provider_poll_lease_until = now() + make_interval(secs => v_lease_seconds)
      FROM candidates c
     WHERE t.id = c.id
     RETURNING
       t.id::text AS task_id,
       t.user_id::text AS owner_user_id,
       t.model_id::text AS internal_model_id,
       t.task_id_external::text AS provider_task_id
  )
  SELECT c.task_id, c.owner_user_id, c.internal_model_id, c.provider_task_id
    FROM claimed c;
END
$$;

CREATE OR REPLACE FUNCTION public.release_video_history_poll_claim(
  p_task_id text,
  p_worker_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF nullif(trim(coalesce(p_task_id, '')), '') IS NULL
     OR nullif(trim(coalesce(p_worker_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'VIDEO_HISTORY_POLL_RELEASE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE public.video_tasks
     SET provider_poll_lease_owner = NULL,
         provider_poll_lease_until = NULL
   WHERE id::text = trim(p_task_id)
     AND provider_poll_lease_owner = trim(p_worker_id);
  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION public.claim_video_history_poll_batch(text, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_video_history_poll_claim(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_video_history_poll_batch(text, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_video_history_poll_claim(text, text)
  TO service_role;

COMMENT ON COLUMN public.video_tasks.provider_poll_lease_owner IS
  'Dedicated media worker currently authorized to refresh this provider task.';
COMMENT ON COLUMN public.video_tasks.provider_poll_lease_until IS
  'Short recoverable lease preventing duplicate provider polls across workers.';

NOTIFY pgrst, 'reload schema';

COMMIT;
