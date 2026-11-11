-- Forward-only candidate. Existing chat turns and their immutable policies are retained.
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';

CREATE FUNCTION public.pub_native_sdk_canonical(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE v text; BEGIN
 CASE jsonb_typeof(p)
 WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.pub_native_sdk_canonical(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO v FROM jsonb_each(p);
 WHEN 'array' THEN SELECT '['||coalesce(string_agg(public.pub_native_sdk_canonical(value),',' ORDER BY ord),'')||']' INTO v FROM jsonb_array_elements(p) WITH ORDINALITY x(value,ord);
 ELSE v:=p::text; END CASE;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.pub_native_sdk_canonical(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE public.pub_native_agent_runtime_config (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL CHECK(revision>0),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object' AND octet_length(config::text)<=16384),
 config_hash text NOT NULL CHECK(config_hash~'^[a-f0-9]{64}$'),
 updated_by varchar(36) NOT NULL REFERENCES public.users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pub_native_agent_runtime_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pub_native_agent_runtime_config FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.pub_native_agent_runtime_config TO service_role;

CREATE FUNCTION public.mutate_native_agent_runtime_config(p_actor uuid,p_expected_revision bigint,p_config jsonb,p_config_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_row public.pub_native_agent_runtime_config%ROWTYPE; k text; m text; BEGIN
 PERFORM public.pub_assert_actor(p_actor::text);
 IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=p_actor::text AND role='admin') THEN RAISE EXCEPTION 'NATIVE_AGENT_CONFIG_FORBIDDEN';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('native-agent-runtime-config',0));
 SELECT * INTO current_row FROM public.pub_native_agent_runtime_config WHERE singleton FOR UPDATE;
 IF p_expected_revision<0 OR coalesce(current_row.revision,0)<>p_expected_revision THEN RAISE EXCEPTION 'NATIVE_AGENT_CONFIG_REVISION_CONFLICT';END IF;
 PERFORM public.pub2_assert_json_keys(p_config,ARRAY['enabled','modelIds','allowedModelIds','maxCallsPerTurn','maxOutputTokens','maxInputBytes','maxCreditsPerTurn'],ARRAY['enabled','modelIds','allowedModelIds','maxCallsPerTurn','maxOutputTokens','maxInputBytes','maxCreditsPerTurn']);
 PERFORM public.pub2_assert_json_keys(p_config->'modelIds',ARRAY['default','background','think'],ARRAY['default','background','think']);
 IF jsonb_typeof(p_config->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_config->'allowedModelIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p_config->'allowedModelIds')>16 THEN RAISE EXCEPTION 'NATIVE_AGENT_CONFIG_INVALID';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_config->'allowedModelIds') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR x#>>'{}' !~ '^pm_[A-Za-z0-9_-]{24}$') OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_config->'allowedModelIds') x GROUP BY x HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_AGENT_CONFIG_INVALID';END IF;
 FOREACH k IN ARRAY ARRAY['default','background','think'] LOOP
  m:=p_config->'modelIds'->>k;
  IF p_config->'modelIds'->k IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(p_config->'modelIds'->k) IS DISTINCT FROM 'string' OR m !~ '^pm_[A-Za-z0-9_-]{24}$') THEN RAISE EXCEPTION 'NATIVE_AGENT_CONFIG_INVALID';END IF;
  IF p_config->'enabled'='true'::jsonb AND (m IS NULL OR NOT (p_config->'allowedModelIds' ? m)) THEN RAISE EXCEPTION 'NATIVE_AGENT_CONFIG_INVALID';END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['maxCallsPerTurn','maxOutputTokens','maxInputBytes'] LOOP
  IF jsonb_typeof(p_config->k) IS DISTINCT FROM 'number' OR p_config->>k !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'NATIVE_AGENT_CONFIG_INVALID';END IF;
 END LOOP;
 IF (p_config->>'maxCallsPerTurn')::numeric NOT BETWEEN 1 AND 24 OR (p_config->>'maxOutputTokens')::numeric NOT BETWEEN 512 AND 8192 OR (p_config->>'maxInputBytes')::numeric NOT BETWEEN 16384 AND 1048576 OR jsonb_typeof(p_config->'maxCreditsPerTurn') IS DISTINCT FROM 'string' OR p_config->>'maxCreditsPerTurn' !~ '^(0|[1-9][0-9]{0,11})\.[0-9]{6}$' OR (p_config->>'maxCreditsPerTurn')::numeric<=0 THEN RAISE EXCEPTION 'NATIVE_AGENT_CONFIG_INVALID';END IF;
 IF p_config_hash IS DISTINCT FROM encode(sha256(convert_to(public.pub_native_sdk_canonical(p_config),'UTF8')),'hex') THEN RAISE EXCEPTION 'NATIVE_AGENT_CONFIG_HASH_INVALID';END IF;
 INSERT INTO public.pub_native_agent_runtime_config(singleton,revision,config,config_hash,updated_by)
 VALUES(true,p_expected_revision+1,p_config,p_config_hash,p_actor::text)
 ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,config=EXCLUDED.config,config_hash=EXCLUDED.config_hash,updated_by=EXCLUDED.updated_by,updated_at=now()
 RETURNING * INTO current_row;
 RETURN to_jsonb(current_row);
END $$;
REVOKE ALL ON FUNCTION public.mutate_native_agent_runtime_config(uuid,bigint,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_native_agent_runtime_config(uuid,bigint,jsonb,text) TO service_role;

CREATE TABLE public.pub_native_agent_runtime_calls (
 owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 task_id uuid NOT NULL,
 turn_id uuid NOT NULL,
 call_id text NOT NULL CHECK(length(call_id) BETWEEN 1 AND 128 AND call_id~'^[A-Za-z0-9_.:-]+$'),
 kind text NOT NULL CHECK(kind IN ('model','tool')),
 input_hash text NOT NULL CHECK(input_hash~'^[a-f0-9]{64}$'),
 config_hash text NOT NULL CHECK(config_hash~'^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('started','succeeded','failed','unknown')),
 reserved_credits numeric(20,6) NOT NULL DEFAULT 0 CHECK(reserved_credits>=0),
 charged_credits numeric(20,6) NOT NULL DEFAULT 0 CHECK(charged_credits>=0),
 result jsonb CHECK(result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=2097152)),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,turn_id,call_id),
 FOREIGN KEY(owner_id,task_id,turn_id) REFERENCES public.pub_native_agent_turns(owner_id,task_id,id) ON DELETE CASCADE
);
CREATE INDEX pub_native_agent_runtime_calls_turn ON public.pub_native_agent_runtime_calls(owner_id,turn_id,created_at);
ALTER TABLE public.pub_native_agent_runtime_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pub_native_agent_runtime_calls FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.pub_native_agent_runtime_calls TO service_role;

CREATE TABLE public.pub_native_agent_runtime_sessions (
 owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 task_id uuid NOT NULL,
 turn_id uuid NOT NULL,
 session_id uuid NOT NULL,
 checkpoint_hash text NOT NULL CHECK(checkpoint_hash~'^[a-f0-9]{64}$'),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,task_id),
 FOREIGN KEY(owner_id,task_id,turn_id) REFERENCES public.pub_native_agent_turns(owner_id,task_id,id) ON DELETE CASCADE
);
ALTER TABLE public.pub_native_agent_runtime_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pub_native_agent_runtime_sessions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.pub_native_agent_runtime_sessions TO service_role;

CREATE FUNCTION public.mutate_native_agent_sdk(p_owner text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a text:=p->>'action'; t public.pub_native_agent_tasks%ROWTYPE; r public.pub_native_agent_turns%ROWTYPE;
 c public.pub_native_agent_runtime_calls%ROWTYPE; req jsonb; cfg jsonb; req_hash text; cfg_hash text; value jsonb;
 v_task_id uuid; v_turn_id uuid; n numeric; k text; next_state text; duplicate_event boolean;
 operator_config public.pub_native_agent_runtime_config%ROWTYPE;
BEGIN
 PERFORM public.pub_assert_actor(p_owner);
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>2200000 THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
 IF a='prepare' THEN
  PERFORM public.pub2_assert_json_keys(p,ARRAY['action','turnId','requestKey','request','config'],ARRAY['action','turnId','requestKey','request','config']);
  req:=p->'request';cfg:=p->'config';cfg_hash:=cfg->>'configHash';v_turn_id:=(p->>'turnId')::uuid;
  PERFORM public.pub2_assert_json_keys(req,ARRAY['taskId','expectedRevision','prompt','context','runtimeApproval'],ARRAY['taskId','expectedRevision','prompt','context','runtimeApproval']);
  IF jsonb_typeof(req->'prompt') IS DISTINCT FROM 'string' OR length(trim(req->>'prompt')) NOT BETWEEN 1 AND 24000 OR p->>'requestKey' !~ '^[A-Za-z0-9_.:-]{8,128}$' OR cfg_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
  req_hash:=encode(sha256(convert_to(public.pub_native_sdk_canonical(req),'UTF8')),'hex');
  SELECT * INTO r FROM public.pub_native_agent_turns WHERE owner_id=p_owner AND request_key=p->>'requestKey';
  IF FOUND THEN
   IF r.request_hash<>req_hash OR r.policy_snapshot->>'version'<>'native-agent-sdk.v1' THEN RAISE EXCEPTION 'NATIVE_AGENT_IDEMPOTENCY_CONFLICT';END IF;
   SELECT * INTO t FROM public.pub_native_agent_tasks WHERE owner_id=p_owner AND id=r.task_id;
   RETURN jsonb_build_object('task',to_jsonb(t),'turn',to_jsonb(r),'alreadyPrepared',true);
  END IF;
  SELECT * INTO operator_config FROM public.pub_native_agent_runtime_config WHERE singleton FOR SHARE;
  IF NOT FOUND OR operator_config.revision IS DISTINCT FROM (cfg->>'revision')::bigint OR operator_config.config_hash IS DISTINCT FROM cfg_hash OR operator_config.config->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'NATIVE_AGENT_CONFIG_REVISION_CONFLICT';END IF;
  PERFORM public.pub2_assert_json_keys(cfg,ARRAY['revision','configHash','roles','maxCallsPerTurn','maxOutputTokens','maxInputBytes','maxCreditsPerTurn'],ARRAY['revision','configHash','roles','maxCallsPerTurn','maxOutputTokens','maxInputBytes','maxCreditsPerTurn']);
  PERFORM public.pub2_assert_json_keys(cfg->'roles',ARRAY['default','background','think'],ARRAY['default','background','think']);
  FOREACH k IN ARRAY ARRAY['maxCallsPerTurn','maxOutputTokens','maxInputBytes','maxCreditsPerTurn'] LOOP
   IF cfg->k IS DISTINCT FROM operator_config.config->k THEN RAISE EXCEPTION 'NATIVE_AGENT_CONFIG_REVISION_CONFLICT';END IF;
  END LOOP;
  PERFORM public.pub2_assert_json_keys(req->'runtimeApproval',ARRAY['revision','configHash','maxCreditsPerTurn'],ARRAY['revision','configHash','maxCreditsPerTurn']);
  IF req->'runtimeApproval'->'revision' IS DISTINCT FROM cfg->'revision' OR req->'runtimeApproval'->'configHash' IS DISTINCT FROM cfg->'configHash' OR (req->'runtimeApproval'->>'maxCreditsPerTurn')::numeric IS DISTINCT FROM (cfg->>'maxCreditsPerTurn')::numeric THEN RAISE EXCEPTION 'NATIVE_AGENT_CONFIG_REVISION_CONFLICT';END IF;
  FOREACH k IN ARRAY ARRAY['default','background','think'] LOOP
   PERFORM public.pub2_assert_json_keys(cfg->'roles'->k,ARRAY['modelId','modelName'],ARRAY['modelId','modelName']);
   IF cfg->'roles'->k->'modelId' IS DISTINCT FROM operator_config.config->'modelIds'->k OR jsonb_typeof(cfg->'roles'->k->'modelName') IS DISTINCT FROM 'string' OR length(cfg->'roles'->k->>'modelName') NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'NATIVE_AGENT_CONFIG_REVISION_CONFLICT';END IF;
  END LOOP;
  IF req->'taskId'='null'::jsonb AND req->'expectedRevision'='null'::jsonb THEN
   v_task_id:=gen_random_uuid();INSERT INTO public.pub_native_agent_tasks(id,owner_id,title) VALUES(v_task_id,p_owner,left(trim(req->>'prompt'),100)) RETURNING * INTO t;
  ELSE
   v_task_id:=(req->>'taskId')::uuid;SELECT * INTO t FROM public.pub_native_agent_tasks WHERE owner_id=p_owner AND id=v_task_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AGENT_NOT_FOUND';END IF;
   IF jsonb_typeof(req->'expectedRevision') IS DISTINCT FROM 'number' OR req->>'expectedRevision' !~ '^[1-9][0-9]*$' OR t.revision IS DISTINCT FROM (req->>'expectedRevision')::integer OR t.archived THEN RAISE EXCEPTION 'NATIVE_AGENT_REVISION_CONFLICT';END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.pub_native_agent_turns x WHERE x.task_id=t.id AND x.state IN ('prepared','running','streaming','cancel_requested','unknown')) THEN RAISE EXCEPTION 'NATIVE_AGENT_ACTIVE_TURN';END IF;
  INSERT INTO public.pub_native_agent_turns(id,owner_id,task_id,request_key,request_hash,input_snapshot,policy_snapshot,model_public_id,main_request_key)
   VALUES(v_turn_id,p_owner,t.id,p->>'requestKey',req_hash,req,jsonb_build_object('version','native-agent-sdk.v1','config',cfg),cfg->'roles'->'default'->>'modelId','native-agent:'||v_turn_id::text||':sdk') RETURNING * INTO r;
  PERFORM public.pub_native_agent_event(p_owner,t.id,r.id,'user:0','user_message','user',jsonb_build_object('text',req->>'prompt'));
  UPDATE public.pub_native_agent_tasks SET status='running',revision=revision+1,updated_at=now() WHERE id=t.id RETURNING * INTO t;
  RETURN jsonb_build_object('task',to_jsonb(t),'turn',to_jsonb(r),'alreadyPrepared',false);
 END IF;

 v_turn_id:=(p->>'turnId')::uuid;
 SELECT * INTO r FROM public.pub_native_agent_turns WHERE owner_id=p_owner AND id=v_turn_id;
 IF NOT FOUND OR r.policy_snapshot->>'version' IS DISTINCT FROM 'native-agent-sdk.v1' THEN RAISE EXCEPTION 'NATIVE_AGENT_NOT_FOUND';END IF;
 SELECT * INTO t FROM public.pub_native_agent_tasks WHERE owner_id=p_owner AND id=r.task_id FOR UPDATE;
 SELECT * INTO r FROM public.pub_native_agent_turns WHERE owner_id=p_owner AND id=v_turn_id FOR UPDATE;
 IF r.lease_owner IS DISTINCT FROM (p->>'runnerId')::uuid THEN RAISE EXCEPTION 'NATIVE_AGENT_RUNNER_CHANGED';END IF;
 cfg:=r.policy_snapshot->'config';cfg_hash:=cfg->>'configHash';
 IF a='finish' AND r.state IN ('completed','failed','cancelled') THEN
  IF r.state IS DISTINCT FROM p->>'state' THEN RAISE EXCEPTION 'NATIVE_AGENT_TERMINAL_STATE';END IF;
  RETURN jsonb_build_object('state',r.state,'alreadyRecorded',true);
 END IF;
 IF a='freeze' THEN
  UPDATE public.pub_native_agent_runtime_calls SET state='unknown',updated_at=now() WHERE owner_id=p_owner AND turn_id=r.id AND state='started';
  IF r.state NOT IN ('completed','failed','cancelled') THEN
   UPDATE public.pub_native_agent_turns SET state='unknown',error_code='NATIVE_AGENT_SDK_UNRESOLVED',revision=revision+1,updated_at=now() WHERE id=r.id;
   UPDATE public.pub_native_agent_tasks SET status='unknown',revision=revision+1,updated_at=now() WHERE id=t.id;
   PERFORM public.pub_native_agent_event(p_owner,t.id,r.id,'sdk:unknown','status','system',jsonb_build_object('state','unknown'));
  END IF;
  RETURN jsonb_build_object('state','unknown');
 END IF;
 IF r.state NOT IN ('running','streaming') OR r.lease_expires_at<=now() THEN RAISE EXCEPTION 'NATIVE_AGENT_TERMINAL_STATE';END IF;
 UPDATE public.pub_native_agent_turns SET lease_expires_at=now()+interval '10 minutes' WHERE id=r.id;
 IF a='begin-call' THEN
  PERFORM public.pub2_assert_json_keys(p,ARRAY['action','turnId','runnerId','callId','kind','inputHash'],ARRAY['action','turnId','runnerId','callId','kind','inputHash']);
  IF p->>'kind' NOT IN ('model','tool') OR p->>'callId' !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p->>'inputHash' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
  SELECT * INTO c FROM public.pub_native_agent_runtime_calls WHERE owner_id=p_owner AND turn_id=r.id AND call_id=p->>'callId';
  IF FOUND THEN
   IF c.input_hash<>p->>'inputHash' OR c.kind<>p->>'kind' OR c.config_hash<>cfg_hash THEN RAISE EXCEPTION 'NATIVE_AGENT_IDEMPOTENCY_CONFLICT';END IF;
   IF c.state<>'succeeded' THEN RAISE EXCEPTION 'NATIVE_AGENT_ACTIVE_TURN';END IF;
   RETURN jsonb_build_object('replayed',true,'call',to_jsonb(c));
  END IF;
  IF EXISTS(SELECT 1 FROM public.pub_native_agent_runtime_calls WHERE owner_id=p_owner AND turn_id=r.id AND state IN ('started','unknown')) THEN RAISE EXCEPTION 'NATIVE_AGENT_ACTIVE_TURN';END IF;
  IF p->>'kind'='model' AND (SELECT count(*) FROM public.pub_native_agent_runtime_calls WHERE owner_id=p_owner AND turn_id=r.id AND kind='model') >= (cfg->>'maxCallsPerTurn')::integer THEN RAISE EXCEPTION 'NATIVE_AGENT_CALL_LIMIT';END IF;
  INSERT INTO public.pub_native_agent_runtime_calls(owner_id,task_id,turn_id,call_id,kind,input_hash,config_hash,state) VALUES(p_owner,t.id,r.id,p->>'callId',p->>'kind',p->>'inputHash',cfg_hash,'started') RETURNING * INTO c;
  RETURN jsonb_build_object('replayed',false,'call',to_jsonb(c));
 ELSIF a IN ('reserve-call','finish-call') THEN
  SELECT * INTO c FROM public.pub_native_agent_runtime_calls WHERE owner_id=p_owner AND turn_id=r.id AND call_id=p->>'callId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AGENT_NOT_FOUND';END IF;
  IF a='reserve-call' THEN
   n:=(p->>'amount')::numeric;
   IF c.state<>'started' OR c.kind<>'model' OR n<0 OR n>(cfg->>'maxCreditsPerTurn')::numeric OR scale(n)>6 THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
   IF c.reserved_credits<>0 AND c.reserved_credits<>n THEN RAISE EXCEPTION 'NATIVE_AGENT_IDEMPOTENCY_CONFLICT';END IF;
   IF n+coalesce((SELECT sum(CASE WHEN state='succeeded' THEN charged_credits ELSE reserved_credits END) FROM public.pub_native_agent_runtime_calls WHERE owner_id=p_owner AND turn_id=r.id AND call_id<>c.call_id),0)>(cfg->>'maxCreditsPerTurn')::numeric THEN RAISE EXCEPTION 'NATIVE_AGENT_BUDGET_EXCEEDED';END IF;
   UPDATE public.pub_native_agent_runtime_calls SET reserved_credits=n,updated_at=now() WHERE owner_id=p_owner AND turn_id=r.id AND call_id=c.call_id;
  ELSE
   value:=p->'result';n:=(p->>'chargedCredits')::numeric;
   IF n IS NULL THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
   IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR octet_length(value::text)>2097152 OR n<0 OR n>c.reserved_credits OR scale(n)>6 THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
   IF c.kind='model' AND NOT EXISTS(
    SELECT 1 FROM public.llm_request_attempts attempt JOIN public.llm_credit_reservations hold ON hold.record_id=attempt.record_id
    WHERE attempt.user_id=p_owner AND attempt.client_request_id=value->'receipt'->>'clientRequestId' AND attempt.state='succeeded'
     AND hold.user_id=p_owner AND hold.status='settled' AND hold.actual_amount=n AND hold.lease_token=attempt.lease_token
     AND hold.price_snapshot->'native_agent'->>'ownerId'=p_owner
     AND hold.price_snapshot->'native_agent'->>'taskId'=t.id::text
     AND hold.price_snapshot->'native_agent'->>'turnId'=r.id::text
     AND hold.price_snapshot->'native_agent'->>'callId'=c.call_id
     AND hold.price_snapshot->'native_agent'->>'configHash'=cfg_hash
     AND attempt.payload_fingerprint=value->'receipt'->>'requestHash'
     AND hold.price_snapshot->'native_agent'->>'requestHash'=value->'receipt'->>'requestHash'
     AND hold.receipt->>'operation_id'=value->'receipt'->>'operationId'
     AND attempt.response_fingerprint=encode(sha256(convert_to(attempt.response_body,'UTF8')),'hex')
     AND attempt.response_body::jsonb->'receipt' IS NOT DISTINCT FROM value->'receipt'
     AND attempt.response_body::jsonb->'delivery' IS NOT DISTINCT FROM value->'delivery'
   ) THEN RAISE EXCEPTION 'NATIVE_AGENT_BILLING_RECEIPT_REQUIRED';END IF;
   IF c.state='succeeded' THEN
    IF c.result IS DISTINCT FROM value OR c.charged_credits<>n THEN RAISE EXCEPTION 'NATIVE_AGENT_IDEMPOTENCY_CONFLICT';END IF;
   ELSIF c.state='started' THEN UPDATE public.pub_native_agent_runtime_calls SET state='succeeded',charged_credits=n,result=value,updated_at=now() WHERE owner_id=p_owner AND turn_id=r.id AND call_id=c.call_id;
   ELSE RAISE EXCEPTION 'NATIVE_AGENT_TERMINAL_STATE';END IF;
  END IF;
  RETURN jsonb_build_object('recorded',true);
 ELSIF a='event' THEN
  IF p->>'kind' NOT IN ('text_delta','assistant_message','tool_proposal','tool_result','status') OR NOT public.pub3_no_credentials(p->'payload') THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
  SELECT EXISTS(SELECT 1 FROM public.pub_native_agent_events WHERE owner_id=p_owner AND turn_id=r.id AND event_key=p->>'eventKey') INTO duplicate_event;
  value:=public.pub_native_agent_event(p_owner,t.id,r.id,p->>'eventKey',p->>'kind',CASE WHEN p->>'kind' LIKE 'tool_%' THEN 'tool' WHEN p->>'kind'='status' THEN 'system' ELSE 'model' END,p->'payload');
  IF p->>'kind'='text_delta' AND NOT duplicate_event THEN UPDATE public.pub_native_agent_turns SET response_text=response_text||coalesce(p->'payload'->>'text',''),state='streaming',revision=revision+1,updated_at=now() WHERE id=r.id;END IF;
  RETURN value;
 ELSIF a='save-session' THEN
  IF p->>'checkpointHash' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
  INSERT INTO public.pub_native_agent_runtime_sessions(owner_id,task_id,turn_id,session_id,checkpoint_hash) VALUES(p_owner,t.id,r.id,(p->>'sessionId')::uuid,p->>'checkpointHash')
  ON CONFLICT(owner_id,task_id) DO UPDATE SET turn_id=EXCLUDED.turn_id,session_id=EXCLUDED.session_id,checkpoint_hash=EXCLUDED.checkpoint_hash,updated_at=now();
  RETURN jsonb_build_object('saved',true);
 ELSIF a='finish' THEN
  next_state:=p->>'state';
  IF next_state NOT IN ('completed','failed','unknown','cancelled') THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
  IF next_state<>'unknown' AND EXISTS(SELECT 1 FROM public.pub_native_agent_runtime_calls WHERE owner_id=p_owner AND turn_id=r.id AND state IN ('started','unknown')) THEN RAISE EXCEPTION 'NATIVE_AGENT_ACTIVE_TURN';END IF;
  IF next_state='completed' AND (EXISTS(SELECT 1 FROM public.pub_native_agent_runtime_calls WHERE owner_id=p_owner AND turn_id=r.id AND state<>'succeeded') OR NOT EXISTS(SELECT 1 FROM public.pub_native_agent_runtime_sessions WHERE owner_id=p_owner AND task_id=t.id AND turn_id=r.id)) THEN RAISE EXCEPTION 'NATIVE_AGENT_ACTIVE_TURN';END IF;
  UPDATE public.pub_native_agent_turns SET state=next_state,revision=revision+1,updated_at=now() WHERE id=r.id;
  UPDATE public.pub_native_agent_tasks SET status=next_state,revision=revision+1,updated_at=now() WHERE id=t.id;
  PERFORM public.pub_native_agent_event(p_owner,t.id,r.id,'sdk:finish','status','system',jsonb_build_object('state',next_state));
  RETURN jsonb_build_object('state',next_state);
 END IF;
 RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';
END $$;
REVOKE ALL ON FUNCTION public.mutate_native_agent_sdk(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_native_agent_sdk(text,jsonb) TO service_role;

-- Legacy readers retain their immutable evidence. Only shared metadata, abort,
-- observation and the single prepared claim may operate on SDK turns.
ALTER FUNCTION public.mutate_native_agent_atomic(text,jsonb) RENAME TO mutate_native_agent_legacy_atomic;
REVOKE ALL ON FUNCTION public.mutate_native_agent_legacy_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.mutate_native_agent_atomic(p_owner text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sdk boolean;BEGIN
 PERFORM public.pub_assert_actor(p_owner);
 IF p?'turnId' THEN
  SELECT policy_snapshot->>'version'='native-agent-sdk.v1' INTO sdk FROM public.pub_native_agent_turns WHERE owner_id=p_owner AND id=(p->>'turnId')::uuid;
  IF sdk AND p->>'action' NOT IN ('claim-turn','observe-unknown') THEN RAISE EXCEPTION 'NATIVE_AGENT_SDK_LEGACY_DISPATCH_DENIED';END IF;
 END IF;
 RETURN public.mutate_native_agent_legacy_atomic(p_owner,p);
END $$;
REVOKE ALL ON FUNCTION public.mutate_native_agent_atomic(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_native_agent_atomic(text,jsonb) TO service_role;

CREATE TABLE public.pub_native_agent_wallet_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 prior_fingerprint text NOT NULL,
 policy_fingerprint text NOT NULL CHECK(policy_fingerprint~'^[a-f0-9]{64}$')
);
ALTER TABLE public.pub_native_agent_wallet_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pub_native_agent_wallet_policy FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.pub_native_agent_wallet_policy TO service_role;
DO $$
DECLARE original text;patched text;actual text;original_acl aclitem[];original_owner oid;BEGIN
 SELECT pg_get_functiondef(oid),proacl,proowner INTO original,original_acl,original_owner FROM pg_proc WHERE oid='public.recover_llm_credit_reservations_atomic(text)'::regprocedure;
 IF encode(sha256(convert_to(original,'UTF8')),'hex')<>'92485af5b003f80443230f044428342b0e4b11160c3a0f763473f0e936574448' OR pg_get_userbyid(original_owner)<>'zimeiti_owner' THEN RAISE EXCEPTION 'NATIVE_AGENT_WALLET_BASELINE_CHANGED';END IF;
 IF has_function_privilege('anon','public.recover_llm_credit_reservations_atomic(text)','EXECUTE') OR has_function_privilege('authenticated','public.recover_llm_credit_reservations_atomic(text)','EXECUTE') OR NOT has_function_privilege('service_role','public.recover_llm_credit_reservations_atomic(text)','EXECUTE') THEN RAISE EXCEPTION 'NATIVE_AGENT_WALLET_ACL_CHANGED';END IF;
 patched:=replace(original,'h.record_id=a.record_id AND h.status=''held''','h.record_id=a.record_id AND h.status=''held'' AND NOT (h.price_snapshot ? ''native_agent'')');
 patched:=replace(patched,'record_id=v_attempt.record_id AND status=''held''','record_id=v_attempt.record_id AND status=''held'' AND NOT (price_snapshot ? ''native_agent'')');
 IF patched=original OR position('NOT (h.price_snapshot ? ''native_agent'')' IN patched)=0 OR position('NOT (price_snapshot ? ''native_agent'')' IN patched)=0 THEN RAISE EXCEPTION 'NATIVE_AGENT_WALLET_PATCH_UNREVIEWED';END IF;
 EXECUTE patched;
 SELECT pg_get_functiondef(oid) INTO actual FROM pg_proc WHERE oid='public.recover_llm_credit_reservations_atomic(text)'::regprocedure;
 IF actual IS DISTINCT FROM patched OR (SELECT proacl IS DISTINCT FROM original_acl OR proowner IS DISTINCT FROM original_owner FROM pg_proc WHERE oid='public.recover_llm_credit_reservations_atomic(text)'::regprocedure) THEN RAISE EXCEPTION 'NATIVE_AGENT_WALLET_PATCH_MISMATCH';END IF;
 INSERT INTO public.pub_native_agent_wallet_policy(singleton,prior_fingerprint,policy_fingerprint) VALUES(true,encode(sha256(convert_to(original,'UTF8')),'hex'),encode(sha256(convert_to(actual,'UTF8')),'hex'));
END $$;
CREATE FUNCTION public.native_agent_reservation_safety() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE body text;guard public.pub_native_agent_wallet_policy%ROWTYPE;fingerprint text;BEGIN
 SELECT * INTO guard FROM public.pub_native_agent_wallet_policy WHERE singleton;
 SELECT pg_get_functiondef(oid) INTO body FROM pg_proc WHERE oid='public.recover_llm_credit_reservations_atomic(text)'::regprocedure AND pg_get_userbyid(proowner)='zimeiti_owner';
 fingerprint:=encode(sha256(convert_to(body,'UTF8')),'hex');
 IF guard.policy_fingerprint IS NULL OR fingerprint IS DISTINCT FROM guard.policy_fingerprint OR fingerprint=guard.prior_fingerprint OR position('NOT (h.price_snapshot ? ''native_agent'')' IN body)=0 OR position('NOT (price_snapshot ? ''native_agent'')' IN body)=0 THEN RAISE EXCEPTION 'NATIVE_AGENT_WALLET_POLICY_UNVERIFIED';END IF;
 IF has_function_privilege('anon','public.recover_llm_credit_reservations_atomic(text)','EXECUTE') OR has_function_privilege('authenticated','public.recover_llm_credit_reservations_atomic(text)','EXECUTE') OR NOT has_function_privilege('service_role','public.recover_llm_credit_reservations_atomic(text)','EXECUTE') THEN RAISE EXCEPTION 'NATIVE_AGENT_WALLET_ACL_CHANGED';END IF;
 RETURN jsonb_build_object('policy','native-agent-unknown-hold.v1','databaseVerified',true,'preservesUnknownHolds',true,'preservesExpiredProviderHolds',true,'policyFingerprint',fingerprint);
END $$;
REVOKE ALL ON FUNCTION public.native_agent_reservation_safety() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.native_agent_reservation_safety() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
