-- Forward-only candidate, NOT applied. Depends on the reviewed atomic wallet
-- migration. It is separate from the existing seven-file candidate bundle.
-- A target balance is a durable admin request, including a no-op target. Its
-- identity must not change when the current balance changes or direction flips.
BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_credit_adjustments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_user_id text NOT NULL,
  user_id text NOT NULL,
  idempotency_key text NOT NULL,
  target_credits numeric(20, 6) NOT NULL CHECK (target_credits >= 0),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  balance_before numeric(20, 6),
  balance_after numeric(20, 6),
  delta numeric(20, 6),
  wallet_operation_id bigint REFERENCES public.wallet_operations(id) ON DELETE RESTRICT,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT admin_credit_adjustments_request_unique UNIQUE (admin_user_id, idempotency_key),
  CONSTRAINT admin_credit_adjustments_completed_evidence CHECK (
    status <> 'completed' OR (
      balance_before IS NOT NULL AND balance_after IS NOT NULL AND delta IS NOT NULL
      AND balance_after = target_credits AND balance_after = balance_before + delta
      AND completed_at IS NOT NULL
      AND ((delta = 0 AND wallet_operation_id IS NULL) OR (delta <> 0 AND wallet_operation_id IS NOT NULL))
    )
  )
);

CREATE INDEX IF NOT EXISTS admin_credit_adjustments_user_created_idx
  ON public.admin_credit_adjustments(user_id, created_at DESC);
ALTER TABLE public.admin_credit_adjustments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_credit_adjustments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.admin_credit_adjustments TO service_role;

