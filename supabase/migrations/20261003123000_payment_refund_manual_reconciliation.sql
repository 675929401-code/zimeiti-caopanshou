-- Auditable manual resolution for ambiguous payment refunds.
-- This migration never resolves an attempt on its own. A current administrator
-- with wallet.adjust + step-up must submit bounded provider evidence through
-- the API, and the database re-checks exact order/status/amount evidence before
-- completing or releasing a reservation. keep_frozen records a review without
-- moving money or changing the provider terminal state.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.payment_refund_attempts') IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_PREREQUISITE_MISSING';
  END IF;
END;
$$;

ALTER TABLE public.payment_refund_attempts
  ADD COLUMN IF NOT EXISTS last_reconciliation_action_id text,
  ADD COLUMN IF NOT EXISTS last_reconciled_by text,
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz;

CREATE TABLE IF NOT EXISTS public.payment_refund_reconciliation_actions (
  action_id text PRIMARY KEY CHECK (action_id ~ '^[a-f0-9]{64}$'),
  attempt_id text NOT NULL REFERENCES public.payment_refund_attempts(attempt_id),
  actor_id text NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 240),
  idempotency_key text NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (action IN ('confirm_completed','confirm_rejected','keep_frozen')),
  previous_state text NOT NULL CHECK (previous_state = 'reconciliation_required'),
  resulting_state text NOT NULL CHECK (resulting_state IN ('reconciliation_required','completed','released')),
  evidence jsonb NOT NULL CHECK (
    jsonb_typeof(evidence) = 'object'
    AND octet_length(evidence::text) <= 16384
  ),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  note text NOT NULL CHECK (length(trim(note)) BETWEEN 8 AND 500),
  wallet_mutation text NOT NULL CHECK (wallet_mutation IN ('none','release')),
  wallet_operation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS payment_refund_reconciliation_attempt_created_idx
  ON public.payment_refund_reconciliation_actions (attempt_id, created_at DESC);

