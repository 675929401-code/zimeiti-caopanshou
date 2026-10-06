BEGIN;

DO $$
BEGIN
  IF to_regclass('public.wallet_operations') IS NULL
     OR to_regclass('public.wallet_ledger_entries') IS NULL
     OR to_regprocedure('public.apply_wallet_operation_atomic(text,text,text,numeric,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_WALLET_MIGRATION_REQUIRED';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.voice_generation_requests (
  id bigserial PRIMARY KEY,
  request_id text NOT NULL,
  user_id text NOT NULL,
  client_request_id text NOT NULL,
  phase text NOT NULL,
  payload_fingerprint text NOT NULL,
  model_id text NOT NULL,
  billing_idempotency_key text NOT NULL,
  quoted_credits numeric(20, 6) NOT NULL,
  charge_credits numeric(20, 6) NOT NULL,
  refunded_credits numeric(20, 6) NOT NULL DEFAULT 0,
  billing_exempt boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'submitting',
  wallet_operation_id bigint REFERENCES public.wallet_operations(id) ON DELETE RESTRICT,
  refund_scopes jsonb NOT NULL DEFAULT '{}'::jsonb,
  asset_id text,
  generation_id text,
  provider_task_id text,
  response jsonb,
  error jsonb,
  price_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  refunded_at timestamptz,
  CONSTRAINT voice_generation_request_id_length CHECK (length(request_id) BETWEEN 8 AND 160),
  CONSTRAINT voice_generation_user_id_length CHECK (length(user_id) BETWEEN 1 AND 160),
  CONSTRAINT voice_generation_client_id_length CHECK (length(client_request_id) BETWEEN 8 AND 128),
  CONSTRAINT voice_generation_phase_valid CHECK (phase IN ('seed-audio', 'mix', 'dual', 'tts')),
  CONSTRAINT voice_generation_fingerprint_valid CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT voice_generation_model_id_length CHECK (length(model_id) BETWEEN 1 AND 240),
  CONSTRAINT voice_generation_billing_key_length CHECK (length(billing_idempotency_key) BETWEEN 8 AND 240),
  CONSTRAINT voice_generation_quoted_credits_valid CHECK (quoted_credits >= 0),
  CONSTRAINT voice_generation_charge_credits_valid CHECK (charge_credits >= 0 AND charge_credits <= quoted_credits),
  CONSTRAINT voice_generation_refunded_credits_valid CHECK (refunded_credits >= 0 AND refunded_credits <= charge_credits),
  CONSTRAINT voice_generation_exemption_valid CHECK (
    (billing_exempt AND charge_credits = 0)
    OR (NOT billing_exempt AND charge_credits > 0)
  ),
  CONSTRAINT voice_generation_state_valid CHECK (
    state IN ('submitting', 'completed', 'refunded', 'failed_unknown', 'recovery_required')
  ),
  CONSTRAINT voice_generation_request_unique UNIQUE (user_id, request_id),
  CONSTRAINT voice_generation_client_phase_unique UNIQUE (user_id, client_request_id, phase)
);

CREATE INDEX IF NOT EXISTS voice_generation_requests_user_started_idx
  ON public.voice_generation_requests (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS voice_generation_requests_state_updated_idx
  ON public.voice_generation_requests (state, updated_at ASC);

ALTER TABLE public.voice_generation_requests ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.begin_voice_generation_atomic(
  p_request_id text,
  p_user_id text,
  p_client_request_id text,
  p_phase text,
  p_payload_fingerprint text,
  p_model_id text,
  p_billing_idempotency_key text,
  p_quoted_credits numeric,
  p_charge_credits numeric,
  p_billing_exempt boolean,
  p_price_snapshot jsonb DEFAULT '{}'::jsonb,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.voice_generation_requests%ROWTYPE;
  v_inserted boolean := false;
  v_wallet_result jsonb := NULL;
  v_quoted numeric(20, 6);
  v_charge numeric(20, 6);
BEGIN
  p_request_id := trim(coalesce(p_request_id, ''));
  p_user_id := trim(coalesce(p_user_id, ''));
  p_client_request_id := trim(coalesce(p_client_request_id, ''));
  p_phase := lower(trim(coalesce(p_phase, '')));
  p_payload_fingerprint := lower(trim(coalesce(p_payload_fingerprint, '')));
  p_model_id := trim(coalesce(p_model_id, ''));
  p_billing_idempotency_key := trim(coalesce(p_billing_idempotency_key, ''));
  v_quoted := round(coalesce(p_quoted_credits, -1), 6);
  v_charge := round(coalesce(p_charge_credits, -1), 6);

  IF length(p_request_id) NOT BETWEEN 8 AND 160
     OR length(p_user_id) NOT BETWEEN 1 AND 160
     OR length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_phase NOT IN ('seed-audio', 'mix', 'dual', 'tts')
     OR p_payload_fingerprint !~ '^[0-9a-f]{64}$'
     OR length(p_model_id) NOT BETWEEN 1 AND 240
     OR length(p_billing_idempotency_key) NOT BETWEEN 8 AND 240 THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_quoted < 0 OR v_charge < 0 OR v_charge > v_quoted THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_PRICE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (coalesce(p_billing_exempt, false) AND v_charge <> 0)
     OR (NOT coalesce(p_billing_exempt, false) AND v_charge <= 0) THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_EXEMPTION_INVALID' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(coalesce(p_price_snapshot, '{}'::jsonb)) <> 'object'
     OR jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_METADATA_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.voice_generation_requests (
    request_id,
    user_id,
    client_request_id,
    phase,
    payload_fingerprint,
    model_id,
    billing_idempotency_key,
    quoted_credits,
    charge_credits,
    billing_exempt,
    price_snapshot,
    metadata
  ) VALUES (
    p_request_id,
    p_user_id,
    p_client_request_id,
    p_phase,
    p_payload_fingerprint,
    p_model_id,
    p_billing_idempotency_key,
    v_quoted,
    v_charge,
    coalesce(p_billing_exempt, false),
    coalesce(p_price_snapshot, '{}'::jsonb),
    coalesce(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (user_id, client_request_id, phase) DO NOTHING
  RETURNING * INTO v_request;

  v_inserted := FOUND;
  IF NOT v_inserted THEN
    SELECT * INTO v_request
      FROM public.voice_generation_requests
     WHERE user_id = p_user_id
       AND client_request_id = p_client_request_id
       AND phase = p_phase
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'VOICE_LIFECYCLE_LOOKUP_FAILED';
    END IF;
    IF v_request.request_id <> p_request_id
       OR v_request.payload_fingerprint <> p_payload_fingerprint
       OR v_request.model_id <> p_model_id
       OR v_request.billing_idempotency_key <> p_billing_idempotency_key
       OR v_request.quoted_credits <> v_quoted
       OR v_request.charge_credits <> v_charge
       OR v_request.billing_exempt <> coalesce(p_billing_exempt, false) THEN
      RAISE EXCEPTION 'VOICE_LIFECYCLE_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
    END IF;

    IF v_request.state = 'completed' THEN
      RETURN jsonb_build_object(
        'success', true,
        'created', false,
        'already_fulfilled', true,
        'state', v_request.state,
        'request', to_jsonb(v_request),
        'response', v_request.response
      );
    END IF;
    IF v_request.state IN ('submitting', 'recovery_required', 'failed_unknown') THEN
      RETURN jsonb_build_object(
        'success', false,
        'created', false,
        'already_fulfilled', false,
        'code', 'VOICE_REQUEST_IN_PROGRESS_OR_UNKNOWN',
        'state', v_request.state,
        'request', to_jsonb(v_request)
      );
    END IF;
    RAISE EXCEPTION 'VOICE_LIFECYCLE_REQUEST_TERMINAL' USING ERRCODE = '22023';
  END IF;

  IF v_charge > 0 THEN
    v_wallet_result := public.apply_wallet_operation_atomic(
      p_user_id,
      'credit_charge',
      p_billing_idempotency_key,
      v_charge,
      '智音工坊生成',
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'route', '/api/voice/tts',
        'voice_request_id', p_request_id,
        'client_request_id', p_client_request_id,
        'phase', p_phase,
        'model_id', p_model_id,
        'price_snapshot', coalesce(p_price_snapshot, '{}'::jsonb)
      )
    );
    IF coalesce((v_wallet_result ->> 'success')::boolean, false) IS NOT TRUE
       OR nullif(v_wallet_result ->> 'operation_id', '') IS NULL THEN
      RAISE EXCEPTION 'VOICE_LIFECYCLE_WALLET_RESULT_INVALID';
    END IF;
  END IF;

  UPDATE public.voice_generation_requests
     SET wallet_operation_id = CASE
           WHEN v_wallet_result IS NULL THEN NULL
           ELSE (v_wallet_result ->> 'operation_id')::bigint
         END,
         updated_at = now()
   WHERE id = v_request.id
   RETURNING * INTO v_request;

  RETURN jsonb_build_object(
    'success', true,
    'created', true,
    'already_fulfilled', false,
    'state', v_request.state,
    'request', to_jsonb(v_request),
    'wallet', v_wallet_result
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_voice_generation_atomic(
  p_request_id text,
  p_user_id text,
  p_payload_fingerprint text,
  p_asset_id text,
  p_generation_id text,
  p_provider_task_id text,
  p_response jsonb,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.voice_generation_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_request
    FROM public.voice_generation_requests
   WHERE request_id = trim(coalesce(p_request_id, ''))
     AND user_id = trim(coalesce(p_user_id, ''))
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_request.payload_fingerprint <> lower(trim(coalesce(p_payload_fingerprint, ''))) THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF length(trim(coalesce(p_asset_id, ''))) = 0
     OR length(trim(coalesce(p_generation_id, ''))) = 0
     OR length(trim(coalesce(p_provider_task_id, ''))) = 0
     OR jsonb_typeof(coalesce(p_response, 'null'::jsonb)) <> 'object'
     OR coalesce((p_response ->> 'success')::boolean, false) IS NOT TRUE
     OR jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_FINALIZE_INVALID' USING ERRCODE = '22023';
  END IF;

  IF v_request.state = 'completed' THEN
    IF v_request.asset_id <> trim(p_asset_id)
       OR v_request.generation_id <> trim(p_generation_id)
       OR v_request.provider_task_id <> trim(p_provider_task_id)
       OR v_request.response IS DISTINCT FROM p_response THEN
      RAISE EXCEPTION 'VOICE_LIFECYCLE_RESULT_CONFLICT' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'already_fulfilled', true,
      'state', v_request.state,
      'request', to_jsonb(v_request),
      'response', v_request.response
    );
  END IF;
  IF v_request.state NOT IN ('submitting', 'recovery_required') THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_REQUEST_TERMINAL' USING ERRCODE = '22023';
  END IF;

  UPDATE public.voice_generation_requests
     SET state = 'completed',
         asset_id = trim(p_asset_id),
         generation_id = trim(p_generation_id),
         provider_task_id = trim(p_provider_task_id),
         response = p_response,
         metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
         error = NULL,
         updated_at = now(),
         completed_at = now()
   WHERE id = v_request.id
   RETURNING * INTO v_request;

  RETURN jsonb_build_object(
    'success', true,
    'already_fulfilled', false,
    'state', v_request.state,
    'request', to_jsonb(v_request),
    'response', v_request.response
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_voice_generation_atomic(
  p_request_id text,
  p_user_id text,
  p_payload_fingerprint text,
  p_refund_credits numeric,
  p_refund_scope text,
  p_refund_idempotency_key text,
  p_reason text,
  p_error jsonb DEFAULT '{}'::jsonb,
  p_terminal boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.voice_generation_requests%ROWTYPE;
  v_refund numeric(20, 6);
  v_new_refunded numeric(20, 6);
  v_scope text := trim(coalesce(p_refund_scope, ''));
  v_refund_key text := trim(coalesce(p_refund_idempotency_key, ''));
  v_existing_scope jsonb;
  v_wallet_result jsonb := NULL;
  v_next_state text;
BEGIN
  SELECT * INTO v_request
    FROM public.voice_generation_requests
   WHERE request_id = trim(coalesce(p_request_id, ''))
     AND user_id = trim(coalesce(p_user_id, ''))
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_request.payload_fingerprint <> lower(trim(coalesce(p_payload_fingerprint, ''))) THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
  END IF;
  v_refund := round(coalesce(p_refund_credits, -1), 6);
  IF v_refund < 0
     OR length(v_scope) NOT BETWEEN 1 AND 80
     OR length(v_refund_key) NOT BETWEEN 8 AND 240
     OR jsonb_typeof(coalesce(p_error, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_REFUND_INVALID' USING ERRCODE = '22023';
  END IF;

  v_existing_scope := v_request.refund_scopes -> v_scope;
  IF v_existing_scope IS NOT NULL THEN
    IF round(coalesce((v_existing_scope ->> 'credits')::numeric, -1), 6) <> v_refund
       OR coalesce(v_existing_scope ->> 'idempotency_key', '') <> v_refund_key THEN
      RAISE EXCEPTION 'VOICE_LIFECYCLE_REFUND_CONFLICT' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'already_fulfilled', true,
      'state', v_request.state,
      'request', to_jsonb(v_request),
      'wallet', v_existing_scope -> 'wallet'
    );
  END IF;

  IF v_request.state NOT IN ('submitting', 'recovery_required') THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_REQUEST_TERMINAL' USING ERRCODE = '22023';
  END IF;
  v_new_refunded := v_request.refunded_credits + v_refund;
  IF v_new_refunded > v_request.charge_credits THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_REFUND_EXCEEDS_CHARGE' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_terminal, true) AND v_new_refunded <> v_request.charge_credits THEN
    RAISE EXCEPTION 'VOICE_LIFECYCLE_TERMINAL_REFUND_INCOMPLETE' USING ERRCODE = '22023';
  END IF;

  IF v_refund > 0 THEN
    v_wallet_result := public.apply_wallet_operation_atomic(
      v_request.user_id,
      'credit_refund',
      v_refund_key,
      v_refund,
      left(coalesce(p_reason, '智音工坊生成失败退款'), 255),
      v_request.metadata || jsonb_build_object(
        'route', '/api/voice/tts',
        'voice_request_id', v_request.request_id,
        'client_request_id', v_request.client_request_id,
        'phase', v_request.phase,
        'refund_scope', v_scope,
        'charge_operation_id', v_request.wallet_operation_id
      )
    );
    IF coalesce((v_wallet_result ->> 'success')::boolean, false) IS NOT TRUE
       OR nullif(v_wallet_result ->> 'operation_id', '') IS NULL THEN
      RAISE EXCEPTION 'VOICE_LIFECYCLE_REFUND_RESULT_INVALID';
    END IF;
  END IF;

  v_next_state := CASE WHEN coalesce(p_terminal, true) THEN 'refunded' ELSE v_request.state END;
  UPDATE public.voice_generation_requests
     SET refunded_credits = v_new_refunded,
         refund_scopes = refund_scopes || jsonb_build_object(
           v_scope,
           jsonb_build_object(
             'credits', v_refund,
             'idempotency_key', v_refund_key,
             'wallet', v_wallet_result,
             'refunded_at', now()
           )
         ),
         state = v_next_state,
         error = CASE WHEN coalesce(p_terminal, true) THEN coalesce(p_error, '{}'::jsonb) ELSE error END,
         updated_at = now(),
         refunded_at = CASE WHEN coalesce(p_terminal, true) THEN now() ELSE refunded_at END
   WHERE id = v_request.id
   RETURNING * INTO v_request;

  RETURN jsonb_build_object(
    'success', true,
    'already_fulfilled', false,
    'state', v_request.state,
    'request', to_jsonb(v_request),
    'wallet', v_wallet_result
  );
END;
$$;

REVOKE ALL ON public.voice_generation_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.voice_generation_requests TO service_role;
REVOKE ALL ON SEQUENCE public.voice_generation_requests_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.voice_generation_requests_id_seq TO service_role;

REVOKE EXECUTE ON FUNCTION public.begin_voice_generation_atomic(
  text, text, text, text, text, text, text, numeric, numeric, boolean, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_voice_generation_atomic(
  text, text, text, text, text, text, text, numeric, numeric, boolean, jsonb, jsonb
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.finalize_voice_generation_atomic(
  text, text, text, text, text, text, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_voice_generation_atomic(
  text, text, text, text, text, text, jsonb, jsonb
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.refund_voice_generation_atomic(
  text, text, text, numeric, text, text, text, jsonb, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_voice_generation_atomic(
  text, text, text, numeric, text, text, text, jsonb, boolean
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
