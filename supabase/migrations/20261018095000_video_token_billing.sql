-- Token billing keeps the accepted budget separate from the final supplier
-- usage. No model configuration, wallet balance, or historical task is changed.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.video_tasks
  ADD COLUMN IF NOT EXISTS billing_token_quote jsonb,
  ADD COLUMN IF NOT EXISTS billing_reserved_yuan numeric(14,4),
  ADD COLUMN IF NOT EXISTS billing_token_usage jsonb,
  ADD COLUMN IF NOT EXISTS billing_token_usage_conflict jsonb,
  ALTER COLUMN billing_quantity TYPE numeric(20,4);

ALTER TABLE public.video_tasks
  DROP CONSTRAINT IF EXISTS video_tasks_billing_snapshot_check,
  ADD CONSTRAINT video_tasks_billing_snapshot_check CHECK (
    (billing_price_yuan IS NULL OR billing_price_yuan >= 0)
    AND (billing_cost_price_yuan IS NULL OR billing_cost_price_yuan >= 0)
    AND (billing_quantity IS NULL OR billing_quantity > 0)
    AND (billing_unit IS NULL OR billing_unit IN ('per_use', 'output_second', 'token'))
  ),
  DROP CONSTRAINT IF EXISTS video_tasks_terminal_billing_state_check,
  ADD CONSTRAINT video_tasks_terminal_billing_state_check CHECK (
    billing_state IS NULL OR billing_state IN (
      'reserved', 'provider_submitted', 'submission_failed', 'asset_persisting',
      'asset_failed', 'billing_pending', 'failed', 'settled_pending_commit',
      'settled', 'legacy_h3_settled', 'not_required', 'usage_pending', 'billing_review', 'quote_exceeded'
    )
  ),
  DROP CONSTRAINT IF EXISTS video_tasks_token_billing_check,
  ADD CONSTRAINT video_tasks_token_billing_check CHECK (
    (billing_reserved_yuan IS NULL OR (
      billing_reserved_yuan > 0 AND billing_reserved_yuan::text NOT IN ('NaN', 'Infinity', '-Infinity')
    ))
    AND (billing_token_quote IS NULL OR (
      jsonb_typeof(billing_token_quote) = 'object'
      AND billing_token_quote->>'schema' = 'video_token_quote.v1'
      AND pg_column_size(billing_token_quote) <= 16384
    ))
    AND (billing_token_usage IS NULL OR (
      jsonb_typeof(billing_token_usage) = 'object'
      AND billing_token_usage->>'schema' = 'video_token_usage.v1'
      AND pg_column_size(billing_token_usage) <= 16384
    ))
    AND (billing_unit IS DISTINCT FROM 'token' OR (
      billing_token_quote IS NOT NULL AND billing_reserved_yuan IS NOT NULL
    ))
  );

-- Preserve the original fixed-price branch. A token task continues occupying
-- its full accepted budget after usage arrives, until the matching actual
-- wallet charge completes or the task reaches a terminal state.
CREATE OR REPLACE FUNCTION public.enforce_video_budget_reservation_atomic()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_cash_balance numeric(20,6);
  v_requested_amount numeric(20,6);
  v_reserved_before numeric(20,6);
