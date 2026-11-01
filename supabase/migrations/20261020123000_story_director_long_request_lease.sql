-- Execute in the migration owner's transaction; this file does not commit it.
DO $lease_guard$
BEGIN
  IF encode(sha256(convert_to(pg_get_functiondef('public.claim_llm_request_attempt_atomic(text,text,text,text,text,integer)'::regprocedure), 'UTF8')), 'hex') <> '6ffe38cb57172c0ce8723af030c7a34746c97badfe84b97807bbfdbab486d8b9' THEN
    RAISE EXCEPTION 'STORY_DIRECTOR_LEASE_BEFORE_FUNCTION_DRIFT';
  END IF;
END;
$lease_guard$;

CREATE OR REPLACE FUNCTION public.claim_llm_request_attempt_atomic(p_record_id text, p_user_id text, p_client_request_id text, p_payload_fingerprint text, p_lease_owner text, p_lease_seconds integer DEFAULT 900)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row public.llm_request_attempts%ROWTYPE;
  v_action text;
  v_created boolean := false;
  v_user_id text := trim(coalesce(p_user_id, ''));
  v_client_request_id text := trim(coalesce(p_client_request_id, ''));
  v_fingerprint text := lower(trim(coalesce(p_payload_fingerprint, '')));
  v_lease_owner text := trim(coalesce(p_lease_owner, ''));
  v_lease_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 900), 2400));
BEGIN
  IF trim(coalesce(p_record_id, '')) !~ '^[a-f0-9]{64}$'
     OR v_user_id = ''
     OR v_client_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     OR v_fingerprint !~ '^[a-f0-9]{64}$'
     OR v_lease_owner = '' THEN
    RAISE EXCEPTION 'LLM_ATTEMPT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id || ':' || v_client_request_id, 0));

  INSERT INTO public.llm_request_attempts (
    record_id, user_id, client_request_id, payload_fingerprint,
    state, attempt_no, lease_owner, lease_token, lease_expires_at
  ) VALUES (
    trim(p_record_id), v_user_id, v_client_request_id, v_fingerprint,
    'running', 1, v_lease_owner, 1, now() + make_interval(secs => v_lease_seconds)
  )
  ON CONFLICT (user_id, client_request_id) DO NOTHING
  RETURNING * INTO v_row;

  v_created := FOUND;
  IF v_created THEN
    v_action := 'execute';
    INSERT INTO public.llm_request_attempt_events (
      record_id, attempt_no, event_type, to_state, lease_owner, lease_token
    ) VALUES (v_row.record_id, v_row.attempt_no, 'claimed', 'running', v_row.lease_owner, v_row.lease_token);
  ELSE
    SELECT * INTO v_row
      FROM public.llm_request_attempts
     WHERE user_id = v_user_id AND client_request_id = v_client_request_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'LLM_ATTEMPT_LOOKUP_FAILED'; END IF;
    IF v_row.record_id <> trim(p_record_id) OR v_row.payload_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'LLM_ATTEMPT_PAYLOAD_CONFLICT' USING ERRCODE = '22023';
    END IF;

    CASE v_row.state
      WHEN 'succeeded' THEN
        v_action := 'replay';
      WHEN 'failed_unknown' THEN
        v_action := 'reconciliation_required';
      WHEN 'reconciliation_required' THEN
        v_action := 'reconciliation_required';
      WHEN 'failed' THEN
        INSERT INTO public.llm_request_attempt_events (
          record_id, attempt_no, event_type, from_state, to_state,
          lease_owner, lease_token, reason, evidence
        ) VALUES (
          v_row.record_id, v_row.attempt_no + 1, 'retry_claimed', 'failed', 'running',
          v_lease_owner, v_row.lease_token + 1, 'definitive_failure_retry',
          jsonb_build_object(
            'prior_error_code', v_row.error_code,
            'prior_http_status', v_row.http_status,
            'prior_response_fingerprint', v_row.response_fingerprint
          )
        );
        UPDATE public.llm_request_attempts
           SET state = 'running', attempt_no = attempt_no + 1,
               lease_owner = v_lease_owner, lease_token = lease_token + 1,
               lease_expires_at = now() + make_interval(secs => v_lease_seconds),
               provider_call_started_at = NULL, http_status = NULL,
               response_headers = '{}'::jsonb, response_body = NULL,
               response_fingerprint = NULL, result_reference = NULL,
               error_code = NULL, error_message = NULL, updated_at = now()
         WHERE record_id = v_row.record_id
         RETURNING * INTO v_row;
        v_action := 'execute';
      WHEN 'running' THEN
        IF v_row.lease_expires_at IS NOT NULL AND v_row.lease_expires_at > now() THEN
          v_action := 'in_progress';
        ELSIF v_row.provider_call_started_at IS NOT NULL THEN
          UPDATE public.llm_request_attempts
             SET state = 'reconciliation_required', lease_owner = NULL,
                 lease_expires_at = NULL, error_code = 'LLM_STALE_AFTER_PROVIDER_START',
                 error_message = 'lease expired after provider dispatch', updated_at = now()
           WHERE record_id = v_row.record_id
           RETURNING * INTO v_row;
          INSERT INTO public.llm_request_attempt_events (
            record_id, attempt_no, event_type, from_state, to_state,
            lease_token, reason, evidence
          ) VALUES (
            v_row.record_id, v_row.attempt_no, 'reconciliation_required', 'running',
            'reconciliation_required', v_row.lease_token, 'stale_after_provider_start',
            jsonb_build_object('provider_call_started_at', v_row.provider_call_started_at)
          );
          v_action := 'reconciliation_required';
        ELSE
          UPDATE public.llm_request_attempts
             SET lease_owner = v_lease_owner, lease_token = lease_token + 1,
                 lease_expires_at = now() + make_interval(secs => v_lease_seconds),
                 updated_at = now()
           WHERE record_id = v_row.record_id
           RETURNING * INTO v_row;
          INSERT INTO public.llm_request_attempt_events (
            record_id, attempt_no, event_type, from_state, to_state,
            lease_owner, lease_token, reason
          ) VALUES (
            v_row.record_id, v_row.attempt_no, 'lease_reclaimed', 'running', 'running',
            v_row.lease_owner, v_row.lease_token, 'expired_before_provider_start'
          );
          v_action := 'execute';
        END IF;
      ELSE
        RAISE EXCEPTION 'LLM_ATTEMPT_STATE_INVALID' USING ERRCODE = '22023';
    END CASE;
  END IF;

  RETURN jsonb_build_object('action', v_action, 'record', to_jsonb(v_row));
END;
$function$;

DO $lease_guard$
BEGIN
  IF encode(sha256(convert_to(pg_get_functiondef('public.claim_llm_request_attempt_atomic(text,text,text,text,text,integer)'::regprocedure), 'UTF8')), 'hex') <> 'a6a5390374afc278caa4b0870b756777ff93ba3a88530c1a9e81bec9b4a01943' THEN
    RAISE EXCEPTION 'STORY_DIRECTOR_LEASE_AFTER_FUNCTION_DRIFT';
  END IF;
END;
$lease_guard$;
