-- Durable, account-scoped history for general-script requests that exist before
-- a short_drama_project can be created. The shared LLM attempt and wallet
-- ledgers remain the execution and billing sources of truth.

BEGIN;

CREATE TABLE public.short_drama_script_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  client_request_id text NOT NULL CHECK (client_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  request_snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(request_snapshot) = 'object'
    AND octet_length(request_snapshot::text) <= 1048576
  ),
  surface text NOT NULL CHECK (surface ~ '^[a-z0-9_-]{1,40}$'),
  profile_id text NOT NULL CHECK (char_length(profile_id) BETWEEN 1 AND 80),
  display_title text NOT NULL CHECK (char_length(display_title) BETWEEN 1 AND 120),
  episode_count integer CHECK (episode_count IS NULL OR episode_count BETWEEN 1 AND 500),
  state text NOT NULL DEFAULT 'submitted' CHECK (
    state IN ('submitted', 'succeeded', 'failed', 'reconciliation_required')
  ),
  result_payload jsonb,
  result_hash text CHECK (result_hash IS NULL OR result_hash ~ '^[a-f0-9]{64}$'),
  billing_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(billing_snapshot) = 'object'),
  error_code text,
  error_message text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT short_drama_script_request_identity_unique UNIQUE (user_id, client_request_id),
  CONSTRAINT short_drama_script_result_shape_check CHECK (
    (state = 'succeeded' AND jsonb_typeof(result_payload) = 'object' AND result_hash IS NOT NULL)
    OR (state <> 'succeeded' AND result_payload IS NULL AND result_hash IS NULL)
  )
);

CREATE INDEX short_drama_script_requests_owner_history_idx
  ON public.short_drama_script_requests (user_id, surface, submitted_at DESC, id DESC);

ALTER TABLE public.short_drama_script_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.short_drama_script_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.short_drama_script_requests TO service_role;

