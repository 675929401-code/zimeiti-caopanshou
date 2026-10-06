BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS public.offline_payment_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  payment_channel text NOT NULL CHECK (payment_channel IN ('wechat', 'alipay', 'bank_transfer', 'cash', 'other')),
  business_type text NOT NULL DEFAULT 'membership_tuition'
    CHECK (business_type IN ('membership_tuition', 'other')),
  amount numeric(20, 2) NOT NULL CHECK (amount > 0 AND amount <= 100000000),
  currency text NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  paid_at timestamptz NOT NULL,
  merchant_reference text,
  payer_reference_masked text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'voided')),
  activation_event_id uuid REFERENCES public.member_activation_events(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  void_request_key text,
  UNIQUE (created_by, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS offline_payment_reference_unique
  ON public.offline_payment_receipts (payment_channel, lower(btrim(merchant_reference)))
  WHERE nullif(btrim(merchant_reference), '') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS offline_payment_void_request_unique
  ON public.offline_payment_receipts (voided_by, void_request_key)
  WHERE voided_by IS NOT NULL AND nullif(btrim(void_request_key), '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS offline_payment_user_paid_idx
  ON public.offline_payment_receipts (user_id, paid_at DESC);

CREATE INDEX IF NOT EXISTS offline_payment_status_paid_idx
  ON public.offline_payment_receipts (status, paid_at DESC);

ALTER TABLE public.offline_payment_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.offline_payment_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.offline_payment_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.record_offline_payment_and_activate_member_atomic(
  p_admin_id text,
  p_user_id text,
  p_payment_channel text,
  p_business_type text,
  p_amount numeric,
  p_paid_at timestamptz,
  p_merchant_reference text,
  p_payer_reference_masked text,
  p_note text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_uuid uuid;
  v_user_uuid uuid;
  v_channel text := lower(btrim(coalesce(p_payment_channel, '')));
  v_business_type text := lower(btrim(coalesce(p_business_type, 'membership_tuition')));
  v_reference text := nullif(btrim(coalesce(p_merchant_reference, '')), '');
  v_payer_mask text := btrim(coalesce(p_payer_reference_masked, ''));
  v_note text := left(coalesce(p_note, ''), 2000);
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_amount numeric(20, 2);
  v_existing public.offline_payment_receipts%ROWTYPE;
  v_receipt public.offline_payment_receipts%ROWTYPE;
  v_activation jsonb;
BEGIN
  BEGIN
    v_admin_uuid := p_admin_id::uuid;
    v_user_uuid := p_user_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_ID_INVALID');
  END;
  IF v_channel NOT IN ('wechat', 'alipay', 'bank_transfer', 'cash', 'other')
     OR v_business_type NOT IN ('membership_tuition', 'other') THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_TYPE_INVALID');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 100000000 THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_AMOUNT_INVALID');
  END IF;
  v_amount := round(p_amount, 2);
  IF p_paid_at IS NULL OR p_paid_at > clock_timestamp() + interval '10 minutes'
     OR p_paid_at < clock_timestamp() - interval '10 years' THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_TIME_INVALID');
  END IF;
  IF v_channel <> 'cash' AND (v_reference IS NULL OR length(v_reference) < 4) THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_REFERENCE_REQUIRED');
  END IF;
  IF length(coalesce(v_reference, '')) > 160 OR length(v_payer_mask) > 32 OR length(v_note) > 2000 THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_TEXT_INVALID');
  END IF;
  IF v_payer_mask <> '' AND v_payer_mask !~ '^[*•0-9A-Za-z._ -]{1,32}$' THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_PAYER_MASK_INVALID');
  END IF;
  IF v_key = '' OR length(v_key) > 180 THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_KEY_INVALID');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_admin_id AND role = 'admin' AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_ADMIN_INVALID');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = p_user_id AND role <> 'admin'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_USER_INVALID');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_admin_uuid::text || ':' || v_key, 9302026));
  SELECT * INTO v_existing
  FROM public.offline_payment_receipts
  WHERE created_by = v_admin_uuid AND idempotency_key = v_key;
  IF FOUND THEN
    IF v_existing.user_id <> v_user_uuid
       OR v_existing.payment_channel <> v_channel
       OR v_existing.business_type <> v_business_type
       OR v_existing.amount <> v_amount
       OR v_existing.paid_at <> p_paid_at
       OR v_existing.merchant_reference IS DISTINCT FROM v_reference
       OR v_existing.payer_reference_masked <> v_payer_mask
       OR v_existing.note <> v_note THEN
      RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_IDEMPOTENCY_CONFLICT');
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'already_recorded', true, 'receipt_id', v_existing.id,
      'activation_event_id', v_existing.activation_event_id, 'status', v_existing.status
    );
  END IF;

  IF v_reference IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.offline_payment_receipts
    WHERE payment_channel = v_channel
      AND lower(btrim(merchant_reference)) = lower(v_reference)
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_REFERENCE_EXISTS');
  END IF;

  INSERT INTO public.offline_payment_receipts (
    user_id, payment_channel, business_type, amount, paid_at,
    merchant_reference, payer_reference_masked, note,
    created_by, idempotency_key
  ) VALUES (
    v_user_uuid, v_channel, v_business_type, v_amount, p_paid_at,
    v_reference, v_payer_mask, v_note,
    v_admin_uuid, v_key
  ) RETURNING * INTO v_receipt;

  IF v_business_type = 'membership_tuition' THEN
    v_activation := public.set_member_activation_state_atomic(
      p_admin_id,
      p_user_id,
      'active',
      'admin_manual',
      coalesce(v_reference, v_receipt.id::text),
      v_amount,
      concat('线下收款凭证 ', v_receipt.id::text, CASE WHEN v_note <> '' THEN '：' || v_note ELSE '' END),
      'offline-payment:' || v_receipt.id::text
    );
    IF coalesce((v_activation ->> 'success')::boolean, false) IS NOT TRUE THEN
      DELETE FROM public.offline_payment_receipts WHERE id = v_receipt.id;
      RETURN jsonb_build_object(
        'success', false,
        'code', coalesce(v_activation ->> 'code', 'OFFLINE_PAYMENT_ACTIVATION_FAILED')
      );
    END IF;
    UPDATE public.offline_payment_receipts
    SET activation_event_id = nullif(v_activation ->> 'event_id', '')::uuid
    WHERE id = v_receipt.id
    RETURNING * INTO v_receipt;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'already_recorded', false, 'receipt_id', v_receipt.id,
    'activation_event_id', v_receipt.activation_event_id,
    'member_activated', v_business_type = 'membership_tuition',
    'status', v_receipt.status, 'amount', v_receipt.amount,
    'payment_channel', v_receipt.payment_channel, 'paid_at', v_receipt.paid_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.void_offline_payment_receipt_atomic(
  p_admin_id text,
  p_receipt_id text,
  p_void_reason text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_uuid uuid;
  v_receipt_uuid uuid;
  v_reason text := btrim(coalesce(p_void_reason, ''));
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_receipt public.offline_payment_receipts%ROWTYPE;
BEGIN
  BEGIN
    v_admin_uuid := p_admin_id::uuid;
    v_receipt_uuid := p_receipt_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_VOID_ID_INVALID');
  END;
  IF length(v_reason) < 4 OR length(v_reason) > 1000 OR v_key = '' OR length(v_key) > 180 THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_VOID_INPUT_INVALID');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_admin_id AND role = 'admin' AND coalesce(is_active, true)
      AND coalesce(status, 'active') = 'active'
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_ADMIN_INVALID');
  END IF;
  SELECT * INTO v_receipt FROM public.offline_payment_receipts WHERE id = v_receipt_uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'OFFLINE_PAYMENT_NOT_FOUND');
  END IF;
  IF v_receipt.status = 'voided' THEN
    RETURN jsonb_build_object(
      'success', true, 'already_voided', true, 'receipt_id', v_receipt.id,
      'requires_membership_review', v_receipt.business_type = 'membership_tuition'
    );
  END IF;
  UPDATE public.offline_payment_receipts
  SET status = 'voided', voided_at = clock_timestamp(), voided_by = v_admin_uuid,
      void_reason = left(v_reason, 1000), void_request_key = v_key
  WHERE id = v_receipt.id
  RETURNING * INTO v_receipt;
  RETURN jsonb_build_object(
    'success', true, 'already_voided', false, 'receipt_id', v_receipt.id,
    'requires_membership_review', v_receipt.business_type = 'membership_tuition'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_offline_payment_and_activate_member_atomic(text,text,text,text,numeric,timestamptz,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.void_offline_payment_receipt_atomic(text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_offline_payment_and_activate_member_atomic(text,text,text,text,numeric,timestamptz,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.void_offline_payment_receipt_atomic(text,text,text,text) TO service_role;

COMMENT ON TABLE public.offline_payment_receipts IS 'Immutable admin-only evidence for offline member payments. Corrections void the original instead of overwriting or deleting it.';
COMMENT ON FUNCTION public.record_offline_payment_and_activate_member_atomic(text,text,text,text,numeric,timestamptz,text,text,text,text) IS 'Atomically records a deduplicated offline tuition receipt and activates the learner without issuing invitation rewards.';
COMMENT ON FUNCTION public.void_offline_payment_receipt_atomic(text,text,text,text) IS 'Voids an offline receipt with an audit reason; membership review remains an explicit separate decision.';

NOTIFY pgrst, 'reload schema';
COMMIT;
