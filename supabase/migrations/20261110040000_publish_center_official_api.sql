BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
CREATE TABLE public.pub3_auth_sessions(id uuid PRIMARY KEY,owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,connection_id text NOT NULL,platform text NOT NULL CHECK(platform='douyin'),provider_session_id text,expires_at timestamptz,state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','pending','requires_selection','completed','failed','unknown','expired')),display jsonb NOT NULL DEFAULT '{}',revision integer NOT NULL DEFAULT 1,request_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,connection_id,request_key));
CREATE TABLE public.pub3_account_bindings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,connection_id text NOT NULL,platform text NOT NULL CHECK(platform='douyin'),provider_account_id text NOT NULL,platform_uid text NOT NULL,display_name text NOT NULL,avatar text,status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','unknown')),revision integer NOT NULL DEFAULT 1,auth_session_id uuid NOT NULL REFERENCES public.pub3_auth_sessions(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(connection_id,platform,provider_account_id));
CREATE TABLE public.pub3_assets(id uuid PRIMARY KEY,owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,connection_id text NOT NULL,local_media_id uuid NOT NULL,file_name text NOT NULL,mime text NOT NULL,size bigint NOT NULL CHECK(size>0 AND size<=1073741824),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),hash_source text NOT NULL DEFAULT 'browser_declared' CHECK(hash_source='browser_declared'),source_ref jsonb NOT NULL DEFAULT '{}',provider_asset_id text,public_url text,state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','uploading','confirming','ready','unknown','failed')),metadata jsonb NOT NULL DEFAULT '{}',expires_at timestamptz,revision integer NOT NULL DEFAULT 1,request_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,connection_id,request_key),UNIQUE(connection_id,provider_asset_id));
CREATE TABLE public.pub3_intents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,draft_id uuid NOT NULL,draft_version integer NOT NULL,binding_id uuid NOT NULL REFERENCES public.pub3_account_bindings(id),binding_revision integer NOT NULL,payload jsonb NOT NULL,revision integer NOT NULL DEFAULT 1,archived boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(draft_id,draft_version) REFERENCES public.pub2_draft_versions(draft_id,version));
CREATE TABLE public.pub3_operations(id uuid PRIMARY KEY,owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,kind text NOT NULL CHECK(kind IN ('authorization','auth_select','asset_sign','asset_confirm','publish','task_change')),subject_id uuid NOT NULL,connection_id text NOT NULL,request_key text NOT NULL,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),snapshot jsonb NOT NULL,snapshot_hash text NOT NULL CHECK(snapshot_hash~'^[a-f0-9]{64}$'),provider_request_hash text NOT NULL CHECK(provider_request_hash~'^[a-f0-9]{64}$'),grant_kind text NOT NULL,grant_subject text NOT NULL,grant_used boolean NOT NULL DEFAULT false,flow_id text,dispatch_state text NOT NULL DEFAULT 'ready' CHECK(dispatch_state IN ('ready','dispatching','dispatched','unknown','settled','blocked')),outcome text NOT NULL DEFAULT 'pending',provider_record_id text,provider_task_id text,entitlement_id uuid REFERENCES public.pub_entitlements(id),intent_revision integer,error_code text,work_id text,work_link text,revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,request_key));
CREATE UNIQUE INDEX pub3_publish_intent_once ON public.pub3_operations(subject_id,intent_revision) WHERE kind='publish';
CREATE UNIQUE INDEX pub3_task_change_pending_once ON public.pub3_operations(subject_id) WHERE kind='task_change' AND dispatch_state IN ('ready','dispatching','unknown');
CREATE UNIQUE INDEX pub3_auth_provider_session_once ON public.pub3_auth_sessions(connection_id,provider_session_id) WHERE provider_session_id IS NOT NULL;
CREATE UNIQUE INDEX pub3_flow_once ON public.pub3_operations(connection_id,flow_id) WHERE flow_id IS NOT NULL;
CREATE UNIQUE INDEX pub3_record_once ON public.pub3_operations(connection_id,provider_record_id) WHERE provider_record_id IS NOT NULL;
CREATE UNIQUE INDEX pub3_task_once ON public.pub3_operations(connection_id,provider_task_id) WHERE provider_task_id IS NOT NULL;
CREATE TABLE public.pub3_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,operation_id uuid NOT NULL REFERENCES public.pub3_operations(id),kind text NOT NULL,source text NOT NULL CHECK(source IN ('provider_reported','system','user_reported')),safe_payload jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['pub3_auth_sessions','pub3_account_bindings','pub3_assets','pub3_intents','pub3_operations','pub3_events'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',t);
  EXECUTE format('CREATE INDEX %I ON public.%I(owner_id,created_at DESC)',t||'_owner_created',t);
 END LOOP;
END $$;
CREATE FUNCTION public.pub3_no_credentials(p_value jsonb,p_depth integer DEFAULT 0) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE e record; v jsonb;BEGIN
 IF p_value IS NULL OR p_depth>20 OR octet_length(p_value::text)>2097152 THEN RETURN false;END IF;
 IF jsonb_typeof(p_value)='object' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p_value))>200 THEN RETURN false;END IF;
  FOR e IN SELECT * FROM jsonb_each(p_value) LOOP
   IF e.key ~* '(cookie|token|secret|password|authorization|credential|api.?key|upload.?url|continuation|headers)' OR e.key IN ('__proto__','constructor','prototype') OR NOT public.pub3_no_credentials(e.value,p_depth+1) THEN RETURN false;END IF;
  END LOOP;
 ELSIF jsonb_typeof(p_value)='array' THEN IF jsonb_array_length(p_value)>200 THEN RETURN false;END IF;FOR v IN SELECT * FROM jsonb_array_elements(p_value) LOOP IF NOT public.pub3_no_credentials(v,p_depth+1) THEN RETURN false;END IF;END LOOP;
 END IF;
 RETURN true;
END $$;
CREATE FUNCTION public.pub3_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.users WHERE id=OLD.owner_id) THEN RETURN OLD; END IF;
 IF TG_TABLE_NAME='pub3_events' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'PUBLISH_API_HISTORY_IMMUTABLE';END IF;
 IF (NEW.id,NEW.created_at,NEW.owner_id,NEW.kind,NEW.subject_id,NEW.connection_id,NEW.request_key,NEW.request_hash,NEW.snapshot,NEW.snapshot_hash,NEW.provider_request_hash,NEW.grant_kind,NEW.grant_subject,NEW.flow_id,NEW.entitlement_id,NEW.intent_revision) IS DISTINCT FROM (OLD.id,OLD.created_at,OLD.owner_id,OLD.kind,OLD.subject_id,OLD.connection_id,OLD.request_key,OLD.request_hash,OLD.snapshot,OLD.snapshot_hash,OLD.provider_request_hash,OLD.grant_kind,OLD.grant_subject,OLD.flow_id,OLD.entitlement_id,OLD.intent_revision) OR OLD.grant_used AND NOT NEW.grant_used OR OLD.provider_record_id IS NOT NULL AND NEW.provider_record_id IS DISTINCT FROM OLD.provider_record_id OR OLD.provider_task_id IS NOT NULL AND NEW.provider_task_id IS DISTINCT FROM OLD.provider_task_id OR OLD.work_id IS NOT NULL AND NEW.work_id IS DISTINCT FROM OLD.work_id THEN RAISE EXCEPTION 'PUBLISH_API_HISTORY_IMMUTABLE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pub3_operation_snapshot_immutable BEFORE UPDATE OR DELETE ON public.pub3_operations FOR EACH ROW EXECUTE FUNCTION public.pub3_history_guard();
