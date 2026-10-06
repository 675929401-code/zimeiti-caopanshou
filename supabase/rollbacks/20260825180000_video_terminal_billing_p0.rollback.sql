-- Destructive manual rollback for 20260825180000_video_terminal_billing_p0.sql.
-- Run only after stopping all video submit/status/stream processes.

BEGIN;
SET LOCAL lock_timeout = '10s';

DO $rollback_guard$
DECLARE
  v_task_evidence_exists boolean := false;
BEGIN
  IF to_regclass('public.digital_video_dispatch_jobs') IS NOT NULL
     OR to_regclass('public.digital_human_long_jobs') IS NOT NULL
     OR to_regprocedure('public.finalize_video_generation_failure_atomic(text,text,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_VIDEO_DEPENDENT_MIGRATION_PRESENT'
      USING ERRCODE = '2BP01';
  END IF;

  IF to_regclass('public.video_tasks') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.video_tasks LIMIT 1)'
      INTO v_task_evidence_exists;
    IF v_task_evidence_exists THEN
      RAISE EXCEPTION 'ROLLBACK_BLOCKED_VIDEO_TASK_EVIDENCE_EXISTS'
        USING ERRCODE = '55000';
    END IF;
  END IF;
END
$rollback_guard$;

DROP FUNCTION IF EXISTS public.finalize_video_generation_task_atomic(text, text, text, text, bigint, boolean);
DROP FUNCTION IF EXISTS public.fail_video_generation_submission_atomic(text, text, text, text, text);
DROP FUNCTION IF EXISTS public.bind_video_provider_task_atomic(text, text, text, text, text);
DROP FUNCTION IF EXISTS public.reserve_video_generation_task_atomic(
  text, text, text, text, text, numeric, numeric, text, numeric, boolean,
  boolean, text, text, text, text, integer, text, text, text, text, text,
  text, integer, text
);

DROP INDEX IF EXISTS public.video_tasks_terminal_billing_state_idx;
DROP INDEX IF EXISTS public.video_tasks_user_client_request_once_idx;

ALTER TABLE public.video_tasks
  DROP CONSTRAINT IF EXISTS video_tasks_terminal_billing_state_check,
  DROP CONSTRAINT IF EXISTS video_tasks_billing_snapshot_check,
  DROP CONSTRAINT IF EXISTS video_tasks_request_fingerprint_check,
  DROP COLUMN IF EXISTS submission_error_code,
  DROP COLUMN IF EXISTS billing_exempt,
  DROP COLUMN IF EXISTS explicitly_free,
  DROP COLUMN IF EXISTS provider_result_url,
  DROP COLUMN IF EXISTS billing_idempotency_key,
  DROP COLUMN IF EXISTS billing_operation_id,
  DROP COLUMN IF EXISTS billing_state,
  DROP COLUMN IF EXISTS billing_quantity,
  DROP COLUMN IF EXISTS billing_unit,
  DROP COLUMN IF EXISTS billing_cost_price_yuan,
  DROP COLUMN IF EXISTS billing_price_yuan,
  DROP COLUMN IF EXISTS request_fingerprint,
  DROP COLUMN IF EXISTS client_request_id;

NOTIFY pgrst, 'reload schema';
COMMIT;
