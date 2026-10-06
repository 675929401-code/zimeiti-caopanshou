-- Preserve accepted provider identities and completed content before settlement.
ALTER TABLE public.extraction_attempts ADD COLUMN IF NOT EXISTS provider_checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.extraction_attempts'::regclass AND conname='extraction_attempts_checkpoint_object') THEN
  ALTER TABLE public.extraction_attempts ADD CONSTRAINT extraction_attempts_checkpoint_object CHECK (jsonb_typeof(provider_checkpoint)='object');
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.checkpoint_extraction_provider_atomic(p_record_id text,p_user_id text,p_payload_fingerprint text,p_provider_task_id text DEFAULT NULL,p_provider_result jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_row public.extraction_attempts%ROWTYPE;v_checkpoint jsonb;v_tasks jsonb;v_task text:=nullif(trim(coalesce(p_provider_task_id,'')),'');
BEGIN
 IF p_record_id !~ '^[a-f0-9]{64}$' OR p_payload_fingerprint !~ '^[a-f0-9]{64}$'
 OR (v_task IS NULL AND p_provider_result IS NULL)
 OR (v_task IS NOT NULL AND v_task !~ '^[A-Za-z0-9_-]{1,128}$')
 OR (p_provider_result IS NOT NULL AND (jsonb_typeof(p_provider_result)<>'object' OR octet_length(p_provider_result::text)>8388608)) THEN
  RAISE EXCEPTION 'EXTRACTION_PROVIDER_CHECKPOINT_INPUT_INVALID' USING ERRCODE='22023';
 END IF;
 SELECT * INTO v_row FROM public.extraction_attempts WHERE record_id=p_record_id AND user_id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'EXTRACTION_PROVIDER_CHECKPOINT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF v_row.payload_fingerprint<>p_payload_fingerprint THEN RAISE EXCEPTION 'EXTRACTION_ATTEMPT_CONFLICT' USING ERRCODE='22023';END IF;
 IF v_row.state<>'running' THEN RAISE EXCEPTION 'EXTRACTION_PROVIDER_CHECKPOINT_CLOSED' USING ERRCODE='22023'; END IF;
 v_checkpoint:=v_row.provider_checkpoint;
 v_tasks:=coalesce(v_checkpoint->'task_ids','[]'::jsonb);
 IF v_task IS NOT NULL AND NOT v_tasks ? v_task THEN
  IF jsonb_array_length(v_tasks)>=50 THEN RAISE EXCEPTION 'EXTRACTION_PROVIDER_CHECKPOINT_LIMIT' USING ERRCODE='22023';END IF;
  v_checkpoint:=v_checkpoint||jsonb_build_object('task_ids',v_tasks||jsonb_build_array(v_task),'last_accepted_at',now());
 END IF;
 IF p_provider_result IS NOT NULL AND (v_checkpoint->'result') IS DISTINCT FROM p_provider_result THEN
  v_checkpoint:=v_checkpoint||jsonb_build_object('result',p_provider_result,'result_saved_at',now());
 END IF;
 IF v_checkpoint IS DISTINCT FROM v_row.provider_checkpoint THEN
  UPDATE public.extraction_attempts SET provider_checkpoint=v_checkpoint,provider_task_id=coalesce(provider_task_id,v_task),updated_at=now() WHERE record_id=v_row.record_id RETURNING * INTO v_row;
 END IF;
 RETURN jsonb_build_object('record',to_jsonb(v_row));
END $$;
REVOKE ALL ON FUNCTION public.checkpoint_extraction_provider_atomic(text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_extraction_provider_atomic(text,text,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_extraction_attempt_atomic(p_record_id text, p_payload_fingerprint text, p_state text, p_http_status integer DEFAULT NULL::integer, p_response jsonb DEFAULT NULL::jsonb, p_provider_task_id text DEFAULT NULL::text, p_provider_evidence jsonb DEFAULT '{}'::jsonb, p_billing_evidence jsonb DEFAULT '{}'::jsonb, p_error_code text DEFAULT NULL::text, p_error_message text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
         provider_task_id = coalesce(nullif(trim(coalesce(p_provider_task_id, '')), ''), v_row.provider_task_id),
         provider_evidence = coalesce(p_provider_evidence, '{}'::jsonb),
         billing_evidence = coalesce(p_billing_evidence, '{}'::jsonb),
         error_code = nullif(left(trim(coalesce(p_error_code, '')), 120), ''),
         error_message = nullif(left(trim(coalesce(p_error_message, '')), 500), ''),
         updated_at = now()
   WHERE record_id = v_row.record_id
   RETURNING * INTO v_row;

  RETURN jsonb_build_object('record', to_jsonb(v_row));
END;
$function$
;
NOTIFY pgrst, 'reload schema';
