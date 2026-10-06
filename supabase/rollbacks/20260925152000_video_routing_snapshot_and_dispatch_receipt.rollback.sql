-- Application rollback only. Provider dispatch evidence is billing and
-- duplicate-charge safety data, so rollback deliberately preserves the new
-- columns and the fail-closed expiry definition instead of deleting evidence.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.reserve_queued_digital_video_task_routing_atomic(jsonb,jsonb,jsonb);
DROP FUNCTION IF EXISTS public.reserve_video_generation_task_routing_atomic(
  text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,
  text,text,text,text,integer,text,text,text,text,text,text,numeric,text
);
DROP FUNCTION IF EXISTS public.record_video_provider_submission_receipt_atomic(text,text,text,text,text,jsonb);
DROP FUNCTION IF EXISTS public.record_video_provider_dispatch_receipt_atomic(text,text,text,jsonb);
DROP FUNCTION IF EXISTS public.persist_video_routing_snapshot_atomic(text,text,text,jsonb);

-- Do not restore the pre-migration timeout behavior: a row with durable POST
-- evidence must remain non-retryable even when older application code runs.
COMMENT ON FUNCTION public.expire_video_submission_confirmations_atomic(text, integer) IS
  'Safety definition retained across application rollback: provider-dispatched unknown tasks require reconciliation or explicit termination.';

NOTIFY pgrst, 'reload schema';
COMMIT;