BEGIN
  v_requested_amount := round(coalesce(NEW.billing_reserved_yuan, NEW.billing_price_yuan, 0)::numeric, 2);
  IF coalesce(NEW.billing_exempt, false) OR coalesce(NEW.explicitly_free, false)
     OR v_requested_amount <= 0 THEN RETURN NEW; END IF;
  SELECT * INTO v_user FROM public.users WHERE id::text = NEW.user_id::text FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VIDEO_BUDGET_USER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT coalesce(sum(round(coalesce(task.billing_reserved_yuan, task.billing_price_yuan)::numeric, 2)), 0)
    INTO v_reserved_before
    FROM public.video_tasks task
   WHERE task.user_id = NEW.user_id
     AND task.status NOT IN ('completed', 'failed', 'cancelled', 'expired')
     AND coalesce(task.billing_exempt, false) IS NOT TRUE
     AND coalesce(task.explicitly_free, false) IS NOT TRUE
     AND round(coalesce(task.billing_reserved_yuan, task.billing_price_yuan, 0)::numeric, 2) > 0
     AND (task.billing_unit = 'token' OR coalesce(task.billing_state, 'reserved') NOT IN (
       'submission_failed', 'settled_pending_commit', 'settled', 'legacy_h3_settled', 'not_required'
     ))
     AND NOT EXISTS (
       SELECT 1 FROM public.wallet_operations wallet_op
        WHERE wallet_op.user_id = task.user_id::text AND wallet_op.wallet = 'cash'
          AND wallet_op.operation_kind = 'cash_charge'
          AND wallet_op.idempotency_key = task.billing_idempotency_key
          AND wallet_op.status = 'completed'
          AND round(wallet_op.amount::numeric, 2) = round(task.billing_price_yuan::numeric, 2)
          AND round(wallet_op.delta::numeric, 2) = -round(task.billing_price_yuan::numeric, 2)
     );
  v_cash_balance := round(coalesce(v_user.cash_balance, 0)::numeric, 2);
  IF v_reserved_before + v_requested_amount > v_cash_balance THEN
    RAISE EXCEPTION 'VIDEO_BUDGET_RESERVATION_INSUFFICIENT' USING ERRCODE = 'P0001',
      DETAIL = jsonb_build_object('cash_balance', v_cash_balance, 'reserved_before', v_reserved_before,
        'requested_amount', v_requested_amount, 'available_before', v_cash_balance - v_reserved_before)::text;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.reserve_video_token_task_v1_atomic(
  p_task jsonb, p_routing_snapshot jsonb, p_request_snapshot jsonb, p_token_quote jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_result jsonb;
  v_max numeric;
  v_sale numeric;
  v_cost numeric;
  v_price_key text;
  v_id text := trim(coalesce(p_task->>'p_task_id', ''));
  v_user text := trim(coalesce(p_task->>'p_user_id', ''));
  v_client text := trim(coalesce(p_task->>'p_client_request_id', ''));
BEGIN
  IF session_user <> 'service_role' AND current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_task) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_token_quote) IS DISTINCT FROM 'object'
     OR p_token_quote->>'schema' IS DISTINCT FROM 'video_token_quote.v1'
     OR p_token_quote->>'resolution' IS DISTINCT FROM '720p'
     OR coalesce(p_token_quote->>'pricingClass', '') NOT IN ('no_reference_video', 'reference_video')
     OR jsonb_typeof(p_token_quote->'saleYuanPerMillionTokens') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_token_quote->'costYuanPerMillionTokens') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_token_quote->'maxChargeYuan') IS DISTINCT FROM 'number'
     OR coalesce(p_token_quote->>'priceVersion', '') NOT LIKE 'video_token_sale.v1:%'
     OR pg_column_size(p_token_quote) > 16384 THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_QUOTE_INVALID' USING ERRCODE = '22023';
  END IF;
  v_max := (p_token_quote->>'maxChargeYuan')::numeric;
  v_sale := (p_token_quote->>'saleYuanPerMillionTokens')::numeric;
  v_cost := (p_token_quote->>'costYuanPerMillionTokens')::numeric;
  IF v_max <= 0 OR v_max >= 10000000000 OR v_max <> round(v_max, 2)
     OR v_sale <= 0 OR v_sale > 9007199254740991 OR v_cost <= 0 OR v_cost > 9007199254740991
     OR (p_task->>'p_billing_price_yuan')::numeric IS DISTINCT FROM v_max
     OR coalesce((p_task->>'p_explicitly_free')::boolean, false)
     OR coalesce((p_task->>'p_billing_exempt')::boolean, false)
     OR p_request_snapshot->>'resolution' IS DISTINCT FROM p_token_quote->>'resolution' THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_QUOTE_INVALID' USING ERRCODE = '22023';
  END IF;
  v_price_key := (p_token_quote->>'resolution') || ':' || (p_token_quote->>'pricingClass');
  IF (p_routing_snapshot->'apiProtocolConfig'->'token_sale_prices_per_million'->>v_price_key)::numeric IS DISTINCT FROM v_sale
     OR (p_routing_snapshot->'apiProtocolConfig'->'token_cost_prices_per_million'->>v_price_key)::numeric IS DISTINCT FROM v_cost
     OR p_routing_snapshot->'apiProtocolConfig'->>'provider_billing_unit' IS DISTINCT FROM 'token'
     OR (p_token_quote->>'pricingClass' = 'reference_video') IS DISTINCT FROM EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_request_snapshot->'referenceAssets') asset
        WHERE asset->>'role' = 'source_video'
     ) THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_QUOTE_ROUTING_MISMATCH' USING ERRCODE = '23514';
  END IF;

  -- Same identity lock as the underlying reservation. Replays must not call
  -- its fixed-price comparison after an actual token amount has been recorded.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user || ':' || v_client, 0));
  SELECT * INTO v_task FROM public.video_tasks
   WHERE user_id::text = v_user AND client_request_id = v_client FOR UPDATE;
  IF FOUND THEN
    IF v_task.id::text IS DISTINCT FROM v_id
       OR v_task.model_id::text IS DISTINCT FROM p_task->>'p_model_id'
       OR v_task.request_fingerprint IS DISTINCT FROM lower(trim(coalesce(p_task->>'p_request_fingerprint', '')))
       OR v_task.billing_unit IS DISTINCT FROM 'token'
       OR v_task.billing_token_quote IS DISTINCT FROM p_token_quote
       OR v_task.billing_reserved_yuan IS DISTINCT FROM v_max
       OR v_task.routing_snapshot IS DISTINCT FROM p_routing_snapshot
       OR v_task.request_snapshot IS DISTINCT FROM p_request_snapshot
       OR v_task.request_snapshot_hash IS DISTINCT FROM lower(trim(coalesce(p_task->>'p_request_snapshot_hash', '')))
       OR (nullif(p_task->>'p_provider_task_id', '') IS NOT NULL
           AND v_task.task_id_external IS DISTINCT FROM p_task->>'p_provider_task_id') THEN
      RAISE EXCEPTION 'VIDEO_TOKEN_RESERVATION_IMMUTABLE_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('created', false, 'task_id', v_task.id, 'status', v_task.status,
      'billing_state', v_task.billing_state, 'provider_task_id', coalesce(v_task.task_id_external, ''),
      'billing_reserved_yuan', v_task.billing_reserved_yuan, 'billing_token_quote', v_task.billing_token_quote);
  END IF;
  v_result := public.reserve_video_generation_task_request_snapshot_v1_atomic(
    p_task_id => v_id, p_user_id => v_user, p_model_id => p_task->>'p_model_id',
    p_client_request_id => v_client, p_request_fingerprint => p_task->>'p_request_fingerprint',
    p_billing_price_yuan => v_max, p_billing_cost_price_yuan => coalesce((p_task->>'p_billing_cost_price_yuan')::numeric, 0),
    p_billing_unit => 'per_use', p_billing_quantity => 1,
    p_explicitly_free => false, p_billing_exempt => false,
    p_routing_snapshot => p_routing_snapshot, p_request_snapshot => p_request_snapshot,
    p_request_snapshot_hash => p_task->>'p_request_snapshot_hash',
    p_provider_task_id => nullif(p_task->>'p_provider_task_id', ''),
    p_task_label => p_task->>'p_task_label', p_batch_id => p_task->>'p_batch_id',
    p_batch_topic => p_task->>'p_batch_topic', p_card_index => (p_task->>'p_card_index')::integer,
    p_prompt => coalesce(p_task->>'p_prompt', ''), p_first_frame_url => p_task->>'p_first_frame_url',
    p_last_frame_url => p_task->>'p_last_frame_url', p_reference_image_url => p_task->>'p_reference_image_url',
    p_aspect_ratio => coalesce(p_task->>'p_aspect_ratio', '16:9'), p_resolution => p_task->>'p_resolution',
    p_duration_seconds => (p_task->>'p_duration_seconds')::numeric, p_content_url => p_task->>'p_content_url'
  );
  IF coalesce((v_result->>'created')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_RESERVATION_IMMUTABLE_CONFLICT' USING ERRCODE = '23505';
  END IF;
  UPDATE public.video_tasks SET billing_unit = 'token', billing_token_quote = p_token_quote,
    billing_reserved_yuan = v_max WHERE id::text = v_id AND user_id::text = v_user;
  RETURN v_result || jsonb_build_object('billing_reserved_yuan', v_max, 'billing_token_quote', p_token_quote);
END $$;

CREATE OR REPLACE FUNCTION public.record_video_token_usage_v1_atomic(
  p_task_id text, p_user_id text, p_provider_task_id text,
  p_total_tokens bigint, p_completion_tokens bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_usage jsonb;
  v_sale numeric;
  v_cost numeric;
  v_state text;
  v_replayed boolean := false;
  v_conflict boolean := false;
  v_settled boolean := false;
BEGIN
  IF session_user <> 'service_role' AND current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_total_tokens IS NULL OR p_completion_tokens IS NULL OR p_total_tokens <= 0
     OR p_total_tokens > 9007199254740991 OR p_total_tokens IS DISTINCT FROM p_completion_tokens
     OR nullif(trim(coalesce(p_provider_task_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_USAGE_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.users WHERE id::text = trim(p_user_id) FOR UPDATE;
  SELECT * INTO v_task FROM public.video_tasks
   WHERE id::text = trim(p_task_id) AND user_id::text = trim(p_user_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VIDEO_TOKEN_TASK_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_task.billing_unit IS DISTINCT FROM 'token' OR v_task.billing_token_quote IS NULL
     OR v_task.billing_reserved_yuan IS NULL
     OR v_task.task_id_external IS DISTINCT FROM trim(p_provider_task_id) THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_USAGE_TASK_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF v_task.status IN ('failed', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_TASK_TERMINAL_NOT_BILLABLE' USING ERRCODE = '23514';
  END IF;
  IF v_task.billing_token_usage IS NOT NULL THEN
    v_replayed := v_task.billing_token_usage->>'providerTaskId' = trim(p_provider_task_id)
      AND (v_task.billing_token_usage->>'totalTokens')::bigint = p_total_tokens
      AND (v_task.billing_token_usage->>'completionTokens')::bigint = p_completion_tokens;
    IF NOT v_replayed THEN
      v_conflict := true;
      v_settled := v_task.status = 'completed' OR EXISTS (
        SELECT 1 FROM public.wallet_operations operation
         WHERE operation.user_id = v_task.user_id::text AND operation.wallet = 'cash'
           AND operation.operation_kind = 'cash_charge' AND operation.status = 'completed'
           AND operation.idempotency_key = v_task.billing_idempotency_key
           AND operation.amount = v_task.billing_price_yuan AND operation.delta = -v_task.billing_price_yuan
      );
      UPDATE public.video_tasks SET
        billing_token_usage_conflict = jsonb_build_object('schema', 'video_token_usage_conflict.v1',
          'usageHash', md5(trim(p_provider_task_id) || ':' || p_total_tokens::text || ':' || p_completion_tokens::text),
          'observations', coalesce((billing_token_usage_conflict->>'observations')::bigint, 0) + 1,
          'lastObservedAt', now()),
        billing_state = CASE WHEN v_settled THEN billing_state ELSE 'billing_review' END,
        status = CASE WHEN v_settled THEN status ELSE 'finalizing' END,
        error_message = CASE WHEN v_settled THEN error_message
          ELSE 'VIDEO_TOKEN_USAGE_CONFLICT: supplier usage changed; the first receipt is preserved' END
       WHERE id = v_task.id RETURNING * INTO v_task;
    END IF;
  ELSE
    v_sale := round(p_total_tokens::numeric * (v_task.billing_token_quote->>'saleYuanPerMillionTokens')::numeric / 1000000, 2);
    v_cost := round(p_total_tokens::numeric * (v_task.billing_token_quote->>'costYuanPerMillionTokens')::numeric / 1000000, 4);
    v_usage := jsonb_build_object('schema', 'video_token_usage.v1', 'providerTaskId', trim(p_provider_task_id),
      'totalTokens', p_total_tokens, 'completionTokens', p_completion_tokens,
      'saleAmountYuan', v_sale, 'costAmountYuan', v_cost, 'recordedAt', now());
    v_state := CASE WHEN v_sale > v_task.billing_reserved_yuan THEN 'quote_exceeded'
      WHEN v_sale <= 0 OR v_cost >= 10000000000 THEN 'billing_review' ELSE 'billing_pending' END;
    UPDATE public.video_tasks SET billing_token_usage = v_usage, status = 'finalizing', billing_state = v_state,
      billing_price_yuan = CASE WHEN v_state = 'billing_pending' THEN v_sale ELSE billing_price_yuan END,
      billing_cost_price_yuan = CASE WHEN v_state = 'billing_pending' THEN v_cost ELSE billing_cost_price_yuan END,
      billing_quantity = p_total_tokens::numeric,
      error_message = CASE v_state WHEN 'quote_exceeded' THEN 'VIDEO_TOKEN_QUOTE_EXCEEDED: final charge exceeds the accepted budget'
        WHEN 'billing_review' THEN 'VIDEO_TOKEN_AMOUNT_REVIEW_REQUIRED: amount cannot be settled at wallet precision'
        ELSE 'Supplier token usage recorded; awaiting exact wallet settlement' END
     WHERE id = v_task.id RETURNING * INTO v_task;
  END IF;
  RETURN jsonb_build_object('task_id', v_task.id, 'status', v_task.status, 'billing_state', v_task.billing_state,
    'usage_replayed', v_replayed, 'usage_conflict', v_conflict, 'price_yuan', v_task.billing_price_yuan,
    'cost_price_yuan', v_task.billing_cost_price_yuan, 'reserved_yuan', v_task.billing_reserved_yuan,
    'billing_token_usage', v_task.billing_token_usage);
END $$;

-- This also protects calls through the pre-existing generic cash executor.
-- Its wallet RPC inserts status=processing before locking the user. Take the
-- account then task locks here, before any wallet row/balance mutation, so a
-- concurrent conflicting receipt cannot pass a stale application check.
CREATE OR REPLACE FUNCTION public.guard_video_token_wallet_charge_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_existing public.wallet_operations%ROWTYPE;
  v_id text;
  v_excluded_task text;
  v_balance numeric;
  v_held numeric;
BEGIN
  -- All currently supported cash debits are cash_charge. Testing delta too
  -- prevents a future debit kind from accidentally bypassing video holds.
  IF NEW.wallet <> 'cash' OR NEW.delta >= 0 THEN RETURN NEW; END IF;
  SELECT round(coalesce(cash_balance, 0), 2) INTO v_balance
    FROM public.users WHERE id::text = NEW.user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VIDEO_BUDGET_USER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  -- BEFORE INSERT also executes before ON CONFLICT DO NOTHING. A completed
  -- matching operation is a read-only replay, even if the remaining cash is low.
  SELECT * INTO v_existing FROM public.wallet_operations
   WHERE user_id = NEW.user_id AND operation_kind = NEW.operation_kind AND idempotency_key = NEW.idempotency_key;
  IF FOUND AND v_existing.status = 'completed' AND v_existing.wallet = NEW.wallet
     AND v_existing.amount = NEW.amount AND v_existing.delta = NEW.delta THEN RETURN NEW; END IF;

  SELECT id::text INTO v_id FROM public.video_tasks
   WHERE (user_id::text = NEW.user_id AND billing_idempotency_key = NEW.idempotency_key)
      OR (billing_unit = 'token' AND id::text = coalesce(NEW.metadata->>'video_task_id', ''))
   ORDER BY (user_id::text = NEW.user_id AND billing_idempotency_key = NEW.idempotency_key) DESC, id::text LIMIT 1;
  IF v_id IS NOT NULL THEN
    SELECT * INTO v_task FROM public.video_tasks WHERE id::text = v_id FOR UPDATE;
    IF v_task.billing_unit = 'token' AND (
       v_task.user_id::text IS DISTINCT FROM NEW.user_id
       OR NEW.metadata->>'video_task_id' IS DISTINCT FROM v_id
       OR NEW.metadata->>'phase' IS DISTINCT FROM 'video_terminal'
       OR NEW.idempotency_key IS DISTINCT FROM v_task.billing_idempotency_key
       OR NEW.status IS DISTINCT FROM 'processing'
       OR v_task.status IN ('failed', 'cancelled', 'expired')
       OR coalesce(v_task.billing_state, '') NOT IN ('billing_pending', 'failed', 'settled_pending_commit', 'settled')
       OR v_task.billing_token_usage IS NULL
       OR v_task.billing_token_usage->>'schema' IS DISTINCT FROM 'video_token_usage.v1'
       OR jsonb_typeof(v_task.billing_token_usage->'totalTokens') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_task.billing_token_usage->'completionTokens') IS DISTINCT FROM 'number'
       OR (v_task.billing_token_usage->>'totalTokens')::numeric <= 0
       OR v_task.billing_token_usage->>'totalTokens' IS DISTINCT FROM v_task.billing_token_usage->>'completionTokens'
       OR v_task.billing_token_usage->>'providerTaskId' IS DISTINCT FROM v_task.task_id_external
       OR NEW.amount IS DISTINCT FROM (v_task.billing_token_usage->>'saleAmountYuan')::numeric
       OR NEW.amount IS DISTINCT FROM v_task.billing_price_yuan
       OR NEW.delta IS DISTINCT FROM -NEW.amount
       OR NEW.amount > v_task.billing_reserved_yuan) THEN
      RAISE EXCEPTION 'VIDEO_TOKEN_WALLET_CHARGE_BLOCKED' USING ERRCODE = '23514';
    END IF;
    -- A metadata claim alone never authorizes releasing somebody else's hold.
    IF NEW.operation_kind = 'cash_charge' AND v_task.user_id::text = NEW.user_id
       AND NEW.idempotency_key = v_task.billing_idempotency_key
       AND NEW.amount = round(v_task.billing_price_yuan, 2) AND NEW.delta = -NEW.amount
       AND coalesce(v_task.billing_state, '') NOT IN ('usage_pending', 'billing_review', 'quote_exceeded')
       AND v_task.status NOT IN ('failed', 'cancelled', 'expired') THEN v_excluded_task := v_id; END IF;
  END IF;

  SELECT coalesce(sum(round(coalesce(task.billing_reserved_yuan, task.billing_price_yuan)::numeric, 2)), 0)
    INTO v_held FROM public.video_tasks task
   WHERE task.user_id::text = NEW.user_id
     AND task.id::text IS DISTINCT FROM v_excluded_task
     AND task.status NOT IN ('completed', 'failed', 'cancelled', 'expired')
     AND coalesce(task.billing_exempt, false) IS NOT TRUE
     AND coalesce(task.explicitly_free, false) IS NOT TRUE
     AND round(coalesce(task.billing_reserved_yuan, task.billing_price_yuan, 0)::numeric, 2) > 0
     AND (task.billing_unit = 'token' OR coalesce(task.billing_state, 'reserved') NOT IN (
       'submission_failed', 'settled_pending_commit', 'settled', 'legacy_h3_settled', 'not_required'
     ))
     AND NOT EXISTS (
       SELECT 1 FROM public.wallet_operations operation
        WHERE operation.user_id = task.user_id::text AND operation.wallet = 'cash'
          AND operation.operation_kind = 'cash_charge' AND operation.status = 'completed'
          AND operation.idempotency_key = task.billing_idempotency_key
          AND round(operation.amount, 2) = round(task.billing_price_yuan, 2)
          AND round(operation.delta, 2) = -round(task.billing_price_yuan, 2)
     );
  IF v_balance - v_held < NEW.amount THEN
    RAISE EXCEPTION 'VIDEO_BUDGET_CASH_RESERVED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wallet_operations_video_token_guard_v1 ON public.wallet_operations;
CREATE TRIGGER wallet_operations_video_token_guard_v1 BEFORE INSERT ON public.wallet_operations
FOR EACH ROW EXECUTE FUNCTION public.guard_video_token_wallet_charge_v1();

CREATE OR REPLACE FUNCTION public.settle_video_token_task_v1_atomic(
  p_task_id text, p_user_id text, p_provider_task_id text,
  p_description text DEFAULT '', p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE v_task public.video_tasks%ROWTYPE; v_wallet jsonb;
BEGIN
  IF session_user <> 'service_role' AND current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.users WHERE id::text = trim(p_user_id) FOR UPDATE;
  SELECT * INTO v_task FROM public.video_tasks
   WHERE id::text = trim(p_task_id) AND user_id::text = trim(p_user_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VIDEO_TOKEN_TASK_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_task.billing_unit IS DISTINCT FROM 'token'
     OR nullif(trim(coalesce(p_provider_task_id, '')), '') IS NULL
     OR v_task.task_id_external IS DISTINCT FROM trim(p_provider_task_id)
     OR v_task.billing_token_usage IS NULL
     OR coalesce(v_task.billing_state, '') NOT IN ('billing_pending', 'failed', 'settled_pending_commit', 'settled')
     OR v_task.status IN ('failed', 'cancelled', 'expired')
     OR v_task.billing_price_yuan <= 0
     OR v_task.billing_price_yuan > v_task.billing_reserved_yuan THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_SETTLEMENT_BLOCKED' USING ERRCODE = '23514';
  END IF;
  v_wallet := public.apply_wallet_operation_atomic(trim(p_user_id), 'cash_charge',
    v_task.billing_idempotency_key, v_task.billing_price_yuan, coalesce(p_description, ''),
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('video_task_id', v_task.id,
      'provider_task_id', v_task.task_id_external, 'phase', 'video_terminal',
      'token_usage', v_task.billing_token_usage, 'token_quote', v_task.billing_token_quote,
      'price_snapshot', coalesce(p_metadata->'price_snapshot', '{}'::jsonb) || jsonb_build_object(
        'price_yuan', v_task.billing_price_yuan, 'cost_price_yuan', v_task.billing_cost_price_yuan,
        'resolution', v_task.resolution, 'duration_seconds', v_task.duration_seconds,
        'request_fingerprint', v_task.request_fingerprint, 'billing_unit', 'token',
        'token_quote', v_task.billing_token_quote, 'token_usage', v_task.billing_token_usage)));
  IF coalesce((v_wallet->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_WALLET_SETTLEMENT_FAILED' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.video_tasks SET billing_operation_id = (v_wallet->>'operation_id')::bigint,
    billing_state = CASE WHEN status = 'completed' THEN 'settled' ELSE 'settled_pending_commit' END
   WHERE id = v_task.id RETURNING * INTO v_task;
  RETURN v_wallet || jsonb_build_object('task_id', v_task.id, 'billing_state', v_task.billing_state);
END $$;

REVOKE ALL ON FUNCTION public.reserve_video_token_task_v1_atomic(jsonb,jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_video_token_usage_v1_atomic(text,text,text,bigint,bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.settle_video_token_task_v1_atomic(text,text,text,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_video_token_wallet_charge_v1() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_video_token_task_v1_atomic(jsonb,jsonb,jsonb,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_video_token_usage_v1_atomic(text,text,text,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_video_token_task_v1_atomic(text,text,text,text,jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
