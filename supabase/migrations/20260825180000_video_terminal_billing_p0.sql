-- Video terminal billing P0.
--
-- This migration makes the business video task the durable idempotency and
-- delivery boundary. A provider success is not a user-visible completion until
-- an owned permanent asset and an attested atomic-wallet operation have both
-- been committed.

ALTER TABLE public.video_tasks
  ADD COLUMN IF NOT EXISTS client_request_id text,
  ADD COLUMN IF NOT EXISTS request_fingerprint text,
  ADD COLUMN IF NOT EXISTS billing_price_yuan numeric(14,4),
  ADD COLUMN IF NOT EXISTS billing_cost_price_yuan numeric(14,4),
  ADD COLUMN IF NOT EXISTS billing_unit text,
  ADD COLUMN IF NOT EXISTS billing_quantity numeric(14,4),
  ADD COLUMN IF NOT EXISTS billing_state text,
  ADD COLUMN IF NOT EXISTS billing_operation_id bigint,
  ADD COLUMN IF NOT EXISTS billing_idempotency_key text,
  ADD COLUMN IF NOT EXISTS provider_result_url text,
  ADD COLUMN IF NOT EXISTS explicitly_free boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_exempt boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS submission_error_code text;

CREATE UNIQUE INDEX IF NOT EXISTS video_tasks_user_client_request_once_idx
  ON public.video_tasks (user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS video_tasks_terminal_billing_state_idx
  ON public.video_tasks (billing_state, status, completed_at DESC);

ALTER TABLE public.video_tasks
  DROP CONSTRAINT IF EXISTS video_tasks_request_fingerprint_check,
  ADD CONSTRAINT video_tasks_request_fingerprint_check CHECK (
    request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  DROP CONSTRAINT IF EXISTS video_tasks_billing_snapshot_check,
  ADD CONSTRAINT video_tasks_billing_snapshot_check CHECK (
    (billing_price_yuan IS NULL OR billing_price_yuan >= 0)
    AND (billing_cost_price_yuan IS NULL OR billing_cost_price_yuan >= 0)
    AND (billing_quantity IS NULL OR billing_quantity > 0)
    AND (billing_unit IS NULL OR billing_unit IN ('per_use', 'output_second'))
  ),
  DROP CONSTRAINT IF EXISTS video_tasks_terminal_billing_state_check,
  ADD CONSTRAINT video_tasks_terminal_billing_state_check CHECK (
    billing_state IS NULL OR billing_state IN (
      'reserved',
      'provider_submitted',
      'submission_failed',
      'asset_persisting',
      'asset_failed',
      'billing_pending',
      'failed',
      'settled_pending_commit',
      'settled',
      'legacy_h3_settled',
      'not_required'
    )
  );

CREATE OR REPLACE FUNCTION public.reserve_video_generation_task_atomic(
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
  p_duration_seconds integer DEFAULT 5,
  p_content_url text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_created boolean := false;
  v_price numeric(14,4);
  v_cost numeric(14,4);
  v_quantity numeric(14,4);
  v_client_request_id text := trim(coalesce(p_client_request_id, ''));
  v_fingerprint text := lower(trim(coalesce(p_request_fingerprint, '')));
  v_provider_task_id text := nullif(trim(coalesce(p_provider_task_id, '')), '');
BEGIN
  IF trim(coalesce(p_task_id, '')) = ''
     OR trim(coalesce(p_user_id, '')) = ''
     OR trim(coalesce(p_model_id, '')) = ''
     OR v_client_request_id !~ '^[A-Za-z0-9._:-]{8,128}$'
     OR v_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'VIDEO_TASK_RESERVATION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_billing_price_yuan IS NULL
     OR p_billing_cost_price_yuan IS NULL
     OR p_billing_quantity IS NULL
     OR p_billing_price_yuan::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_billing_cost_price_yuan::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_billing_quantity::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'VIDEO_TASK_PRICE_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_price := round(p_billing_price_yuan, 4);
  v_cost := round(p_billing_cost_price_yuan, 4);
  v_quantity := round(p_billing_quantity, 4);
  IF v_price < 0 OR v_cost < 0 OR v_quantity <= 0
     OR trim(coalesce(p_billing_unit, '')) NOT IN ('per_use', 'output_second')
     OR (coalesce(p_explicitly_free, false) IS NOT TRUE
         AND coalesce(p_billing_exempt, false) IS NOT TRUE
         AND round(v_price, 2) <= 0) THEN
    RAISE EXCEPTION 'VIDEO_TASK_PRICE_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Serialize first submit and all concurrent replays for the same account key.
  PERFORM pg_advisory_xact_lock(hashtextextended(trim(p_user_id) || ':' || v_client_request_id, 0));

  SELECT * INTO v_task
    FROM public.video_tasks
   WHERE user_id::text = trim(p_user_id)
     AND client_request_id = v_client_request_id
   FOR UPDATE;

  IF FOUND THEN
    IF v_task.id::text IS DISTINCT FROM trim(p_task_id)
       OR v_task.model_id::text IS DISTINCT FROM trim(p_model_id)
       OR v_task.request_fingerprint IS DISTINCT FROM v_fingerprint
       OR v_task.billing_price_yuan IS DISTINCT FROM v_price
       OR v_task.billing_cost_price_yuan IS DISTINCT FROM v_cost
       OR v_task.billing_unit IS DISTINCT FROM trim(p_billing_unit)
       OR v_task.billing_quantity IS DISTINCT FROM v_quantity
       OR coalesce(v_task.explicitly_free, false) IS DISTINCT FROM coalesce(p_explicitly_free, false)
       OR coalesce(v_task.billing_exempt, false) IS DISTINCT FROM coalesce(p_billing_exempt, false)
       OR (v_provider_task_id IS NOT NULL
           AND v_task.task_id_external IS NOT NULL
           AND v_task.task_id_external IS DISTINCT FROM v_provider_task_id) THEN
      RAISE EXCEPTION 'VIDEO_REQUEST_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'created', false,
      'task_id', v_task.id,
      'status', v_task.status,
      'billing_state', v_task.billing_state,
      'provider_task_id', coalesce(v_task.task_id_external, '')
    );
  END IF;

  INSERT INTO public.video_tasks (
    id, user_id, model_id, task_label, batch_id, batch_topic, card_index,
    prompt, first_frame_url, last_frame_url, reference_image_url,
    aspect_ratio, resolution, duration_seconds, status, task_id_external,
    content_url, error_message, price_charged, completed_at,
    client_request_id, request_fingerprint, billing_price_yuan,
    billing_cost_price_yuan, billing_unit, billing_quantity, billing_state,
    billing_idempotency_key, explicitly_free, billing_exempt
  ) VALUES (
    trim(p_task_id), trim(p_user_id), trim(p_model_id), p_task_label,
    p_batch_id, p_batch_topic, p_card_index, coalesce(p_prompt, ''),
    p_first_frame_url, p_last_frame_url, p_reference_image_url,
    coalesce(nullif(trim(p_aspect_ratio), ''), '16:9'), p_resolution,
    greatest(coalesce(p_duration_seconds, 5), 1), 'pending',
    v_provider_task_id, p_content_url,
    CASE WHEN v_provider_task_id IS NULL
      THEN '任务已安全登记，等待供应商接收'
      ELSE '任务已安全登记，等待供应商处理'
    END,
    0, NULL, v_client_request_id, v_fingerprint, v_price, v_cost,
    trim(p_billing_unit), v_quantity,
    CASE WHEN v_provider_task_id IS NULL THEN 'reserved' ELSE 'provider_submitted' END,
    'video-terminal:' || trim(p_task_id),
    coalesce(p_explicitly_free, false), coalesce(p_billing_exempt, false)
  ) RETURNING * INTO v_task;
  v_created := true;

  RETURN jsonb_build_object(
    'created', v_created,
    'task_id', v_task.id,
    'status', v_task.status,
    'billing_state', v_task.billing_state,
    'provider_task_id', coalesce(v_task.task_id_external, '')
  );
END
$$;

CREATE OR REPLACE FUNCTION public.bind_video_provider_task_atomic(
  p_task_id text,
  p_user_id text,
  p_request_fingerprint text,
  p_provider_task_id text,
  p_content_url text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_provider_task_id text := trim(coalesce(p_provider_task_id, ''));
BEGIN
  IF v_provider_task_id = '' THEN
    RAISE EXCEPTION 'VIDEO_PROVIDER_TASK_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_task
    FROM public.video_tasks
   WHERE id::text = trim(p_task_id)
     AND user_id::text = trim(p_user_id)
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VIDEO_TASK_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_task.request_fingerprint IS DISTINCT FROM lower(trim(p_request_fingerprint)) THEN
    RAISE EXCEPTION 'VIDEO_REQUEST_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  IF v_task.task_id_external IS NOT NULL
     AND v_task.task_id_external IS DISTINCT FROM v_provider_task_id THEN
    RAISE EXCEPTION 'VIDEO_PROVIDER_TASK_CONFLICT' USING ERRCODE = '23505';
  END IF;
  IF v_task.status = 'completed' AND v_task.task_id_external IS DISTINCT FROM v_provider_task_id THEN
    RAISE EXCEPTION 'VIDEO_PROVIDER_TASK_CONFLICT' USING ERRCODE = '23505';
  END IF;

  UPDATE public.video_tasks
     SET task_id_external = v_provider_task_id,
         content_url = coalesce(nullif(trim(coalesce(p_content_url, '')), ''), content_url),
         billing_state = CASE WHEN status = 'completed' THEN billing_state ELSE 'provider_submitted' END,
         error_message = CASE WHEN status = 'completed' THEN error_message ELSE '供应商已接收任务，等待生成终态' END,
         submission_error_code = NULL,
         completed_at = CASE WHEN status = 'completed' THEN completed_at ELSE NULL END
   WHERE id = v_task.id
   RETURNING * INTO v_task;

  RETURN jsonb_build_object(
    'task_id', v_task.id,
    'provider_task_id', v_task.task_id_external,
    'status', v_task.status,
    'billing_state', v_task.billing_state
  );
END
$$;

CREATE OR REPLACE FUNCTION public.fail_video_generation_submission_atomic(
  p_task_id text,
  p_user_id text,
  p_request_fingerprint text,
  p_error_code text,
  p_error_message text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
BEGIN
  SELECT * INTO v_task
    FROM public.video_tasks
   WHERE id::text = trim(p_task_id)
     AND user_id::text = trim(p_user_id)
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VIDEO_TASK_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_task.request_fingerprint IS DISTINCT FROM lower(trim(p_request_fingerprint)) THEN
    RAISE EXCEPTION 'VIDEO_REQUEST_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  -- Once a provider task id exists, a transport exception is an unknown
  -- outcome and may not be rewritten as a safe-to-resubmit failure.
  IF v_task.task_id_external IS NOT NULL OR v_task.status = 'completed' THEN
    RETURN jsonb_build_object(
      'task_id', v_task.id,
      'status', v_task.status,
      'billing_state', v_task.billing_state,
      'provider_task_id', coalesce(v_task.task_id_external, '')
    );
  END IF;
  UPDATE public.video_tasks
     SET status = 'failed',
         billing_state = 'submission_failed',
         submission_error_code = left(coalesce(p_error_code, 'VIDEO_PROVIDER_SUBMISSION_FAILED'), 120),
         error_message = left(coalesce(p_error_message, '供应商提交失败'), 1000),
         price_charged = 0,
         completed_at = now()
   WHERE id = v_task.id
   RETURNING * INTO v_task;
  RETURN jsonb_build_object(
    'task_id', v_task.id,
    'status', v_task.status,
    'billing_state', v_task.billing_state,
    'provider_task_id', ''
  );
END
$$;

CREATE OR REPLACE FUNCTION public.finalize_video_generation_task_atomic(
  p_task_id text,
  p_user_id text,
  p_provider_task_id text,
  p_stable_storage_url text,
  p_billing_operation_id bigint DEFAULT NULL,
  p_legacy_h3_settled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_operation public.wallet_operations%ROWTYPE;
  v_h3 public.autodl_h3_settlements%ROWTYPE;
  v_provider_task_id text := nullif(trim(coalesce(p_provider_task_id, '')), '');
  v_stable_storage_url text := trim(coalesce(p_stable_storage_url, ''));
  v_price numeric(14,4);
  v_paid boolean;
  v_charged numeric(14,4) := 0;
  v_billing_state text;
BEGIN
  IF v_stable_storage_url !~ '^object://tencent_cos/[^?#]+$' THEN
    RAISE EXCEPTION 'VIDEO_STABLE_ASSET_REQUIRED' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_task
    FROM public.video_tasks
   WHERE id::text = trim(p_task_id)
     AND user_id::text = trim(p_user_id)
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VIDEO_TASK_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_task.storage_url IS DISTINCT FROM v_stable_storage_url THEN
    RAISE EXCEPTION 'VIDEO_STABLE_ASSET_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF v_provider_task_id IS NOT NULL
     AND v_task.task_id_external IS NOT NULL
     AND v_task.task_id_external IS DISTINCT FROM v_provider_task_id THEN
    RAISE EXCEPTION 'VIDEO_PROVIDER_TASK_CONFLICT' USING ERRCODE = '23505';
  END IF;
  IF v_task.billing_price_yuan IS NULL
     OR v_task.billing_cost_price_yuan IS NULL
     OR v_task.billing_price_yuan < 0
     OR v_task.billing_cost_price_yuan < 0 THEN
    RAISE EXCEPTION 'VIDEO_PRICE_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_price := round(v_task.billing_price_yuan, 4);
  v_paid := coalesce(v_task.billing_exempt, false) IS NOT TRUE
    AND coalesce(v_task.explicitly_free, false) IS NOT TRUE
    AND round(v_price, 2) > 0;
  IF coalesce(v_task.billing_exempt, false) IS NOT TRUE
     AND coalesce(v_task.explicitly_free, false) IS NOT TRUE
     AND round(v_price, 2) <= 0 THEN
    RAISE EXCEPTION 'VIDEO_PRICE_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF v_task.status = 'completed'
     AND v_task.video_url = v_stable_storage_url
     AND v_task.storage_url = v_stable_storage_url
     AND (
       (v_paid AND v_task.billing_state IN ('settled', 'legacy_h3_settled')
        AND round(coalesce(v_task.price_charged, 0), 2) = round(v_price, 2))
       OR (NOT v_paid AND v_task.billing_state = 'not_required'
           AND coalesce(v_task.price_charged, 0) = 0)
     ) THEN
    RETURN jsonb_build_object(
      'status', 'completed',
      'already_completed', true,
      'billing_state', v_task.billing_state,
      'price_charged', v_task.price_charged,
      'stable_storage_url', v_stable_storage_url
    );
  END IF;

  IF v_paid THEN
    IF coalesce(p_legacy_h3_settled, false) THEN
      SELECT * INTO v_h3
        FROM public.autodl_h3_settlements
       WHERE video_task_internal_id = v_task.id::text
         AND user_id::text = v_task.user_id::text
         AND model_id::text = v_task.model_id::text
         AND stable_asset_url = v_stable_storage_url
       FOR UPDATE;
      IF NOT FOUND
         OR round(v_h3.price_yuan, 4) <> v_price
         OR round(v_h3.charged_yuan, 4) <> v_price THEN
        RAISE EXCEPTION 'VIDEO_LEGACY_H3_SETTLEMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      v_charged := v_price;
      v_billing_state := 'legacy_h3_settled';
    ELSE
      IF p_billing_operation_id IS NULL OR trim(coalesce(v_task.billing_idempotency_key, '')) = '' THEN
        RAISE EXCEPTION 'VIDEO_BILLING_OPERATION_REQUIRED' USING ERRCODE = '22023';
      END IF;
      SELECT * INTO v_operation
        FROM public.wallet_operations
       WHERE id = p_billing_operation_id
         AND user_id = v_task.user_id::text
         AND wallet = 'cash'
         AND operation_kind = 'cash_charge'
         AND idempotency_key = v_task.billing_idempotency_key
       FOR UPDATE;
      IF NOT FOUND
         OR v_operation.status <> 'completed'
         OR round(v_operation.amount, 4) <> v_price
         OR round(v_operation.delta, 4) <> -v_price THEN
        RAISE EXCEPTION 'VIDEO_BILLING_OPERATION_INVALID' USING ERRCODE = '22023';
      END IF;
      v_charged := v_price;
      v_billing_state := 'settled';
    END IF;
  ELSE
    IF p_billing_operation_id IS NOT NULL OR coalesce(p_legacy_h3_settled, false) THEN
      RAISE EXCEPTION 'VIDEO_FREE_TASK_MUST_NOT_CHARGE' USING ERRCODE = '22023';
    END IF;
    v_charged := 0;
    v_billing_state := 'not_required';
  END IF;

  UPDATE public.video_tasks
     SET status = 'completed',
         task_id_external = coalesce(v_provider_task_id, task_id_external),
         video_url = v_stable_storage_url,
         storage_url = v_stable_storage_url,
         needs_proxy = false,
         price_charged = v_charged,
         billing_state = v_billing_state,
         billing_operation_id = CASE WHEN v_paid AND NOT coalesce(p_legacy_h3_settled, false)
           THEN p_billing_operation_id ELSE billing_operation_id END,
         error_message = NULL,
         completed_at = now()
   WHERE id = v_task.id
   RETURNING * INTO v_task;

  RETURN jsonb_build_object(
    'status', v_task.status,
    'already_completed', false,
    'billing_state', v_task.billing_state,
    'price_charged', v_task.price_charged,
    'stable_storage_url', v_task.storage_url,
    'billing_operation_id', v_task.billing_operation_id
  );
END
$$;

REVOKE ALL ON FUNCTION public.reserve_video_generation_task_atomic(
  text, text, text, text, text, numeric, numeric, text, numeric, boolean,
  boolean, text, text, text, text, integer, text, text, text, text, text,
  text, integer, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bind_video_provider_task_atomic(text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_video_generation_submission_atomic(text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_video_generation_task_atomic(text, text, text, text, bigint, boolean)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_video_generation_task_atomic(
  text, text, text, text, text, numeric, numeric, text, numeric, boolean,
  boolean, text, text, text, text, integer, text, text, text, text, text,
  text, integer, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_video_provider_task_atomic(text, text, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_video_generation_submission_atomic(text, text, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_video_generation_task_atomic(text, text, text, text, bigint, boolean)
  TO service_role;
