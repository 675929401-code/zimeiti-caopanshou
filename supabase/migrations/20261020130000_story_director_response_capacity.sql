-- Owner transaction and migration ledger required. Ordinary new responses remain capped at 8 MiB in trusted server code.
DO $capacity_guard$
BEGIN
  IF encode(sha256(convert_to(pg_get_functiondef('public.finalize_llm_request_attempt_atomic(text,text,text,bigint,text,integer,jsonb,text,text,text,text,text)'::regprocedure), 'UTF8')), 'hex') <> 'cd69fa178b999358541e17f13dbb4fbc67ebb6bf2152b4f89c5bdb4be6d49708' THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_DRIFT'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.finalize_llm_request_attempt_atomic(text,text,text,bigint,text,integer,jsonb,text,text,text,text,text)'::regprocedure AND (proowner::regrole::text IS DISTINCT FROM 'zimeiti_owner' OR proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}')) THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_AUTHORITY_DRIFT'; END IF;
  IF encode(sha256(convert_to(pg_get_functiondef('public.reconcile_llm_request_attempt_atomic(text,integer,text,text,text,integer,jsonb,text,text,text)'::regprocedure), 'UTF8')), 'hex') <> 'ea2a99ae2f6cccce010b37f8a3f791ddcee45a387f38fff7d0d3d16b169384a2' THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_DRIFT'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.reconcile_llm_request_attempt_atomic(text,integer,text,text,text,integer,jsonb,text,text,text)'::regprocedure AND (proowner::regrole::text IS DISTINCT FROM 'zimeiti_owner' OR proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}')) THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_AUTHORITY_DRIFT'; END IF;
  IF encode(sha256(convert_to(pg_get_functiondef('public.claim_llm_request_attempt_atomic(text,text,text,text,text,integer)'::regprocedure), 'UTF8')), 'hex') <> 'a6a5390374afc278caa4b0870b756777ff93ba3a88530c1a9e81bec9b4a01943' THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_DRIFT'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.claim_llm_request_attempt_atomic(text,text,text,text,text,integer)'::regprocedure AND (proowner::regrole::text IS DISTINCT FROM 'zimeiti_owner' OR proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}')) THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_AUTHORITY_DRIFT'; END IF;
  IF encode(sha256(convert_to(pg_get_functiondef('public.recover_llm_credit_reservations_atomic(text)'::regprocedure), 'UTF8')), 'hex') <> '92485af5b003f80443230f044428342b0e4b11160c3a0f763473f0e936574448' THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_DRIFT'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.recover_llm_credit_reservations_atomic(text)'::regprocedure AND (proowner::regrole::text IS DISTINCT FROM 'zimeiti_owner' OR proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}')) THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_AUTHORITY_DRIFT'; END IF;
  IF encode(sha256(convert_to(pg_get_functiondef('public.reserve_llm_credits_atomic(text,text,bigint,numeric,jsonb)'::regprocedure), 'UTF8')), 'hex') <> '2f054d880348d8f31a84220c6142b1f5aec50546e9d1a8a2174477f14ce258e0' THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_DRIFT'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.reserve_llm_credits_atomic(text,text,bigint,numeric,jsonb)'::regprocedure AND (proowner::regrole::text IS DISTINCT FROM 'zimeiti_owner' OR proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}')) THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_AUTHORITY_DRIFT'; END IF;
  IF encode(sha256(convert_to(pg_get_functiondef('public.settle_llm_credits_atomic(text,text,bigint,numeric,text,jsonb,jsonb)'::regprocedure), 'UTF8')), 'hex') <> 'c713fc2cb2106bbfe5a4caf192163d5e8124d3291b567577ebe455244106db77' THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_DRIFT'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.settle_llm_credits_atomic(text,text,bigint,numeric,text,jsonb,jsonb)'::regprocedure AND (proowner::regrole::text IS DISTINCT FROM 'zimeiti_owner' OR proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}')) THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_AUTHORITY_DRIFT'; END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.llm_request_attempts'::regclass AND conname='llm_request_attempts_response_size') IS DISTINCT FROM $constraint$CHECK (((response_body IS NULL) OR (octet_length(response_body) <= 8388608)))$constraint$ THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_CONSTRAINT_DRIFT'; END IF;
