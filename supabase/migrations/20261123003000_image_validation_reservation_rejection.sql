-- A rejected wallet reservation is persisted before dispatch. The original request, owner,
-- fingerprint and input rejection envelope must all match before a new validation epoch.
CREATE OR REPLACE FUNCTION public.record_image_model_validation_outcome(
  p_validation_id text,p_user_id text,p_outcome text,p_rejection_code text DEFAULT NULL,p_http_status integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_row public.image_model_validations%ROWTYPE; v_request public.image_generation_requests%ROWTYPE; v_user public.users%ROWTYPE;
BEGIN
  PERFORM public.assert_image_validation_admin(p_user_id);
  SELECT * INTO v_user FROM public.users WHERE id::text=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_user.role IS DISTINCT FROM 'admin' OR v_user.is_active IS DISTINCT FROM true
     OR (v_user.status IS NOT NULL AND v_user.status <> 'active') THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_ADMIN_REQUIRED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_row FROM public.image_model_validations WHERE validation_id=p_validation_id FOR UPDATE;
  IF NOT FOUND OR v_row.user_id <> p_user_id THEN RAISE EXCEPTION 'IMAGE_VALIDATION_OWNER_MISMATCH' USING ERRCODE='42501'; END IF;
  IF p_outcome NOT IN ('unknown','rejected','completed') OR p_outcome IS NULL THEN RAISE EXCEPTION 'IMAGE_VALIDATION_OUTCOME_INVALID' USING ERRCODE='22023'; END IF;
  IF v_row.state IN ('rejected','completed','published') THEN
    IF v_row.state <> p_outcome AND NOT (v_row.state='published' AND p_outcome='completed') THEN
      RAISE EXCEPTION 'IMAGE_VALIDATION_TERMINAL_CONFLICT' USING ERRCODE='22023';
    END IF;
    RETURN jsonb_build_object('record',to_jsonb(v_row));
  END IF;
  SELECT * INTO v_request FROM public.image_generation_requests WHERE record_id=v_row.image_record_id FOR UPDATE;
  IF FOUND AND (v_request.user_id<>v_row.user_id OR v_request.client_idempotency_key<>v_row.client_idempotency_key
    OR v_request.client_trace_id<>v_row.client_trace_id OR v_request.payload_fingerprint<>v_row.payload_fingerprint) THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_REQUEST_MISMATCH' USING ERRCODE='22023';
  END IF;
  IF p_outcome='completed' AND (v_request.record_id IS NULL OR v_request.state<>'completed'
     OR coalesce(v_request.response->>'selectedModelId','')<>v_row.model_id) THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_RESULT_INCOMPLETE' USING ERRCODE='22023';
  END IF;
  IF p_outcome='rejected' THEN
    IF v_request.record_id IS NULL OR v_request.state<>'failed_unknown'
       OR v_request.response->>'schema' IS DISTINCT FROM 'image_request_rejection.v1'
       OR v_request.response->>'payloadFingerprint' IS DISTINCT FROM v_row.payload_fingerprint
       OR v_request.response->>'code' IS DISTINCT FROM p_rejection_code THEN
      RAISE EXCEPTION 'IMAGE_VALIDATION_REJECTION_UNPROVEN' USING ERRCODE='22023';
    END IF;
    IF v_request.response->>'source'='input' THEN
      IF p_rejection_code IS NULL OR p_rejection_code NOT IN ('IMAGE_REFERENCE_READ_FAILED','IMAGE_BILLING_RESERVATION_REJECTED') OR p_http_status IS NOT NULL
         OR v_request.response->>'upstreamStatus' IS NOT NULL THEN
        RAISE EXCEPTION 'IMAGE_VALIDATION_REJECTION_UNPROVEN' USING ERRCODE='22023';
      END IF;
    ELSIF v_request.response->>'source'='provider' THEN
      IF p_rejection_code='IMAGE_UPSTREAM_TERMINAL_EVENT' THEN
        IF p_http_status IS NOT NULL OR v_request.response->>'upstreamStatus' IS NOT NULL THEN
          RAISE EXCEPTION 'IMAGE_VALIDATION_REJECTION_UNPROVEN' USING ERRCODE='22023';
        END IF;
      ELSIF p_rejection_code='IMAGE_UPSTREAM_ACCOUNT_UNAVAILABLE' THEN
        IF p_http_status IS DISTINCT FROM 503 OR v_request.response->>'upstreamStatus' IS DISTINCT FROM '503' THEN
          RAISE EXCEPTION 'IMAGE_VALIDATION_REJECTION_UNPROVEN' USING ERRCODE='22023';
        END IF;
      ELSIF p_http_status IS NULL OR p_http_status NOT IN (400,401,403,404,422)
         OR v_request.response->>'upstreamStatus' IS DISTINCT FROM p_http_status::text
         OR p_rejection_code IS NULL OR p_rejection_code NOT IN ('IMAGE_REFERENCE_REJECTED','IMAGE_UPSTREAM_REQUEST_REJECTED')
         OR (p_rejection_code='IMAGE_REFERENCE_REJECTED' AND p_http_status<>400) THEN
        RAISE EXCEPTION 'IMAGE_VALIDATION_REJECTION_UNPROVEN' USING ERRCODE='22023';
      END IF;
    ELSE
      RAISE EXCEPTION 'IMAGE_VALIDATION_REJECTION_UNPROVEN' USING ERRCODE='22023';
    END IF;
  END IF;
  IF p_outcome='unknown' AND v_request.state='completed' THEN RAISE EXCEPTION 'IMAGE_VALIDATION_RESULT_ALREADY_COMPLETED' USING ERRCODE='22023'; END IF;
  UPDATE public.image_model_validations SET state=p_outcome,updated_at=now(),
    rejection_code=CASE WHEN p_outcome='rejected' THEN p_rejection_code END,
    rejection_http_status=CASE WHEN p_outcome='rejected' THEN p_http_status END
    WHERE validation_id=p_validation_id RETURNING * INTO v_row;
  RETURN jsonb_build_object('record',to_jsonb(v_row));
END;
$$;

