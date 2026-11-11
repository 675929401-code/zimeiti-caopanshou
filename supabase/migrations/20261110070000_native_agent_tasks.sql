BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';

CREATE TABLE public.pub_native_agent_tasks (
 id uuid PRIMARY KEY,
 owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
 status text NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','completed','failed','unknown','cancel_requested','cancelled')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 next_seq bigint NOT NULL DEFAULT 0 CHECK(next_seq>=0),
 archived boolean NOT NULL DEFAULT false,
 favorited_at timestamptz,
 rating integer CHECK(rating BETWEEN 1 AND 5),
 rating_comment text NOT NULL DEFAULT '' CHECK(length(rating_comment)<=1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id)
);
CREATE TABLE public.pub_native_agent_turns (
 id uuid PRIMARY KEY,
 owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 task_id uuid NOT NULL,
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128 AND request_key~'^[A-Za-z0-9_.:-]+$'),
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 input_snapshot jsonb NOT NULL CHECK(jsonb_typeof(input_snapshot)='object' AND octet_length(input_snapshot::text)<=262144),
 policy_snapshot jsonb NOT NULL CHECK(jsonb_typeof(policy_snapshot)='object' AND octet_length(policy_snapshot::text)<=65536),
 model_public_id text NOT NULL CHECK(length(model_public_id) BETWEEN 1 AND 160),
 main_request_key text NOT NULL,
 main_attempt_id text CHECK(main_attempt_id~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','running','streaming','completed','failed','unknown','cancel_requested','cancelled')),
 response_text text NOT NULL DEFAULT '' CHECK(octet_length(response_text)<=1048576),
 error_code text CHECK(length(error_code)<=100 AND error_code~'^[A-Z0-9_:.-]+$'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 lease_owner uuid,
 lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,request_key),
 UNIQUE(owner_id,id),
 UNIQUE(owner_id,task_id,id),
 FOREIGN KEY(owner_id,task_id) REFERENCES public.pub_native_agent_tasks(owner_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX pub_native_agent_one_active_turn ON public.pub_native_agent_turns(task_id)
 WHERE state IN ('prepared','running','streaming','cancel_requested','unknown');
CREATE TABLE public.pub_native_agent_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 task_id uuid NOT NULL,
 turn_id uuid NOT NULL,
 seq bigint NOT NULL CHECK(seq>0),
 event_key text NOT NULL CHECK(length(event_key) BETWEEN 1 AND 160 AND event_key~'^[A-Za-z0-9_.:-]+$'),
 kind text NOT NULL CHECK(kind IN ('user_message','turn_started','text_delta','assistant_message','tool_proposal','tool_result','status','error','abort_requested')),
 source text NOT NULL CHECK(source IN ('user','system','model','tool')),
 safe_payload jsonb NOT NULL CHECK(jsonb_typeof(safe_payload)='object' AND octet_length(safe_payload::text)<=65536),
 payload_hash text NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,seq),
 UNIQUE(turn_id,event_key),
 FOREIGN KEY(owner_id,task_id,turn_id) REFERENCES public.pub_native_agent_turns(owner_id,task_id,id) ON DELETE CASCADE
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pub_native_agent_tasks','pub_native_agent_turns','pub_native_agent_events'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',t);
  EXECUTE format('CREATE INDEX %I ON public.%I(owner_id,created_at DESC)',t||'_owner_created',t);
 END LOOP;
END $$;

