-- Unified wallet ledger + payment fulfillment P0.
--
-- Guarantees:
--   * one stable idempotency key produces at most one balance mutation;
--   * the user balance, legacy transaction row and durable wallet ledger are
--     committed in the same PostgreSQL transaction;
--   * payment order fulfillment locks the order, verifies the provider-paid
--     amount and credits the wallet before marking the order paid;
--   * no application-level fallback is required or permitted.

BEGIN;

CREATE TABLE IF NOT EXISTS public.wallet_operations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL,
  wallet text NOT NULL CHECK (wallet IN ('credits', 'cash')),
  operation_kind text NOT NULL CHECK (
    operation_kind IN (
      'credit_topup',
      'credit_charge',
      'credit_refund',
      'cash_topup',
      'cash_charge',
      'cash_refund'
    )
  ),
  idempotency_key text NOT NULL,
  amount numeric(20, 6) NOT NULL CHECK (amount > 0),
  delta numeric(20, 6) NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  balance_before numeric(20, 6),
  balance_after numeric(20, 6),
  description text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  legacy_transaction_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT wallet_operations_idempotency_unique
    UNIQUE (user_id, operation_kind, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.wallet_ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id bigint NOT NULL REFERENCES public.wallet_operations(id) ON DELETE RESTRICT,
  user_id text NOT NULL,
  wallet text NOT NULL CHECK (wallet IN ('credits', 'cash')),
  delta numeric(20, 6) NOT NULL,
  balance_before numeric(20, 6) NOT NULL,
  balance_after numeric(20, 6) NOT NULL,
  operation_kind text NOT NULL,
  idempotency_key text NOT NULL,
  description text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_ledger_one_entry_per_operation UNIQUE (operation_id),
  CONSTRAINT wallet_ledger_idempotency_unique
    UNIQUE (user_id, operation_kind, idempotency_key)
);