CREATE FUNCTION public.claim_short_drama_script_request_atomic(
  p_user_id text,
  p_client_request_id text,
  p_request_hash text,
  p_request_snapshot jsonb,
  p_surface text,
  p_profile_id text,
  p_display_title text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.short_drama_script_requests%ROWTYPE;
  v_created integer := 0;
  v_user_id text := trim(coalesce(p_user_id, ''));
  v_request_id text := trim(coalesce(p_client_request_id, ''));
  v_request_hash text := lower(trim(coalesce(p_request_hash, '')));
  v_surface text := lower(trim(coalesce(p_surface, '')));
  v_profile_id text := trim(coalesce(p_profile_id, ''));
  v_display_title text := trim(coalesce(p_display_title, ''));
  v_action text;
BEGIN
  IF v_user_id = ''
     OR v_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR v_request_hash !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(p_request_snapshot) IS DISTINCT FROM 'object'
     OR octet_length(p_request_snapshot::text) > 1048576
     OR v_surface !~ '^[a-z0-9_-]{1,40}$'
     OR char_length(v_profile_id) NOT BETWEEN 1 AND 80
     OR char_length(v_display_title) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_REQUEST_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.short_drama_script_requests (
    user_id, client_request_id, request_hash, request_snapshot, surface, profile_id, display_title
  ) VALUES (
    v_user_id, v_request_id, v_request_hash, p_request_snapshot, v_surface, v_profile_id, v_display_title
  ) ON CONFLICT (user_id, client_request_id) DO NOTHING;
  GET DIAGNOSTICS v_created = ROW_COUNT;

  SELECT * INTO v_row
    FROM public.short_drama_script_requests
   WHERE user_id = v_user_id AND client_request_id = v_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_REQUEST_CLAIM_FAILED';
  END IF;
  IF v_row.request_hash <> v_request_hash
     OR v_row.request_snapshot <> p_request_snapshot
     OR v_row.surface <> v_surface
     OR v_row.profile_id <> v_profile_id
     OR v_row.display_title <> v_display_title THEN
    RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_REQUEST_CONFLICT' USING ERRCODE = '22023';
  END IF;

  v_action := CASE
    WHEN v_created = 1 THEN 'execute'
    WHEN v_row.state = 'submitted' THEN 'resume'
    WHEN v_row.state = 'succeeded' THEN 'replay'
    WHEN v_row.state = 'failed' THEN 'failed'
    ELSE 'reconciliation_required'
  END;
  RETURN jsonb_build_object('action', v_action, 'record', to_jsonb(v_row));
END;
$$;

CREATE FUNCTION public.finalize_short_drama_script_request_atomic(
  p_user_id text,
  p_client_request_id text,
  p_request_hash text,
  p_state text,
  p_result_payload jsonb,
  p_result_hash text,
  p_billing_snapshot jsonb,
  p_display_title text,
  p_episode_count integer,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.short_drama_script_requests%ROWTYPE;
  v_charge public.wallet_operations%ROWTYPE;
  v_refund public.wallet_operations%ROWTYPE;
  v_state text := lower(trim(coalesce(p_state, '')));
  v_request_hash text := lower(trim(coalesce(p_request_hash, '')));
  v_result_hash text := lower(trim(coalesce(p_result_hash, '')));
  v_billing jsonb := coalesce(p_billing_snapshot, '{}'::jsonb);
  v_display_title text := trim(coalesce(p_display_title, ''));
BEGIN
  IF v_state NOT IN ('succeeded', 'failed', 'reconciliation_required')
     OR v_request_hash !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(v_billing) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_FINALIZE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_state = 'succeeded' AND (
    jsonb_typeof(p_result_payload) IS DISTINCT FROM 'object'
    OR octet_length(p_result_payload::text) > 8388608
    OR v_result_hash !~ '^[a-f0-9]{64}$'
    OR v_billing->>'state' IS DISTINCT FROM 'settled'
    OR char_length(v_display_title) NOT BETWEEN 1 AND 120
    OR p_episode_count NOT BETWEEN 1 AND 500
  ) THEN
    RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_SUCCESS_EVIDENCE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_state = 'failed' AND (
    p_result_payload IS NOT NULL OR p_result_hash IS NOT NULL
    OR p_display_title IS NOT NULL OR p_episode_count IS NOT NULL
    OR coalesce(v_billing->>'state', '') NOT IN ('not_charged', 'refunded')
  ) THEN
    RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_FAILURE_EVIDENCE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_state = 'reconciliation_required' AND (
    p_result_payload IS NOT NULL OR p_result_hash IS NOT NULL
    OR p_display_title IS NOT NULL OR p_episode_count IS NOT NULL
    OR v_billing->>'state' IS DISTINCT FROM 'reconciliation_required'
  ) THEN
    RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_RECONCILIATION_EVIDENCE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM public.short_drama_script_requests
   WHERE user_id = trim(coalesce(p_user_id, ''))
     AND client_request_id = trim(coalesce(p_client_request_id, ''))
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.request_hash <> v_request_hash THEN
    RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_REQUEST_CONFLICT' USING ERRCODE = '22023';
  END IF;

  IF v_state = 'succeeded' THEN
    IF coalesce(v_billing->>'creditsCharged', '') !~ '^[0-9]+([.][0-9]+)?$' THEN
      RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_BILLING_EVIDENCE_INVALID' USING ERRCODE = '22023';
    END IF;
    IF (v_billing->>'creditsCharged')::numeric > 0 THEN
      IF coalesce(v_billing->>'operationId', '') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_BILLING_EVIDENCE_INVALID' USING ERRCODE = '22023';
      END IF;
      SELECT * INTO v_charge FROM public.wallet_operations
       WHERE id = (v_billing->>'operationId')::bigint
         AND user_id = v_row.user_id
         AND operation_kind = 'credit_charge'
         AND idempotency_key = 'llm:' || v_row.client_request_id || ':answer'
         AND status = 'completed';
      IF v_charge.id IS NULL OR v_charge.amount IS DISTINCT FROM (v_billing->>'creditsCharged')::numeric THEN
        RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_BILLING_EVIDENCE_INVALID' USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;

  IF v_state = 'failed' AND v_billing->>'state' = 'refunded' THEN
    IF coalesce(v_billing->>'chargeOperationId', '') !~ '^[0-9]+$'
       OR coalesce(v_billing->>'refundOperationId', '') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_REFUND_EVIDENCE_REQUIRED' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_charge FROM public.wallet_operations
     WHERE id = (v_billing->>'chargeOperationId')::bigint
       AND user_id = v_row.user_id
       AND operation_kind = 'credit_charge'
       AND idempotency_key = 'llm:' || v_row.client_request_id || ':answer'
       AND status = 'completed';
    SELECT * INTO v_refund FROM public.wallet_operations
     WHERE id = (v_billing->>'refundOperationId')::bigint
       AND user_id = v_row.user_id
       AND operation_kind = 'credit_refund'
       AND status = 'completed';
    IF v_charge.id IS NULL OR v_refund.id IS NULL
       OR v_charge.amount <> v_refund.amount
       OR coalesce(v_refund.metadata->>'original_operation_id', '') <> v_charge.id::text
       OR EXISTS (
         SELECT 1 FROM public.wallet_operations
          WHERE user_id = v_row.user_id
            AND operation_kind = 'credit_charge'
            AND idempotency_key = 'llm:' || v_row.client_request_id || ':thinking'
            AND status = 'completed'
       )
       OR (v_billing->>'creditsCharged')::numeric IS DISTINCT FROM v_charge.amount
       OR (v_billing->>'creditsRefunded')::numeric IS DISTINCT FROM v_refund.amount THEN
      RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_REFUND_EVIDENCE_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_row.state <> 'submitted' THEN
    IF v_row.state <> v_state
       OR v_row.result_payload IS DISTINCT FROM p_result_payload
       OR v_row.result_hash IS DISTINCT FROM nullif(v_result_hash, '')
       OR v_row.billing_snapshot IS DISTINCT FROM v_billing THEN
      RAISE EXCEPTION 'SHORT_DRAMA_SCRIPT_TERMINAL_CONFLICT' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('record', to_jsonb(v_row), 'replayed', true);
  END IF;

  UPDATE public.short_drama_script_requests
     SET state = v_state,
         result_payload = CASE WHEN v_state = 'succeeded' THEN p_result_payload ELSE NULL END,
         result_hash = CASE WHEN v_state = 'succeeded' THEN v_result_hash ELSE NULL END,
         display_title = CASE WHEN v_state = 'succeeded' THEN v_display_title ELSE display_title END,
         episode_count = CASE WHEN v_state = 'succeeded' THEN p_episode_count ELSE NULL END,
         billing_snapshot = v_billing,
         error_code = nullif(left(trim(coalesce(p_error_code, '')), 120), ''),
         error_message = nullif(left(trim(coalesce(p_error_message, '')), 500), ''),
         updated_at = now(),
         completed_at = now()
   WHERE id = v_row.id
   RETURNING * INTO v_row;

  RETURN jsonb_build_object('record', to_jsonb(v_row), 'replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_short_drama_script_request_atomic(text,text,text,jsonb,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_short_drama_script_request_atomic(text,text,text,text,jsonb,text,jsonb,text,integer,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_short_drama_script_request_atomic(text,text,text,jsonb,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_short_drama_script_request_atomic(text,text,text,text,jsonb,text,jsonb,text,integer,text,text)
  TO service_role;

COMMIT;
