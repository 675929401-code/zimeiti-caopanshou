-- Provider-evidence payment fulfillment hardening.
--
-- This migration keeps provider confirmation evidence on the payment order,
-- prevents one provider transaction from funding multiple orders, disables the
-- legacy evidence-free fulfillment RPC and exposes one service-role-only RPC
-- that commits wallet balance, wallet ledgers and the paid order state in one
-- PostgreSQL transaction.

BEGIN;

ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS provider_trade_order_id text,
  ADD COLUMN IF NOT EXISTS provider_transaction_id text,
  ADD COLUMN IF NOT EXISTS provider_paid_amount numeric(20, 2),
  ADD COLUMN IF NOT EXISTS provider_confirmed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.payment_orders'::regclass
       AND conname = 'payment_provider_evidence_all_or_none'
  ) THEN
    ALTER TABLE public.payment_orders
      ADD CONSTRAINT payment_provider_evidence_all_or_none CHECK (
        (
          provider_trade_order_id IS NULL
          AND provider_transaction_id IS NULL
          AND provider_paid_amount IS NULL
          AND provider_confirmed_at IS NULL
        )
        OR
        (
          provider_trade_order_id IS NOT NULL
          AND trim(provider_trade_order_id) <> ''
          AND length(provider_trade_order_id) <= 240
          AND provider_transaction_id IS NOT NULL
          AND trim(provider_transaction_id) <> ''
          AND length(provider_transaction_id) <= 240
          AND provider_paid_amount IS NOT NULL
          AND provider_paid_amount > 0
          AND provider_paid_amount::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND provider_confirmed_at IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_provider_transaction_unique
  ON public.payment_orders (lower(trim(payment_provider)), provider_transaction_id)
  WHERE payment_provider IS NOT NULL
    AND trim(payment_provider) <> ''
    AND provider_transaction_id IS NOT NULL
    AND trim(provider_transaction_id) <> '';

CREATE OR REPLACE FUNCTION public.fulfill_payment_order_with_evidence_atomic(
  p_trade_order_id text,
  p_provider text,
  p_provider_trade_order_id text,
  p_provider_transaction_id text,
  p_paid_amount numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_trade_order_id text := trim(coalesce(p_trade_order_id, ''));
  v_provider text := lower(trim(coalesce(p_provider, '')));
  v_provider_trade_order_id text := trim(coalesce(p_provider_trade_order_id, ''));
  v_provider_transaction_id text := trim(coalesce(p_provider_transaction_id, ''));
  v_order public.payment_orders%ROWTYPE;
  v_expected_amount numeric(20, 2);
  v_paid_amount numeric(20, 2);
  v_operation_kind text;
  v_wallet_amount numeric(20, 6);
  v_existing_operation public.wallet_operations%ROWTYPE;
  v_ledger_count integer;
  v_wallet_result jsonb;
BEGIN
  IF v_trade_order_id = '' OR length(v_trade_order_id) > 240
     OR v_trade_order_id ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'PAYMENT_ORDER_ID_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_provider !~ '^[a-z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_provider_trade_order_id = ''
     OR length(v_provider_trade_order_id) > 240
     OR v_provider_trade_order_id ~ '[[:cntrl:]]'
     OR v_provider_trade_order_id <> v_trade_order_id THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_ORDER_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF v_provider_transaction_id = ''
     OR length(v_provider_transaction_id) > 240
     OR v_provider_transaction_id ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_TRANSACTION_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_paid_amount IS NULL
     OR p_paid_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_paid_amount <= 0
     OR round(p_paid_amount, 2) <> p_paid_amount THEN
    RAISE EXCEPTION 'PAYMENT_PAID_AMOUNT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_paid_amount := p_paid_amount::numeric(20, 2);

  SELECT * INTO v_order
    FROM public.payment_orders
   WHERE trade_order_id = v_trade_order_id
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

  IF EXISTS (
    SELECT 1
      FROM public.payment_orders other_order
     WHERE other_order.id <> v_order.id
       AND lower(trim(other_order.payment_provider)) = v_provider
       AND other_order.provider_transaction_id = v_provider_transaction_id
  ) THEN
    RAISE EXCEPTION 'PAYMENT_PROVIDER_TRANSACTION_REUSED' USING ERRCODE = '23505';
  END IF;

  IF v_order.type = 'credits' THEN
    IF v_order.credits_amount IS NULL
       OR v_order.credits_amount::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_order.credits_amount <= 0 THEN
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

  IF v_order.status = 'paid' THEN
    IF v_order.provider_trade_order_id IS DISTINCT FROM v_provider_trade_order_id
       OR v_order.provider_transaction_id IS DISTINCT FROM v_provider_transaction_id
       OR v_order.provider_paid_amount IS DISTINCT FROM v_paid_amount
       OR v_order.provider_confirmed_at IS NULL THEN
      RAISE EXCEPTION 'PAYMENT_PAID_EVIDENCE_MISMATCH' USING ERRCODE = '22023';
    END IF;

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
      'provider_trade_order_id', v_order.provider_trade_order_id,
      'provider_transaction_id', v_order.provider_transaction_id,
      'provider_paid_amount', v_order.provider_paid_amount,
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

  IF v_order.provider_trade_order_id IS NOT NULL
     OR v_order.provider_transaction_id IS NOT NULL
     OR v_order.provider_paid_amount IS NOT NULL
     OR v_order.provider_confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_PENDING_WITH_PARTIAL_PROVIDER_EVIDENCE';
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
      'provider_trade_order_id', v_provider_trade_order_id,
      'provider_transaction_id', v_provider_transaction_id,
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
         payment_provider = v_provider,
         provider_trade_order_id = v_provider_trade_order_id,
         provider_transaction_id = v_provider_transaction_id,
         provider_paid_amount = v_paid_amount,
         provider_confirmed_at = now()
   WHERE id = v_order.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_ORDER_UPDATE_FAILED';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_fulfilled', coalesce((v_wallet_result ->> 'already_fulfilled')::boolean, false),
    'trade_order_id', v_order.trade_order_id,
    'status', 'paid',
    'provider_trade_order_id', v_provider_trade_order_id,
    'provider_transaction_id', v_provider_transaction_id,
    'provider_paid_amount', v_paid_amount,
    'wallet_operation', v_wallet_result
  );
END;
$$;

-- Prevent all callers, including service_role, from using the legacy RPC that
-- lacks provider merchant-order and provider-transaction evidence.
REVOKE EXECUTE ON FUNCTION public.fulfill_payment_order_atomic(text, text, numeric)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fulfill_payment_order_with_evidence_atomic(text, text, text, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fulfill_payment_order_with_evidence_atomic(text, text, text, text, numeric)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
