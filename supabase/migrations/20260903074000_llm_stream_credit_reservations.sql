BEGIN;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS credits_reserved numeric(20,6) NOT NULL DEFAULT 0;
ALTER TABLE public.users ADD CONSTRAINT users_credit_reservation_balance_check
  CHECK (credits_reserved >= 0 AND coalesce(credits, 0) >= credits_reserved);

CREATE TABLE public.llm_credit_reservations (
  record_id text NOT NULL REFERENCES public.llm_request_attempts(record_id) ON DELETE RESTRICT,
  lease_token bigint NOT NULL,
  lease_owner text NOT NULL,
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  client_request_id text NOT NULL,
  amount numeric(20,6) NOT NULL CHECK (amount > 0),
  price_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held','settled','released')),
  actual_amount numeric(20,6),
  receipt jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (record_id, lease_token)
);
CREATE INDEX llm_credit_reservations_pending_idx ON public.llm_credit_reservations(user_id, expires_at) WHERE status = 'held';
ALTER TABLE public.llm_credit_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.llm_credit_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.llm_credit_reservations TO service_role;

CREATE FUNCTION public.reserve_llm_credits_atomic(
  p_record_id text, p_lease_owner text, p_lease_token bigint,
  p_amount numeric, p_price_snapshot jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_attempt public.llm_request_attempts%ROWTYPE;
  v_hold public.llm_credit_reservations%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_amount numeric(20,6);
BEGIN
  IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity') OR p_amount <= 0
     OR jsonb_typeof(p_price_snapshot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'LLM_RESERVATION_INPUT_INVALID';
  END IF;
  v_amount := round(p_amount, 6);
  IF v_amount <= 0 THEN RAISE EXCEPTION 'LLM_RESERVATION_INPUT_INVALID'; END IF;
  SELECT * INTO v_attempt FROM public.llm_request_attempts WHERE record_id=p_record_id FOR UPDATE;
  IF NOT FOUND OR v_attempt.state <> 'running' OR v_attempt.lease_owner IS DISTINCT FROM p_lease_owner
    OR v_attempt.lease_token IS DISTINCT FROM p_lease_token OR v_attempt.lease_expires_at <= now()
    OR v_attempt.provider_call_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'LLM_RESERVATION_LEASE_CONFLICT';
  END IF;
  SELECT * INTO v_hold FROM public.llm_credit_reservations
    WHERE record_id=p_record_id AND lease_token=p_lease_token FOR UPDATE;
  IF FOUND THEN
    IF v_hold.status <> 'held' OR v_hold.amount <> v_amount OR v_hold.price_snapshot <> p_price_snapshot
       OR v_hold.lease_owner <> p_lease_owner THEN RAISE EXCEPTION 'LLM_RESERVATION_CONFLICT'; END IF;
    RETURN jsonb_build_object('success',true,'already_reserved',true,'amount',v_hold.amount,'status',v_hold.status);
  END IF;
  FOR v_hold IN SELECT * FROM public.llm_credit_reservations
    WHERE record_id=p_record_id AND lease_token<>p_lease_token AND status='held' FOR UPDATE LOOP
    PERFORM public.release_llm_credits_atomic(v_hold.record_id,v_hold.lease_owner,v_hold.lease_token,'lease_replaced_before_provider');
  END LOOP;
  SELECT * INTO v_user FROM public.users WHERE id=v_attempt.user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WALLET_USER_NOT_FOUND'; END IF;
  IF coalesce(v_user.credits,0)-v_user.credits_reserved < v_amount THEN RAISE EXCEPTION 'INSUFFICIENT_CREDITS'; END IF;
  INSERT INTO public.llm_credit_reservations(record_id,lease_token,lease_owner,user_id,client_request_id,amount,price_snapshot,expires_at)
    VALUES(p_record_id,p_lease_token,p_lease_owner,v_attempt.user_id,v_attempt.client_request_id,v_amount,p_price_snapshot,v_attempt.lease_expires_at+interval '5 minutes');
  UPDATE public.users SET credits_reserved=credits_reserved+v_amount WHERE id=v_user.id;
  RETURN jsonb_build_object('success',true,'already_reserved',false,'amount',v_amount,'status','held',
    'available',coalesce(v_user.credits,0)-v_user.credits_reserved-v_amount);
END;
$$;

CREATE FUNCTION public.settle_llm_credits_atomic(
  p_record_id text,p_lease_owner text,p_lease_token bigint,
  p_actual_amount numeric,p_description text,p_billing jsonb,p_metadata jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_attempt public.llm_request_attempts%ROWTYPE;
  v_hold public.llm_credit_reservations%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_receipt jsonb;
  v_operation jsonb;
  v_key text;
BEGIN
  IF p_actual_amount IS NULL OR p_actual_amount::text IN ('NaN','Infinity','-Infinity') OR p_actual_amount < 0
     OR jsonb_typeof(p_billing) IS DISTINCT FROM 'object' OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object'
     OR (p_billing->>'creditsCharged')::numeric IS DISTINCT FROM p_actual_amount THEN
    RAISE EXCEPTION 'LLM_RESERVATION_SETTLEMENT_INVALID';
  END IF;
  SELECT * INTO v_attempt FROM public.llm_request_attempts WHERE record_id=p_record_id FOR UPDATE;
  SELECT * INTO v_hold FROM public.llm_credit_reservations
    WHERE record_id=p_record_id AND lease_token=p_lease_token FOR UPDATE;
  IF NOT FOUND OR v_hold.lease_owner IS DISTINCT FROM p_lease_owner THEN RAISE EXCEPTION 'LLM_RESERVATION_LEASE_CONFLICT'; END IF;
  IF v_hold.status='settled' THEN
    IF v_hold.actual_amount IS DISTINCT FROM p_actual_amount OR v_hold.receipt->'billing' IS DISTINCT FROM p_billing THEN
      RAISE EXCEPTION 'LLM_RESERVATION_SETTLEMENT_CONFLICT';
    END IF;
    RETURN v_hold.receipt || jsonb_build_object('already_fulfilled',true);
  END IF;
  IF v_hold.status <> 'held' OR v_hold.expires_at <= now() OR v_attempt.state <> 'running'
     OR v_attempt.lease_owner IS DISTINCT FROM p_lease_owner OR v_attempt.lease_token IS DISTINCT FROM p_lease_token
     OR v_attempt.provider_call_started_at IS NULL THEN RAISE EXCEPTION 'LLM_RESERVATION_LEASE_CONFLICT'; END IF;
  IF p_actual_amount > v_hold.amount THEN RAISE EXCEPTION 'LLM_RESERVATION_BUDGET_EXCEEDED'; END IF;
  SELECT * INTO v_user FROM public.users WHERE id=v_hold.user_id FOR UPDATE;
  IF v_user.credits_reserved < v_hold.amount THEN RAISE EXCEPTION 'LLM_RESERVATION_BALANCE_CONFLICT'; END IF;
  UPDATE public.users SET credits_reserved=credits_reserved-v_hold.amount WHERE id=v_hold.user_id;
  v_key := 'llm:' || v_hold.client_request_id || ':response';
  IF p_actual_amount > 0 THEN
    v_operation := public.apply_wallet_operation_atomic(v_hold.user_id,'credit_charge',v_key,p_actual_amount,p_description,
      p_metadata || jsonb_build_object('price_snapshot',v_hold.price_snapshot,'reservation_record_id',p_record_id,
        'reservation_lease_token',p_lease_token,'credits_reserved',v_hold.amount));
  ELSE
    v_operation := jsonb_build_object('success',true,'operation_id',v_key,'balance_after',v_user.credits);
  END IF;
  SELECT * INTO v_user FROM public.users WHERE id=v_hold.user_id;
  v_receipt := v_operation || jsonb_build_object('success',true,'already_fulfilled',false,'billing',p_billing,
    'reserved',v_hold.amount,'released',v_hold.amount-p_actual_amount,'available',v_user.credits-v_user.credits_reserved);
  UPDATE public.llm_credit_reservations SET status='settled',actual_amount=p_actual_amount,receipt=v_receipt,completed_at=now()
    WHERE record_id=p_record_id AND lease_token=p_lease_token;
  RETURN v_receipt;
END;
$$;

CREATE FUNCTION public.release_llm_credits_atomic(p_record_id text,p_lease_owner text,p_lease_token bigint,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_hold public.llm_credit_reservations%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.llm_request_attempts WHERE record_id=p_record_id FOR UPDATE;
  SELECT * INTO v_hold FROM public.llm_credit_reservations WHERE record_id=p_record_id AND lease_token=p_lease_token FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',true,'released',false); END IF;
  IF v_hold.lease_owner IS DISTINCT FROM p_lease_owner THEN RAISE EXCEPTION 'LLM_RESERVATION_LEASE_CONFLICT'; END IF;
  IF v_hold.status <> 'held' THEN RETURN jsonb_build_object('success',true,'released',false,'status',v_hold.status); END IF;
  UPDATE public.users SET credits_reserved=credits_reserved-v_hold.amount WHERE id=v_hold.user_id AND credits_reserved>=v_hold.amount;
  IF NOT FOUND THEN RAISE EXCEPTION 'LLM_RESERVATION_BALANCE_CONFLICT'; END IF;
  UPDATE public.llm_credit_reservations SET status='released',actual_amount=0,reason=left(coalesce(p_reason,''),120),completed_at=now()
    WHERE record_id=p_record_id AND lease_token=p_lease_token;
  RETURN jsonb_build_object('success',true,'released',true,'amount',v_hold.amount);
END;
$$;

CREATE FUNCTION public.recover_llm_credit_reservations_atomic(p_user_id text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_attempt public.llm_request_attempts%ROWTYPE; v_hold public.llm_credit_reservations%ROWTYPE; v_count integer:=0;
BEGIN
  FOR v_attempt IN SELECT a.* FROM public.llm_request_attempts a WHERE a.user_id=p_user_id AND EXISTS (
    SELECT 1 FROM public.llm_credit_reservations h WHERE h.record_id=a.record_id AND h.status='held'
      AND (h.expires_at<=now() OR a.state IN ('failed','failed_unknown','reconciliation_required'))
  ) ORDER BY a.created_at LIMIT 100 FOR UPDATE OF a SKIP LOCKED LOOP
    FOR v_hold IN SELECT * FROM public.llm_credit_reservations WHERE record_id=v_attempt.record_id AND status='held'
      AND (expires_at<=now() OR v_attempt.state IN ('failed','failed_unknown','reconciliation_required')) FOR UPDATE LOOP
      IF v_attempt.state='running' AND v_attempt.lease_token=v_hold.lease_token THEN
        UPDATE public.llm_request_attempts SET state='reconciliation_required',lease_owner=NULL,lease_expires_at=NULL,
          error_code='LLM_CREDIT_RESERVATION_EXPIRED',error_message='Reservation expired without confirmed settlement',updated_at=now()
          WHERE record_id=v_attempt.record_id;
        INSERT INTO public.llm_request_attempt_events(record_id,attempt_no,event_type,from_state,to_state,lease_owner,lease_token,evidence)
          VALUES(v_attempt.record_id,v_attempt.attempt_no,'reconciliation_required','running','reconciliation_required',v_attempt.lease_owner,v_attempt.lease_token,
            jsonb_build_object('reason','credit_reservation_expired'));
      END IF;
      PERFORM public.release_llm_credits_atomic(v_hold.record_id,v_hold.lease_owner,v_hold.lease_token,'terminal_or_expired');
      v_count:=v_count+1;
    END LOOP;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_llm_credits_atomic(text,text,bigint,numeric,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.settle_llm_credits_atomic(text,text,bigint,numeric,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.release_llm_credits_atomic(text,text,bigint,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.recover_llm_credit_reservations_atomic(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_llm_credits_atomic(text,text,bigint,numeric,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_llm_credits_atomic(text,text,bigint,numeric,text,jsonb,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_llm_credits_atomic(text,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_llm_credit_reservations_atomic(text) TO service_role;

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
NOTIFY pgrst,'reload schema';
COMMIT;
