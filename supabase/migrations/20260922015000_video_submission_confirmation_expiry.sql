-- Close orphaned video submissions after a bounded confirmation window.
-- A task is eligible only when no provider receipt, delivered asset, billing
-- operation, revenue record, or worker-owned lifecycle record exists.

BEGIN;

CREATE OR REPLACE FUNCTION public.expire_video_submission_confirmations_atomic(
  p_user_id text,
  p_timeout_seconds integer DEFAULT 1800
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expired_ids text[] := ARRAY[]::text[];
BEGIN
  IF nullif(trim(coalesce(p_user_id, '')), '') IS NULL
     OR p_timeout_seconds < 300
     OR p_timeout_seconds > 86400 THEN
    RAISE EXCEPTION 'VIDEO_SUBMISSION_EXPIRY_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT t.id
      FROM public.video_tasks t
     WHERE t.user_id::text = trim(p_user_id)
       AND t.status IN ('pending', 'queued')
       AND t.billing_state = 'reserved'
       AND t.submission_error_code = 'VIDEO_SUBMIT_OUTCOME_UNKNOWN'
       AND nullif(trim(coalesce(t.task_id_external, '')), '') IS NULL
       AND nullif(trim(coalesce(t.provider_result_url, '')), '') IS NULL
       AND nullif(trim(coalesce(t.storage_url, '')), '') IS NULL
       AND nullif(trim(coalesce(t.video_url, '')), '') IS NULL
       AND coalesce(t.price_charged, 0) = 0
       AND t.billing_operation_id IS NULL
       AND coalesce(t.task_label, '') NOT LIKE 'digital-human:%'
       AND t.created_at <= now() - make_interval(secs => p_timeout_seconds)
       AND NOT EXISTS (
         SELECT 1 FROM public.wallet_operations o
          WHERE o.user_id::text = trim(p_user_id)
            AND o.idempotency_key = t.billing_idempotency_key
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.wallet_ledger_entries l
          WHERE l.user_id::text = trim(p_user_id)
            AND l.idempotency_key = t.billing_idempotency_key
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.cash_transactions c
          WHERE c.user_id::text = trim(p_user_id)
            AND c.reference_id = t.billing_idempotency_key
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.revenue_records r
          WHERE r.user_id::text = trim(p_user_id)
            AND r.task_id = t.id::text
            AND r.record_type = 'video'
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.user_files f
          WHERE f.user_id::text = trim(p_user_id)
            AND f.meta->>'taskId' = t.id::text
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.digital_video_dispatch_jobs q
          WHERE q.task_id = t.id::text
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.autodl_h3_jobs h
          WHERE h.video_task_internal_id = t.id::text
       )
     FOR UPDATE OF t SKIP LOCKED
  ), updated AS (
    UPDATE public.video_tasks t
       SET status = 'failed',
           billing_state = 'submission_failed',
           submission_error_code = 'VIDEO_SUBMISSION_CONFIRMATION_EXPIRED',
           error_message = '超过确认时限且未取得上游任务编号，本次未扣费；可重新发起新任务',
           provider_progress = NULL,
           provider_status_message = '提交确认已结束，本次未扣费',
           provider_last_polled_at = now(),
           completed_at = now(),
           price_charged = 0
      FROM candidates c
     WHERE t.id = c.id
     RETURNING t.id::text
  )
  SELECT coalesce(array_agg(id), ARRAY[]::text[])
    INTO v_expired_ids
    FROM updated;

  RETURN jsonb_build_object(
    'expired_count', cardinality(v_expired_ids),
    'task_ids', to_jsonb(v_expired_ids),
    'charged_yuan', 0
  );
END
$$;

REVOKE ALL ON FUNCTION public.expire_video_submission_confirmations_atomic(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_video_submission_confirmations_atomic(text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.expire_video_submission_confirmations_atomic(text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_video_submission_confirmations_atomic(text, integer) TO service_role;

COMMENT ON FUNCTION public.expire_video_submission_confirmations_atomic(text, integer) IS
  'Terminates stale unknown video submissions only when provider, asset, lifecycle, and billing evidence are all absent.';

COMMIT;