END;
$capacity_guard$;
CREATE OR REPLACE FUNCTION public.finalize_llm_request_attempt_atomic(p_record_id text, p_payload_fingerprint text, p_lease_owner text, p_lease_token bigint, p_state text, p_http_status integer DEFAULT NULL::integer, p_response_headers jsonb DEFAULT '{}'::jsonb, p_response_body text DEFAULT NULL::text, p_response_fingerprint text DEFAULT NULL::text, p_result_reference text DEFAULT NULL::text, p_error_code text DEFAULT NULL::text, p_error_message text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row public.llm_request_attempts%ROWTYPE;
  v_state text := lower(trim(coalesce(p_state, '')));
  v_fingerprint text := lower(trim(coalesce(p_payload_fingerprint, '')));
BEGIN
  IF v_state NOT IN ('succeeded', 'failed', 'failed_unknown', 'reconciliation_required')
     OR jsonb_typeof(coalesce(p_response_headers, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'LLM_ATTEMPT_FINALIZE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_state = 'succeeded' AND (
    p_http_status NOT BETWEEN 200 AND 299 OR p_response_body IS NULL
    OR trim(coalesce(p_response_fingerprint, '')) !~ '^[a-f0-9]{64}$'
    OR trim(coalesce(p_result_reference, '')) = ''
  ) THEN RAISE EXCEPTION 'LLM_ATTEMPT_SUCCESS_EVIDENCE_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF v_state = 'failed' AND (
    p_http_status IS NULL OR p_response_body IS NULL
    OR trim(coalesce(p_response_fingerprint, '')) !~ '^[a-f0-9]{64}$'
  ) THEN RAISE EXCEPTION 'LLM_ATTEMPT_FAILURE_EVIDENCE_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF v_state IN ('failed_unknown', 'reconciliation_required') AND p_response_body IS NOT NULL THEN
    RAISE EXCEPTION 'LLM_ATTEMPT_UNKNOWN_RESPONSE_FORBIDDEN' USING ERRCODE = '22023';
  END IF;
  IF p_response_body IS NOT NULL AND octet_length(p_response_body) > 33554432 THEN
    RAISE EXCEPTION 'LLM_ATTEMPT_RESPONSE_TOO_LARGE' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.llm_request_attempts
   WHERE record_id = trim(coalesce(p_record_id, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LLM_ATTEMPT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_row.payload_fingerprint <> v_fingerprint THEN
    RAISE EXCEPTION 'LLM_ATTEMPT_PAYLOAD_CONFLICT' USING ERRCODE = '22023';
  END IF;

  IF v_row.state <> 'running' THEN
    IF v_row.state <> v_state THEN
      RAISE EXCEPTION 'LLM_ATTEMPT_TERMINAL_CONFLICT' USING ERRCODE = '22023';
    END IF;
    IF v_state = 'succeeded' AND (
      v_row.http_status IS DISTINCT FROM p_http_status
      OR v_row.response_fingerprint IS DISTINCT FROM trim(p_response_fingerprint)
      OR v_row.result_reference IS DISTINCT FROM trim(p_result_reference)
    ) THEN RAISE EXCEPTION 'LLM_ATTEMPT_RESULT_CONFLICT' USING ERRCODE = '22023'; END IF;
    IF v_state = 'failed' AND (
      v_row.http_status IS DISTINCT FROM p_http_status
      OR v_row.response_fingerprint IS DISTINCT FROM trim(p_response_fingerprint)
    ) THEN RAISE EXCEPTION 'LLM_ATTEMPT_RESULT_CONFLICT' USING ERRCODE = '22023'; END IF;
    RETURN jsonb_build_object('record', to_jsonb(v_row));
  END IF;

  IF v_row.lease_owner <> trim(coalesce(p_lease_owner, '')) OR v_row.lease_token <> p_lease_token THEN
    RAISE EXCEPTION 'LLM_ATTEMPT_LEASE_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF v_state = 'succeeded' AND v_row.provider_call_started_at IS NULL THEN
    RAISE EXCEPTION 'LLM_ATTEMPT_PROVIDER_START_REQUIRED' USING ERRCODE = '22023';
  END IF;

  UPDATE public.llm_request_attempts
     SET state = v_state, lease_owner = NULL, lease_expires_at = NULL,
         http_status = CASE WHEN v_state IN ('succeeded', 'failed') THEN p_http_status ELSE NULL END,
         response_headers = CASE WHEN v_state IN ('succeeded', 'failed') THEN coalesce(p_response_headers, '{}'::jsonb) ELSE '{}'::jsonb END,
         response_body = CASE WHEN v_state IN ('succeeded', 'failed') THEN p_response_body ELSE NULL END,
         response_fingerprint = CASE WHEN v_state IN ('succeeded', 'failed') THEN lower(trim(p_response_fingerprint)) ELSE NULL END,
         result_reference = CASE WHEN v_state = 'succeeded' THEN trim(p_result_reference) ELSE NULL END,
         error_code = nullif(left(trim(coalesce(p_error_code, '')), 120), ''),
         error_message = nullif(left(trim(coalesce(p_error_message, '')), 500), ''),
         updated_at = now()
   WHERE record_id = v_row.record_id RETURNING * INTO v_row;

  INSERT INTO public.llm_request_attempt_events (
    record_id, attempt_no, event_type, from_state, to_state,
    lease_token, reason, evidence
  ) VALUES (
    v_row.record_id, v_row.attempt_no, v_state, 'running', v_state,
    v_row.lease_token, nullif(left(trim(coalesce(p_error_message, '')), 500), ''),
    jsonb_strip_nulls(jsonb_build_object(
      'http_status', v_row.http_status,
      'response_fingerprint', v_row.response_fingerprint,
      'result_reference', v_row.result_reference,
      'error_code', v_row.error_code
    ))
  );
  RETURN jsonb_build_object('record', to_jsonb(v_row));
END;
$function$

;
ALTER TABLE public.llm_request_attempts DROP CONSTRAINT llm_request_attempts_response_size;
ALTER TABLE public.llm_request_attempts ADD CONSTRAINT llm_request_attempts_response_size CHECK (((response_body IS NULL) OR (octet_length(response_body) <= 33554432)));
DO $capacity_guard$
BEGIN
  IF encode(sha256(convert_to(pg_get_functiondef('public.finalize_llm_request_attempt_atomic(text,text,text,bigint,text,integer,jsonb,text,text,text,text,text)'::regprocedure), 'UTF8')), 'hex') <> '80dfc7c22c3cd6653724c7e35a979d42d7791df727984c7a73460680ca3d5384' THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_DRIFT'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.finalize_llm_request_attempt_atomic(text,text,text,bigint,text,integer,jsonb,text,text,text,text,text)'::regprocedure AND (proowner::regrole::text IS DISTINCT FROM 'zimeiti_owner' OR proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}')) THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_AUTHORITY_DRIFT'; END IF;
  IF encode(sha256(convert_to(pg_get_functiondef('public.reconcile_llm_request_attempt_atomic(text,integer,text,text,text,integer,jsonb,text,text,text)'::regprocedure), 'UTF8')), 'hex') <> 'ea2a99ae2f6cccce010b37f8a3f791ddcee45a387f38fff7d0d3d16b169384a2' THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_DRIFT'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.reconcile_llm_request_attempt_atomic(text,integer,text,text,text,integer,jsonb,text,text,text)'::regprocedure AND (proowner::regrole::text IS DISTINCT FROM 'zimeiti_owner' OR proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}')) THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_AUTHORITY_DRIFT'; END IF;
  IF encode(sha256(convert_to(pg_get_functiondef('public.claim_llm_request_attempt_atomic(text,text,text,text,text,integer)'::regprocedure), 'UTF8')), 'hex') <> 'a6a5390374afc278caa4b0870b756777ff93ba3a88530c1a9e81bec9b4a01943' THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_DRIFT'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.claim_llm_request_attempt_atomic(text,text,text,text,text,integer)'::regprocedure AND (proowner::regrole::text IS DISTINCT FROM 'zimeiti_owner' OR proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}')) THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_AUTHORITY_DRIFT'; END IF;
  IF encode(sha256(convert_to(pg_get_functiondef('public.recover_llm_credit_reservations_atomic(text)'::regprocedure), 'UTF8')), 'hex') <> '92485af5b003f80443230f044428342b0e4b11160c3a0f763473f0e936574448' THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_DRIFT'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.recover_llm_credit_reservations_atomic(text)'::regprocedure AND (proowner::regrole::text IS DISTINCT FROM 'zimeiti_owner' OR proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}')) THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_AUTHORITY_DRIFT'; END IF;
  IF encode(sha256(convert_to(pg_get_functiondef('public.reserve_llm_credits_atomic(text,text,bigint,numeric,jsonb)'::regprocedure), 'UTF8')), 'hex') <> '2f054d880348d8f31a84220c6142b1f5aec50546e9d1a8a2174477f14ce258e0' THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_DRIFT'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.reserve_llm_credits_atomic(text,text,bigint,numeric,jsonb)'::regprocedure AND (proowner::regrole::text IS DISTINCT FROM 'zimeiti_owner' OR proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}')) THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_AUTHORITY_DRIFT'; END IF;
  IF encode(sha256(convert_to(pg_get_functiondef('public.settle_llm_credits_atomic(text,text,bigint,numeric,text,jsonb,jsonb)'::regprocedure), 'UTF8')), 'hex') <> 'c713fc2cb2106bbfe5a4caf192163d5e8124d3291b567577ebe455244106db77' THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_DRIFT'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.settle_llm_credits_atomic(text,text,bigint,numeric,text,jsonb,jsonb)'::regprocedure AND (proowner::regrole::text IS DISTINCT FROM 'zimeiti_owner' OR proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}')) THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_FUNCTION_AUTHORITY_DRIFT'; END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.llm_request_attempts'::regclass AND conname='llm_request_attempts_response_size') IS DISTINCT FROM $constraint$CHECK (((response_body IS NULL) OR (octet_length(response_body) <= 33554432)))$constraint$ THEN RAISE EXCEPTION 'RESPONSE_CAPACITY_CONSTRAINT_DRIFT'; END IF;
END;
$capacity_guard$;