CREATE INDEX IF NOT EXISTS wallet_operations_user_created_idx
  ON public.wallet_operations (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS wallet_ledger_user_created_idx
  ON public.wallet_ledger_entries (user_id, created_at DESC);

ALTER TABLE public.wallet_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_ledger_entries ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.apply_wallet_operation_atomic(
  p_user_id text,
  p_operation_kind text,
  p_idempotency_key text,
  p_amount numeric,
  p_description text DEFAULT '',
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind text := lower(trim(coalesce(p_operation_kind, '')));
  v_key text := trim(coalesce(p_idempotency_key, ''));
  v_wallet text;
  v_direction text;
  v_legacy_type text;
  v_amount numeric(20, 6);
  v_delta numeric(20, 6);
  v_user public.users%ROWTYPE;
  v_user_uuid uuid;
  v_operation public.wallet_operations%ROWTYPE;
  v_balance_before numeric(20, 6);
  v_balance_after numeric(20, 6);
  v_legacy_transaction_id text;
  v_inserted boolean := false;
BEGIN
  IF trim(coalesce(p_user_id, '')) = '' THEN
    RAISE EXCEPTION 'WALLET_USER_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_key = '' OR length(v_key) > 240 THEN
    RAISE EXCEPTION 'WALLET_IDEMPOTENCY_KEY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <= 0 THEN
    RAISE EXCEPTION 'WALLET_AMOUNT_INVALID' USING ERRCODE = '22023';
  END IF;

  CASE v_kind
    WHEN 'credit_topup' THEN
      v_wallet := 'credits'; v_direction := 'credit'; v_legacy_type := 'topup';
    WHEN 'credit_refund' THEN
      v_wallet := 'credits'; v_direction := 'credit'; v_legacy_type := 'refund';
    WHEN 'credit_charge' THEN
      v_wallet := 'credits'; v_direction := 'debit'; v_legacy_type := 'consumption';
    WHEN 'cash_topup' THEN
      v_wallet := 'cash'; v_direction := 'credit'; v_legacy_type := 'topup';
    WHEN 'cash_refund' THEN
      v_wallet := 'cash'; v_direction := 'credit'; v_legacy_type := 'refund';
    WHEN 'cash_charge' THEN
      v_wallet := 'cash'; v_direction := 'debit'; v_legacy_type := 'consume';
    ELSE
      RAISE EXCEPTION 'WALLET_OPERATION_KIND_INVALID' USING ERRCODE = '22023';
  END CASE;

  v_amount := CASE
    WHEN v_wallet = 'cash' THEN round(p_amount, 2)
    ELSE round(p_amount, 6)
  END;
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'WALLET_AMOUNT_ROUNDS_TO_ZERO' USING ERRCODE = '22023';
  END IF;
  v_delta := CASE WHEN v_direction = 'debit' THEN -v_amount ELSE v_amount END;

  INSERT INTO public.wallet_operations (
    user_id,
    wallet,
    operation_kind,
    idempotency_key,
    amount,
    delta,
    status,
    description,
    metadata
  ) VALUES (
    trim(p_user_id),
    v_wallet,
    v_kind,
    v_key,
    v_amount,
    v_delta,
    'processing',
    coalesce(p_description, ''),
    coalesce(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (user_id, operation_kind, idempotency_key) DO NOTHING
  RETURNING * INTO v_operation;

  v_inserted := FOUND;
  IF NOT v_inserted THEN
    SELECT * INTO v_operation
      FROM public.wallet_operations
     WHERE user_id = trim(p_user_id)
       AND operation_kind = v_kind
       AND idempotency_key = v_key;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'WALLET_IDEMPOTENCY_LOOKUP_FAILED';
    END IF;
    IF v_operation.wallet <> v_wallet
       OR v_operation.amount <> v_amount
       OR v_operation.delta <> v_delta THEN
      RAISE EXCEPTION 'WALLET_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
    END IF;
    IF v_operation.status = 'completed' THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_fulfilled', true,
        'operation_id', v_operation.id,
        'wallet', v_operation.wallet,
        'operation_kind', v_operation.operation_kind,
        'amount', v_operation.amount,
        'delta', v_operation.delta,
        'balance_before', v_operation.balance_before,
        'balance_after', v_operation.balance_after,
        'legacy_transaction_id', v_operation.legacy_transaction_id
      );
    END IF;
    RAISE EXCEPTION 'WALLET_OPERATION_INCOMPLETE';
  END IF;

  SELECT * INTO v_user
    FROM public.users
   WHERE id = trim(p_user_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_USER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Current credit/cash transaction tables use UUID user_id while users.id is
  -- varchar. Refuse an unrepresentable identity instead of mutating a balance
  -- without its legacy audit row.
  BEGIN
    v_user_uuid := v_user.id::text::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'WALLET_USER_ID_NOT_UUID_COMPATIBLE' USING ERRCODE = '22023';
  END;

  IF v_wallet = 'credits' THEN
    v_balance_before := coalesce(v_user.credits, 0);
  ELSE
    v_balance_before := coalesce(v_user.cash_balance, 0);
  END IF;

  IF v_direction = 'debit' AND v_balance_before < v_amount THEN
    RAISE EXCEPTION '%', CASE
      WHEN v_wallet = 'credits' THEN 'INSUFFICIENT_CREDITS'
      ELSE 'INSUFFICIENT_CASH'
    END USING ERRCODE = 'P0001';
  END IF;
  v_balance_after := v_balance_before + v_delta;

  IF v_kind = 'credit_topup' THEN
    UPDATE public.users
       SET credits = v_balance_after,
           total_credits_recharged = coalesce(total_credits_recharged, 0) + v_amount,
           updated_at = now()
     WHERE id = v_user.id;
  ELSIF v_kind = 'credit_charge' THEN
    UPDATE public.users
       SET credits = v_balance_after,
           total_credits_consumed = coalesce(total_credits_consumed, 0) + v_amount,
           updated_at = now()
     WHERE id = v_user.id;
  ELSIF v_kind = 'credit_refund' THEN
    UPDATE public.users
       SET credits = v_balance_after,
           updated_at = now()
     WHERE id = v_user.id;
  ELSIF v_kind = 'cash_topup' THEN
    UPDATE public.users
       SET cash_balance = v_balance_after,
           total_cash_recharged = coalesce(total_cash_recharged, 0) + v_amount,
           updated_at = now()
     WHERE id = v_user.id;
  ELSIF v_kind = 'cash_charge' THEN
    UPDATE public.users
       SET cash_balance = v_balance_after,
           total_cash_consumed = coalesce(total_cash_consumed, 0) + v_amount,
           updated_at = now()
     WHERE id = v_user.id;
  ELSE
    UPDATE public.users
       SET cash_balance = v_balance_after,
           updated_at = now()
     WHERE id = v_user.id;
  END IF;

  IF v_wallet = 'credits' THEN
    INSERT INTO public.credit_transactions (
      user_id,
      amount,
      type,
      transaction_type,
      balance_after,
      description,
      metadata
    ) VALUES (
      v_user_uuid,
      v_delta,
      v_legacy_type,
      v_legacy_type,
      v_balance_after,
      left(coalesce(p_description, ''), 255),
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'wallet_operation_id', v_operation.id,
        'idempotency_key', v_key,
        'exact_balance', v_balance_after
      )
    )
    RETURNING id::text INTO v_legacy_transaction_id;
  ELSE
    INSERT INTO public.cash_transactions (
      user_id,
      amount,
      balance_after,
      type,
      description,
      reference_id,
      metadata
    ) VALUES (
      v_user_uuid,
      v_amount,
      v_balance_after,
      v_legacy_type,
      coalesce(p_description, ''),
      v_key,
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'wallet_operation_id', v_operation.id,
        'idempotency_key', v_key,
        'signed_delta', v_delta
      )
    )
    RETURNING id::text INTO v_legacy_transaction_id;
  END IF;

  INSERT INTO public.wallet_ledger_entries (
    operation_id,
    user_id,
    wallet,
    delta,
    balance_before,
    balance_after,
    operation_kind,
    idempotency_key,
    description,
    metadata
  ) VALUES (
    v_operation.id,
    trim(p_user_id),
    v_wallet,
    v_delta,
    v_balance_before,
    v_balance_after,
    v_kind,
    v_key,
    coalesce(p_description, ''),
    coalesce(p_metadata, '{}'::jsonb)
  );

  UPDATE public.wallet_operations
     SET status = 'completed',
         balance_before = v_balance_before,
         balance_after = v_balance_after,
         legacy_transaction_id = v_legacy_transaction_id,
         completed_at = now()
   WHERE id = v_operation.id
   RETURNING * INTO v_operation;

  RETURN jsonb_build_object(
    'success', true,
    'already_fulfilled', false,
    'operation_id', v_operation.id,
    'wallet', v_operation.wallet,
    'operation_kind', v_operation.operation_kind,
    'amount', v_operation.amount,
    'delta', v_operation.delta,
    'balance_before', v_operation.balance_before,
    'balance_after', v_operation.balance_after,
    'legacy_transaction_id', v_operation.legacy_transaction_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfill_payment_order_atomic(
  p_trade_order_id text,
  p_provider text,
  p_paid_amount numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.payment_orders%ROWTYPE;
  v_provider text := lower(trim(coalesce(p_provider, '')));
  v_expected_amount numeric(20, 2);
  v_paid_amount numeric(20, 2);
  v_operation_kind text;
  v_wallet_amount numeric(20, 6);
  v_existing_operation public.wallet_operations%ROWTYPE;
  v_ledger_count integer;
  v_wallet_result jsonb;
BEGIN
  IF trim(coalesce(p_trade_order_id, '')) = '' THEN
    RAISE EXCEPTION 'PAYMENT_ORDER_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_provider = '' OR length(v_provider) > 64 THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_paid_amount IS NULL
     OR p_paid_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_paid_amount <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_PAID_AMOUNT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order
    FROM public.payment_orders
   WHERE trade_order_id = trim(p_trade_order_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_order.amount IS NULL
     OR v_order.amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_order.amount <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_ORDER_AMOUNT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_expected_amount := round(v_order.amount, 2);
  v_paid_amount := round(p_paid_amount, 2);
  IF v_paid_amount <> v_expected_amount THEN
    RAISE EXCEPTION 'PAYMENT_AMOUNT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  IF v_order.payment_provider IS NOT NULL
     AND trim(v_order.payment_provider) <> ''
     AND lower(trim(v_order.payment_provider)) <> v_provider THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF v_order.status IN ('cancelled', 'refunded') THEN
    RAISE EXCEPTION 'PAYMENT_ORDER_STATUS_REJECTED' USING ERRCODE = '22023';
  END IF;

  IF v_order.type = 'credits' THEN
    IF v_order.credits_amount IS NULL OR v_order.credits_amount <= 0 THEN
      RAISE EXCEPTION 'PAYMENT_CREDITS_AMOUNT_MISSING' USING ERRCODE = '22023';
    END IF;
    v_operation_kind := 'credit_topup';
    v_wallet_amount := round(v_order.credits_amount, 6);
  ELSIF v_order.type = 'cash' THEN
    v_operation_kind := 'cash_topup';
    v_wallet_amount := v_expected_amount;
  ELSE
    RAISE EXCEPTION 'PAYMENT_ORDER_TYPE_INVALID' USING ERRCODE = '22023';
  END IF;

  IF v_wallet_amount IS NULL OR v_wallet_amount <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_WALLET_AMOUNT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- A paid order is not accepted as proof of fulfillment by itself.  It must
  -- have exactly one completed wallet operation and exactly one matching
  -- ledger row.  This prevents legacy/partial writes from being mistaken for
  -- an idempotent success and silently skipping the wallet credit.
  IF v_order.status = 'paid' THEN
    SELECT * INTO v_existing_operation
      FROM public.wallet_operations
     WHERE user_id = v_order.user_id::text
       AND operation_kind = v_operation_kind
       AND idempotency_key = 'payment:' || v_order.trade_order_id;

    IF NOT FOUND
       OR v_existing_operation.status <> 'completed'
       OR v_existing_operation.amount <> v_wallet_amount
       OR v_existing_operation.balance_before IS NULL
       OR v_existing_operation.balance_after IS NULL THEN
      RAISE EXCEPTION 'PAYMENT_PAID_WITHOUT_COMPLETED_WALLET_OPERATION';
    END IF;

    SELECT count(*) INTO v_ledger_count
      FROM public.wallet_ledger_entries
     WHERE operation_id = v_existing_operation.id
       AND user_id = v_order.user_id::text
       AND operation_kind = v_operation_kind
       AND idempotency_key = 'payment:' || v_order.trade_order_id
       AND delta = v_wallet_amount
       AND balance_before = v_existing_operation.balance_before
       AND balance_after = v_existing_operation.balance_after;

    IF v_ledger_count <> 1 THEN
      RAISE EXCEPTION 'PAYMENT_PAID_WITHOUT_MATCHING_LEDGER';
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'already_fulfilled', true,
      'trade_order_id', v_order.trade_order_id,
      'status', v_order.status,
      'paid_at', v_order.paid_at,
      'wallet_operation', jsonb_build_object(
        'success', true,
        'already_fulfilled', true,
        'operation_id', v_existing_operation.id,
        'wallet', v_existing_operation.wallet,
        'operation_kind', v_existing_operation.operation_kind,
        'amount', v_existing_operation.amount,
        'delta', v_existing_operation.delta,
        'balance_before', v_existing_operation.balance_before,
        'balance_after', v_existing_operation.balance_after,
        'legacy_transaction_id', v_existing_operation.legacy_transaction_id
      )
    );
  END IF;

  v_wallet_result := public.apply_wallet_operation_atomic(
    v_order.user_id::text,
    v_operation_kind,
    'payment:' || v_order.trade_order_id,
    v_wallet_amount,
    'Online recharge ' || v_expected_amount::text || ' (' || v_provider || ') [' || v_order.trade_order_id || ']',
    jsonb_build_object(
      'source', 'payment',
      'trade_order_id', v_order.trade_order_id,
      'provider', v_provider,
      'paid_amount', v_paid_amount,
      'order_type', v_order.type
    )
  );

  IF NOT coalesce((v_wallet_result ->> 'success')::boolean, false) THEN
    RAISE EXCEPTION 'PAYMENT_WALLET_OPERATION_FAILED';
  END IF;

  UPDATE public.payment_orders
     SET status = 'paid',
         paid_at = coalesce(paid_at, now()),
         payment_provider = v_provider
   WHERE id = v_order.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_ORDER_UPDATE_FAILED';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_fulfilled', coalesce((v_wallet_result ->> 'already_fulfilled')::boolean, false),
    'trade_order_id', v_order.trade_order_id,
    'status', 'paid',
    'wallet_operation', v_wallet_result
  );
END;
$$;

REVOKE ALL ON public.wallet_operations FROM anon, authenticated;
REVOKE ALL ON public.wallet_ledger_entries FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.apply_wallet_operation_atomic(text, text, text, numeric, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fulfill_payment_order_atomic(text, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_wallet_operation_atomic(text, text, text, numeric, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfill_payment_order_atomic(text, text, numeric)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
