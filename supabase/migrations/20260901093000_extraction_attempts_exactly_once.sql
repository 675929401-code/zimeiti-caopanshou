-- Durable exactly-once contract for every extraction provider submission.
-- External providers cannot participate in a PostgreSQL transaction. A row
-- left in running/failed_unknown therefore fails closed until an operator
-- reconciles it; the same client_request_id is never submitted upstream twice.

CREATE TABLE IF NOT EXISTS public.extraction_attempts (
  record_id text PRIMARY KEY,
  user_id text NOT NULL,
  client_request_id text NOT NULL,
  request_kind text NOT NULL
    CHECK (request_kind IN ('single', 'batch', 'search', 'coze', 'semantic')),
  payload_fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'succeeded', 'failed', 'failed_unknown')),
  http_status integer,
  response jsonb,
  provider_task_id text,
  provider_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  billing_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  reconciled_by text,
  reconciled_at timestamptz,
  reconciliation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_attempts_user_request_unique
    UNIQUE (user_id, client_request_id),
  CONSTRAINT extraction_attempts_record_id_format CHECK (
    record_id ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT extraction_attempts_client_request_format CHECK (
    client_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  CONSTRAINT extraction_attempts_fingerprint_format CHECK (
    payload_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT extraction_attempts_http_status_range CHECK (
    http_status IS NULL OR http_status BETWEEN 100 AND 599
  ),
  CONSTRAINT extraction_attempts_provider_evidence_object CHECK (
    jsonb_typeof(provider_evidence) = 'object'
  ),
  CONSTRAINT extraction_attempts_billing_evidence_object CHECK (
    jsonb_typeof(billing_evidence) = 'object'
  ),
  CONSTRAINT extraction_attempts_terminal_shape CHECK (
    (state = 'running' AND http_status IS NULL AND response IS NULL)
    OR (state = 'succeeded' AND http_status IS NOT NULL AND http_status BETWEEN 200 AND 299 AND response IS NOT NULL)
    OR (state = 'failed' AND http_status IS NOT NULL AND response IS NOT NULL)
    OR (state = 'failed_unknown' AND response IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS extraction_attempts_user_updated_idx
  ON public.extraction_attempts (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS extraction_attempts_reconciliation_idx
  ON public.extraction_attempts (state, updated_at ASC)
  WHERE state IN ('running', 'failed_unknown');

ALTER TABLE public.extraction_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.extraction_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.extraction_attempts TO service_role;

CREATE OR REPLACE FUNCTION public.claim_extraction_attempt_atomic(
  p_record_id text,
  p_user_id text,
  p_client_request_id text,
  p_request_kind text,
  p_payload_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.extraction_attempts%ROWTYPE;
  v_created boolean := false;
  v_user_id text := trim(coalesce(p_user_id, ''));
  v_client_request_id text := trim(coalesce(p_client_request_id, ''));
  v_request_kind text := lower(trim(coalesce(p_request_kind, '')));
  v_fingerprint text := lower(trim(coalesce(p_payload_fingerprint, '')));
BEGIN
  IF trim(coalesce(p_record_id, '')) !~ '^[a-f0-9]{64}$'
     OR v_user_id = ''
     OR v_client_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR v_request_kind NOT IN ('single', 'batch', 'search', 'coze', 'semantic')
     OR v_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'EXTRACTION_ATTEMPT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_user_id || ':' || v_client_request_id, 0)
  );

  INSERT INTO public.extraction_attempts (
    record_id,
    user_id,
    client_request_id,
    request_kind,
    payload_fingerprint,
    state
  ) VALUES (
    trim(p_record_id),
    v_user_id,
    v_client_request_id,
    v_request_kind,
    v_fingerprint,
    'running'
  )
  ON CONFLICT (user_id, client_request_id) DO NOTHING
  RETURNING * INTO v_row;

  v_created := FOUND;
  IF NOT v_created THEN
    SELECT * INTO v_row
      FROM public.extraction_attempts
     WHERE user_id = v_user_id
       AND client_request_id = v_client_request_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'EXTRACTION_ATTEMPT_LOOKUP_FAILED';
    END IF;
    IF v_row.record_id <> trim(p_record_id)
       OR v_row.request_kind <> v_request_kind
       OR v_row.payload_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'EXTRACTION_ATTEMPT_CONFLICT' USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN jsonb_build_object('created', v_created, 'record', to_jsonb(v_row));
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_extraction_attempt_atomic(
  p_record_id text,
  p_payload_fingerprint text,
  p_state text,
  p_http_status integer DEFAULT NULL,
  p_response jsonb DEFAULT NULL,
  p_provider_task_id text DEFAULT NULL,
  p_provider_evidence jsonb DEFAULT '{}'::jsonb,
  p_billing_evidence jsonb DEFAULT '{}'::jsonb,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.extraction_attempts%ROWTYPE;
  v_state text := lower(trim(coalesce(p_state, '')));
  v_fingerprint text := lower(trim(coalesce(p_payload_fingerprint, '')));
BEGIN
  IF v_state NOT IN ('succeeded', 'failed', 'failed_unknown')
     OR v_fingerprint !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(coalesce(p_provider_evidence, '{}'::jsonb)) <> 'object'
     OR jsonb_typeof(coalesce(p_billing_evidence, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'EXTRACTION_ATTEMPT_FINALIZE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_state = 'succeeded'
     AND (p_http_status IS NULL OR p_http_status NOT BETWEEN 200 AND 299 OR p_response IS NULL) THEN
    RAISE EXCEPTION 'EXTRACTION_ATTEMPT_SUCCESS_EVIDENCE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_state = 'failed'
     AND (p_http_status IS NULL OR p_response IS NULL) THEN
    RAISE EXCEPTION 'EXTRACTION_ATTEMPT_FAILURE_EVIDENCE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM public.extraction_attempts
   WHERE record_id = trim(coalesce(p_record_id, ''))
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXTRACTION_ATTEMPT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.payload_fingerprint <> v_fingerprint THEN
    RAISE EXCEPTION 'EXTRACTION_ATTEMPT_CONFLICT' USING ERRCODE = '22023';
  END IF;

  IF v_row.state <> 'running' THEN
    IF v_row.state <> v_state THEN
      RAISE EXCEPTION 'EXTRACTION_ATTEMPT_TERMINAL_CONFLICT' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('record', to_jsonb(v_row));
  END IF;

  UPDATE public.extraction_attempts
     SET state = v_state,
         http_status = p_http_status,
         response = CASE WHEN v_state = 'failed_unknown' THEN NULL ELSE p_response END,
         provider_task_id = nullif(trim(coalesce(p_provider_task_id, '')), ''),
         provider_evidence = coalesce(p_provider_evidence, '{}'::jsonb),
         billing_evidence = coalesce(p_billing_evidence, '{}'::jsonb),
         error_code = nullif(left(trim(coalesce(p_error_code, '')), 120), ''),
         error_message = nullif(left(trim(coalesce(p_error_message, '')), 500), ''),
         updated_at = now()
   WHERE record_id = v_row.record_id
   RETURNING * INTO v_row;

  RETURN jsonb_build_object('record', to_jsonb(v_row));
END;
$$;

REVOKE ALL ON FUNCTION public.claim_extraction_attempt_atomic(text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_extraction_attempt_atomic(text, text, text, integer, jsonb, text, jsonb, jsonb, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_extraction_attempt_atomic(text, text, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_extraction_attempt_atomic(text, text, text, integer, jsonb, text, jsonb, jsonb, text, text)
  TO service_role;

-- Operators never delete or silently reset an unresolved attempt. Every
-- service-role-only transition is optimistic-concurrency protected and leaves
-- an immutable audit row. The application route separately requires an
-- authenticated platform administrator before it calls these RPCs.
CREATE TABLE IF NOT EXISTS public.extraction_attempt_reconciliation_audit (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  record_id text NOT NULL REFERENCES public.extraction_attempts(record_id),
  actor_user_id text NOT NULL,
  from_state text NOT NULL
    CHECK (from_state IN ('running', 'failed_unknown')),
  to_state text NOT NULL
    CHECK (to_state IN ('succeeded', 'failed', 'failed_unknown')),
  reason text NOT NULL,
  response_fingerprint text,
  provider_task_id text,
  provider_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  billing_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_attempt_reconciliation_reason_check
    CHECK (char_length(reason) BETWEEN 8 AND 500),
  CONSTRAINT extraction_attempt_reconciliation_response_hash_check
    CHECK (response_fingerprint IS NULL OR response_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT extraction_attempt_reconciliation_provider_object_check
    CHECK (jsonb_typeof(provider_evidence) = 'object'),
  CONSTRAINT extraction_attempt_reconciliation_billing_object_check
    CHECK (jsonb_typeof(billing_evidence) = 'object')
);

CREATE INDEX IF NOT EXISTS extraction_attempt_reconciliation_audit_record_idx
  ON public.extraction_attempt_reconciliation_audit (record_id, created_at DESC);

ALTER TABLE public.extraction_attempt_reconciliation_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.extraction_attempt_reconciliation_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.extraction_attempt_reconciliation_audit TO service_role;

CREATE OR REPLACE FUNCTION public.list_extraction_attempts_for_reconciliation(
  p_limit integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
  v_rows jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(item ORDER BY item.updated_at ASC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT record_id,
             user_id,
             client_request_id,
             request_kind,
             payload_fingerprint,
             state,
             http_status,
             provider_task_id,
             provider_evidence,
             billing_evidence,
             error_code,
             error_message,
             created_at,
             updated_at
        FROM public.extraction_attempts
       WHERE state = 'failed_unknown'
          OR (state = 'running' AND updated_at <= now() - interval '30 minutes')
       ORDER BY updated_at ASC
       LIMIT v_limit
    ) AS item;
  RETURN jsonb_build_object('records', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_extraction_attempt_atomic(
  p_record_id text,
  p_expected_updated_at timestamptz,
  p_actor_user_id text,
  p_target_state text,
  p_http_status integer DEFAULT NULL,
  p_response jsonb DEFAULT NULL,
  p_response_fingerprint text DEFAULT NULL,
  p_provider_task_id text DEFAULT NULL,
  p_provider_evidence jsonb DEFAULT '{}'::jsonb,
  p_billing_evidence jsonb DEFAULT '{}'::jsonb,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.extraction_attempts%ROWTYPE;
  v_from_state text;
  v_target_state text := lower(trim(coalesce(p_target_state, '')));
  v_actor_user_id text := trim(coalesce(p_actor_user_id, ''));
  v_reason text := trim(coalesce(p_reason, ''));
  v_response_fingerprint text := lower(trim(coalesce(p_response_fingerprint, '')));
BEGIN
  IF trim(coalesce(p_record_id, '')) !~ '^[a-f0-9]{64}$'
     OR v_actor_user_id = ''
     OR v_target_state NOT IN ('succeeded', 'failed', 'failed_unknown')
     OR char_length(v_reason) NOT BETWEEN 8 AND 500
     OR jsonb_typeof(coalesce(p_provider_evidence, '{}'::jsonb)) <> 'object'
     OR jsonb_typeof(coalesce(p_billing_evidence, '{}'::jsonb)) <> 'object'
     OR coalesce(p_provider_evidence, '{}'::jsonb) = '{}'::jsonb
     OR coalesce(p_billing_evidence, '{}'::jsonb) = '{}'::jsonb THEN
    RAISE EXCEPTION 'EXTRACTION_RECONCILIATION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF v_target_state IN ('succeeded', 'failed') THEN
    IF p_http_status IS NULL
       OR p_response IS NULL
       OR v_response_fingerprint !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'EXTRACTION_RECONCILIATION_TERMINAL_EVIDENCE_REQUIRED' USING ERRCODE = '22023';
    END IF;
    IF v_target_state = 'succeeded' AND p_http_status NOT BETWEEN 200 AND 299 THEN
      RAISE EXCEPTION 'EXTRACTION_RECONCILIATION_SUCCESS_STATUS_INVALID' USING ERRCODE = '22023';
    END IF;
    IF v_target_state = 'failed' AND p_http_status BETWEEN 200 AND 299 THEN
      RAISE EXCEPTION 'EXTRACTION_RECONCILIATION_FAILURE_STATUS_INVALID' USING ERRCODE = '22023';
    END IF;
  ELSIF p_response IS NOT NULL THEN
    RAISE EXCEPTION 'EXTRACTION_RECONCILIATION_UNKNOWN_RESPONSE_FORBIDDEN' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(trim(p_record_id), 0));
  SELECT * INTO v_row
    FROM public.extraction_attempts
   WHERE record_id = trim(p_record_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXTRACTION_ATTEMPT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.state NOT IN ('running', 'failed_unknown') THEN
    RAISE EXCEPTION 'EXTRACTION_RECONCILIATION_ALREADY_TERMINAL' USING ERRCODE = '22023';
  END IF;
  IF v_row.state = 'running'
     AND v_row.updated_at > now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'EXTRACTION_RECONCILIATION_ATTEMPT_ACTIVE' USING ERRCODE = '55000';
  END IF;
  IF p_expected_updated_at IS NULL OR v_row.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'EXTRACTION_RECONCILIATION_STALE' USING ERRCODE = '40001';
  END IF;

  v_from_state := v_row.state;
  UPDATE public.extraction_attempts
     SET state = v_target_state,
         http_status = p_http_status,
         response = CASE WHEN v_target_state = 'failed_unknown' THEN NULL ELSE p_response END,
         provider_task_id = coalesce(nullif(trim(coalesce(p_provider_task_id, '')), ''), provider_task_id),
         provider_evidence = coalesce(p_provider_evidence, '{}'::jsonb),
         billing_evidence = coalesce(p_billing_evidence, '{}'::jsonb),
         error_code = nullif(left(trim(coalesce(p_error_code, '')), 120), ''),
         error_message = nullif(left(trim(coalesce(p_error_message, '')), 500), ''),
         reconciled_by = v_actor_user_id,
         reconciled_at = now(),
         reconciliation_reason = v_reason,
         updated_at = now()
   WHERE record_id = v_row.record_id
   RETURNING * INTO v_row;

  INSERT INTO public.extraction_attempt_reconciliation_audit (
    record_id,
    actor_user_id,
    from_state,
    to_state,
    reason,
    response_fingerprint,
    provider_task_id,
    provider_evidence,
    billing_evidence
  ) VALUES (
    v_row.record_id,
    v_actor_user_id,
    v_from_state,
    v_target_state,
    v_reason,
    nullif(v_response_fingerprint, ''),
    nullif(trim(coalesce(p_provider_task_id, '')), ''),
    coalesce(p_provider_evidence, '{}'::jsonb),
    coalesce(p_billing_evidence, '{}'::jsonb)
  );

  RETURN jsonb_build_object('record', to_jsonb(v_row));
END;
$$;

REVOKE ALL ON FUNCTION public.list_extraction_attempts_for_reconciliation(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_extraction_attempt_atomic(text, timestamptz, text, text, integer, jsonb, text, text, jsonb, jsonb, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_extraction_attempts_for_reconciliation(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_extraction_attempt_atomic(text, timestamptz, text, text, integer, jsonb, text, text, jsonb, jsonb, text, text, text)
  TO service_role;
