BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Older installations already had user_voices, so CREATE TABLE IF NOT EXISTS
-- could not apply the durable defaults and nullability required by the voice
-- finalizer. Repair only those declared columns and preserve every identifier.
DO $guard$
BEGIN
  IF to_regclass('public.user_voices') IS NULL THEN
    RAISE EXCEPTION 'USER_VOICES_REQUIRED_FOR_SEMANTIC_RECONCILIATION';
  END IF;
END;
$guard$;

ALTER TABLE public.user_voices
  ALTER COLUMN source_info SET DEFAULT '{}'::jsonb,
  ALTER COLUMN is_active SET DEFAULT true,
  ALTER COLUMN updated_at SET DEFAULT now();

UPDATE public.user_voices
   SET source_info = coalesce(source_info, '{}'::jsonb),
       is_active = coalesce(is_active, true),
       updated_at = coalesce(updated_at, created_at, now())
 WHERE source_info IS NULL OR is_active IS NULL OR updated_at IS NULL;

ALTER TABLE public.user_voices
  ALTER COLUMN source_info SET NOT NULL,
  ALTER COLUMN is_active SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

-- Reassert the reservation-aware wallet implementation. The debit guard must
-- subtract credits_reserved before accepting a new credit charge.
CREATE OR REPLACE FUNCTION public.apply_wallet_operation_atomic(p_user_id text, p_operation_kind text, p_idempotency_key text, p_amount numeric, p_description text DEFAULT ''::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  IF v_direction = 'debit' AND (v_balance_before - CASE WHEN v_wallet = 'credits' THEN v_user.credits_reserved ELSE 0 END) < v_amount THEN
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
$function$
;
REVOKE ALL ON FUNCTION public.apply_wallet_operation_atomic(text, text, text, numeric, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_wallet_operation_atomic(text, text, text, numeric, text, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