CREATE OR REPLACE FUNCTION public.set_admin_credit_balance_atomic(
  p_admin_id text,
  p_user_id text,
  p_target_credits numeric,
  p_idempotency_key text,
  p_description text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id text := trim(coalesce(p_admin_id, ''));
  v_user_id text := trim(coalesce(p_user_id, ''));
  v_key text := trim(coalesce(p_idempotency_key, ''));
  v_description text := trim(coalesce(p_description, ''));
  v_admin public.users%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_request public.admin_credit_adjustments%ROWTYPE;
  v_operation public.wallet_operations%ROWTYPE;
  v_before numeric(20, 6);
  v_delta numeric(20, 6);
  v_kind text;
  v_wallet_result jsonb;
  v_inserted boolean;
BEGIN
  IF v_admin_id = '' OR v_user_id = '' OR v_key = '' OR length(v_key) > 240
     OR v_description = '' OR length(v_description) > 1000 THEN
    RAISE EXCEPTION 'ADMIN_CREDIT_ADJUSTMENT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_target_credits IS NULL OR p_target_credits::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_target_credits < 0 OR p_target_credits <> round(p_target_credits, 6) THEN
    RAISE EXCEPTION 'ADMIN_CREDIT_ADJUSTMENT_TARGET_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_admin FROM public.users WHERE id::text = v_admin_id;
  IF NOT FOUND OR v_admin.role IS DISTINCT FROM 'admin' OR v_admin.is_active IS DISTINCT FROM true
     OR (v_admin.status IS NOT NULL AND v_admin.status <> 'active') THEN
    RAISE EXCEPTION 'ADMIN_CREDIT_ADJUSTMENT_ADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.admin_credit_adjustments (
    admin_user_id, user_id, idempotency_key, target_credits, description
  ) VALUES (v_admin_id, v_user_id, v_key, p_target_credits, v_description)
  ON CONFLICT (admin_user_id, idempotency_key) DO NOTHING
  RETURNING * INTO v_request;
  v_inserted := FOUND;
  IF NOT v_inserted THEN
    SELECT * INTO v_request FROM public.admin_credit_adjustments
      WHERE admin_user_id = v_admin_id AND idempotency_key = v_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ADMIN_CREDIT_ADJUSTMENT_LOOKUP_FAILED';
    END IF;
    IF v_request.user_id <> v_user_id OR v_request.target_credits <> p_target_credits THEN
      RAISE EXCEPTION 'ADMIN_CREDIT_ADJUSTMENT_CONFLICT' USING ERRCODE = '22023';
    END IF;
    IF v_request.status <> 'completed' THEN
      RAISE EXCEPTION 'ADMIN_CREDIT_ADJUSTMENT_INCOMPLETE';
    END IF;
  ELSE
    SELECT * INTO v_user FROM public.users WHERE id::text = v_user_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ADMIN_CREDIT_ADJUSTMENT_USER_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    v_before := coalesce(v_user.credits, 0);
    v_delta := p_target_credits - v_before;
    IF v_delta <> 0 THEN
      v_kind := CASE WHEN v_delta > 0 THEN 'credit_topup' ELSE 'credit_charge' END;
      -- The user row remains locked while the existing wallet RPC writes its
      -- operation, legacy transaction and ledger within this SAME transaction.
      v_wallet_result := public.apply_wallet_operation_atomic(
        v_user_id, v_kind, 'admin-credit-set:' || v_request.id::text,
        abs(v_delta), v_description,
        jsonb_build_object(
          'source', 'admin_manual', 'source_id', v_key,
          'admin_user_id', v_admin_id, 'admin_adjustment_id', v_request.id,
          'requested_credits', p_target_credits
        )
      );
      IF coalesce((v_wallet_result->>'success')::boolean, false) IS NOT TRUE
         OR (v_wallet_result->>'balance_before')::numeric IS DISTINCT FROM v_before
         OR (v_wallet_result->>'balance_after')::numeric IS DISTINCT FROM p_target_credits
         OR (v_wallet_result->>'delta')::numeric IS DISTINCT FROM v_delta THEN
        RAISE EXCEPTION 'ADMIN_CREDIT_ADJUSTMENT_WALLET_EVIDENCE_INVALID';
      END IF;
      SELECT * INTO v_operation FROM public.wallet_operations
        WHERE id = (v_wallet_result->>'operation_id')::bigint;
      IF NOT FOUND OR v_operation.status <> 'completed' OR v_operation.user_id <> v_user_id
         OR v_operation.wallet <> 'credits' OR v_operation.operation_kind <> v_kind
         OR v_operation.idempotency_key <> 'admin-credit-set:' || v_request.id::text
         OR v_operation.delta <> v_delta OR v_operation.balance_before IS DISTINCT FROM v_before
         OR v_operation.balance_after IS DISTINCT FROM p_target_credits
         OR NOT EXISTS (
           SELECT 1 FROM public.wallet_ledger_entries l
            WHERE l.operation_id = v_operation.id AND l.user_id = v_user_id AND l.wallet = 'credits'
              AND l.delta = v_delta AND l.balance_before = v_before AND l.balance_after = p_target_credits
              AND l.metadata->>'admin_user_id' = v_admin_id
              AND l.metadata->>'admin_adjustment_id' = v_request.id::text
         ) THEN
        RAISE EXCEPTION 'ADMIN_CREDIT_ADJUSTMENT_LEDGER_EVIDENCE_INVALID';
      END IF;
    END IF;
    UPDATE public.admin_credit_adjustments
       SET status = 'completed', balance_before = v_before, balance_after = p_target_credits,
           delta = v_delta, wallet_operation_id = v_operation.id, completed_at = now()
     WHERE id = v_request.id RETURNING * INTO v_request;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'already_fulfilled', NOT v_inserted,
    'adjustment_id', v_request.id, 'operation_id', v_request.wallet_operation_id,
    'wallet', 'credits', 'operation_kind', CASE WHEN v_request.delta = 0 THEN 'credit_set_noop'
      WHEN v_request.delta > 0 THEN 'credit_topup' ELSE 'credit_charge' END,
    'target_credits', v_request.target_credits, 'no_change', v_request.delta = 0,
    'balance_before', v_request.balance_before, 'balance_after', v_request.balance_after,
    'delta', v_request.delta
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_admin_credit_balance_atomic(text, text, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_admin_credit_balance_atomic(text, text, numeric, text, text)
  TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