ALTER TABLE public.payment_refund_reconciliation_actions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.resolve_payment_refund_reconciliation_atomic(
  p_action_id text,
  p_attempt_id text,
  p_actor_id text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_action text,
  p_note text,
  p_evidence jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_action_id text := trim(coalesce(p_action_id, ''));
  v_attempt_id text := trim(coalesce(p_attempt_id, ''));
  v_actor_id text := trim(coalesce(p_actor_id, ''));
  v_idempotency_key text := trim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := trim(coalesce(p_request_fingerprint, ''));
  v_action_name text := lower(trim(coalesce(p_action, '')));
  v_note text := trim(coalesce(p_note, ''));
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_source text := trim(coalesce(v_evidence ->> 'source', ''));
  v_reference text := trim(coalesce(v_evidence ->> 'reference', ''));
  v_observed_at text := trim(coalesce(v_evidence ->> 'observedAt', ''));
  v_provider_status text := upper(trim(coalesce(v_evidence ->> 'providerStatus', '')));
  v_provider_order text := trim(coalesce(v_evidence ->> 'providerTradeOrderId', ''));
  v_provider_refund_id text := trim(coalesce(v_evidence ->> 'providerRefundId', ''));
  v_provider_amount numeric(20,2);
  v_attempt public.payment_refund_attempts%ROWTYPE;
  v_existing public.payment_refund_reconciliation_actions%ROWTYPE;
  v_record public.payment_refund_reconciliation_actions%ROWTYPE;
  v_release_kind text;
  v_release_result jsonb;
  v_release_replayed boolean;
  v_release_operation_id text;
  v_resulting_state text;
  v_wallet_mutation text := 'none';
  v_evidence_digest text;
BEGIN
  IF v_action_id !~ '^[a-f0-9]{64}$'
     OR v_attempt_id !~ '^[a-f0-9]{64}$'
     OR v_fingerprint !~ '^[a-f0-9]{64}$'
     OR v_actor_id = '' OR length(v_actor_id) > 240
     OR v_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR v_action_name NOT IN ('confirm_completed','confirm_rejected','keep_frozen')
     OR length(v_note) < 8 OR length(v_note) > 500
     OR jsonb_typeof(v_evidence) <> 'object'
     OR octet_length(v_evidence::text) > 16384 THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_INPUT_INVALID' USING ERRCODE='22023';
  END IF;

  IF v_source NOT IN ('provider_dashboard','provider_support','provider_signed_receipt','bank_statement','no_conclusive_evidence')
     OR v_observed_at = '' OR length(v_observed_at) > 64
     OR v_provider_status NOT IN ('CD','UD','RD','UNKNOWN')
     OR length(v_reference) > 240
     OR length(v_provider_order) > 240
     OR length(v_provider_refund_id) > 240 THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_EVIDENCE_INVALID' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_attempt
    FROM public.payment_refund_attempts
   WHERE attempt_id = v_attempt_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_ATTEMPT_NOT_FOUND' USING ERRCODE='P0002';
  END IF;

  SELECT * INTO v_existing
    FROM public.payment_refund_reconciliation_actions
   WHERE action_id = v_action_id
      OR (actor_id = v_actor_id AND idempotency_key = v_idempotency_key)
   LIMIT 1;
  IF FOUND THEN
    IF v_existing.action_id <> v_action_id
       OR v_existing.attempt_id <> v_attempt_id
       OR v_existing.actor_id <> v_actor_id
       OR v_existing.idempotency_key <> v_idempotency_key
       OR v_existing.request_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
    END IF;
    RETURN jsonb_build_object(
      'resolution','replayed',
      'record',to_jsonb(v_attempt),
      'actionRecord',to_jsonb(v_existing)
    );
  END IF;

  IF v_attempt.state <> 'reconciliation_required' THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_STATE_CONFLICT' USING ERRCODE='22023';
  END IF;
  IF v_attempt.paid_amount IS NULL OR v_attempt.paid_amount <= 0
     OR trim(coalesce(v_attempt.trade_order_id, '')) = '' THEN
    RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_ATTEMPT_EVIDENCE_INVALID' USING ERRCODE='22023';
  END IF;

  IF v_action_name = 'confirm_completed' THEN
    IF v_source = 'no_conclusive_evidence' OR v_reference = ''
       OR v_provider_status <> 'CD'
       OR v_provider_order <> v_attempt.trade_order_id
       OR v_provider_refund_id = ''
       OR jsonb_typeof(v_evidence -> 'providerRefundAmount') <> 'number' THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_COMPLETION_EVIDENCE_INVALID' USING ERRCODE='22023';
    END IF;
    v_provider_amount := round((v_evidence ->> 'providerRefundAmount')::numeric, 2);
    IF v_provider_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_provider_amount <> v_attempt.paid_amount THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_AMOUNT_MISMATCH' USING ERRCODE='22023';
    END IF;

    UPDATE public.payment_orders SET
      status = 'refunded',
      refund_attempt_id = v_attempt.attempt_id,
      provider_refund_id = v_provider_refund_id,
      provider_refund_amount = v_provider_amount,
      provider_refund_status = 'CD',
      refunded_at = now()
    WHERE trade_order_id = v_attempt.trade_order_id
      AND status = 'paid';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_ORDER_STATUS_CONFLICT' USING ERRCODE='22023';
    END IF;

    UPDATE public.payment_refund_attempts SET
      state = 'completed',
      provider_status = 'CD',
      provider_trade_order_id = v_provider_order,
      provider_refund_id = v_provider_refund_id,
      provider_refund_amount = v_provider_amount,
      last_reconciliation_action_id = v_action_id,
      last_reconciled_by = v_actor_id,
      last_reconciled_at = now(),
      completed_at = now(),
      updated_at = now()
    WHERE attempt_id = v_attempt.attempt_id
    RETURNING * INTO v_attempt;
    v_resulting_state := 'completed';

  ELSIF v_action_name = 'confirm_rejected' THEN
    IF v_source = 'no_conclusive_evidence' OR v_reference = ''
       OR v_provider_status <> 'UD'
       OR v_provider_order <> v_attempt.trade_order_id THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_REJECTION_EVIDENCE_INVALID' USING ERRCODE='22023';
    END IF;

    v_release_kind := CASE WHEN v_attempt.order_type = 'credits' THEN 'credit_refund' ELSE 'cash_refund' END;
    v_release_result := public.apply_wallet_operation_atomic(
      v_attempt.user_id,
      v_release_kind,
      'payment-refund-release:' || v_attempt.attempt_id,
      v_attempt.wallet_amount,
      'Release wallet reservation after evidenced provider refund rejection [' || v_attempt.trade_order_id || ']',
      jsonb_build_object(
        'source','payment_refund_manual_reconciliation',
        'attempt_id',v_attempt.attempt_id,
        'trade_order_id',v_attempt.trade_order_id,
        'action_id',v_action_id,
        'phase','release'
      )
    );
    IF NOT coalesce((v_release_result ->> 'success')::boolean, false) THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_RELEASE_FAILED';
    END IF;
    v_release_replayed := coalesce((v_release_result ->> 'already_fulfilled')::boolean, false);
    v_release_operation_id := nullif(v_release_result ->> 'operation_id', '');
    IF v_release_operation_id IS NULL THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_RELEASE_RECEIPT_INVALID';
    END IF;
    IF NOT v_release_replayed THEN
      IF v_attempt.order_type = 'credits' THEN
        UPDATE public.users SET
          total_credits_recharged = coalesce(total_credits_recharged, 0) + v_attempt.wallet_amount,
          updated_at = now()
        WHERE id = v_attempt.user_id;
      ELSE
        UPDATE public.users SET
          total_cash_recharged = coalesce(total_cash_recharged, 0) + v_attempt.wallet_amount,
          updated_at = now()
        WHERE id = v_attempt.user_id;
      END IF;
    END IF;

    UPDATE public.payment_refund_attempts SET
      state = 'released',
      release_operation_id = v_release_operation_id,
      provider_status = 'UD',
      provider_trade_order_id = v_provider_order,
      last_reconciliation_action_id = v_action_id,
      last_reconciled_by = v_actor_id,
      last_reconciled_at = now(),
      released_at = now(),
      updated_at = now()
    WHERE attempt_id = v_attempt.attempt_id
    RETURNING * INTO v_attempt;
    v_resulting_state := 'released';
    v_wallet_mutation := 'release';

  ELSE
    IF v_provider_status NOT IN ('RD','UNKNOWN') THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_FROZEN_STATUS_CONFLICT' USING ERRCODE='22023';
    END IF;
    UPDATE public.payment_refund_attempts SET
      last_reconciliation_action_id = v_action_id,
      last_reconciled_by = v_actor_id,
      last_reconciled_at = now(),
      updated_at = now()
    WHERE attempt_id = v_attempt.attempt_id
      AND state = 'reconciliation_required'
    RETURNING * INTO v_attempt;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PAYMENT_REFUND_RECONCILIATION_STATE_CONFLICT' USING ERRCODE='22023';
    END IF;
    v_resulting_state := 'reconciliation_required';
  END IF;

  v_evidence_digest := encode(sha256(convert_to(v_evidence::text, 'UTF8')), 'hex');
  INSERT INTO public.payment_refund_reconciliation_actions (
    action_id, attempt_id, actor_id, idempotency_key, request_fingerprint,
    action, previous_state, resulting_state, evidence, evidence_digest, note,
    wallet_mutation, wallet_operation_id
  ) VALUES (
    v_action_id, v_attempt_id, v_actor_id, v_idempotency_key, v_fingerprint,
    v_action_name, 'reconciliation_required', v_resulting_state, v_evidence,
    v_evidence_digest, v_note, v_wallet_mutation, v_release_operation_id
  )
  RETURNING * INTO v_record;

  RETURN jsonb_build_object(
    'resolution',CASE
      WHEN v_resulting_state = 'reconciliation_required' THEN 'frozen'
      ELSE v_resulting_state
    END,
    'record',to_jsonb(v_attempt),
    'actionRecord',to_jsonb(v_record)
  );
END;
$$;

-- Server-side aggregate keeps the admin list API from downloading the whole
-- payment_orders table merely to calculate five summary figures.
CREATE OR REPLACE FUNCTION public.read_payment_order_admin_summary(
  p_status text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text := nullif(lower(trim(coalesce(p_status, ''))), '');
  v_summary jsonb;
BEGIN
  IF v_status IS NOT NULL AND v_status NOT IN ('pending','paid','failed','expired','refunded') THEN
    RAISE EXCEPTION 'PAYMENT_ORDER_STATUS_FILTER_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT jsonb_build_object(
    'totalOrders', count(*)::bigint,
    'totalAmount', coalesce(round(sum(amount)::numeric, 2), 0),
    'successAmount', coalesce(round(sum(amount) FILTER (WHERE status = 'paid')::numeric, 2), 0),
    'successCount', count(*) FILTER (WHERE status = 'paid'),
    'pendingCount', count(*) FILTER (WHERE status = 'pending'),
    'byPayMethod', '{}'::jsonb,
    'scope', 'filtered_server_aggregate'
  ) INTO v_summary
  FROM public.payment_orders
  WHERE v_status IS NULL OR status = v_status;
  RETURN v_summary;
END;
$$;

REVOKE ALL ON TABLE public.payment_refund_reconciliation_actions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_payment_refund_reconciliation_atomic(text,text,text,text,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_payment_order_admin_summary(text) FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.payment_refund_reconciliation_actions TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_payment_refund_reconciliation_atomic(text,text,text,text,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_payment_order_admin_summary(text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
