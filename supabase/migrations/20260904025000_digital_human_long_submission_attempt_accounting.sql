-- Polling a provider task is not a new provider submission attempt. Count only
-- queued -> preparing claims so a long-running upstream task cannot exhaust the
-- retry guard merely because it needs more than twenty status polls.
CREATE OR REPLACE FUNCTION public.claim_digital_human_long_segment(p_worker text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_segment public.digital_human_long_segments%ROWTYPE;
  v_parent public.digital_human_long_jobs%ROWTYPE;
  v_claim record;
BEGIN
  IF length(p_worker) < 16 OR length(p_worker) > 100 THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_LONG_WORKER_INVALID';
  END IF;

  UPDATE public.digital_human_long_segments
    SET state = 'queued', lease_owner = NULL, lease_until = NULL, next_run_at = now(), updated_at = now()
    WHERE state = 'preparing' AND lease_until < now();
  UPDATE public.digital_human_long_segments
    SET state = CASE WHEN provider_task_id IS NULL THEN 'submission_unknown' ELSE 'running' END,
        lease_owner = NULL, lease_until = NULL, next_run_at = now(), updated_at = now()
    WHERE state = 'dispatching' AND lease_until < now();
  UPDATE public.digital_human_long_segments
    SET lease_owner = NULL, lease_until = NULL, next_run_at = now(), updated_at = now()
    WHERE state IN ('running','finalizing') AND lease_until < now();

  FOR v_claim IN
    SELECT s, p FROM public.digital_human_long_segments s
    JOIN public.digital_human_long_jobs p ON p.id = s.parent_id
    WHERE p.state IN ('queued','processing','confirming')
      AND s.state IN ('queued','running','finalizing')
      AND s.next_run_at <= now()
      AND (s.lease_until IS NULL OR s.lease_until < now())
      AND NOT EXISTS (
        SELECT 1 FROM public.digital_human_long_segments prior
        WHERE prior.parent_id = s.parent_id AND prior.ordinal < s.ordinal AND prior.state <> 'completed'
      )
    ORDER BY CASE s.state WHEN 'running' THEN 0 WHEN 'finalizing' THEN 1 ELSE 2 END,
             p.created_at, s.ordinal
    LIMIT 100
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    v_segment := v_claim.s;
    v_parent := v_claim.p;
    IF NOT pg_try_advisory_xact_lock(hashtextextended('digital-video-channel:' || v_parent.provider_key, 0)) THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.digital_video_dispatch_jobs
      WHERE provider_key = v_parent.provider_key
        AND state IN ('dispatching','running','submission_unknown','finalizing')
    ) THEN CONTINUE; END IF;
    IF v_segment.state = 'queued' AND EXISTS (
        SELECT 1 FROM public.digital_human_long_segments other
        JOIN public.digital_human_long_jobs other_parent ON other_parent.id = other.parent_id
        WHERE other_parent.provider_key = v_parent.provider_key AND other.id <> v_segment.id
          AND other.state IN ('preparing','dispatching','running','submission_unknown','finalizing')
    ) THEN CONTINUE; END IF;

    UPDATE public.digital_human_long_segments
      SET state = CASE WHEN v_segment.state = 'queued' THEN 'preparing' ELSE v_segment.state END,
          lease_owner = p_worker, lease_until = now() + interval '10 minutes',
          attempt_count = attempt_count + CASE WHEN v_segment.state = 'queued' THEN 1 ELSE 0 END,
          updated_at = now()
      WHERE id = v_segment.id RETURNING * INTO v_segment;
    UPDATE public.digital_human_long_jobs
      SET state = 'processing', updated_at = now()
      WHERE id = v_parent.id AND state IN ('queued','processing','confirming');
    RETURN to_jsonb(v_segment) || jsonb_build_object('parent', to_jsonb(v_parent));
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_digital_human_long_segment(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_digital_human_long_segment(text) TO service_role;

NOTIFY pgrst, 'reload schema';
