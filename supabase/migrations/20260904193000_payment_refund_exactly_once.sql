-- Exact-once payment refunds with current-admin authorization at the API layer,
-- a durable provider-call boundary and an atomic wallet reversal reservation.
-- The provider is never called unless this migration successfully returns an
-- execute lease. Ambiguous provider outcomes keep the wallet amount reserved
-- and require reconciliation rather than risking a second refund.

BEGIN;

CREATE TABLE IF NOT EXISTS public.payment_refund_attempts (
  attempt_id text PRIMARY KEY CHECK (attempt_id ~ '^[a-f0-9]{64}$'),
  trade_order_id text NOT NULL,
  user_id text NOT NULL,
  admin_user_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 80),
  state text NOT NULL CHECK (state IN ('reserved','provider_started','reconciliation_required','completed','released')),
  order_type text NOT NULL CHECK (order_type IN ('credits','cash')),
  payment_provider text NOT NULL CHECK (payment_provider = 'xunhupay'),
  paid_amount numeric(20,2) NOT NULL CHECK (paid_amount > 0),
  wallet_amount numeric(20,6) NOT NULL CHECK (wallet_amount > 0),
  wallet_operation_id text,
  release_operation_id text,
  lease_owner text NOT NULL,
  lease_token bigint NOT NULL DEFAULT 1 CHECK (lease_token > 0),
  lease_until timestamptz NOT NULL,
  provider_call_started_at timestamptz,
  provider_refund_id text,
  provider_trade_order_id text,
  provider_refund_amount numeric(20,2),
  provider_status text,
  provider_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  released_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_refund_one_active_per_order
  ON public.payment_refund_attempts (trade_order_id)
  WHERE state IN ('reserved','provider_started','reconciliation_required','completed');

CREATE UNIQUE INDEX IF NOT EXISTS payment_refund_provider_receipt_unique
  ON public.payment_refund_attempts (provider_refund_id)
  WHERE provider_refund_id IS NOT NULL AND trim(provider_refund_id) <> '';

CREATE INDEX IF NOT EXISTS payment_refund_state_updated_idx
  ON public.payment_refund_attempts (state, updated_at);

ALTER TABLE public.payment_refund_attempts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS refund_attempt_id text,
  ADD COLUMN IF NOT EXISTS provider_refund_id text,
  ADD COLUMN IF NOT EXISTS provider_refund_amount numeric(20,2),
  ADD COLUMN IF NOT EXISTS provider_refund_status text,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

CREATE OR REPLACE FUNCTION public.claim_payment_refund_attempt_atomic(
  p_attempt_id text,
  p_trade_order_id text,
  p_admin_user_id text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_reason text,
  p_lease_owner text,
  p_lease_seconds integer DEFAULT 300
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempt_id text := trim(coalesce(p_attempt_id, ''));
  v_trade_order_id text := trim(coalesce(p_trade_order_id, ''));
  v_admin_user_id text := trim(coalesce(p_admin_user_id, ''));
  v_idempotency_key text := trim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := trim(coalesce(p_request_fingerprint, ''));
  v_reason text := trim(coalesce(p_reason, ''));
  v_lease_owner text := trim(coalesce(p_lease_owner, ''));
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 300), 300));
  v_existing public.payment_refund_attempts%ROWTYPE;
  v_order public.payment_orders%ROWTYPE;
  v_attempt public.payment_refund_attempts%ROWTYPE;
  v_wallet_kind text;
  v_wallet_amount numeric(20,6);
  v_wallet_result jsonb;
  v_wallet_operation_id text;
  v_wallet_replayed boolean;
