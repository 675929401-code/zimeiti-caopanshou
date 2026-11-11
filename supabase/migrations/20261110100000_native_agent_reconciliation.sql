BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';

-- Observation only: consumes a previously persisted, owner-bound main-site result.
-- No new model request, execution grant, reservation, settlement or refund.
CREATE FUNCTION public.reconcile_native_agent_main_atomic(
 p_owner text,p_turn_id uuid,p_main_attempt_id text,p_response_fingerprint text,p_full_text text,p_outcome text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 v_turn public.pub_native_agent_turns%ROWTYPE;
 v_task public.pub_native_agent_tasks%ROWTYPE;
 v_main public.llm_request_attempts%ROWTYPE;
 v_cursor integer;v_length integer;v_part text;v_event jsonb;v_error text;
BEGIN
 PERFORM public.pub_assert_actor(p_owner);
 IF p_turn_id IS NULL OR p_main_attempt_id IS NULL OR p_main_attempt_id !~ '^[a-f0-9]{64}$' OR p_outcome IS NULL OR p_outcome NOT IN ('completed','failed') THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
 SELECT * INTO v_turn FROM public.pub_native_agent_turns WHERE id=p_turn_id AND owner_id=p_owner;
 IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AGENT_NOT_FOUND';END IF;
 SELECT * INTO v_task FROM public.pub_native_agent_tasks WHERE id=v_turn.task_id AND owner_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AGENT_NOT_FOUND';END IF;
 SELECT * INTO v_turn FROM public.pub_native_agent_turns WHERE id=p_turn_id AND owner_id=p_owner AND task_id=v_task.id FOR UPDATE;
 SELECT * INTO v_main FROM public.llm_request_attempts
  WHERE record_id=p_main_attempt_id AND user_id=p_owner AND client_request_id=v_turn.main_request_key FOR SHARE NOWAIT;
 IF NOT FOUND OR v_main.record_id IS DISTINCT FROM encode(sha256(convert_to(p_owner,'UTF8')||decode('00','hex')||convert_to(v_turn.main_request_key,'UTF8')),'hex') THEN RAISE EXCEPTION 'NATIVE_AGENT_MAIN_ATTEMPT_INVALID';END IF;
 IF v_turn.main_attempt_id IS NOT NULL AND v_turn.main_attempt_id IS DISTINCT FROM v_main.record_id THEN RAISE EXCEPTION 'NATIVE_AGENT_MAIN_ATTEMPT_INVALID';END IF;
 IF p_outcome='completed' THEN
  IF v_main.state<>'succeeded' OR v_main.http_status NOT BETWEEN 200 AND 299 OR v_main.http_status IS NULL
   OR v_main.response_body IS NULL OR v_main.result_reference IS NULL OR length(v_main.result_reference)<1
   OR p_response_fingerprint IS NULL OR p_response_fingerprint !~ '^[a-f0-9]{64}$'
   OR v_main.response_fingerprint IS DISTINCT FROM p_response_fingerprint
   OR encode(sha256(convert_to(v_main.response_body,'UTF8')),'hex') IS DISTINCT FROM p_response_fingerprint
   OR p_full_text IS NULL OR octet_length(p_full_text)>1048576
  THEN RAISE EXCEPTION 'NATIVE_AGENT_MAIN_ATTEMPT_UNVERIFIED';END IF;
 ELSIF v_main.state<>'failed' OR p_full_text IS NOT NULL
  OR p_response_fingerprint IS NOT NULL AND (p_response_fingerprint !~ '^[a-f0-9]{64}$' OR p_response_fingerprint IS DISTINCT FROM v_main.response_fingerprint)
 THEN RAISE EXCEPTION 'NATIVE_AGENT_MAIN_ATTEMPT_UNVERIFIED';
 END IF;
 IF v_turn.state IN ('completed','failed','cancelled') THEN
  IF v_turn.state=p_outcome AND v_turn.main_attempt_id=v_main.record_id AND (p_outcome='failed' OR v_turn.response_text=p_full_text) THEN
   RETURN jsonb_build_object('task',to_jsonb(v_task),'turn',to_jsonb(v_turn),'reconciled',true,'alreadyReconciled',true);
  END IF;
  RAISE EXCEPTION 'NATIVE_AGENT_TERMINAL_STATE';
 END IF;
 IF v_turn.state NOT IN ('running','streaming','unknown','cancel_requested') OR v_turn.lease_owner IS NULL THEN RAISE EXCEPTION 'NATIVE_AGENT_TERMINAL_STATE';END IF;
 IF p_outcome='completed' THEN
  IF left(p_full_text,char_length(v_turn.response_text)) IS DISTINCT FROM v_turn.response_text THEN RAISE EXCEPTION 'NATIVE_AGENT_STREAM_CONFLICT';END IF;
  v_cursor:=char_length(v_turn.response_text);v_length:=char_length(p_full_text);
  WHILE v_cursor<v_length LOOP
   v_part:=substring(p_full_text FROM v_cursor+1 FOR 3000);
   PERFORM public.pub_native_agent_event(p_owner,v_task.id,v_turn.id,'main-reconcile:'||v_main.record_id||':'||v_cursor::text,'text_delta','model',jsonb_build_object('text',v_part));
   v_cursor:=v_cursor+char_length(v_part);
  END LOOP;
 ELSE v_error:='NATIVE_AGENT_MAIN_FAILED';
 END IF;
 UPDATE public.pub_native_agent_turns SET
  response_text=CASE WHEN p_outcome='completed' THEN p_full_text ELSE response_text END,
  state=p_outcome,error_code=v_error,main_attempt_id=v_main.record_id,revision=revision+1,updated_at=now()
  WHERE id=v_turn.id AND owner_id=p_owner RETURNING * INTO v_turn;
 UPDATE public.pub_native_agent_tasks SET status=p_outcome,revision=revision+1,updated_at=now()
  WHERE id=v_task.id AND owner_id=p_owner RETURNING * INTO v_task;
 v_event:=public.pub_native_agent_event(p_owner,v_task.id,v_turn.id,'main-reconcile:terminal:'||v_main.record_id,'status','system',jsonb_build_object('state',p_outcome,'errorCode',v_error));
 RETURN jsonb_build_object('task',to_jsonb(v_task),'turn',to_jsonb(v_turn),'event',v_event,'reconciled',true,'alreadyReconciled',false);
END $$;
REVOKE ALL ON FUNCTION public.reconcile_native_agent_main_atomic(text,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_native_agent_main_atomic(text,uuid,text,text,text,text) TO service_role;
COMMIT;
