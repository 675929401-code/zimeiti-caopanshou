-- Settle provider-side video failures atomically. A failed provider task must
-- never remain in a non-terminal billing state that asks users to reconcile it.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.finalize_video_generation_failure_atomic(
  p_task_id text,
  p_user_id text,
  p_provider_task_id text,
  p_error_code text,
  p_error_message text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_provider_task_id text := nullif(trim(coalesce(p_provider_task_id, '')), '');
  v_error_code text := left(nullif(trim(coalesce(p_error_code, '')), ''), 120);
  v_error_message text := left(nullif(trim(coalesce(p_error_message, '')), ''), 1000);
BEGIN
  IF trim(coalesce(p_task_id, '')) = ''
     OR trim(coalesce(p_user_id, '')) = ''
     OR v_provider_task_id IS NULL
     OR v_error_message IS NULL THEN
    RAISE EXCEPTION 'VIDEO_FAILURE_FINALIZATION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_task
    FROM public.video_tasks
   WHERE id::text = trim(p_task_id)
     AND user_id::text = trim(p_user_id)
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VIDEO_TASK_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_task.task_id_external IS NULL
     OR v_task.task_id_external IS DISTINCT FROM v_provider_task_id THEN
    RAISE EXCEPTION 'VIDEO_PROVIDER_TASK_CONFLICT' USING ERRCODE = '23505';
  END IF;
  IF v_task.status = 'completed'
     OR v_task.status IN ('cancelled', 'expired') THEN
    RAISE EXCEPTION 'VIDEO_TASK_TERMINAL_CONFLICT' USING ERRCODE = '23505';
  END IF;
  IF coalesce(v_task.price_charged, 0) <> 0
     OR v_task.billing_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'VIDEO_FAILED_TASK_BILLING_RECONCILIATION_REQUIRED' USING ERRCODE = '23514';
  END IF;

  IF v_task.status = 'failed' AND v_task.billing_state = 'failed' THEN
    RETURN jsonb_build_object(
      'task_id', v_task.id,
      'status', v_task.status,
      'billing_state', v_task.billing_state,
      'price_charged', v_task.price_charged,
      'already_failed', true
    );
  END IF;

  UPDATE public.video_tasks
     SET status = 'failed',
         billing_state = 'failed',
         submission_error_code = v_error_code,
         error_message = v_error_message,
         price_charged = 0,
         completed_at = now()
   WHERE id = v_task.id
   RETURNING * INTO v_task;

  RETURN jsonb_build_object(
    'task_id', v_task.id,
    'status', v_task.status,
    'billing_state', v_task.billing_state,
    'price_charged', v_task.price_charged,
    'already_failed', false
  );
END
$function$;

REVOKE ALL ON FUNCTION public.finalize_video_generation_failure_atomic(text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_video_generation_failure_atomic(text,text,text,text,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