CREATE FUNCTION public.pub_native_agent_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.users WHERE id=OLD.owner_id) THEN RAISE EXCEPTION 'NATIVE_AGENT_HISTORY_IMMUTABLE';END IF;
  RETURN OLD;
 END IF;
 IF TG_TABLE_NAME='pub_native_agent_events' THEN RAISE EXCEPTION 'NATIVE_AGENT_HISTORY_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='pub_native_agent_turns' AND
   (NEW.id,NEW.owner_id,NEW.task_id,NEW.request_key,NEW.request_hash,NEW.input_snapshot,NEW.policy_snapshot,NEW.model_public_id,NEW.main_request_key,NEW.created_at)
   IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.task_id,OLD.request_key,OLD.request_hash,OLD.input_snapshot,OLD.policy_snapshot,OLD.model_public_id,OLD.main_request_key,OLD.created_at)
 THEN RAISE EXCEPTION 'NATIVE_AGENT_HISTORY_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='pub_native_agent_turns' AND OLD.main_attempt_id IS NOT NULL AND NEW.main_attempt_id IS DISTINCT FROM OLD.main_attempt_id THEN RAISE EXCEPTION 'NATIVE_AGENT_HISTORY_IMMUTABLE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pub_native_agent_turn_history BEFORE UPDATE OR DELETE ON public.pub_native_agent_turns FOR EACH ROW EXECUTE FUNCTION public.pub_native_agent_immutable();
CREATE TRIGGER pub_native_agent_event_history BEFORE UPDATE OR DELETE ON public.pub_native_agent_events FOR EACH ROW EXECUTE FUNCTION public.pub_native_agent_immutable();

CREATE FUNCTION public.pub_native_agent_no_credentials(p jsonb,p_depth integer DEFAULT 0) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE e record;v jsonb;BEGIN
 IF p IS NULL OR p_depth>20 OR octet_length(p::text)>2097152 THEN RETURN false;END IF;
 IF jsonb_typeof(p)='object' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p))>200 THEN RETURN false;END IF;
  FOR e IN SELECT * FROM jsonb_each(p) LOOP
   IF e.key IN ('__proto__','constructor','prototype') THEN RETURN false;END IF;
   IF e.key ~* '(cookie|token|secret|password|authorization|credential|api.?key|upload.?url|continuation|headers)' AND NOT (e.key IN ('maxReplyTokens','max_reply_tokens','max_context_tokens') AND jsonb_typeof(e.value)='number') THEN RETURN false;END IF;
   IF NOT public.pub_native_agent_no_credentials(e.value,p_depth+1) THEN RETURN false;END IF;
  END LOOP;
 ELSIF jsonb_typeof(p)='array' THEN
  IF jsonb_array_length(p)>200 THEN RETURN false;END IF;
  FOR v IN SELECT * FROM jsonb_array_elements(p) LOOP IF NOT public.pub_native_agent_no_credentials(v,p_depth+1) THEN RETURN false;END IF;END LOOP;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.pub_native_agent_no_credentials(jsonb,integer) FROM PUBLIC,anon,authenticated,service_role;

-- Internal helper is not executable by API roles. All callers hold actor then task locks.
CREATE FUNCTION public.pub_native_agent_event(p_owner text,p_task uuid,p_turn uuid,p_key text,p_kind text,p_source text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE prior public.pub_native_agent_events%ROWTYPE; inserted public.pub_native_agent_events%ROWTYPE; next_sequence bigint; h text; BEGIN
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR NOT public.pub3_no_credentials(p_payload) OR octet_length(p_payload::text)>65536 THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
 h:=encode(sha256(convert_to(jsonb_build_object('kind',p_kind,'source',p_source,'payload',p_payload)::text,'UTF8')),'hex');
 SELECT * INTO prior FROM public.pub_native_agent_events WHERE turn_id=p_turn AND event_key=p_key;
 IF FOUND THEN
  IF prior.owner_id IS DISTINCT FROM p_owner OR prior.task_id IS DISTINCT FROM p_task OR prior.payload_hash IS DISTINCT FROM h THEN RAISE EXCEPTION 'NATIVE_AGENT_IDEMPOTENCY_CONFLICT';END IF;
  RETURN to_jsonb(prior);
 END IF;
 UPDATE public.pub_native_agent_tasks SET next_seq=next_seq+1 WHERE id=p_task AND owner_id=p_owner RETURNING next_seq INTO next_sequence;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.pub_native_agent_turns WHERE id=p_turn AND owner_id=p_owner AND task_id=p_task) THEN RAISE EXCEPTION 'NATIVE_AGENT_NOT_FOUND';END IF;
 INSERT INTO public.pub_native_agent_events(owner_id,task_id,turn_id,seq,event_key,kind,source,safe_payload,payload_hash)
 VALUES(p_owner,p_task,p_turn,next_sequence,p_key,p_kind,p_source,p_payload,h) RETURNING * INTO inserted;
 RETURN to_jsonb(inserted);