BEGIN
  IF v_attempt_id !~ '^[a-f0-9]{64}$'
     OR v_fingerprint !~ '^[a-f0-9]{64}$'
     OR v_trade_order_id = '' OR length(v_trade_order_id) > 240
     OR v_admin_user_id = '' OR length(v_admin_user_id) > 240
     OR v_idempotency_key = '' OR length(v_idempotency_key) > 128
     OR v_reason = '' OR length(v_reason) > 80
     OR v_lease_owner = '' OR length(v_lease_owner) > 240 THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.payment_refund_attempts
   WHERE attempt_id = v_attempt_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.trade_order_id <> v_trade_order_id
       OR v_existing.admin_user_id <> v_admin_user_id
       OR v_existing.idempotency_key <> v_idempotency_key
       OR v_existing.request_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
    END IF;
    IF v_existing.state = 'completed' THEN
      RETURN jsonb_build_object('action','replay','record',to_jsonb(v_existing));
    END IF;
    IF v_existing.state = 'released' THEN
      RETURN jsonb_build_object('action','released','record',to_jsonb(v_existing));
    END IF;
    IF v_existing.state IN ('provider_started','reconciliation_required') THEN
      RETURN jsonb_build_object('action','reconciliation_required','record',to_jsonb(v_existing));
    END IF;
    IF v_existing.lease_until > now() THEN
      RETURN jsonb_build_object('action','in_progress','record',to_jsonb(v_existing));
    END IF;
    UPDATE public.payment_refund_attempts
       SET lease_owner = v_lease_owner,
           lease_token = lease_token + 1,
           lease_until = now() + make_interval(secs => v_lease_seconds),
           updated_at = now()
     WHERE attempt_id = v_attempt_id
       AND state = 'reserved'
       AND lease_until <= now()
     RETURNING * INTO v_attempt;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_LEASE_CONFLICT' USING ERRCODE = '40001';
    END IF;
    RETURN jsonb_build_object('action','execute','record',to_jsonb(v_attempt));
  END IF;

  SELECT * INTO v_order
    FROM public.payment_orders
   WHERE trade_order_id = v_trade_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.status <> 'paid' THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_ORDER_STATUS_INVALID' USING ERRCODE = '22023';
  END IF;
  IF lower(trim(coalesce(v_order.payment_provider, ''))) <> 'xunhupay' THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_PROVIDER_UNSUPPORTED' USING ERRCODE = '22023';
  END IF;
  IF v_order.provider_trade_order_id IS NULL
     OR v_order.provider_transaction_id IS NULL
     OR v_order.provider_paid_amount IS NULL
     OR v_order.provider_confirmed_at IS NULL
     OR trim(v_order.provider_trade_order_id) <> v_trade_order_id
     OR v_order.provider_paid_amount <> round(v_order.amount, 2) THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_EVIDENCE_INVALID' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payment_refund_attempts
     WHERE trade_order_id = v_trade_order_id
       AND state IN ('reserved','provider_started','reconciliation_required','completed')
  ) THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_ALREADY_ACTIVE' USING ERRCODE = '23505';
  END IF;

  IF v_order.type = 'credits' THEN
    IF v_order.credits_amount IS NULL OR v_order.credits_amount <= 0 THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_AMOUNT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_wallet_kind := 'credit_charge';
    v_wallet_amount := round(v_order.credits_amount, 6);
  ELSIF v_order.type = 'cash' THEN
    v_wallet_kind := 'cash_charge';
    v_wallet_amount := round(v_order.amount, 2);
  ELSE
    RAISE EXCEPTION 'PAYMENT_REFUND_ORDER_TYPE_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.payment_refund_attempts (
    attempt_id, trade_order_id, user_id, admin_user_id, idempotency_key,
    request_fingerprint, reason, state, order_type, payment_provider,
    paid_amount, wallet_amount, lease_owner, lease_until
  ) VALUES (
    v_attempt_id, v_trade_order_id, v_order.user_id::text, v_admin_user_id,
    v_idempotency_key, v_fingerprint, v_reason, 'reserved', v_order.type,
    'xunhupay', round(v_order.amount, 2), v_wallet_amount, v_lease_owner,
    now() + make_interval(secs => v_lease_seconds)
  );

  v_wallet_result := public.apply_wallet_operation_atomic(
    v_order.user_id::text,
    v_wallet_kind,
    'payment-refund-reserve:' || v_attempt_id,
    v_wallet_amount,
    'Reserve wallet value before provider payment refund [' || v_trade_order_id || ']',
    jsonb_build_object('source','payment_refund','attempt_id',v_attempt_id,'trade_order_id',v_trade_order_id,'phase','reserve')
  );
  IF NOT coalesce((v_wallet_result ->> 'success')::boolean, false) THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_BALANCE_INSUFFICIENT';
  END IF;
  v_wallet_operation_id := nullif(v_wallet_result ->> 'operation_id', '');
  v_wallet_replayed := coalesce((v_wallet_result ->> 'already_fulfilled')::boolean, false);
  IF v_wallet_operation_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_WALLET_RECEIPT_INVALID';
  END IF;

  -- A payment refund reverses a recharge; it is not product consumption.
  -- Neutralize the generic debit counter and reduce the matching recharge
  -- counter only on the first durable reserve mutation.
  IF NOT v_wallet_replayed THEN
    IF v_order.type = 'credits' THEN
      UPDATE public.users SET
        total_credits_consumed = greatest(coalesce(total_credits_consumed, 0) - v_wallet_amount, 0),
        total_credits_recharged = greatest(coalesce(total_credits_recharged, 0) - v_wallet_amount, 0),
        updated_at = now()
      WHERE id = v_order.user_id::text;
    ELSE
      UPDATE public.users SET
        total_cash_consumed = greatest(coalesce(total_cash_consumed, 0) - v_wallet_amount, 0),
        total_cash_recharged = greatest(coalesce(total_cash_recharged, 0) - v_wallet_amount, 0),
        updated_at = now()
      WHERE id = v_order.user_id::text;
    END IF;
  END IF;

  UPDATE public.payment_refund_attempts
     SET wallet_operation_id = v_wallet_operation_id,
         updated_at = now()
   WHERE attempt_id = v_attempt_id
   RETURNING * INTO v_attempt;
  RETURN jsonb_build_object('action','execute','record',to_jsonb(v_attempt));
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_payment_refund_provider_started_atomic(
  p_attempt_id text,
  p_request_fingerprint text,
  p_lease_owner text,
  p_lease_token bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempt public.payment_refund_attempts%ROWTYPE;
BEGIN
  SELECT * INTO v_attempt FROM public.payment_refund_attempts
   WHERE attempt_id = trim(coalesce(p_attempt_id,'')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_REFUND_ATTEMPT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_attempt.request_fingerprint <> trim(coalesce(p_request_fingerprint,''))
     OR v_attempt.lease_owner <> trim(coalesce(p_lease_owner,''))
     OR v_attempt.lease_token <> p_lease_token THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_LEASE_CONFLICT' USING ERRCODE='40001';
  END IF;
  IF v_attempt.state <> 'reserved' OR v_attempt.lease_until <= now() THEN
    RETURN jsonb_build_object('action','reconciliation_required','record',to_jsonb(v_attempt));
  END IF;
  UPDATE public.payment_refund_attempts SET
    state='provider_started', provider_call_started_at=now(), updated_at=now()
  WHERE attempt_id=v_attempt.attempt_id RETURNING * INTO v_attempt;
  RETURN jsonb_build_object('action','execute','record',to_jsonb(v_attempt));
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_payment_refund_attempt_atomic(
  p_attempt_id text,
  p_request_fingerprint text,
  p_lease_owner text,
  p_lease_token bigint,
  p_terminal_state text,
  p_provider_status text,
  p_provider_trade_order_id text DEFAULT NULL,
  p_provider_refund_id text DEFAULT NULL,
  p_provider_refund_amount numeric DEFAULT NULL,
  p_provider_response jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempt public.payment_refund_attempts%ROWTYPE;
  v_terminal text := lower(trim(coalesce(p_terminal_state,'')));
  v_provider_status text := upper(trim(coalesce(p_provider_status,'')));
  v_provider_order text := trim(coalesce(p_provider_trade_order_id,''));
  v_provider_refund_id text := trim(coalesce(p_provider_refund_id,''));
  v_provider_amount numeric(20,2);
  v_release_kind text;
  v_release_result jsonb;
  v_release_replayed boolean;
BEGIN
  IF v_terminal NOT IN ('completed','released','reconciliation_required')
     OR v_provider_status = '' OR length(v_provider_status) > 64
     OR octet_length(coalesce(p_provider_response,'{}'::jsonb)::text) > 65536 THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_RESULT_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_attempt FROM public.payment_refund_attempts
   WHERE attempt_id=trim(coalesce(p_attempt_id,'')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_REFUND_ATTEMPT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_attempt.request_fingerprint <> trim(coalesce(p_request_fingerprint,''))
     OR v_attempt.lease_owner <> trim(coalesce(p_lease_owner,''))
     OR v_attempt.lease_token <> p_lease_token THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_LEASE_CONFLICT' USING ERRCODE='40001';
  END IF;
  IF v_attempt.state = 'completed' THEN
    RETURN jsonb_build_object('action','replay','record',to_jsonb(v_attempt));
  END IF;
  IF v_attempt.state = 'released' THEN
    RETURN jsonb_build_object('action','released','record',to_jsonb(v_attempt));
  END IF;
  IF v_attempt.state NOT IN ('provider_started','reconciliation_required') THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_STATE_CONFLICT' USING ERRCODE='22023';
  END IF;

  IF v_terminal = 'completed' THEN
    IF v_provider_status <> 'CD'
       OR v_provider_order <> v_attempt.trade_order_id
       OR v_provider_refund_id = '' OR length(v_provider_refund_id) > 240
       OR p_provider_refund_amount IS NULL
       OR p_provider_refund_amount::text IN ('NaN','Infinity','-Infinity')
       OR round(p_provider_refund_amount,2) <> v_attempt.paid_amount THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_EVIDENCE_MISMATCH' USING ERRCODE='22023';
    END IF;
    v_provider_amount := round(p_provider_refund_amount,2);
    UPDATE public.payment_orders SET
      status='refunded', refund_attempt_id=v_attempt.attempt_id,
      provider_refund_id=v_provider_refund_id,
      provider_refund_amount=v_provider_amount,
      provider_refund_status=v_provider_status,
      refunded_at=now()
    WHERE trade_order_id=v_attempt.trade_order_id AND status='paid';
    IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_REFUND_ORDER_STATUS_CONFLICT' USING ERRCODE='22023'; END IF;
    UPDATE public.payment_refund_attempts SET
      state='completed', provider_status=v_provider_status,
      provider_trade_order_id=v_provider_order,
      provider_refund_id=v_provider_refund_id,
      provider_refund_amount=v_provider_amount,
      provider_response=coalesce(p_provider_response,'{}'::jsonb),
      completed_at=now(), updated_at=now()
    WHERE attempt_id=v_attempt.attempt_id RETURNING * INTO v_attempt;
    RETURN jsonb_build_object('action','replay','record',to_jsonb(v_attempt));
  END IF;

  IF v_terminal = 'released' THEN
    IF v_provider_status <> 'UD' THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_RELEASE_EVIDENCE_INVALID' USING ERRCODE='22023';
    END IF;
    v_release_kind := CASE WHEN v_attempt.order_type='credits' THEN 'credit_refund' ELSE 'cash_refund' END;
    v_release_result := public.apply_wallet_operation_atomic(
      v_attempt.user_id, v_release_kind,
      'payment-refund-release:' || v_attempt.attempt_id,
      v_attempt.wallet_amount,
      'Release wallet reservation after definitive provider refund failure [' || v_attempt.trade_order_id || ']',
      jsonb_build_object('source','payment_refund','attempt_id',v_attempt.attempt_id,'trade_order_id',v_attempt.trade_order_id,'phase','release')
    );
    IF NOT coalesce((v_release_result ->> 'success')::boolean,false) THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_RELEASE_FAILED';
    END IF;
    v_release_replayed := coalesce((v_release_result ->> 'already_fulfilled')::boolean,false);
    IF NOT v_release_replayed THEN
      IF v_attempt.order_type='credits' THEN
        UPDATE public.users SET total_credits_recharged=coalesce(total_credits_recharged,0)+v_attempt.wallet_amount, updated_at=now() WHERE id=v_attempt.user_id;
      ELSE
        UPDATE public.users SET total_cash_recharged=coalesce(total_cash_recharged,0)+v_attempt.wallet_amount, updated_at=now() WHERE id=v_attempt.user_id;
      END IF;
    END IF;
    UPDATE public.payment_refund_attempts SET
      state='released', release_operation_id=nullif(v_release_result ->> 'operation_id',''),
      provider_status=v_provider_status,
      provider_response=coalesce(p_provider_response,'{}'::jsonb),
      released_at=now(), updated_at=now()
    WHERE attempt_id=v_attempt.attempt_id RETURNING * INTO v_attempt;
    RETURN jsonb_build_object('action','released','record',to_jsonb(v_attempt));
  END IF;

  UPDATE public.payment_refund_attempts SET
    state='reconciliation_required', provider_status=v_provider_status,
    provider_trade_order_id=nullif(v_provider_order,''),
    provider_refund_id=nullif(v_provider_refund_id,''),
    provider_refund_amount=p_provider_refund_amount,
    provider_response=coalesce(p_provider_response,'{}'::jsonb),
    updated_at=now()
  WHERE attempt_id=v_attempt.attempt_id RETURNING * INTO v_attempt;
  RETURN jsonb_build_object('action','reconciliation_required','record',to_jsonb(v_attempt));
END;
$$;

REVOKE ALL ON TABLE public.payment_refund_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_payment_refund_attempt_atomic(text,text,text,text,text,text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_payment_refund_provider_started_atomic(text,text,text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_payment_refund_attempt_atomic(text,text,text,bigint,text,text,text,text,numeric,jsonb) FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.payment_refund_attempts TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_payment_refund_attempt_atomic(text,text,text,text,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_payment_refund_provider_started_atomic(text,text,text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_payment_refund_attempt_atomic(text,text,text,bigint,text,text,text,text,numeric,jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
