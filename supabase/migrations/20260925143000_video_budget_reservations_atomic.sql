-- Serialize ordinary video budget reservations per account before any provider
-- submission. The durable video_tasks row is the reservation: terminal task
-- states release it, while a completed matching wallet charge is already
-- reflected in users.cash_balance and therefore is not counted twice.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.enforce_video_budget_reservation_atomic()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_cash_balance numeric(20,6);
  v_requested_amount numeric(20,6);
  v_reserved_before numeric(20,6);
BEGIN
  v_requested_amount := round(coalesce(NEW.billing_price_yuan, 0)::numeric, 2);
  IF coalesce(NEW.billing_exempt, false) IS TRUE
     OR coalesce(NEW.explicitly_free, false) IS TRUE
     OR v_requested_amount <= 0 THEN
    RETURN NEW;
  END IF;

  -- The wallet RPC locks this same row before every cash mutation. Different
  -- client_request_id values for one account therefore serialize with each
  -- other and with terminal cash deductions.
  SELECT * INTO v_user
    FROM public.users
   WHERE id::text = NEW.user_id::text
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VIDEO_BUDGET_USER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(sum(round(task.billing_price_yuan::numeric, 2)), 0)
    INTO v_reserved_before
    FROM public.video_tasks task
   WHERE task.user_id = NEW.user_id
     AND task.status NOT IN ('completed', 'failed', 'cancelled', 'expired')
     AND coalesce(task.billing_exempt, false) IS NOT TRUE
     AND coalesce(task.explicitly_free, false) IS NOT TRUE
     AND round(coalesce(task.billing_price_yuan, 0)::numeric, 2) > 0
     AND coalesce(task.billing_state, 'reserved') NOT IN (
       'submission_failed', 'settled_pending_commit', 'settled',
       'legacy_h3_settled', 'not_required'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.wallet_operations wallet_op
        WHERE wallet_op.user_id = task.user_id::text
          AND wallet_op.wallet = 'cash'
          AND wallet_op.operation_kind = 'cash_charge'
          AND wallet_op.idempotency_key = task.billing_idempotency_key
          AND wallet_op.status = 'completed'
          AND round(wallet_op.amount::numeric, 2) = round(task.billing_price_yuan::numeric, 2)
          AND round(wallet_op.delta::numeric, 2) = -round(task.billing_price_yuan::numeric, 2)
     );

  v_cash_balance := round(coalesce(v_user.cash_balance, 0)::numeric, 2);
  IF v_reserved_before + v_requested_amount > v_cash_balance THEN
    RAISE EXCEPTION 'VIDEO_BUDGET_RESERVATION_INSUFFICIENT'
      USING ERRCODE = 'P0001',
            DETAIL = jsonb_build_object(
              'cash_balance', v_cash_balance,
              'reserved_before', v_reserved_before,
              'requested_amount', v_requested_amount,
              'available_before', v_cash_balance - v_reserved_before
            )::text;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS video_tasks_budget_reservation_atomic_before_insert
  ON public.video_tasks;
CREATE TRIGGER video_tasks_budget_reservation_atomic_before_insert
BEFORE INSERT ON public.video_tasks
FOR EACH ROW
EXECUTE FUNCTION public.enforce_video_budget_reservation_atomic();

-- Versioned entrypoints make application-before-migration rollout fail closed.
-- The existing durable reservation functions retain their idempotency and
-- queue transaction semantics; every new video_tasks row passes the trigger.
CREATE FUNCTION public.reserve_video_generation_task_budget_atomic(
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
  p_duration_seconds numeric DEFAULT 5,
  p_content_url text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN public.reserve_video_generation_task_atomic(
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
END
$$;

CREATE FUNCTION public.reserve_queued_digital_video_task_budget_atomic(
  p_task jsonb,
  p_dispatch jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN public.reserve_queued_digital_video_task(p_task, p_dispatch);
END
$$;

REVOKE ALL ON FUNCTION public.enforce_video_budget_reservation_atomic()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reserve_video_generation_task_budget_atomic(
  text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,
  text,text,text,text,integer,text,text,text,text,text,text,numeric,text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_queued_digital_video_task_budget_atomic(jsonb,jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_video_generation_task_budget_atomic(
  text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,
  text,text,text,text,integer,text,text,text,text,text,text,numeric,text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_queued_digital_video_task_budget_atomic(jsonb,jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
