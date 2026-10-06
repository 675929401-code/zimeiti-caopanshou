-- A completed extraction can have HTTP 200 with an explicit business failure.
-- Keep every other reconciliation gate and require completed, uncharged failure evidence.
BEGIN;
CREATE OR REPLACE FUNCTION public.reconcile_extraction_attempt_atomic(p_record_id text, p_expected_updated_at timestamp with time zone, p_actor_user_id text, p_target_state text, p_http_status integer DEFAULT NULL::integer, p_response jsonb DEFAULT NULL::jsonb, p_response_fingerprint text DEFAULT NULL::text, p_provider_task_id text DEFAULT NULL::text, p_provider_evidence jsonb DEFAULT '{}'::jsonb, p_billing_evidence jsonb DEFAULT '{}'::jsonb, p_error_code text DEFAULT NULL::text, p_error_message text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    IF v_target_state = 'failed' AND p_http_status BETWEEN 200 AND 299
       AND NOT (coalesce(p_response->'success', 'null'::jsonb) = 'false'::jsonb
                AND coalesce(p_response->'upstream_completed', 'null'::jsonb) = 'true'::jsonb
                AND coalesce(p_response->'charged', 'null'::jsonb) = 'false'::jsonb) THEN
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
$function$;
COMMIT;