END $$;
REVOKE ALL ON FUNCTION public.pub_native_agent_event(text,uuid,uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.pub_native_agent_assert_policy(p jsonb,request jsonb,turn_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r jsonb;m jsonb; k text;BEGIN
 PERFORM public.pub2_assert_json_keys(p,ARRAY['version','billingMode','modelPublicId','maxReplyTokens','maxToolRounds','mainRequest'],ARRAY['version','billingMode','modelPublicId','maxReplyTokens','maxToolRounds','mainRequest']);
 IF p->>'version' IS DISTINCT FROM 'native-agent-policy.v1' OR p->>'billingMode' IS DISTINCT FROM 'main_actual_usage' OR p->>'modelPublicId' IS DISTINCT FROM request->>'modelId' OR p->>'modelPublicId' !~ '^pm_[A-Za-z0-9_-]+$' THEN RAISE EXCEPTION 'NATIVE_AGENT_POLICY_INVALID';END IF;
 FOREACH k IN ARRAY ARRAY['maxReplyTokens','maxToolRounds'] LOOP IF jsonb_typeof(p->k) IS DISTINCT FROM 'number' OR p->>k !~ '^[0-9]+$' THEN RAISE EXCEPTION 'NATIVE_AGENT_POLICY_INVALID';END IF;END LOOP;
 IF (p->>'maxReplyTokens')::numeric NOT BETWEEN 1 AND 8192 OR (p->>'maxToolRounds')::numeric NOT BETWEEN 0 AND 4 THEN RAISE EXCEPTION 'NATIVE_AGENT_POLICY_INVALID';END IF;
 r:=p->'mainRequest';
 PERFORM public.pub2_assert_json_keys(r,ARRAY['agentId','modelId','model_overridden','stream','max_reply_tokens','max_context_rounds','max_context_tokens','client_request_id','messages'],ARRAY['agentId','modelId','model_overridden','stream','max_reply_tokens','max_context_rounds','max_context_tokens','client_request_id','messages']);
 IF r->>'agentId' IS DISTINCT FROM '__free_chat__' OR r->>'modelId' IS DISTINCT FROM request->>'modelId' OR r->'model_overridden' IS DISTINCT FROM 'true'::jsonb OR r->'stream' IS DISTINCT FROM 'true'::jsonb OR r->>'client_request_id' IS DISTINCT FROM 'native-agent:'||turn_id::text||':llm:0' OR r->'max_reply_tokens' IS DISTINCT FROM p->'maxReplyTokens' THEN RAISE EXCEPTION 'NATIVE_AGENT_POLICY_INVALID';END IF;
 FOREACH k IN ARRAY ARRAY['max_context_rounds','max_context_tokens'] LOOP IF jsonb_typeof(r->k) IS DISTINCT FROM 'number' OR r->>k !~ '^[0-9]+$' THEN RAISE EXCEPTION 'NATIVE_AGENT_POLICY_INVALID';END IF;END LOOP;
 IF (r->>'max_context_rounds')::numeric NOT BETWEEN 0 AND 8 OR (r->>'max_context_tokens')::numeric NOT BETWEEN 1 AND 32768 OR jsonb_typeof(r->'messages') IS DISTINCT FROM 'array' OR jsonb_array_length(r->'messages') NOT BETWEEN 1 AND 24 OR octet_length((r->'messages')::text)>196608 THEN RAISE EXCEPTION 'NATIVE_AGENT_POLICY_INVALID';END IF;
 FOR m IN SELECT * FROM jsonb_array_elements(r->'messages') LOOP
  PERFORM public.pub2_assert_json_keys(m,ARRAY['role','content'],ARRAY['role','content']);
  IF jsonb_typeof(m->'role') IS DISTINCT FROM 'string' OR m->>'role' NOT IN ('system','user','assistant') OR jsonb_typeof(m->'content') IS DISTINCT FROM 'string' OR length(m->>'content')>50000 THEN RAISE EXCEPTION 'NATIVE_AGENT_POLICY_INVALID';END IF;
 END LOOP;
 IF r->'messages'->-1->>'role' IS DISTINCT FROM 'user' OR r->'messages'->-1->>'content' IS DISTINCT FROM request->>'prompt' THEN RAISE EXCEPTION 'NATIVE_AGENT_POLICY_INVALID';END IF;
END $$;
REVOKE ALL ON FUNCTION public.pub_native_agent_assert_policy(jsonb,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.mutate_native_agent_atomic(p_owner text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a text:=p->>'action'; required text[]; optional text[]:=ARRAY[]::text[]; k text;
 task public.pub_native_agent_tasks%ROWTYPE; turn public.pub_native_agent_turns%ROWTYPE;
 v_task_id uuid; v_turn_id uuid; fingerprint text; snap jsonb; value jsonb; inserted boolean; next_state text;
BEGIN
 PERFORM public.pub_assert_actor(p_owner);
 CASE a
 WHEN 'prepare-turn' THEN required:=ARRAY['action','turnId','requestKey','request','policy'];
 WHEN 'claim-turn' THEN required:=ARRAY['action','turnId','runnerId'];
 WHEN 'cancel-before-main' THEN required:=ARRAY['action','turnId','runnerId'];
 WHEN 'append-text' THEN required:=ARRAY['action','turnId','runnerId','eventKey','text'];
 WHEN 'finish-turn' THEN required:=ARRAY['action','turnId','runnerId','state','eventKey'];optional:=ARRAY['errorCode','mainAttemptId'];
 WHEN 'observe-unknown' THEN required:=ARRAY['action','turnId','expectedRevision'];
 WHEN 'rename' THEN required:=ARRAY['action','taskId','expectedRevision','title'];
 WHEN 'archive' THEN required:=ARRAY['action','taskId','expectedRevision','archived'];
 WHEN 'favorite' THEN required:=ARRAY['action','taskId','expectedRevision','favorite'];
 WHEN 'rate' THEN required:=ARRAY['action','taskId','expectedRevision','rating','comment'];
 WHEN 'abort' THEN required:=ARRAY['action','taskId','expectedRevision'];
 ELSE RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';
 END CASE;
 PERFORM public.pub2_assert_json_keys(p,required||optional,required);
 IF EXISTS(SELECT 1 FROM jsonb_each(p) AS entry WHERE entry.value='null'::jsonb) OR NOT public.pub_native_agent_no_credentials(p) THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
 FOREACH k IN ARRAY ARRAY['turnId','taskId','runnerId','proposalId'] LOOP
  IF p?k AND (jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR p->>k !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
 END LOOP;
 IF p?'mainAttemptId' AND (jsonb_typeof(p->'mainAttemptId') IS DISTINCT FROM 'string' OR p->>'mainAttemptId' !~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
 IF p?'expectedRevision' AND (jsonb_typeof(p->'expectedRevision') IS DISTINCT FROM 'number' OR p->>'expectedRevision' !~ '^[1-9][0-9]*$' OR (p->>'expectedRevision')::numeric>2147483647) THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
 FOREACH k IN ARRAY ARRAY['requestKey','eventKey','toolCallId'] LOOP
  IF p?k AND (jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR length(p->>k) NOT BETWEEN (CASE WHEN k='requestKey' THEN 8 ELSE 1 END) AND (CASE WHEN k='eventKey' THEN 160 ELSE 128 END) OR p->>k !~ '^[A-Za-z0-9_.:-]+$') THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
 END LOOP;

 IF a='prepare-turn' THEN
  snap:=p->'request';
  PERFORM public.pub2_assert_json_keys(snap,ARRAY['taskId','expectedRevision','prompt','modelId','context'],ARRAY['taskId','expectedRevision','prompt','modelId','context']);
  IF jsonb_typeof(snap->'prompt') IS DISTINCT FROM 'string' OR length(trim(snap->>'prompt')) NOT BETWEEN 1 AND 24000 OR jsonb_typeof(snap->'modelId') IS DISTINCT FROM 'string' OR length(snap->>'modelId') NOT BETWEEN 1 AND 160 OR snap->>'modelId' !~ '^[A-Za-z0-9_.:-]+$' THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
  PERFORM public.pub2_assert_json_keys(snap->'context',ARRAY['accountIds','collectionIds','draftIds','assetIds'],ARRAY['accountIds','collectionIds','draftIds','assetIds']);
  FOREACH k IN ARRAY ARRAY['accountIds','collectionIds','draftIds','assetIds'] LOOP
   IF jsonb_typeof(snap->'context'->k) IS DISTINCT FROM 'array' OR jsonb_array_length(snap->'context'->k)>30 OR EXISTS(SELECT 1 FROM jsonb_array_elements(snap->'context'->k) v WHERE jsonb_typeof(v) IS DISTINCT FROM 'string' OR v#>>'{}' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') OR EXISTS(SELECT 1 FROM jsonb_array_elements(snap->'context'->k) v GROUP BY v HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(snap->'context'->'accountIds') x WHERE NOT EXISTS(SELECT 1 FROM public.pub_accounts WHERE id=x::uuid AND user_id=p_owner) AND NOT EXISTS(SELECT 1 FROM public.pub3_account_bindings WHERE id=x::uuid AND owner_id=p_owner))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(snap->'context'->'collectionIds') x WHERE NOT EXISTS(SELECT 1 FROM public.pub2_collections WHERE id=x::uuid AND user_id=p_owner))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(snap->'context'->'draftIds') x WHERE NOT EXISTS(SELECT 1 FROM public.pub2_drafts WHERE id=x::uuid AND user_id=p_owner))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(snap->'context'->'assetIds') x WHERE NOT EXISTS(SELECT 1 FROM public.pub3_assets WHERE id=x::uuid AND owner_id=p_owner)) THEN RAISE EXCEPTION 'NATIVE_AGENT_RESOURCE_SCOPE_INVALID';END IF;
  IF jsonb_typeof(p->'policy') IS DISTINCT FROM 'object' OR octet_length((p->'policy')::text)>65536 THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
  fingerprint:=encode(sha256(convert_to(snap::text,'UTF8')),'hex');
  SELECT * INTO turn FROM public.pub_native_agent_turns WHERE owner_id=p_owner AND request_key=p->>'requestKey';
  IF FOUND THEN IF turn.request_hash IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'NATIVE_AGENT_IDEMPOTENCY_CONFLICT';END IF;SELECT * INTO task FROM public.pub_native_agent_tasks WHERE owner_id=p_owner AND id=turn.task_id;RETURN jsonb_build_object('task',to_jsonb(task),'turn',to_jsonb(turn),'alreadyPrepared',true);END IF;
  IF snap->'taskId'='null'::jsonb AND snap->'expectedRevision'='null'::jsonb THEN
   v_task_id:=gen_random_uuid();
   INSERT INTO public.pub_native_agent_tasks(id,owner_id,title) VALUES(v_task_id,p_owner,left(trim(snap->>'prompt'),100)) RETURNING * INTO task;
  ELSE
   IF jsonb_typeof(snap->'taskId') IS DISTINCT FROM 'string' OR snap->>'taskId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR jsonb_typeof(snap->'expectedRevision') IS DISTINCT FROM 'number' OR snap->>'expectedRevision' !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
   v_task_id:=(snap->>'taskId')::uuid;
   SELECT * INTO task FROM public.pub_native_agent_tasks WHERE owner_id=p_owner AND id=v_task_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AGENT_NOT_FOUND';END IF;
   IF task.revision::numeric IS DISTINCT FROM (snap->>'expectedRevision')::numeric OR task.archived THEN RAISE EXCEPTION 'NATIVE_AGENT_REVISION_CONFLICT';END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.pub_native_agent_turns WHERE task_id=task.id AND state IN ('prepared','running','streaming','cancel_requested','unknown')) THEN RAISE EXCEPTION 'NATIVE_AGENT_ACTIVE_TURN';END IF;
  v_turn_id:=(p->>'turnId')::uuid;
  PERFORM public.pub_native_agent_assert_policy(p->'policy',snap,v_turn_id);
  INSERT INTO public.pub_native_agent_turns(id,owner_id,task_id,request_key,request_hash,input_snapshot,policy_snapshot,model_public_id,main_request_key)
   VALUES(v_turn_id,p_owner,task.id,p->>'requestKey',fingerprint,snap,p->'policy',snap->>'modelId','native-agent:'||v_turn_id::text||':llm:0') RETURNING * INTO turn;
  value:=public.pub_native_agent_event(p_owner,task.id,turn.id,'user:0','user_message','user',jsonb_build_object('text',snap->>'prompt'));
  UPDATE public.pub_native_agent_tasks SET status='running',revision=revision+1,updated_at=now() WHERE id=task.id RETURNING * INTO task;
  RETURN jsonb_build_object('task',to_jsonb(task),'turn',to_jsonb(turn),'event',value,'alreadyPrepared',false);
 END IF;

 IF p?'turnId' THEN
  SELECT * INTO turn FROM public.pub_native_agent_turns WHERE id=(p->>'turnId')::uuid AND owner_id=p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AGENT_NOT_FOUND';END IF;
  v_turn_id:=turn.id;v_task_id:=turn.task_id;
 ELSE v_task_id:=(p->>'taskId')::uuid;END IF;
 SELECT * INTO task FROM public.pub_native_agent_tasks WHERE id=v_task_id AND owner_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AGENT_NOT_FOUND';END IF;
 IF v_turn_id IS NOT NULL THEN SELECT * INTO turn FROM public.pub_native_agent_turns WHERE id=v_turn_id AND owner_id=p_owner AND task_id=task.id FOR UPDATE;END IF;

 IF a IN ('rename','archive','favorite','rate','abort') THEN
  IF task.revision IS DISTINCT FROM (p->>'expectedRevision')::integer THEN RAISE EXCEPTION 'NATIVE_AGENT_REVISION_CONFLICT';END IF;
  IF a='rename' AND (jsonb_typeof(p->'title') IS DISTINCT FROM 'string' OR length(trim(p->>'title')) NOT BETWEEN 1 AND 100) OR a='archive' AND jsonb_typeof(p->'archived') IS DISTINCT FROM 'boolean' OR a='favorite' AND jsonb_typeof(p->'favorite') IS DISTINCT FROM 'boolean' OR a='rate' AND (jsonb_typeof(p->'rating') IS DISTINCT FROM 'number' OR p->>'rating' !~ '^[1-5]$' OR jsonb_typeof(p->'comment') IS DISTINCT FROM 'string' OR length(p->>'comment')>1000) THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
  IF a='abort' THEN
   SELECT * INTO turn FROM public.pub_native_agent_turns WHERE task_id=task.id AND owner_id=p_owner AND state IN ('prepared','running','streaming','cancel_requested','unknown') FOR UPDATE;
   IF FOUND THEN
    -- An acknowledged request is not evidence that dispatched work stopped.
    UPDATE public.pub_native_agent_turns SET state=CASE WHEN state='prepared' THEN 'cancelled' WHEN state IN ('unknown','cancel_requested') THEN state ELSE 'cancel_requested' END,revision=revision+1,updated_at=now() WHERE id=turn.id RETURNING * INTO turn;
    PERFORM public.pub_native_agent_event(p_owner,task.id,turn.id,'abort:'||(turn.revision::text),'abort_requested','user',jsonb_build_object('state',turn.state));
   END IF;
  END IF;
  UPDATE public.pub_native_agent_tasks SET
   title=CASE WHEN a='rename' THEN trim(p->>'title') ELSE title END,
   archived=CASE WHEN a='archive' THEN (p->>'archived')::boolean ELSE archived END,
   favorited_at=CASE WHEN a='favorite' THEN CASE WHEN (p->>'favorite')::boolean THEN coalesce(favorited_at,now()) ELSE NULL END ELSE favorited_at END,
   rating=CASE WHEN a='rate' THEN (p->>'rating')::integer ELSE rating END,
   rating_comment=CASE WHEN a='rate' THEN p->>'comment' ELSE rating_comment END,
   status=CASE WHEN a='abort' AND turn.id IS NOT NULL THEN turn.state ELSE status END,
   revision=revision+1,updated_at=now() WHERE id=task.id RETURNING * INTO task;
  RETURN jsonb_build_object('task',to_jsonb(task),'turn',CASE WHEN turn.id IS NULL THEN NULL ELSE to_jsonb(turn) END);
 ELSIF a='claim-turn' THEN
  IF turn.state<>'prepared' THEN RETURN jsonb_build_object('turn',to_jsonb(turn),'shouldExecute',false);END IF;
  UPDATE public.pub_native_agent_turns SET state='running',lease_owner=(p->>'runnerId')::uuid,lease_expires_at=now()+interval '10 minutes',revision=revision+1,updated_at=now() WHERE id=turn.id RETURNING * INTO turn;
  value:=public.pub_native_agent_event(p_owner,task.id,turn.id,'start:0','turn_started','system',jsonb_build_object('state','running','mainRequestKey',turn.main_request_key));
  RETURN jsonb_build_object('turn',to_jsonb(turn),'event',value,'shouldExecute',true);
 ELSIF a='cancel-before-main' THEN
  IF turn.lease_owner IS DISTINCT FROM (p->>'runnerId')::uuid THEN RAISE EXCEPTION 'NATIVE_AGENT_RUNNER_CHANGED';END IF;
  IF turn.state='cancel_requested' AND NOT EXISTS(SELECT 1 FROM public.llm_request_attempts WHERE user_id=p_owner AND client_request_id=turn.main_request_key) THEN
   UPDATE public.pub_native_agent_turns SET state='cancelled',revision=revision+1,updated_at=now() WHERE id=turn.id RETURNING * INTO turn;
   UPDATE public.pub_native_agent_tasks SET status='cancelled',revision=revision+1,updated_at=now() WHERE id=task.id RETURNING * INTO task;
   value:=public.pub_native_agent_event(p_owner,task.id,turn.id,'cancel:before-main','status','system',jsonb_build_object('state','cancelled','reason','MAIN_HANDLER_NOT_STARTED'));
   RETURN jsonb_build_object('task',to_jsonb(task),'turn',to_jsonb(turn),'event',value,'cancelled',true);
  END IF;
  RETURN jsonb_build_object('turn',to_jsonb(turn),'cancelled',false,'shouldExecute',false);
 ELSIF a='observe-unknown' THEN
  IF turn.revision IS DISTINCT FROM (p->>'expectedRevision')::integer THEN RAISE EXCEPTION 'NATIVE_AGENT_REVISION_CONFLICT';END IF;
  IF turn.state IN ('running','streaming','cancel_requested') AND turn.lease_expires_at<=now() THEN
   UPDATE public.pub_native_agent_turns SET state='unknown',error_code='RUNNER_OBSERVATION_LOST',revision=revision+1,updated_at=now() WHERE id=turn.id RETURNING * INTO turn;
   UPDATE public.pub_native_agent_tasks SET status='unknown',revision=revision+1,updated_at=now() WHERE id=task.id;
   PERFORM public.pub_native_agent_event(p_owner,task.id,turn.id,'unknown:'||turn.revision::text,'status','system',jsonb_build_object('state','unknown'));
  END IF;
  RETURN jsonb_build_object('turn',to_jsonb(turn),'shouldExecute',false);
 ELSIF a IN ('append-text','finish-turn') THEN
  IF turn.lease_owner IS DISTINCT FROM (p->>'runnerId')::uuid THEN RAISE EXCEPTION 'NATIVE_AGENT_RUNNER_CHANGED';END IF;
  IF a='append-text' THEN
   IF jsonb_typeof(p->'text') IS DISTINCT FROM 'string' OR octet_length(p->>'text') NOT BETWEEN 1 AND 16000 THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
   SELECT EXISTS(SELECT 1 FROM public.pub_native_agent_events WHERE turn_id=turn.id AND event_key=p->>'eventKey') INTO inserted;
   IF NOT inserted AND turn.state NOT IN ('running','streaming','cancel_requested','unknown') THEN RAISE EXCEPTION 'NATIVE_AGENT_TERMINAL_STATE';END IF;
   value:=public.pub_native_agent_event(p_owner,task.id,turn.id,p->>'eventKey','text_delta','model',jsonb_build_object('text',p->>'text'));
   IF NOT inserted THEN UPDATE public.pub_native_agent_turns SET response_text=response_text||(p->>'text'),state=CASE WHEN state IN ('cancel_requested','unknown') THEN state ELSE 'streaming' END,lease_expires_at=now()+interval '10 minutes',revision=revision+1,updated_at=now() WHERE id=turn.id RETURNING * INTO turn;END IF;
   RETURN jsonb_build_object('turn',to_jsonb(turn),'event',value,'alreadyRecorded',inserted);
  ELSIF a='finish-turn' THEN
   next_state:=p->>'state';
   IF next_state NOT IN ('completed','failed','unknown','cancelled') OR jsonb_typeof(p->'state') IS DISTINCT FROM 'string' OR p?'errorCode' AND (jsonb_typeof(p->'errorCode') IS DISTINCT FROM 'string' OR length(p->>'errorCode') NOT BETWEEN 1 AND 100 OR p->>'errorCode' !~ '^[A-Z0-9_:.-]+$') THEN RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';END IF;
   IF turn.state IN ('completed','failed','cancelled') THEN IF turn.state=next_state THEN RETURN jsonb_build_object('turn',to_jsonb(turn),'alreadyRecorded',true);END IF;RAISE EXCEPTION 'NATIVE_AGENT_TERMINAL_STATE';END IF;
   IF turn.state NOT IN ('running','streaming','cancel_requested','unknown') THEN RAISE EXCEPTION 'NATIVE_AGENT_TERMINAL_STATE';END IF;
   IF p?'mainAttemptId' AND NOT EXISTS(SELECT 1 FROM public.llm_request_attempts WHERE record_id=p->>'mainAttemptId' AND user_id=p_owner AND client_request_id=turn.main_request_key) THEN RAISE EXCEPTION 'NATIVE_AGENT_MAIN_ATTEMPT_INVALID';END IF;
   IF next_state='completed' AND NOT EXISTS(SELECT 1 FROM public.llm_request_attempts WHERE record_id=coalesce(p->>'mainAttemptId',turn.main_attempt_id) AND user_id=p_owner AND client_request_id=turn.main_request_key AND state='succeeded') THEN RAISE EXCEPTION 'NATIVE_AGENT_MAIN_ATTEMPT_UNVERIFIED';END IF;
   IF next_state IN ('failed','cancelled') AND NOT EXISTS(SELECT 1 FROM public.llm_request_attempts WHERE record_id=coalesce(p->>'mainAttemptId',turn.main_attempt_id) AND user_id=p_owner AND client_request_id=turn.main_request_key AND state='failed') THEN RAISE EXCEPTION 'NATIVE_AGENT_MAIN_ATTEMPT_UNVERIFIED';END IF;
   IF next_state='cancelled' AND turn.state<>'cancel_requested' THEN RAISE EXCEPTION 'NATIVE_AGENT_TERMINAL_STATE';END IF;
   UPDATE public.pub_native_agent_turns SET state=next_state,error_code=p->>'errorCode',main_attempt_id=coalesce(p->>'mainAttemptId',main_attempt_id),revision=revision+1,updated_at=now() WHERE id=turn.id RETURNING * INTO turn;
   UPDATE public.pub_native_agent_tasks SET status=next_state,revision=revision+1,updated_at=now() WHERE id=task.id RETURNING * INTO task;
   value:=public.pub_native_agent_event(p_owner,task.id,turn.id,p->>'eventKey','status','system',jsonb_build_object('state',next_state,'errorCode',turn.error_code));
   RETURN jsonb_build_object('task',to_jsonb(task),'turn',to_jsonb(turn),'event',value,'alreadyRecorded',false);
  END IF;
 END IF;
 RAISE EXCEPTION 'NATIVE_AGENT_INPUT_INVALID';
END $$;
REVOKE ALL ON FUNCTION public.mutate_native_agent_atomic(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_native_agent_atomic(text,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.pub_native_agent_immutable() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
