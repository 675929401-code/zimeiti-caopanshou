-- Freeze the non-secret provider routing contract for every accepted video
-- task. A provider POST is allowed only after its redacted dispatch receipt is
-- durable. Unknown submissions with such a receipt are reconciliation work;
-- they must never age into a retryable failure automatically.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.video_tasks
  ADD COLUMN IF NOT EXISTS routing_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS routing_snapshot_hash text,
  ADD COLUMN IF NOT EXISTS routing_snapshot_version integer,
  ADD COLUMN IF NOT EXISTS provider_dispatch_receipt jsonb,
  ADD COLUMN IF NOT EXISTS provider_submission_receipt jsonb,
  ADD COLUMN IF NOT EXISTS provider_dispatch_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_reconciliation_state text;

ALTER TABLE public.video_tasks
  DROP CONSTRAINT IF EXISTS video_tasks_routing_snapshot_check,
  ADD CONSTRAINT video_tasks_routing_snapshot_check CHECK (
    routing_snapshot IS NULL OR (
      jsonb_typeof(routing_snapshot) = 'object'
      AND routing_snapshot_version = 1
      AND routing_snapshot_hash ~ '^[0-9a-f]{64}$'
      AND routing_snapshot->>'configVersion' = routing_snapshot_hash
      AND routing_snapshot->>'modelId' = model_id::text
      AND routing_snapshot->>'apiEndpoint' ~ '^https?://'
      AND routing_snapshot->>'provider' <> ''
      AND routing_snapshot->>'protocolType' <> ''
      AND routing_snapshot->>'modelName' <> ''
      AND routing_snapshot->>'credentialRef' ~ '^(secret://[a-z0-9][a-z0-9._-]{0,127}|env://[A-Z][A-Z0-9_]{1,127}|video-model://[A-Za-z0-9._:-]{1,160}/api-key)$'
      AND pg_column_size(routing_snapshot) <= 32768
    )
  ),
  DROP CONSTRAINT IF EXISTS video_tasks_provider_dispatch_receipt_check,
  ADD CONSTRAINT video_tasks_provider_dispatch_receipt_check CHECK (
    provider_dispatch_receipt IS NULL OR (
      jsonb_typeof(provider_dispatch_receipt) = 'object'
      AND provider_dispatch_receipt->>'schemaVersion' = '1'
      AND jsonb_typeof(provider_dispatch_receipt->'requests') = 'array'
      AND pg_column_size(provider_dispatch_receipt) <= 32768
    )
  ),
  DROP CONSTRAINT IF EXISTS video_tasks_provider_submission_receipt_check,
  ADD CONSTRAINT video_tasks_provider_submission_receipt_check CHECK (
    provider_submission_receipt IS NULL OR (
      jsonb_typeof(provider_submission_receipt) = 'object'
      AND provider_submission_receipt->>'schemaVersion' = '1'
      AND jsonb_typeof(provider_submission_receipt->'events') = 'array'
      AND pg_column_size(provider_submission_receipt) <= 32768
    )
  ),
  DROP CONSTRAINT IF EXISTS video_tasks_provider_reconciliation_state_check,
  ADD CONSTRAINT video_tasks_provider_reconciliation_state_check CHECK (
    provider_reconciliation_state IS NULL OR provider_reconciliation_state IN (
      'dispatch_recorded', 'reconciliation_required', 'acknowledged', 'manual_terminated'
    )
  );

CREATE INDEX IF NOT EXISTS video_tasks_provider_reconciliation_idx
  ON public.video_tasks (provider_reconciliation_state, provider_dispatch_started_at, created_at)
  WHERE provider_reconciliation_state = 'reconciliation_required';