CREATE TRIGGER pub3_events_append_only BEFORE UPDATE OR DELETE ON public.pub3_events FOR EACH ROW EXECUTE FUNCTION public.pub3_history_guard();

CREATE FUNCTION public.pub3_assert_display(p jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE x jsonb;k text;BEGIN
 PERFORM public.pub2_assert_json_keys(p,ARRAY['url','selectableAccounts'],ARRAY[]::text[]);
 IF p ? 'url' AND (jsonb_typeof(p->'url') IS DISTINCT FROM 'string' OR length(p->>'url')>1048576 OR NOT(public.pub2_safe_https(p->>'url') OR p->>'url' ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$')) THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
 IF p ? 'selectableAccounts' THEN
  IF jsonb_typeof(p->'selectableAccounts') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'selectableAccounts')>100 THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
  FOR x IN SELECT * FROM jsonb_array_elements(p->'selectableAccounts') LOOP
   PERFORM public.pub2_assert_json_keys(x,ARRAY['platformUid','displayName','account'],ARRAY['platformUid','displayName']);
   FOR k IN SELECT jsonb_object_keys(x) LOOP IF jsonb_typeof(x->k) IS DISTINCT FROM 'string' OR length(x->>k)>240 THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;END LOOP;
   IF coalesce(x->>'platformUid','')='' THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
  END LOOP;
 END IF;
END $$;
CREATE FUNCTION public.pub3_assert_intent(p jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE k text;x jsonb;o jsonb;BEGIN
 PERFORM public.pub2_assert_json_keys(p,ARRAY['draftId','draftVersion','bindingId','bindingRevision','titleOverride','bodyOverride','topicsOverride','mediaIds','coverMediaId','assetIds','publishAt','options'],ARRAY['draftId','draftVersion','bindingId','bindingRevision','mediaIds','assetIds','publishAt','options']);
 FOREACH k IN ARRAY ARRAY['draftId','bindingId','coverMediaId'] LOOP IF p ? k AND (jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR p->>k !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;END LOOP;
 FOREACH k IN ARRAY ARRAY['draftVersion','bindingRevision'] LOOP IF jsonb_typeof(p->k) IS DISTINCT FROM 'number' OR p->>k !~ '^[1-9]\d*$' THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;END LOOP;
 FOREACH k IN ARRAY ARRAY['mediaIds','assetIds'] LOOP
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'array' OR jsonb_array_length(p->k) NOT BETWEEN 1 AND 31 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->k) e WHERE jsonb_typeof(e) IS DISTINCT FROM 'string' OR e#>>'{}' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->k) e GROUP BY e HAVING count(*)>1) THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
 END LOOP;
 IF p ? 'titleOverride' AND (jsonb_typeof(p->'titleOverride') IS DISTINCT FROM 'string' OR length(p->>'titleOverride')>200) OR p ? 'bodyOverride' AND (jsonb_typeof(p->'bodyOverride') IS DISTINCT FROM 'string' OR length(p->>'bodyOverride')>50000) THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
 IF p ? 'topicsOverride' THEN IF jsonb_typeof(p->'topicsOverride') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'topicsOverride')>30 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'topicsOverride') e WHERE jsonb_typeof(e) IS DISTINCT FROM 'string' OR length(trim(e#>>'{}')) NOT BETWEEN 1 AND 100) THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;END IF;
 IF p->'publishAt' IS DISTINCT FROM 'null'::jsonb THEN PERFORM public.pub2_assert_timestamp(p->>'publishAt');END IF;
 o:=p->'options';PERFORM public.pub2_assert_json_keys(o,ARRAY['short_title','cover_tsp','download_type','private_status'],ARRAY[]::text[]);
 IF o ? 'short_title' AND (jsonb_typeof(o->'short_title') IS DISTINCT FROM 'string' OR length(o->>'short_title')>12) OR o ? 'cover_tsp' AND (jsonb_typeof(o->'cover_tsp') IS DISTINCT FROM 'number' OR o->>'cover_tsp' !~ '^\d+$') OR o ? 'download_type' AND o->'download_type' NOT IN ('1'::jsonb,'2'::jsonb) OR o ? 'private_status' AND o->'private_status' NOT IN ('0'::jsonb,'1'::jsonb,'2'::jsonb) THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
END $$;
-- Unicode Han ranges plus the exact ASCII word characters consumed upstream.
CREATE FUNCTION public.pub3_topic_safe(p text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT length(p)>0 AND coalesce(bool_and(code BETWEEN 48 AND 57 OR code BETWEEN 65 AND 90 OR code=95 OR code BETWEEN 97 AND 122 OR code BETWEEN 11904 AND 11929 OR code BETWEEN 11931 AND 12019 OR code BETWEEN 12032 AND 12245 OR code IN (12293,12295) OR code BETWEEN 12321 AND 12329 OR code BETWEEN 12344 AND 12347 OR code BETWEEN 13312 AND 19903 OR code BETWEEN 19968 AND 40959 OR code BETWEEN 63744 AND 64109 OR code BETWEEN 64112 AND 64217 OR code BETWEEN 94178 AND 94179 OR code BETWEEN 94192 AND 94193 OR code BETWEEN 131072 AND 173791 OR code BETWEEN 173824 AND 177977 OR code BETWEEN 177984 AND 178205 OR code BETWEEN 178208 AND 183969 OR code BETWEEN 183984 AND 191456 OR code BETWEEN 194560 AND 195101 OR code BETWEEN 196608 AND 201546 OR code BETWEEN 201552 AND 205743),false) FROM (SELECT ascii(c) code FROM regexp_split_to_table(p,'') c) chars
$$;
CREATE FUNCTION public.pub3_wire_body(p_body text,p_topics jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE v_match text[];all_topics jsonb:='[]';t text;clean text;tags text:='';BEGIN
 clean:=regexp_replace(p_body,'#([^[:space:]]+)','','g');
 FOR v_match IN SELECT regexp_matches(p_body,'#([^[:space:]]+)','g') LOOP all_topics:=all_topics||to_jsonb(v_match[1]);END LOOP;
 all_topics:=all_topics||coalesce(p_topics,'[]');
 FOR t IN SELECT value FROM jsonb_array_elements_text(all_topics) WITH ORDINALITY x(value,n) ORDER BY n LOOP
  t:=trim(regexp_replace(regexp_replace(replace(t,'[话题]',''),'^#+','','g'),'#+$','','g'));
  IF t<>'' AND public.pub3_topic_safe(t) IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
  IF t<>'' AND NOT EXISTS(SELECT 1 FROM regexp_matches(tags,'#([^[:space:]]+)','g') r WHERE lower(r[1])=lower(t)) THEN tags:=concat_ws(' ',nullif(tags,''),'#'||t);END IF;
 END LOOP;
 clean:=regexp_replace(clean,'^\s+|\s+$','','g');
 RETURN trim(concat_ws(E'\n',nullif(clean,''),nullif(tags,'')));
END $$;
CREATE FUNCTION public.pub3_utf16_length(p text) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$ SELECT coalesce(sum(CASE WHEN ascii(c)>65535 THEN 2 ELSE 1 END),0)::integer FROM regexp_split_to_table(p,'') c $$;

CREATE FUNCTION public.pub3_assert_input(p jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE a text:=p->>'action';r text[];optional text[]:=ARRAY[]::text[];k text;BEGIN
 CASE a
 WHEN 'prepare-auth' THEN r:=ARRAY['action','connectionId','operationId','sessionId','requestKey','requestHash','snapshot','providerRequestHash'];
 WHEN 'prepare-select' THEN r:=ARRAY['action','connectionId','operationId','sessionId','expectedRevision','requestKey','requestHash','snapshot','providerRequestHash'];
 WHEN 'prepare-upload' THEN r:=ARRAY['action','connectionId','operationId','assetId','asset','requestKey','requestHash','snapshot','providerRequestHash'];
 WHEN 'prepare-confirm' THEN r:=ARRAY['action','connectionId','operationId','assetId','requestKey','requestHash','snapshot','providerRequestHash'];
 WHEN 'save-intent' THEN r:=ARRAY['action','connectionId','payload','expectedRevision'];optional:=ARRAY['intentId'];
 WHEN 'submit' THEN r:=ARRAY['action','connectionId','operationId','intentId','intentRevision','entitlementId','flowId','requestKey','requestHash','snapshot','providerRequestHash'];
 WHEN 'prepare-change' THEN r:=ARRAY['action','connectionId','operationId','parentOperationId','expectedRevision','change','requestKey','requestHash','snapshot','providerRequestHash'];
 WHEN 'dispatch' THEN r:=ARRAY['action','connectionId','operationId'];
 WHEN 'consume-grant' THEN r:=ARRAY['action','connectionId','operationId','grantKind','grantSubject','providerRequestHash'];
 WHEN 'record-auth' THEN r:=ARRAY['action','connectionId','operationId','providerSessionId','expiresAt','display'];
 WHEN 'sync-auth' THEN r:=ARRAY['action','connectionId','sessionId','providerSessionId','state','display','accounts'];
 WHEN 'record-asset' THEN r:=ARRAY['action','connectionId','operationId','providerAssetId','publicUrl'];optional:=ARRAY['size','mime','metadata'];
 WHEN 'record-operation' THEN r:=ARRAY['action','connectionId','operationId','expectedRevision','outcome'];optional:=ARRAY['recordId','taskId','errorCode','workId','workLink'];
 ELSE RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END CASE;
 PERFORM public.pub2_assert_json_keys(p,r||optional,r);
 IF EXISTS(SELECT 1 FROM jsonb_each(p) e WHERE e.value='null'::jsonb) THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
 FOREACH k IN ARRAY ARRAY['operationId','sessionId','assetId','intentId','parentOperationId','entitlementId'] LOOP
  IF p ? k AND (jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR p->>k !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['expectedRevision','intentRevision','size'] LOOP
  IF p ? k AND (jsonb_typeof(p->k) IS DISTINCT FROM 'number' OR p->>k !~ '^\d+$') THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['connectionId','requestKey','requestHash','providerRequestHash','grantKind','grantSubject','providerSessionId','expiresAt','state','outcome','recordId','taskId','errorCode','workId','workLink','providerAssetId','publicUrl','mime','flowId','change'] LOOP
  IF p ? k AND (jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR length(p->>k)>2048) THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['snapshot','display','metadata','payload','asset'] LOOP IF p ? k AND (jsonb_typeof(p->k) IS DISTINCT FROM 'object' OR NOT public.pub3_no_credentials(p->k)) THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;END LOOP;
 IF p ? 'expiresAt' THEN PERFORM public.pub2_assert_timestamp(p->>'expiresAt');IF (p->>'expiresAt')::timestamptz<=now() THEN RAISE EXCEPTION 'PUBLISH_API_AUTH_SESSION_INVALID';END IF;END IF;
 FOREACH k IN ARRAY ARRAY['providerSessionId','providerAssetId','recordId','taskId'] LOOP IF p ? k AND (length(p->>k) NOT BETWEEN 1 AND 240 OR p->>k !~ '^[A-Za-z0-9_.:-]+$') THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;END LOOP;
 IF p ? 'workId' AND length(p->>'workId') NOT BETWEEN 1 AND 240 OR p ? 'errorCode' AND (length(p->>'errorCode')>100 OR p->>'errorCode' !~ '^[A-Za-z0-9_.:-]+$') THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
 IF p ? 'metadata' THEN PERFORM public.pub2_assert_json_keys(p->'metadata',ARRAY['width','height','duration'],ARRAY[]::text[]);FOR k IN SELECT jsonb_object_keys(p->'metadata') LOOP IF jsonb_typeof(p->'metadata'->k) IS DISTINCT FROM 'number' OR (p->'metadata'->>k)::numeric<=0 THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;END LOOP;END IF;
END $$;

CREATE FUNCTION public.mutate_publish_v3_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a text:=p_input->>'action'; conn text:=p_input->>'connectionId'; op public.pub3_operations%ROWTYPE; old_op public.pub3_operations%ROWTYPE; sess public.pub3_auth_sessions%ROWTYPE; asset public.pub3_assets%ROWTYPE; binding public.pub3_account_bindings%ROWTYPE; intent public.pub3_intents%ROWTYPE; ent public.pub_entitlements%ROWTYPE; cfg public.pub_config_versions%ROWTYPE; v_payload jsonb; snap jsonb; account jsonb; media jsonb; ref jsonb; expected_media jsonb; cover_url text; row_out jsonb; local_id uuid; op_id uuid; v_kind text; subject uuid; v_grant_kind text; v_grant_subject text; qkey text:=p_input->>'requestKey'; qhash text:=p_input->>'requestHash'; api_hash text:=p_input->>'providerRequestHash'; input_snapshot jsonb:=p_input->'snapshot'; inserted boolean;
BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 PERFORM public.pub3_assert_input(p_input);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR length(coalesce(conn,'')) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
 IF a IN ('prepare-auth','prepare-select','prepare-upload','prepare-confirm','submit','prepare-change') THEN
  IF length(coalesce(qkey,'')) NOT BETWEEN 8 AND 160 OR qkey !~ '^[A-Za-z0-9_.:-]+$' OR coalesce(qhash,'') !~ '^[a-f0-9]{64}$' OR coalesce(api_hash,'') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(input_snapshot) IS DISTINCT FROM 'object' OR NOT public.pub3_no_credentials(input_snapshot) THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
  SELECT * INTO op FROM public.pub3_operations WHERE owner_id=p_user_id AND request_key=qkey;
  IF FOUND THEN
   IF op.connection_id<>conn OR op.request_hash<>qhash THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;
   RETURN jsonb_build_object('operation',to_jsonb(op),'alreadyFulfilled',true);
  END IF;
  op_id:=(p_input->>'operationId')::uuid;
 END IF;
 IF a='prepare-auth' THEN
  local_id:=(p_input->>'sessionId')::uuid;
  PERFORM public.pub2_assert_json_keys(input_snapshot,ARRAY['request'],ARRAY['request']);
  PERFORM public.pub2_assert_json_keys(input_snapshot->'request',ARRAY['type','correlationId','callbackUrl'],ARRAY['type','correlationId','callbackUrl']);
  IF input_snapshot->'request'->>'type' IS DISTINCT FROM 'douyin' OR input_snapshot->'request'->>'correlationId' IS DISTINCT FROM local_id::text OR input_snapshot->'request'->'callbackUrl' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'PUBLISH_API_SNAPSHOT_MISMATCH';END IF;
  INSERT INTO public.pub3_auth_sessions(id,owner_id,connection_id,platform,request_key) VALUES(local_id,p_user_id,conn,'douyin',qkey);
  v_kind:='authorization';subject:=local_id;v_grant_kind:='authorization';v_grant_subject:=local_id::text;
 ELSIF a='prepare-select' THEN
  SELECT * INTO sess FROM public.pub3_auth_sessions WHERE id=(p_input->>'sessionId')::uuid AND owner_id=p_user_id AND connection_id=conn FOR UPDATE;
  IF NOT FOUND OR sess.provider_session_id IS NULL OR sess.expires_at<=now() OR sess.state<>'requires_selection' OR sess.revision<>(p_input->>'expectedRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_API_AUTH_SESSION_INVALID';END IF;
  PERFORM public.pub2_assert_json_keys(input_snapshot,ARRAY['request'],ARRAY['request']);PERFORM public.pub2_assert_json_keys(input_snapshot->'request',ARRAY['accounts'],ARRAY['accounts']);
  IF jsonb_typeof(input_snapshot->'request'->'accounts') IS DISTINCT FROM 'array' OR jsonb_array_length(input_snapshot->'request'->'accounts') NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(input_snapshot->'request'->'accounts') x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(sess.display->'selectableAccounts','[]')) z WHERE z->>'platformUid'=x->>'platformUid' AND coalesce(z->>'account','')=coalesce(x->>'account',''))) THEN RAISE EXCEPTION 'PUBLISH_API_AUTH_SELECTION_INVALID';END IF;
  FOR account IN SELECT * FROM jsonb_array_elements(input_snapshot->'request'->'accounts') LOOP PERFORM public.pub2_assert_json_keys(account,ARRAY['platformUid','account'],ARRAY['platformUid']);IF jsonb_typeof(account->'platformUid') IS DISTINCT FROM 'string' OR length(account->>'platformUid') NOT BETWEEN 1 AND 240 OR account->>'platformUid' !~ '^[A-Za-z0-9_.:-]+$' OR account ? 'account' AND (jsonb_typeof(account->'account') IS DISTINCT FROM 'string' OR length(account->>'account')>240) THEN RAISE EXCEPTION 'PUBLISH_API_AUTH_SELECTION_INVALID';END IF;END LOOP;
  v_kind:='auth_select';subject:=sess.id;v_grant_kind:='authorization';v_grant_subject:=sess.provider_session_id||':selection';
 ELSIF a='prepare-upload' THEN
  local_id:=(p_input->>'assetId')::uuid;
  v_payload:=p_input->'asset';
  PERFORM public.pub2_assert_json_keys(v_payload,ARRAY['mediaId','fileName','mime','size','sha256'],ARRAY['mediaId','fileName','mime','size','sha256']);
  IF jsonb_typeof(v_payload->'mediaId') IS DISTINCT FROM 'string' OR v_payload->>'mediaId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR jsonb_typeof(v_payload->'fileName') IS DISTINCT FROM 'string' OR length(v_payload->>'fileName') NOT BETWEEN 1 AND 255 OR v_payload->>'fileName' ~ '[[:cntrl:]/\\]' OR jsonb_typeof(v_payload->'size') IS DISTINCT FROM 'number' OR v_payload->>'size' !~ '^[1-9]\d*$' OR jsonb_typeof(v_payload->'mime') IS DISTINCT FROM 'string' OR jsonb_typeof(v_payload->'sha256') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  IF v_payload->>'mime'='image/jpeg' AND v_payload->>'fileName' !~* '\.jpe?g$' OR v_payload->>'mime'='image/png' AND v_payload->>'fileName' !~* '\.png$' OR v_payload->>'mime'='image/webp' AND v_payload->>'fileName' !~* '\.webp$' OR v_payload->>'mime'='video/mp4' AND v_payload->>'fileName' !~* '\.mp4$' THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  PERFORM public.pub2_assert_json_keys(input_snapshot,ARRAY['request'],ARRAY['request']);PERFORM public.pub2_assert_json_keys(input_snapshot->'request',ARRAY['filename','size','type'],ARRAY['filename','size','type']);
  IF input_snapshot->'request'->>'filename' IS DISTINCT FROM v_payload->>'fileName' OR input_snapshot->'request'->'size' IS DISTINCT FROM v_payload->'size' OR input_snapshot->'request'->>'type' IS DISTINCT FROM 'publishMedia' THEN RAISE EXCEPTION 'PUBLISH_API_SNAPSHOT_MISMATCH';END IF;
  IF coalesce(v_payload->>'sha256','') !~ '^[a-f0-9]{64}$' OR coalesce(v_payload->>'mime','') NOT IN ('image/jpeg','image/png','image/webp','video/mp4') OR coalesce((v_payload->>'size')::bigint,0) NOT BETWEEN 1 AND 1073741824 OR v_payload->>'mime' LIKE 'image/%' AND (v_payload->>'size')::bigint>20971520 THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  INSERT INTO public.pub3_assets(id,owner_id,connection_id,local_media_id,file_name,mime,size,sha256,request_key) VALUES(local_id,p_user_id,conn,(v_payload->>'mediaId')::uuid,v_payload->>'fileName',v_payload->>'mime',(v_payload->>'size')::bigint,v_payload->>'sha256',qkey);
  v_kind:='asset_sign';subject:=local_id;v_grant_kind:='asset_sign';v_grant_subject:=op_id::text;
 ELSIF a='prepare-confirm' THEN
  SELECT * INTO asset FROM public.pub3_assets WHERE id=(p_input->>'assetId')::uuid AND owner_id=p_user_id AND connection_id=conn FOR UPDATE;
  IF NOT FOUND OR asset.provider_asset_id IS NULL OR asset.state NOT IN ('uploading','confirming','ready') THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  PERFORM public.pub2_assert_json_keys(input_snapshot,ARRAY['request'],ARRAY['request']);PERFORM public.pub2_assert_json_keys(input_snapshot->'request',ARRAY['assetId'],ARRAY['assetId']);
  IF input_snapshot->'request'->>'assetId' IS DISTINCT FROM asset.provider_asset_id THEN RAISE EXCEPTION 'PUBLISH_API_SNAPSHOT_MISMATCH';END IF;
  v_kind:='asset_confirm';subject:=asset.id;v_grant_kind:='asset_confirm';v_grant_subject:=asset.provider_asset_id;
 ELSIF a='save-intent' THEN
  v_payload:=p_input->'payload';
  PERFORM public.pub3_assert_intent(v_payload);
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' OR NOT public.pub3_no_credentials(v_payload) OR coalesce((v_payload->>'draftVersion')::integer,0)<1 OR jsonb_typeof(v_payload->'mediaIds') IS DISTINCT FROM 'array' OR jsonb_array_length(v_payload->'mediaIds') NOT BETWEEN 1 AND 30 OR jsonb_typeof(v_payload->'assetIds') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
  SELECT * INTO binding FROM public.pub3_account_bindings WHERE id=(v_payload->>'bindingId')::uuid AND owner_id=p_user_id AND connection_id=conn AND status='active' FOR SHARE;
  IF NOT FOUND OR binding.revision<>(v_payload->>'bindingRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_API_BINDING_CHANGED';END IF;
  SELECT v.payload INTO snap FROM public.pub2_draft_versions v JOIN public.pub2_drafts d ON d.id=v.draft_id WHERE v.draft_id=(v_payload->>'draftId')::uuid AND v.version=(v_payload->>'draftVersion')::integer AND v.user_id=p_user_id AND NOT d.archived;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_DRAFT_NOT_FOUND';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_payload->'mediaIds') i WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snap->'media') m WHERE m->>'id'=i)) OR v_payload ? 'coverMediaId' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snap->'media') m WHERE m->>'id'=v_payload->>'coverMediaId' AND m->>'role'<>'video') THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_payload->'assetIds') i WHERE NOT EXISTS(SELECT 1 FROM public.pub3_assets x WHERE x.id=i::uuid AND x.owner_id=p_user_id AND x.connection_id=conn AND x.state='ready')) THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  IF p_input->>'intentId' IS NULL THEN
   IF (p_input->>'expectedRevision')::integer<>0 THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT';END IF;
   INSERT INTO public.pub3_intents(owner_id,draft_id,draft_version,binding_id,binding_revision,payload) VALUES(p_user_id,(v_payload->>'draftId')::uuid,(v_payload->>'draftVersion')::integer,binding.id,binding.revision,v_payload) RETURNING * INTO intent;
  ELSE
   UPDATE public.pub3_intents SET draft_id=(v_payload->>'draftId')::uuid,draft_version=(v_payload->>'draftVersion')::integer,binding_id=binding.id,binding_revision=binding.revision,payload=v_payload,revision=revision+1,updated_at=now() WHERE id=(p_input->>'intentId')::uuid AND owner_id=p_user_id AND revision=(p_input->>'expectedRevision')::integer AND NOT archived RETURNING * INTO intent;
   IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT';END IF;
  END IF;
  RETURN jsonb_build_object('intent',to_jsonb(intent));
 ELSIF a='submit' THEN
  SELECT * INTO cfg FROM public.pub_config_versions ORDER BY version DESC LIMIT 1 FOR SHARE;
  IF NOT FOUND OR cfg.execution_enabled IS NOT TRUE OR coalesce(cfg.enabled_platforms ? 'douyin',false) IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_EXECUTION_DISABLED';END IF;
  SELECT * INTO intent FROM public.pub3_intents WHERE id=(p_input->>'intentId')::uuid AND owner_id=p_user_id AND NOT archived FOR UPDATE;
  IF NOT FOUND OR intent.revision<>(p_input->>'intentRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT';END IF;
  SELECT * INTO op FROM public.pub3_operations WHERE kind='publish' AND subject_id=intent.id AND intent_revision=intent.revision;
  IF FOUND THEN RAISE EXCEPTION 'PUBLISH_API_INTENT_ALREADY_SUBMITTED';END IF;
  SELECT * INTO binding FROM public.pub3_account_bindings WHERE id=intent.binding_id AND owner_id=p_user_id AND connection_id=conn AND status='active' FOR SHARE;
  IF NOT FOUND OR binding.revision<>intent.binding_revision THEN RAISE EXCEPTION 'PUBLISH_API_BINDING_CHANGED';END IF;
  SELECT v.payload INTO v_payload FROM public.pub2_draft_versions v JOIN public.pub2_drafts d ON d.id=v.draft_id WHERE v.draft_id=intent.draft_id AND v.version=intent.draft_version AND v.user_id=p_user_id AND NOT d.archived;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_DRAFT_NOT_FOUND';END IF;
  PERFORM public.pub2_assert_json_keys(input_snapshot,ARRAY['request','draft','intent','binding','assets'],ARRAY['request','draft','intent','binding','assets']);
  IF input_snapshot->'draft' IS DISTINCT FROM v_payload OR input_snapshot->'intent' IS DISTINCT FROM intent.payload OR input_snapshot->'binding' IS DISTINCT FROM jsonb_build_object('id',binding.id,'revision',binding.revision,'providerAccountId',binding.provider_account_id,'platformUid',binding.platform_uid) THEN RAISE EXCEPTION 'PUBLISH_API_SNAPSHOT_MISMATCH';END IF;
  PERFORM public.pub2_assert_json_keys(input_snapshot->'request',ARRAY['flowId','publishAt','content','items'],ARRAY['flowId','publishAt','content','items']);
  PERFORM public.pub2_assert_json_keys(input_snapshot->'request'->'content',ARRAY['title','body','media','cover'],ARRAY['title','body','media']);
  IF input_snapshot->'request'->>'flowId' IS DISTINCT FROM p_input->>'flowId' OR jsonb_typeof(input_snapshot->'request'->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(input_snapshot->'request'->'items')<>1 THEN RAISE EXCEPTION 'PUBLISH_API_SNAPSHOT_MISMATCH';END IF;
  PERFORM public.pub2_assert_json_keys(input_snapshot->'request'->'items'->0,ARRAY['platform','accountId','option'],ARRAY['platform','accountId','option']);
  IF input_snapshot->'request'->'items'->0->'option' IS DISTINCT FROM intent.payload->'options' OR input_snapshot->'request'->'content'->>'title' IS DISTINCT FROM coalesce(intent.payload->>'titleOverride',v_payload->>'title') OR input_snapshot->'request'->'content'->>'body' IS DISTINCT FROM public.pub3_wire_body(coalesce(intent.payload->>'bodyOverride',v_payload->>'body'),coalesce(intent.payload->'topicsOverride',v_payload->'topics')) THEN RAISE EXCEPTION 'PUBLISH_API_SNAPSHOT_MISMATCH';END IF;
  IF public.pub3_utf16_length(input_snapshot->'request'->'content'->>'title')>30 OR public.pub3_utf16_length(input_snapshot->'request'->'content'->>'title')>12 AND length(trim(coalesce(intent.payload->'options'->>'short_title','')))=0 OR public.pub3_utf16_length(regexp_replace(regexp_replace(coalesce(intent.payload->>'bodyOverride',v_payload->>'body'),'#([^[:space:]]+)','','g'),'^\s+|\s+$','','g'))+public.pub3_utf16_length(input_snapshot->'request'->'content'->>'title')>1000 OR (SELECT count(*) FROM regexp_matches(input_snapshot->'request'->'content'->>'body','#([^[:space:]]+)','g'))>5 THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
  IF public.pub3_utf16_length(intent.payload->'options'->>'short_title')>12 THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
  PERFORM public.pub2_assert_timestamp(input_snapshot->'request'->>'publishAt');
  IF intent.payload->'publishAt'<>'null'::jsonb THEN IF input_snapshot->'request'->>'publishAt' IS DISTINCT FROM intent.payload->>'publishAt' OR (intent.payload->>'publishAt')::timestamptz<=now() THEN RAISE EXCEPTION 'PUBLISH_API_SNAPSHOT_MISMATCH';END IF;ELSIF abs(extract(epoch FROM ((input_snapshot->'request'->>'publishAt')::timestamptz-now())))>300 THEN RAISE EXCEPTION 'PUBLISH_API_SNAPSHOT_MISMATCH';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(intent.payload->'assetIds') i WHERE NOT EXISTS(SELECT 1 FROM public.pub3_assets x WHERE x.id=i::uuid AND x.owner_id=p_user_id AND x.connection_id=conn AND x.state='ready' AND (x.expires_at IS NULL OR x.expires_at>now()))) THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(intent.payload->'mediaIds') i WHERE (SELECT count(*) FROM public.pub3_assets x WHERE x.local_media_id=i::uuid AND x.id::text IN (SELECT jsonb_array_elements_text(intent.payload->'assetIds')) AND x.owner_id=p_user_id AND x.connection_id=conn AND x.state='ready')<>1) OR EXISTS(SELECT 1 FROM public.pub3_assets x WHERE x.id::text IN (SELECT jsonb_array_elements_text(intent.payload->'assetIds')) AND coalesce(intent.payload->'mediaIds' ? x.local_media_id::text OR intent.payload->>'coverMediaId'=x.local_media_id::text,false) IS NOT TRUE) THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'media') m JOIN public.pub3_assets x ON x.local_media_id=(m->>'id')::uuid WHERE x.id::text IN (SELECT jsonb_array_elements_text(intent.payload->'assetIds')) AND (x.size IS DISTINCT FROM (m->>'size')::bigint OR x.mime IS DISTINCT FROM m->>'type' OR m ? 'hash' AND x.sha256 IS DISTINCT FROM m->>'hash')) THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  SELECT jsonb_agg(jsonb_build_object('id',x.id,'mediaId',x.local_media_id,'size',x.size,'mime',x.mime,'sha256',x.sha256,'providerAssetId',x.provider_asset_id,'publicUrl',x.public_url,'metadata',x.metadata) ORDER BY i.n) INTO row_out FROM jsonb_array_elements_text(intent.payload->'assetIds') WITH ORDINALITY i(id,n) JOIN public.pub3_assets x ON x.id=i.id::uuid AND x.owner_id=p_user_id AND x.connection_id=conn;
  IF input_snapshot->'assets' IS DISTINCT FROM row_out THEN RAISE EXCEPTION 'PUBLISH_API_SNAPSHOT_MISMATCH';END IF;
  IF v_payload->>'contentType'='video' AND (jsonb_array_length(intent.payload->'mediaIds')<>1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'media') m WHERE intent.payload->'mediaIds' ? (m->>'id') AND m->>'role'<>'video')) OR v_payload->>'contentType'='image' AND (jsonb_array_length(intent.payload->'mediaIds') NOT BETWEEN 1 AND 12 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'media') m WHERE intent.payload->'mediaIds' ? (m->>'id') AND m->>'role'<>'image')) THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  IF EXISTS(SELECT 1 FROM public.pub3_assets x WHERE x.id::text IN (SELECT jsonb_array_elements_text(intent.payload->'assetIds')) AND ((intent.payload->'mediaIds' ? x.local_media_id::text) AND (v_payload->>'contentType'='video' AND x.mime<>'video/mp4' OR v_payload->>'contentType'='image' AND x.mime NOT IN ('image/jpeg','image/png')) OR intent.payload->>'coverMediaId'=x.local_media_id::text AND x.mime NOT IN ('image/jpeg','image/png'))) THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  IF EXISTS(SELECT 1 FROM public.pub3_assets x WHERE x.id::text IN (SELECT jsonb_array_elements_text(intent.payload->'assetIds')) AND (CASE WHEN x.mime='video/mp4' THEN x.size>104857600 OR coalesce((x.metadata->>'duration')::numeric,0) NOT BETWEEN 0.001 AND 900 ELSE x.mime NOT IN ('image/jpeg','image/png') OR x.size>20971520 END)) THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('url',x.public_url) ORDER BY i.ordinality),'[]') INTO expected_media FROM jsonb_array_elements_text(intent.payload->'mediaIds') WITH ORDINALITY i(media_id,ordinality) JOIN public.pub3_assets x ON x.local_media_id=i.media_id::uuid AND x.id::text IN (SELECT jsonb_array_elements_text(intent.payload->'assetIds')) AND x.owner_id=p_user_id AND x.connection_id=conn AND x.state='ready';
  IF jsonb_array_length(expected_media)<>jsonb_array_length(intent.payload->'mediaIds') OR input_snapshot->'request'->'content'->'media' IS DISTINCT FROM expected_media OR input_snapshot->'request'->'items'->0->>'accountId' IS DISTINCT FROM binding.provider_account_id OR input_snapshot->'request'->'items'->0->>'platform' IS DISTINCT FROM 'douyin' THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  IF intent.payload ? 'coverMediaId' THEN
   IF (SELECT count(*) FROM public.pub3_assets x WHERE x.local_media_id=(intent.payload->>'coverMediaId')::uuid AND x.id::text IN (SELECT jsonb_array_elements_text(intent.payload->'assetIds')) AND x.owner_id=p_user_id AND x.connection_id=conn AND x.state='ready')<>1 THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
   PERFORM public.pub2_assert_json_keys(input_snapshot->'request'->'content'->'cover',ARRAY['url'],ARRAY['url']);
   SELECT x.public_url INTO cover_url FROM public.pub3_assets x WHERE x.local_media_id=(intent.payload->>'coverMediaId')::uuid AND x.id::text IN (SELECT jsonb_array_elements_text(intent.payload->'assetIds')) AND x.owner_id=p_user_id AND x.connection_id=conn AND x.state='ready';
   IF cover_url IS NULL OR input_snapshot->'request'->'content'->'cover'->>'url' IS DISTINCT FROM cover_url THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  ELSIF input_snapshot->'request'->'content' ? 'cover' THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  SELECT * INTO ent FROM public.pub_entitlements WHERE id=(p_input->>'entitlementId')::uuid AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_ENTITLEMENT_NOT_FOUND';END IF;
  IF ent.expires_at<=now() THEN RAISE EXCEPTION 'PUBLISH_ENTITLEMENT_EXPIRED';END IF;
  IF ent.used>=ent.quota THEN RAISE EXCEPTION 'PUBLISH_NO_QUOTA';END IF;
  IF coalesce(ent.platforms ? 'douyin',false) IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_PLATFORM_NOT_ALLOWED';END IF;
  UPDATE public.pub_entitlements SET used=used+1 WHERE id=ent.id;
  v_kind:='publish';subject:=intent.id;v_grant_kind:='create_flow';v_grant_subject:=p_input->>'flowId';
 ELSIF a='prepare-change' THEN
  SELECT * INTO old_op FROM public.pub3_operations WHERE id=(p_input->>'parentOperationId')::uuid AND owner_id=p_user_id AND connection_id=conn AND kind='publish' FOR UPDATE;
  IF NOT FOUND OR old_op.revision<>(p_input->>'expectedRevision')::integer OR old_op.provider_task_id IS NULL OR old_op.outcome NOT IN ('waiting','queued','platform_scheduled') THEN RAISE EXCEPTION 'PUBLISH_API_TASK_STATE_INVALID';END IF;
  IF p_input->>'change' NOT IN ('cancel','reschedule','publish-now') THEN RAISE EXCEPTION 'PUBLISH_API_TASK_STATE_INVALID';END IF;
  IF p_input->>'change'<>'cancel' AND old_op.outcome NOT IN ('waiting','queued') OR EXISTS(SELECT 1 FROM public.pub3_operations c WHERE c.kind='task_change' AND c.subject_id=old_op.id AND c.dispatch_state IN ('ready','dispatching','unknown')) THEN RAISE EXCEPTION 'PUBLISH_API_TASK_STATE_INVALID';END IF;
  PERFORM public.pub2_assert_json_keys(input_snapshot,ARRAY['request'],ARRAY['request']);PERFORM public.pub2_assert_json_keys(input_snapshot->'request',ARRAY['taskId','action','publishAt'],ARRAY['taskId','action','publishAt']);
  IF input_snapshot->'request'->>'taskId' IS DISTINCT FROM old_op.provider_task_id OR input_snapshot->'request'->>'action' IS DISTINCT FROM p_input->>'change' THEN RAISE EXCEPTION 'PUBLISH_API_SNAPSHOT_MISMATCH';END IF;
  IF p_input->>'change'='reschedule' THEN PERFORM public.pub2_assert_timestamp(input_snapshot->'request'->>'publishAt');IF (input_snapshot->'request'->>'publishAt')::timestamptz<=now() THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;ELSIF input_snapshot->'request'->'publishAt' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'PUBLISH_API_SNAPSHOT_MISMATCH';END IF;
  v_kind:='task_change';subject:=old_op.id;v_grant_kind:='task_change';v_grant_subject:=old_op.provider_task_id||':'||(p_input->>'change');
 ELSIF a='dispatch' THEN
  SELECT * INTO op FROM public.pub3_operations WHERE id=(p_input->>'operationId')::uuid AND owner_id=p_user_id AND connection_id=conn;
  IF op.kind IN ('publish','task_change') THEN SELECT * INTO cfg FROM public.pub_config_versions ORDER BY version DESC LIMIT 1 FOR SHARE;IF NOT FOUND OR cfg.execution_enabled IS NOT TRUE OR coalesce(cfg.enabled_platforms ? 'douyin',false) IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_EXECUTION_DISABLED';END IF;END IF;
  UPDATE public.pub3_operations SET dispatch_state='dispatching',revision=revision+1,updated_at=now() WHERE id=(p_input->>'operationId')::uuid AND owner_id=p_user_id AND connection_id=conn AND dispatch_state='ready' RETURNING * INTO op;
  inserted:=FOUND;
  IF NOT inserted THEN SELECT * INTO op FROM public.pub3_operations WHERE id=(p_input->>'operationId')::uuid AND owner_id=p_user_id AND connection_id=conn;END IF;
  IF op.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_API_OPERATION_NOT_FOUND';END IF;
  RETURN jsonb_build_object('operation',to_jsonb(op),'shouldSend',inserted);
 ELSIF a='consume-grant' THEN
  SELECT * INTO op FROM public.pub3_operations WHERE id=(p_input->>'operationId')::uuid AND owner_id=p_user_id AND connection_id=conn;
  IF op.kind IN ('publish','task_change') THEN SELECT * INTO cfg FROM public.pub_config_versions ORDER BY version DESC LIMIT 1 FOR SHARE;IF NOT FOUND OR cfg.execution_enabled IS NOT TRUE OR coalesce(cfg.enabled_platforms ? 'douyin',false) IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_EXECUTION_DISABLED';END IF;END IF;
  UPDATE public.pub3_operations SET grant_used=true,revision=revision+1,updated_at=now() WHERE id=(p_input->>'operationId')::uuid AND owner_id=p_user_id AND connection_id=conn AND dispatch_state='dispatching' AND NOT grant_used AND grant_kind=p_input->>'grantKind' AND grant_subject=p_input->>'grantSubject' AND provider_request_hash=p_input->>'providerRequestHash' RETURNING * INTO op;
  RETURN jsonb_build_object('consumed',FOUND,'operation',to_jsonb(op));
 ELSIF a='record-auth' THEN
  SELECT * INTO op FROM public.pub3_operations WHERE id=(p_input->>'operationId')::uuid AND owner_id=p_user_id AND connection_id=conn AND kind='authorization' FOR UPDATE;
  IF NOT FOUND OR NOT op.grant_used OR op.dispatch_state<>'dispatching' THEN RAISE EXCEPTION 'PUBLISH_API_OPERATION_NOT_FOUND';END IF;
  PERFORM public.pub3_assert_display(p_input->'display');
  UPDATE public.pub3_auth_sessions SET provider_session_id=p_input->>'providerSessionId',expires_at=(p_input->>'expiresAt')::timestamptz,state='pending',display=p_input->'display',revision=revision+1,updated_at=now() WHERE id=op.subject_id AND owner_id=p_user_id AND connection_id=conn RETURNING * INTO sess;
  UPDATE public.pub3_operations SET dispatch_state='settled',outcome='waiting',revision=revision+1,updated_at=now() WHERE id=op.id RETURNING * INTO op;
  RETURN jsonb_build_object('session',to_jsonb(sess),'operation',to_jsonb(op));
 ELSIF a='sync-auth' THEN
  SELECT * INTO sess FROM public.pub3_auth_sessions WHERE id=(p_input->>'sessionId')::uuid AND owner_id=p_user_id AND connection_id=conn AND provider_session_id=p_input->>'providerSessionId' FOR UPDATE;
  IF NOT FOUND OR sess.expires_at<=now() OR sess.state='completed' AND p_input->>'state'<>'completed' THEN RAISE EXCEPTION 'PUBLISH_API_AUTH_SESSION_INVALID';END IF;
  IF p_input->>'state' NOT IN ('pending','requires_selection','completed','failed') OR NOT public.pub3_no_credentials(p_input->'display') THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
  PERFORM public.pub3_assert_display(p_input->'display');
  IF p_input->>'state'='completed' THEN
   IF jsonb_typeof(p_input->'accounts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'accounts') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'PUBLISH_API_AUTH_SESSION_INVALID';END IF;
   FOR account IN SELECT * FROM jsonb_array_elements(p_input->'accounts') LOOP
    PERFORM public.pub2_assert_json_keys(account,ARRAY['accountId','platform','platformUid','displayName','avatar'],ARRAY['accountId','platform','platformUid','displayName']);
    IF jsonb_typeof(account->'displayName') IS DISTINCT FROM 'string' OR length(account->>'displayName')>240 OR length(account->>'platformUid') NOT BETWEEN 1 AND 240 OR account ? 'avatar' AND public.pub2_safe_https(account->>'avatar') IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_API_AUTH_SESSION_INVALID';END IF;
    IF coalesce(account->>'platform','')<>'douyin' OR coalesce(account->>'accountId','') !~ '^[A-Za-z0-9_.:-]+$' OR length(account->>'accountId')>240 OR coalesce(account->>'platformUid','')='' THEN RAISE EXCEPTION 'PUBLISH_API_AUTH_SESSION_INVALID';END IF;
    INSERT INTO public.pub3_account_bindings(owner_id,connection_id,platform,provider_account_id,platform_uid,display_name,avatar,auth_session_id) VALUES(p_user_id,conn,'douyin',account->>'accountId',account->>'platformUid',account->>'displayName',account->>'avatar',sess.id) ON CONFLICT(connection_id,platform,provider_account_id) DO UPDATE SET platform_uid=EXCLUDED.platform_uid,display_name=EXCLUDED.display_name,avatar=EXCLUDED.avatar,auth_session_id=EXCLUDED.auth_session_id,status='active',revision=CASE WHEN (pub3_account_bindings.platform_uid,pub3_account_bindings.display_name,pub3_account_bindings.avatar,pub3_account_bindings.auth_session_id,pub3_account_bindings.status) IS DISTINCT FROM (EXCLUDED.platform_uid,EXCLUDED.display_name,EXCLUDED.avatar,EXCLUDED.auth_session_id,'active') THEN pub3_account_bindings.revision+1 ELSE pub3_account_bindings.revision END,updated_at=CASE WHEN (pub3_account_bindings.platform_uid,pub3_account_bindings.display_name,pub3_account_bindings.avatar,pub3_account_bindings.auth_session_id,pub3_account_bindings.status) IS DISTINCT FROM (EXCLUDED.platform_uid,EXCLUDED.display_name,EXCLUDED.avatar,EXCLUDED.auth_session_id,'active') THEN now() ELSE pub3_account_bindings.updated_at END WHERE pub3_account_bindings.owner_id=p_user_id RETURNING * INTO binding;
    IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_API_ACCOUNT_ALREADY_OWNED';END IF;
   END LOOP;
  END IF;
  UPDATE public.pub3_auth_sessions SET state=p_input->>'state',display=p_input->'display',revision=CASE WHEN (state,display) IS DISTINCT FROM (p_input->>'state',p_input->'display') THEN revision+1 ELSE revision END,updated_at=CASE WHEN (state,display) IS DISTINCT FROM (p_input->>'state',p_input->'display') THEN now() ELSE updated_at END WHERE id=sess.id RETURNING * INTO sess;
  RETURN jsonb_build_object('session',to_jsonb(sess));
 ELSIF a='record-asset' THEN
  SELECT * INTO op FROM public.pub3_operations WHERE id=(p_input->>'operationId')::uuid AND owner_id=p_user_id AND connection_id=conn AND kind IN ('asset_sign','asset_confirm') FOR UPDATE;
  IF NOT FOUND OR NOT op.grant_used OR op.dispatch_state<>'dispatching' THEN RAISE EXCEPTION 'PUBLISH_API_OPERATION_NOT_FOUND';END IF;
  SELECT * INTO asset FROM public.pub3_assets WHERE id=op.subject_id AND owner_id=p_user_id AND connection_id=conn FOR UPDATE;
  IF NOT FOUND OR public.pub2_safe_https(p_input->>'publicUrl') IS NOT TRUE OR coalesce(p_input->>'providerAssetId','') !~ '^[A-Za-z0-9_.:-]+$' THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;
  IF op.kind='asset_confirm' AND (NOT(p_input ?& ARRAY['size','mime','metadata']) OR asset.provider_asset_id IS DISTINCT FROM p_input->>'providerAssetId' OR asset.public_url IS DISTINCT FROM p_input->>'publicUrl' OR asset.size IS DISTINCT FROM (p_input->>'size')::bigint OR asset.mime IS DISTINCT FROM p_input->>'mime' OR NOT public.pub3_no_credentials(p_input->'metadata')) THEN RAISE EXCEPTION 'PUBLISH_API_ASSET_INVALID';END IF;

  UPDATE public.pub3_assets SET provider_asset_id=p_input->>'providerAssetId',public_url=p_input->>'publicUrl',state=CASE WHEN op.kind='asset_sign' THEN 'uploading' ELSE 'ready' END,metadata=coalesce(p_input->'metadata','{}'),revision=revision+1,updated_at=now() WHERE id=asset.id RETURNING * INTO asset;
  UPDATE public.pub3_operations SET dispatch_state='settled',outcome='waiting',revision=revision+1,updated_at=now() WHERE id=op.id RETURNING * INTO op;
  RETURN jsonb_build_object('asset',to_jsonb(asset),'operation',to_jsonb(op));
 ELSIF a='record-operation' THEN
  SELECT * INTO op FROM public.pub3_operations WHERE id=(p_input->>'operationId')::uuid AND owner_id=p_user_id AND connection_id=conn FOR UPDATE;
  IF NOT FOUND OR op.dispatch_state='ready' OR p_input->>'outcome'<>'unknown' AND NOT op.grant_used THEN RAISE EXCEPTION 'PUBLISH_API_OPERATION_NOT_FOUND';END IF;
  IF op.revision IS DISTINCT FROM (p_input->>'expectedRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT';END IF;
  IF (p_input ? 'workId' OR p_input ? 'workLink') AND p_input->>'outcome'<>'published' OR op.kind<>'publish' AND (p_input ? 'recordId' OR p_input ? 'taskId' OR p_input ? 'workId' OR p_input ? 'workLink' OR p_input->>'outcome'='published') THEN RAISE EXCEPTION 'PUBLISH_API_OUTCOME_UNVERIFIED';END IF;
  IF op.outcome IN ('published','cancelled') AND op.outcome IS DISTINCT FROM p_input->>'outcome' OR p_input ? 'recordId' AND op.provider_record_id IS NOT NULL AND op.provider_record_id IS DISTINCT FROM p_input->>'recordId' OR p_input ? 'taskId' AND op.provider_task_id IS NOT NULL AND op.provider_task_id IS DISTINCT FROM p_input->>'taskId' OR p_input ? 'workId' AND op.work_id IS NOT NULL AND op.work_id IS DISTINCT FROM p_input->>'workId' THEN RAISE EXCEPTION 'PUBLISH_API_OUTCOME_CONFLICT';END IF;
  IF coalesce(p_input->>'outcome','') NOT IN ('pending','waiting','publishing','queued','platform_scheduled','awaiting_user_action','published','failed','cancelled','unknown') OR p_input->>'outcome'='published' AND coalesce(p_input->>'workId',p_input->>'workLink','')='' THEN RAISE EXCEPTION 'PUBLISH_API_OUTCOME_UNVERIFIED';END IF;
  IF p_input ? 'workLink' AND public.pub2_safe_https(p_input->>'workLink') IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
  UPDATE public.pub3_operations SET dispatch_state=CASE WHEN p_input->>'outcome'='unknown' THEN 'unknown' ELSE 'settled' END,outcome=p_input->>'outcome',provider_record_id=coalesce(provider_record_id,p_input->>'recordId'),provider_task_id=coalesce(provider_task_id,p_input->>'taskId'),error_code=p_input->>'errorCode',work_id=coalesce(p_input->>'workId',work_id),work_link=coalesce(p_input->>'workLink',work_link),revision=revision+1,updated_at=now() WHERE id=op.id RETURNING * INTO op;
  INSERT INTO public.pub3_events(owner_id,operation_id,kind,source,safe_payload) VALUES(p_user_id,op.id,'status','provider_reported',jsonb_strip_nulls(jsonb_build_object('status',op.outcome,'errorCode',op.error_code,'workId',op.work_id,'workLink',op.work_link)));
  RETURN jsonb_build_object('operation',to_jsonb(op));
 ELSE RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';
 END IF;
 IF v_kind IS NULL OR op_id IS NULL OR subject IS NULL THEN RAISE EXCEPTION 'PUBLISH_API_INPUT_INVALID';END IF;
 INSERT INTO public.pub3_operations(id,owner_id,kind,subject_id,connection_id,request_key,request_hash,snapshot,snapshot_hash,provider_request_hash,grant_kind,grant_subject,flow_id,entitlement_id,intent_revision) VALUES(op_id,p_user_id,v_kind,subject,conn,qkey,qhash,input_snapshot,encode(sha256(convert_to(input_snapshot::text,'UTF8')),'hex'),api_hash,v_grant_kind,v_grant_subject,CASE WHEN v_kind='publish' THEN p_input->>'flowId' ELSE NULL END,CASE WHEN v_kind='publish' THEN ent.id ELSE NULL END,CASE WHEN v_kind='publish' THEN intent.revision ELSE NULL END) RETURNING * INTO op;
 INSERT INTO public.pub3_events(owner_id,operation_id,kind,source,safe_payload) VALUES(p_user_id,op.id,'admitted','system','{}');
 RETURN jsonb_build_object('operation',to_jsonb(op),'alreadyFulfilled',false);
END $$;
REVOKE ALL ON FUNCTION public.pub3_no_credentials(jsonb,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pub3_assert_input(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pub3_assert_display(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pub3_assert_intent(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pub3_wire_body(text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pub3_utf16_length(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pub3_topic_safe(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pub3_history_guard() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.mutate_publish_v3_atomic(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_publish_v3_atomic(text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