CREATE OR REPLACE FUNCTION public.persist_video_routing_snapshot_atomic(
  p_task_id text,
  p_user_id text,
  p_request_fingerprint text,
  p_routing_snapshot jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_hash text := lower(trim(coalesce(p_routing_snapshot->>'configVersion', '')));
BEGIN
  IF nullif(trim(coalesce(p_task_id, '')), '') IS NULL
     OR nullif(trim(coalesce(p_user_id, '')), '') IS NULL
     OR lower(trim(coalesce(p_request_fingerprint, ''))) !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(p_routing_snapshot) IS DISTINCT FROM 'object'
     OR p_routing_snapshot->>'schemaVersion' IS DISTINCT FROM '1'
     OR p_routing_snapshot->>'modelId' IS NULL
     OR p_routing_snapshot->>'apiEndpoint' !~ '^https?://'
     OR coalesce(p_routing_snapshot->>'provider', '') = ''
     OR coalesce(p_routing_snapshot->>'protocolType', '') = ''
     OR coalesce(p_routing_snapshot->>'modelName', '') = ''
     OR coalesce(p_routing_snapshot->>'credentialRef', '') !~ '^(secret://[a-z0-9][a-z0-9._-]{0,127}|env://[A-Z][A-Z0-9_]{1,127}|video-model://[A-Za-z0-9._:-]{1,160}/api-key)$'
     OR v_hash !~ '^[0-9a-f]{64}$'
     OR pg_column_size(p_routing_snapshot) > 32768 THEN
    RAISE EXCEPTION 'VIDEO_ROUTING_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_task
    FROM public.video_tasks
   WHERE id::text = trim(p_task_id)
     AND user_id::text = trim(p_user_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VIDEO_ROUTING_TASK_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_task.request_fingerprint IS DISTINCT FROM lower(trim(p_request_fingerprint))
     OR v_task.model_id::text IS DISTINCT FROM p_routing_snapshot->>'modelId' THEN
    RAISE EXCEPTION 'VIDEO_ROUTING_TASK_IDENTITY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF v_task.routing_snapshot IS NOT NULL
     AND (v_task.routing_snapshot IS DISTINCT FROM p_routing_snapshot
          OR v_task.routing_snapshot_hash IS DISTINCT FROM v_hash) THEN
    RAISE EXCEPTION 'VIDEO_ROUTING_SNAPSHOT_IMMUTABLE_CONFLICT' USING ERRCODE = '23505';
  END IF;

  UPDATE public.video_tasks
     SET routing_snapshot = p_routing_snapshot,
         routing_snapshot_hash = v_hash,
         routing_snapshot_version = 1
   WHERE id = v_task.id
     AND routing_snapshot IS NULL;

  RETURN jsonb_build_object(
    'task_id', v_task.id,
    'routing_snapshot_hash', v_hash,
    'created', v_task.routing_snapshot IS NULL
  );
END
$$;

-- Versioned wrappers make application-before-migration rollout fail closed.
-- The nested reservation and snapshot update share one PostgreSQL transaction.
CREATE FUNCTION public.reserve_video_generation_task_routing_atomic(
  p_task_id text,
  p_user_id text,
  p_model_id text,
  p_client_request_id text,
  p_request_fingerprint text,
  p_billing_price_yuan numeric,
  p_billing_cost_price_yuan numeric,
  p_billing_unit text,
  p_billing_quantity numeric,
  p_explicitly_free boolean,
  p_billing_exempt boolean,
  p_routing_snapshot jsonb,
  p_provider_task_id text DEFAULT NULL,
  p_task_label text DEFAULT NULL,
  p_batch_id text DEFAULT NULL,
  p_batch_topic text DEFAULT NULL,
  p_card_index integer DEFAULT NULL,
  p_prompt text DEFAULT '',
  p_first_frame_url text DEFAULT NULL,
  p_last_frame_url text DEFAULT NULL,
  p_reference_image_url text DEFAULT NULL,
  p_aspect_ratio text DEFAULT '16:9',
  p_resolution text DEFAULT NULL,
  p_duration_seconds numeric DEFAULT 5,
  p_content_url text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_snapshot_result jsonb;
BEGIN
  v_result := public.reserve_video_generation_task_budget_atomic(
    p_task_id => p_task_id,
    p_user_id => p_user_id,
    p_model_id => p_model_id,
    p_client_request_id => p_client_request_id,
    p_request_fingerprint => p_request_fingerprint,
    p_billing_price_yuan => p_billing_price_yuan,
    p_billing_cost_price_yuan => p_billing_cost_price_yuan,
    p_billing_unit => p_billing_unit,
    p_billing_quantity => p_billing_quantity,
    p_explicitly_free => p_explicitly_free,
    p_billing_exempt => p_billing_exempt,
    p_provider_task_id => p_provider_task_id,
    p_task_label => p_task_label,
    p_batch_id => p_batch_id,
    p_batch_topic => p_batch_topic,
    p_card_index => p_card_index,
    p_prompt => p_prompt,
    p_first_frame_url => p_first_frame_url,
    p_last_frame_url => p_last_frame_url,
    p_reference_image_url => p_reference_image_url,
    p_aspect_ratio => p_aspect_ratio,
    p_resolution => p_resolution,
    p_duration_seconds => p_duration_seconds,
    p_content_url => p_content_url
  );
  v_snapshot_result := public.persist_video_routing_snapshot_atomic(
    p_task_id, p_user_id, p_request_fingerprint, p_routing_snapshot
  );
  RETURN v_result || jsonb_build_object(
    'routing_snapshot_hash', v_snapshot_result->>'routing_snapshot_hash'
  );
END
$$;

CREATE FUNCTION public.reserve_queued_digital_video_task_routing_atomic(
  p_task jsonb,
  p_dispatch jsonb,
  p_routing_snapshot jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_snapshot_result jsonb;
BEGIN
  v_result := public.reserve_queued_digital_video_task_budget_atomic(p_task, p_dispatch);
  v_snapshot_result := public.persist_video_routing_snapshot_atomic(
    p_task->>'p_task_id',
    p_task->>'p_user_id',
    p_task->>'p_request_fingerprint',
    p_routing_snapshot
  );
  RETURN v_result || jsonb_build_object(
    'routing_snapshot_hash', v_snapshot_result->>'routing_snapshot_hash'
  );
END
$$;

CREATE OR REPLACE FUNCTION public.record_video_provider_dispatch_receipt_atomic(
  p_task_id text,
  p_user_id text,
  p_request_fingerprint text,
  p_receipt jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_receipts jsonb;
BEGIN
  IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object'
     OR p_receipt->>'schemaVersion' IS DISTINCT FROM '1'
     OR coalesce(p_receipt->>'endpointHost', '') = ''
     OR p_receipt->>'endpointHost' LIKE '%://%'
     OR coalesce(p_receipt->>'routingConfigVersion', '') !~ '^[0-9a-f]{64}$'
     OR pg_column_size(p_receipt) > 8192 THEN
    RAISE EXCEPTION 'VIDEO_PROVIDER_DISPATCH_RECEIPT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_task
    FROM public.video_tasks
   WHERE id::text = trim(p_task_id)
     AND user_id::text = trim(p_user_id)
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VIDEO_PROVIDER_DISPATCH_TASK_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_task.request_fingerprint IS DISTINCT FROM lower(trim(p_request_fingerprint))
     OR v_task.routing_snapshot IS NULL
     OR v_task.routing_snapshot_hash IS DISTINCT FROM p_receipt->>'routingConfigVersion'
     OR v_task.status IN ('completed', 'failed', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'VIDEO_PROVIDER_DISPATCH_NOT_ALLOWED' USING ERRCODE = '23514';
  END IF;
  v_receipts := coalesce(v_task.provider_dispatch_receipt, '{"schemaVersion":1,"requests":[]}'::jsonb);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_receipts->'requests') item WHERE item = p_receipt) THEN
    IF jsonb_array_length(v_receipts->'requests') >= 16 THEN
      RAISE EXCEPTION 'VIDEO_PROVIDER_DISPATCH_RECEIPT_LIMIT' USING ERRCODE = '54000';
    END IF;
    v_receipts := jsonb_set(v_receipts, '{requests}', (v_receipts->'requests') || jsonb_build_array(p_receipt));
  END IF;
  UPDATE public.video_tasks
     SET provider_dispatch_receipt = v_receipts,
         provider_dispatch_started_at = coalesce(provider_dispatch_started_at, clock_timestamp()),
         provider_reconciliation_state = CASE
           WHEN provider_reconciliation_state = 'acknowledged' THEN provider_reconciliation_state
           ELSE 'dispatch_recorded'
         END
   WHERE id = v_task.id;
  RETURN jsonb_build_object('task_id', v_task.id, 'dispatch_recorded', true);
END
$$;

CREATE OR REPLACE FUNCTION public.record_video_provider_submission_receipt_atomic(
  p_task_id text,
  p_user_id text,
  p_request_fingerprint text,
  p_outcome text,
  p_provider_task_id text,
  p_receipt jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_receipts jsonb;
  v_event jsonb;
  v_provider_task_id text := nullif(trim(coalesce(p_provider_task_id, '')), '');
BEGIN
  IF p_outcome NOT IN ('unknown', 'acknowledged')
     OR (p_outcome = 'acknowledged' AND v_provider_task_id IS NULL)
     OR jsonb_typeof(p_receipt) IS DISTINCT FROM 'object'
     OR p_receipt->>'schemaVersion' IS DISTINCT FROM '1'
     OR pg_column_size(p_receipt) > 8192 THEN
    RAISE EXCEPTION 'VIDEO_PROVIDER_SUBMISSION_RECEIPT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_task
    FROM public.video_tasks
   WHERE id::text = trim(p_task_id)
     AND user_id::text = trim(p_user_id)
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VIDEO_PROVIDER_SUBMISSION_TASK_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_task.request_fingerprint IS DISTINCT FROM lower(trim(p_request_fingerprint))
     OR v_task.provider_dispatch_started_at IS NULL
     OR v_task.provider_dispatch_receipt IS NULL THEN
    RAISE EXCEPTION 'VIDEO_PROVIDER_SUBMISSION_RECEIPT_WITHOUT_DISPATCH' USING ERRCODE = '23514';
  END IF;
  v_event := jsonb_build_object(
    'outcome', p_outcome,
    'providerTaskIdHash', CASE WHEN v_provider_task_id IS NULL THEN NULL ELSE encode(sha256(convert_to(v_provider_task_id, 'UTF8')), 'hex') END,
    'receipt', p_receipt
  );
  v_receipts := coalesce(v_task.provider_submission_receipt, '{"schemaVersion":1,"events":[]}'::jsonb);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_receipts->'events') item WHERE item = v_event) THEN
    IF jsonb_array_length(v_receipts->'events') >= 16 THEN
      RAISE EXCEPTION 'VIDEO_PROVIDER_SUBMISSION_RECEIPT_LIMIT' USING ERRCODE = '54000';
    END IF;
    v_receipts := jsonb_set(v_receipts, '{events}', (v_receipts->'events') || jsonb_build_array(v_event));
  END IF;
  UPDATE public.video_tasks
     SET provider_submission_receipt = v_receipts,
         provider_acknowledged_at = CASE WHEN p_outcome = 'acknowledged' THEN coalesce(provider_acknowledged_at, clock_timestamp()) ELSE provider_acknowledged_at END,
         provider_reconciliation_state = CASE WHEN p_outcome = 'acknowledged' THEN 'acknowledged' ELSE 'reconciliation_required' END,
         status = CASE WHEN p_outcome = 'unknown' THEN 'pending' ELSE status END,
         submission_error_code = CASE WHEN p_outcome = 'unknown' THEN 'VIDEO_SUBMIT_OUTCOME_UNKNOWN' ELSE submission_error_code END,
         error_message = CASE WHEN p_outcome = 'unknown' THEN '上游提交结果尚未确认，系统将保留原任务且不会重复提交' ELSE error_message END,
         completed_at = CASE WHEN p_outcome = 'unknown' THEN NULL ELSE completed_at END
   WHERE id = v_task.id;
  RETURN jsonb_build_object(
    'task_id', v_task.id,
    'outcome', p_outcome,
    'reconciliation_state', CASE WHEN p_outcome = 'acknowledged' THEN 'acknowledged' ELSE 'reconciliation_required' END
  );
END
$$;

-- Replace the legacy timeout release. Only tasks for which no provider POST was
-- recorded may expire automatically. Any dispatch evidence remains reserved
-- and requires provider reconciliation or an explicit operator/user terminal.
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
  v_protected_count integer := 0;
BEGIN
  IF nullif(trim(coalesce(p_user_id, '')), '') IS NULL
     OR p_timeout_seconds < 300
     OR p_timeout_seconds > 86400 THEN
    RAISE EXCEPTION 'VIDEO_SUBMISSION_EXPIRY_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::integer INTO v_protected_count
    FROM public.video_tasks t
   WHERE t.user_id::text = trim(p_user_id)
     AND t.status IN ('pending', 'queued')
     AND t.billing_state = 'reserved'
     AND t.submission_error_code = 'VIDEO_SUBMIT_OUTCOME_UNKNOWN'
     AND t.created_at <= now() - make_interval(secs => p_timeout_seconds)
     AND (
       t.provider_dispatch_started_at IS NOT NULL
       OR t.provider_dispatch_receipt IS NOT NULL
       OR t.provider_submission_receipt IS NOT NULL
       OR t.provider_reconciliation_state IN ('dispatch_recorded', 'reconciliation_required', 'acknowledged')
     );

  WITH candidates AS MATERIALIZED (
    SELECT t.id
      FROM public.video_tasks t
     WHERE t.user_id::text = trim(p_user_id)
       AND t.status IN ('pending', 'queued')
       AND t.billing_state = 'reserved'
       AND t.submission_error_code = 'VIDEO_SUBMIT_OUTCOME_UNKNOWN'
       AND nullif(trim(coalesce(t.task_id_external, '')), '') IS NULL
       AND t.provider_dispatch_started_at IS NULL
       AND t.provider_dispatch_receipt IS NULL
       AND t.provider_submission_receipt IS NULL
       AND t.provider_reconciliation_state IS NULL
       AND nullif(trim(coalesce(t.provider_result_url, '')), '') IS NULL
       AND nullif(trim(coalesce(t.storage_url, '')), '') IS NULL
       AND nullif(trim(coalesce(t.video_url, '')), '') IS NULL
       AND coalesce(t.price_charged, 0) = 0
       AND t.billing_operation_id IS NULL
       AND coalesce(t.task_label, '') NOT LIKE 'digital-human:%'
       AND t.created_at <= now() - make_interval(secs => p_timeout_seconds)
       AND NOT EXISTS (SELECT 1 FROM public.wallet_operations o WHERE o.user_id::text = trim(p_user_id) AND o.idempotency_key = t.billing_idempotency_key)
       AND NOT EXISTS (SELECT 1 FROM public.wallet_ledger_entries l WHERE l.user_id::text = trim(p_user_id) AND l.idempotency_key = t.billing_idempotency_key)
       AND NOT EXISTS (SELECT 1 FROM public.cash_transactions c WHERE c.user_id::text = trim(p_user_id) AND c.reference_id = t.billing_idempotency_key)
       AND NOT EXISTS (SELECT 1 FROM public.revenue_records r WHERE r.user_id::text = trim(p_user_id) AND r.task_id = t.id::text AND r.record_type = 'video')
       AND NOT EXISTS (SELECT 1 FROM public.user_files f WHERE f.user_id::text = trim(p_user_id) AND f.meta->>'taskId' = t.id::text)
       AND NOT EXISTS (SELECT 1 FROM public.digital_video_dispatch_jobs q WHERE q.task_id = t.id::text)
       AND NOT EXISTS (SELECT 1 FROM public.autodl_h3_jobs h WHERE h.video_task_internal_id = t.id::text)
     FOR UPDATE OF t SKIP LOCKED
  ), updated AS (
    UPDATE public.video_tasks t
       SET status = 'failed',
           billing_state = 'submission_failed',
           submission_error_code = 'VIDEO_SUBMISSION_CONFIRMATION_EXPIRED',
           error_message = '提交前未产生任何上游投递证据，本次未扣费；可以重新发起任务',
           provider_progress = NULL,
           provider_status_message = '本次未投递上游，确认已结束且未扣费',
           provider_last_polled_at = now(),
           completed_at = now(),
           price_charged = 0
      FROM candidates c
     WHERE t.id = c.id
     RETURNING t.id::text
  )
  SELECT coalesce(array_agg(id), ARRAY[]::text[]) INTO v_expired_ids FROM updated;

  RETURN jsonb_build_object(
    'expired_count', cardinality(v_expired_ids),
    'protected_dispatch_count', v_protected_count,
    'task_ids', to_jsonb(v_expired_ids),
    'charged_yuan', 0
  );
END
$$;

REVOKE ALL ON FUNCTION public.persist_video_routing_snapshot_atomic(text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_video_generation_task_routing_atomic(
  text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,
  text,text,text,text,integer,text,text,text,text,text,text,numeric,text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_queued_digital_video_task_routing_atomic(jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_video_provider_dispatch_receipt_atomic(text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_video_provider_submission_receipt_atomic(text,text,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.persist_video_routing_snapshot_atomic(text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_video_generation_task_routing_atomic(
  text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,
  text,text,text,text,integer,text,text,text,text,text,text,numeric,text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_queued_digital_video_task_routing_atomic(jsonb,jsonb,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_video_provider_dispatch_receipt_atomic(text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_video_provider_submission_receipt_atomic(text,text,text,text,text,jsonb) TO service_role;

COMMENT ON COLUMN public.video_tasks.routing_snapshot IS
  'Immutable non-secret provider endpoint/protocol/model/config snapshot captured in the reservation transaction.';
COMMENT ON COLUMN public.video_tasks.provider_dispatch_receipt IS
  'Redacted provider POST routing receipts durably written before network dispatch.';
COMMENT ON COLUMN public.video_tasks.provider_submission_receipt IS
  'Redacted response/transport evidence used to reconcile an ambiguous provider acknowledgement.';
COMMENT ON FUNCTION public.expire_video_submission_confirmations_atomic(text, integer) IS
  'Expires only never-dispatched stale reservations; any durable provider dispatch evidence remains reconciliation-required.';

NOTIFY pgrst, 'reload schema';
COMMIT;
