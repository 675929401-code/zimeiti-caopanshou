BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
-- Authorization adjunct only: no wallet, entitlement, publishing or provider revocation.
CREATE TABLE public.pub4_auth_sessions(
 id uuid PRIMARY KEY,owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 connection_id text NOT NULL,platform text NOT NULL CHECK(platform IN ('linkedin','threads','instagram','KWAI','pinterest','wxGzh','bilibili','facebook','youtube','tiktok','twitter')),
 provider_session_id text,request_key text NOT NULL,state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','pending','requires_selection','completed','failed','unknown','expired')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),expires_at timestamptz,display jsonb NOT NULL DEFAULT '{}',choices jsonb NOT NULL DEFAULT '[]',completed_accounts jsonb NOT NULL DEFAULT '[]',binding_ids jsonb NOT NULL DEFAULT '[]',
 target_group_id uuid REFERENCES public.pub2_groups(id) ON DELETE SET NULL,error_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id),UNIQUE(owner_id,request_key),UNIQUE(connection_id,provider_session_id));
CREATE TABLE public.pub4_account_bindings(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,connection_id text NOT NULL,
 platform text NOT NULL CHECK(platform IN ('linkedin','threads','instagram','KWAI','pinterest','wxGzh','bilibili','facebook','youtube','tiktok','twitter')),
 provider_account_id text NOT NULL,platform_uid text NOT NULL,account text NOT NULL DEFAULT '',display_name text NOT NULL,avatar text,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disconnected','unknown')),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 auth_session_id uuid NOT NULL,group_id uuid REFERENCES public.pub2_groups(id) ON DELETE SET NULL,disconnected_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,id),UNIQUE(connection_id,provider_account_id),
 UNIQUE(owner_id,connection_id,platform,platform_uid,account),FOREIGN KEY(owner_id,auth_session_id) REFERENCES public.pub4_auth_sessions(owner_id,id) ON DELETE CASCADE);
CREATE TABLE public.pub4_auth_operations(
 id uuid PRIMARY KEY,owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,connection_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('start','select','move_binding','disconnect_binding')),request_key text NOT NULL,request_payload jsonb NOT NULL,request_hash text NOT NULL,
 session_id uuid,binding_id uuid,provider_request jsonb NOT NULL DEFAULT '{}',provider_request_hash text NOT NULL,grant_kind text,grant_subject text,grant_used boolean NOT NULL DEFAULT false,
 dispatch_state text NOT NULL DEFAULT 'ready' CHECK(dispatch_state IN ('ready','dispatching','dispatched','unknown','settled','blocked')),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 result jsonb NOT NULL DEFAULT '{}',error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id),UNIQUE(owner_id,request_key),FOREIGN KEY(owner_id,session_id) REFERENCES public.pub4_auth_sessions(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,binding_id) REFERENCES public.pub4_account_bindings(owner_id,id) ON DELETE CASCADE);
CREATE TABLE public.pub4_auth_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 session_id uuid,operation_id uuid,binding_id uuid,kind text NOT NULL,source text NOT NULL CHECK(source IN ('system','provider_reported','browser_reported')),
 safe_payload jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,session_id) REFERENCES public.pub4_auth_sessions(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,operation_id) REFERENCES public.pub4_auth_operations(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,binding_id) REFERENCES public.pub4_account_bindings(owner_id,id) ON DELETE CASCADE);
CREATE UNIQUE INDEX pub4_selection_once ON public.pub4_auth_operations(session_id) WHERE kind='select' AND dispatch_state IN ('ready','dispatching','dispatched','unknown');
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['pub4_auth_sessions','pub4_account_bindings','pub4_auth_operations','pub4_auth_events'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',t);
  EXECUTE format('CREATE INDEX %I ON public.%I(owner_id,created_at DESC,id)',t||'_owner_created',t);
 END LOOP;
END$$;
CREATE FUNCTION public.pub4_canonical_json(p jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE v text;BEGIN
 IF jsonb_typeof(p)='object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(k)::text||':'||public.pub4_canonical_json(x),',' ORDER BY k COLLATE "C"),'')||'}' INTO v FROM jsonb_each(p) e(k,x);RETURN v;
 ELSIF jsonb_typeof(p)='array' THEN SELECT '['||coalesce(string_agg(public.pub4_canonical_json(x),',' ORDER BY n),'')||']' INTO v FROM jsonb_array_elements(p) WITH ORDINALITY e(x,n);RETURN v;
 ELSE RETURN p::text;END IF;
END$$;
CREATE FUNCTION public.pub4_keys(p jsonb,allowed text[],required text[]) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>262144 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT(k=ANY(allowed))) OR EXISTS(SELECT 1 FROM unnest(required) k WHERE NOT(p ? k) OR p->k='null'::jsonb) OR NOT public.pub3_no_credentials(p) THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
END$$;
CREATE FUNCTION public.pub4_uuid(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$SELECT coalesce(jsonb_typeof(p)='string' AND p#>>'{}' ~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$',false)$$;
CREATE FUNCTION public.pub4_revision(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$SELECT coalesce(jsonb_typeof(p)='number' AND p#>>'{}' ~ '^[1-9][0-9]{0,9}$' AND (p#>>'{}')::numeric<=2147483647,false)$$;
CREATE FUNCTION public.pub4_text(p jsonb,n integer,nonempty boolean DEFAULT true) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$SELECT coalesce(jsonb_typeof(p)='string' AND public.pub3_utf16_length(p#>>'{}')<=n AND (NOT nonempty OR length(btrim(p#>>'{}'))>0) AND p#>>'{}' !~ '[[:cntrl:]]',false)$$;
CREATE FUNCTION public.pub4_assert_display(p jsonb,p_platform text,p_session text) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE v_url text;v_authority text;v_path text;v_locale text;BEGIN
 PERFORM public.pub4_keys(p,ARRAY['authUrl','instructions'],ARRAY['authUrl']);
 IF NOT public.pub4_text(p->'authUrl',16384) THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 v_url=p->>'authUrl';
 IF v_url !~ '^https://' OR v_url ~ '[\\[:space:]]' OR v_url ~* '%(00|0a|0d)' OR v_url ~* '[?&]([^=&#]*(cookie|token|secret|password|credential|authorization|api.?key|signature|(code|pkce).?verifier)[^=&#]*|code|headers|continuation)=' THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 v_authority=split_part(substr(v_url,9),'/',1);v_path=split_part(split_part(substr(v_url,9+length(v_authority)),'?',1),'#',1);
 v_authority=lower(regexp_replace(v_authority,':443$',''));
 IF v_path ~ '%' OR (SELECT count(*) FROM regexp_matches(v_url,'[?&]state=([^&#]*)','g'))<>1 OR NOT EXISTS(SELECT 1 FROM regexp_matches(v_url,'[?&]state=([^&#]*)','g') m WHERE m[1]=p_session) THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 IF NOT (CASE p_platform
  WHEN 'linkedin' THEN v_authority='www.linkedin.com' AND v_path='/oauth/v2/authorization'
  WHEN 'threads' THEN v_authority='threads.net' AND v_path='/oauth/authorize'
  WHEN 'instagram' THEN v_authority='www.instagram.com' AND v_path='/oauth/authorize'
  WHEN 'KWAI' THEN v_authority='open.kuaishou.com' AND v_path='/oauth2/authorize'
  WHEN 'pinterest' THEN v_authority='www.pinterest.com' AND v_path='/oauth/'
  WHEN 'wxGzh' THEN v_authority='open.weixin.qq.com' AND v_path='/connect/oauth2/authorize'
  WHEN 'bilibili' THEN v_authority='account.bilibili.com' AND v_path='/pc/account-pc/auth/oauth'
  WHEN 'facebook' THEN v_authority='www.facebook.com' AND v_path ~ '^/v[1-9][0-9]?\.[0-9]{1,2}/dialog/oauth$'
  WHEN 'youtube' THEN v_authority='accounts.google.com' AND v_path='/o/oauth2/v2/auth'
  WHEN 'tiktok' THEN v_authority='www.tiktok.com' AND v_path='/v2/auth/authorize'
  WHEN 'twitter' THEN v_authority='x.com' AND v_path='/i/oauth2/authorize' ELSE false END) THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 IF EXISTS(SELECT 1 FROM regexp_matches(v_url,'[?&]response_type=([^&#]*)','g') m WHERE m[1]<>'code') THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 IF p_platform='wxGzh' THEN IF substring(v_url from '#.*$') IS DISTINCT FROM '#wechat_redirect' THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 ELSIF position('#' in v_url)>0 THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 IF p ? 'instructions' THEN
  PERFORM public.pub4_keys(p->'instructions',ARRAY['zh-CN','en-US'],ARRAY['zh-CN','en-US']);
  FOREACH v_locale IN ARRAY ARRAY['zh-CN','en-US'] LOOP IF jsonb_typeof(p->'instructions'->v_locale) IS DISTINCT FROM 'string' OR public.pub3_utf16_length(p->'instructions'->>v_locale)>2000 THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;END LOOP;
 END IF;
END$$;
CREATE FUNCTION public.pub4_assert_request(p jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE v_action text;BEGIN
 v_action=p->>'action';
 IF v_action='start' THEN
  PERFORM public.pub4_keys(p,ARRAY['action','platform','requestKey','groupId','expectedGroupRevision'],ARRAY['action','platform','requestKey']);
  IF jsonb_typeof(p->'platform') IS DISTINCT FROM 'string' OR p->>'platform' NOT IN ('linkedin','threads','instagram','KWAI','pinterest','wxGzh','bilibili','facebook','youtube','tiktok','twitter') OR (p ? 'groupId') IS DISTINCT FROM (p ? 'expectedGroupRevision') OR p ? 'groupId' AND (NOT public.pub4_uuid(p->'groupId') OR NOT public.pub4_revision(p->'expectedGroupRevision')) THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 ELSIF v_action='select' THEN
  PERFORM public.pub4_keys(p,ARRAY['action','sessionId','expectedRevision','choiceIds','requestKey'],ARRAY['action','sessionId','expectedRevision','choiceIds','requestKey']);
  IF NOT public.pub4_uuid(p->'sessionId') OR NOT public.pub4_revision(p->'expectedRevision') OR jsonb_typeof(p->'choiceIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'choiceIds') NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'choiceIds') x WHERE NOT public.pub4_uuid(x)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'choiceIds') x GROUP BY x HAVING count(*)>1) THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 ELSIF v_action IN ('disconnect','move-binding') THEN
  IF v_action='disconnect' THEN PERFORM public.pub4_keys(p,ARRAY['action','bindingId','expectedRevision','requestKey'],ARRAY['action','bindingId','expectedRevision','requestKey']);
  ELSE
   PERFORM public.pub4_keys(p,ARRAY['action','bindingId','expectedRevision','groupId','expectedGroupRevision','requestKey'],ARRAY['action','bindingId','expectedRevision','requestKey']);
   IF NOT(p ? 'groupId') OR p->'groupId'<>'null'::jsonb AND NOT public.pub4_uuid(p->'groupId') OR (p->'groupId'<>'null'::jsonb) IS DISTINCT FROM (p ? 'expectedGroupRevision') OR p ? 'expectedGroupRevision' AND NOT public.pub4_revision(p->'expectedGroupRevision') THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
  END IF;
  IF NOT public.pub4_uuid(p->'bindingId') OR NOT public.pub4_revision(p->'expectedRevision') THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 ELSE RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 IF NOT public.pub4_text(p->'requestKey',160) OR p->>'requestKey' !~ '^[A-Za-z0-9_.:-]+$' THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
END$$;
CREATE FUNCTION public.pub4_assert_identities(p jsonb,p_choices boolean,p_platform text) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE v_identity jsonb;v_key text;BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'array' OR jsonb_array_length(p)>100 THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 FOR v_identity IN SELECT entry.value FROM jsonb_array_elements(p) AS entry(value) LOOP
  IF p_choices THEN PERFORM public.pub4_keys(v_identity,ARRAY['id','platform','platformUid','account','displayName','avatar','parentDisplayName'],ARRAY['id','platform','platformUid','displayName']);IF NOT public.pub4_uuid(v_identity->'id') THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
  ELSE PERFORM public.pub4_keys(v_identity,ARRAY['providerAccountId','platform','platformUid','account','displayName','avatar'],ARRAY['providerAccountId','platform','platformUid','displayName']);IF NOT public.pub4_text(v_identity->'providerAccountId',240) OR v_identity->>'providerAccountId' !~ '^[A-Za-z0-9_.:-]+$' THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;END IF;
  IF v_identity->>'platform' IS DISTINCT FROM p_platform OR NOT public.pub4_text(v_identity->'platformUid',240) OR NOT public.pub4_text(v_identity->'displayName',240,false) THEN RAISE EXCEPTION 'PUBLISH_AUTH_PLATFORM_MISMATCH';END IF;
  FOREACH v_key IN ARRAY ARRAY['account','parentDisplayName'] LOOP IF v_identity ? v_key AND NOT public.pub4_text(v_identity->v_key,240,false) THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;END LOOP;
  IF v_identity ? 'avatar' AND (NOT public.pub4_text(v_identity->'avatar',2048) OR NOT public.pub2_safe_https(v_identity->>'avatar')) THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p) AS entry(value) GROUP BY entry.value->>'platformUid',coalesce(entry.value->>'account','') HAVING count(*)>1) OR p_choices AND EXISTS(SELECT 1 FROM jsonb_array_elements(p) AS entry(value) GROUP BY entry.value->>'id' HAVING count(*)>1) OR NOT p_choices AND EXISTS(SELECT 1 FROM jsonb_array_elements(p) AS entry(value) GROUP BY entry.value->>'providerAccountId' HAVING count(*)>1) THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
END$$;
CREATE FUNCTION public.pub4_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.users WHERE id=OLD.owner_id) THEN RETURN OLD;END IF;
 IF TG_OP='DELETE' OR TG_TABLE_NAME='pub4_auth_events' THEN RAISE EXCEPTION 'PUBLISH_AUTH_HISTORY_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='pub4_auth_operations' THEN
  IF (NEW.id,NEW.owner_id,NEW.connection_id,NEW.kind,NEW.request_key,NEW.request_payload,NEW.request_hash,NEW.session_id,NEW.binding_id,NEW.provider_request,NEW.provider_request_hash,NEW.grant_kind,NEW.grant_subject,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.connection_id,OLD.kind,OLD.request_key,OLD.request_payload,OLD.request_hash,OLD.session_id,OLD.binding_id,OLD.provider_request,OLD.provider_request_hash,OLD.grant_kind,OLD.grant_subject,OLD.created_at) OR OLD.grant_used AND NOT NEW.grant_used OR OLD.dispatch_state='settled' AND (NEW.dispatch_state,NEW.result,NEW.error_code) IS DISTINCT FROM (OLD.dispatch_state,OLD.result,OLD.error_code) THEN RAISE EXCEPTION 'PUBLISH_AUTH_HISTORY_IMMUTABLE';END IF;
 ELSIF TG_TABLE_NAME='pub4_auth_sessions' THEN
  IF (NEW.id,NEW.owner_id,NEW.connection_id,NEW.platform,NEW.request_key,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.connection_id,OLD.platform,OLD.request_key,OLD.created_at) OR OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id OR OLD.choices<>'[]' AND NEW.choices IS DISTINCT FROM OLD.choices OR OLD.state IN ('completed','failed') AND (NEW.state,NEW.completed_accounts,NEW.binding_ids,NEW.display) IS DISTINCT FROM (OLD.state,OLD.completed_accounts,OLD.binding_ids,OLD.display) THEN RAISE EXCEPTION 'PUBLISH_AUTH_HISTORY_IMMUTABLE';END IF;
 ELSE IF (NEW.id,NEW.owner_id,NEW.connection_id,NEW.platform,NEW.provider_account_id,NEW.platform_uid,NEW.account,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.connection_id,OLD.platform,OLD.provider_account_id,OLD.platform_uid,OLD.account,OLD.created_at) THEN RAISE EXCEPTION 'PUBLISH_AUTH_HISTORY_IMMUTABLE';END IF;END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER pub4_events_append_only BEFORE UPDATE OR DELETE ON public.pub4_auth_events FOR EACH ROW EXECUTE FUNCTION public.pub4_history_guard();
CREATE TRIGGER pub4_operations_immutable BEFORE UPDATE OR DELETE ON public.pub4_auth_operations FOR EACH ROW EXECUTE FUNCTION public.pub4_history_guard();
CREATE TRIGGER pub4_sessions_identity BEFORE UPDATE OR DELETE ON public.pub4_auth_sessions FOR EACH ROW EXECUTE FUNCTION public.pub4_history_guard();
CREATE TRIGGER pub4_bindings_identity BEFORE UPDATE OR DELETE ON public.pub4_account_bindings FOR EACH ROW EXECUTE FUNCTION public.pub4_history_guard();
CREATE FUNCTION public.pub4_group_unset_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF OLD.group_id IS NOT NULL AND NEW.group_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.pub2_groups WHERE id=OLD.group_id) AND EXISTS(SELECT 1 FROM public.users WHERE id=OLD.owner_id) THEN
  NEW.revision=OLD.revision+1;NEW.updated_at=now();
  INSERT INTO public.pub4_auth_events(owner_id,binding_id,kind,source,safe_payload) VALUES(OLD.owner_id,OLD.id,'group_removed','system',jsonb_build_object('revision',NEW.revision));
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER pub4_group_removed BEFORE UPDATE OF group_id ON public.pub4_account_bindings FOR EACH ROW EXECUTE FUNCTION public.pub4_group_unset_audit();
CREATE FUNCTION public.pub4_session_group_unset_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF OLD.target_group_id IS NOT NULL AND NEW.target_group_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.pub2_groups WHERE id=OLD.target_group_id) AND EXISTS(SELECT 1 FROM public.users WHERE id=OLD.owner_id) THEN
  NEW.revision=OLD.revision+1;NEW.updated_at=now();
  INSERT INTO public.pub4_auth_events(owner_id,session_id,kind,source,safe_payload) VALUES(OLD.owner_id,OLD.id,'target_group_removed','system',jsonb_build_object('revision',NEW.revision));
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER pub4_session_group_removed BEFORE UPDATE OF target_group_id ON public.pub4_auth_sessions FOR EACH ROW EXECUTE FUNCTION public.pub4_session_group_unset_audit();

CREATE FUNCTION public.mutate_publishing_authorization_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_action text;v_request jsonb;v_hash text;v_provider jsonb;v_provider_hash text;v_connection text;v_op public.pub4_auth_operations;v_session public.pub4_auth_sessions;v_binding public.pub4_account_bindings;v_group public.pub2_groups;v_x jsonb;v_accounts jsonb='[]';v_ids jsonb='[]';v_kind text;v_subject text;v_state text;v_expiry timestamptz;v_choices jsonb;v_constraint text;v_identity_account text;BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>262144 OR NOT public.pub3_no_credentials(p_input) THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 v_action=p_input->>'action';v_connection=p_input->>'connectionId';
 IF NOT public.pub4_text(p_input->'connectionId',160) THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
 IF v_action IN ('prepare-start','prepare-selection','move-binding','disconnect-binding') THEN
  IF v_action IN ('prepare-start','prepare-selection') THEN PERFORM public.pub4_keys(p_input,ARRAY['action','connectionId','operationId','sessionId','request','providerRequest','providerRequestHash'],ARRAY['action','connectionId','operationId','sessionId','request','providerRequest','providerRequestHash']);
  ELSE PERFORM public.pub4_keys(p_input,ARRAY['action','connectionId','operationId','request'],ARRAY['action','connectionId','operationId','request']);END IF;
  IF NOT public.pub4_uuid(p_input->'operationId') THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
  v_request=p_input->'request';PERFORM public.pub4_assert_request(v_request);
  IF (v_action='prepare-start' AND v_request->>'action'<>'start') OR (v_action='prepare-selection' AND v_request->>'action'<>'select') OR (v_action='move-binding' AND v_request->>'action'<>'move-binding') OR (v_action='disconnect-binding' AND v_request->>'action'<>'disconnect') THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
  v_hash=encode(sha256(convert_to(v_request::text,'UTF8')),'hex');
  SELECT * INTO v_op FROM public.pub4_auth_operations WHERE owner_id=p_user_id AND request_key=v_request->>'requestKey' FOR UPDATE;
  IF FOUND THEN IF v_op.request_hash IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'PUBLISH_AUTH_IDEMPOTENCY_CONFLICT';END IF;RETURN jsonb_build_object('operation',to_jsonb(v_op),'alreadyFulfilled',true);END IF;
  IF v_action='prepare-start' THEN
   IF NOT public.pub4_uuid(p_input->'sessionId') THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
   IF v_request ? 'groupId' THEN SELECT * INTO v_group FROM public.pub2_groups WHERE id=(v_request->>'groupId')::uuid AND user_id=p_user_id FOR UPDATE;IF NOT FOUND OR v_group.revision IS DISTINCT FROM (v_request->>'expectedGroupRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_AUTH_GROUP_CHANGED';END IF;END IF;
   v_provider=jsonb_build_object('type',v_request->>'platform','correlationId',p_input->>'sessionId','callbackUrl',NULL);v_kind='start';v_subject=p_input->>'sessionId';
   INSERT INTO public.pub4_auth_sessions(id,owner_id,connection_id,platform,request_key,target_group_id) VALUES((p_input->>'sessionId')::uuid,p_user_id,v_connection,v_request->>'platform',v_request->>'requestKey',(v_request->>'groupId')::uuid) RETURNING * INTO v_session;
  ELSIF v_action='prepare-selection' THEN
   IF NOT public.pub4_uuid(p_input->'sessionId') OR p_input->>'sessionId' IS DISTINCT FROM v_request->>'sessionId' THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
   SELECT * INTO v_session FROM public.pub4_auth_sessions WHERE id=(v_request->>'sessionId')::uuid AND owner_id=p_user_id FOR UPDATE;
   IF NOT FOUND OR v_session.connection_id IS DISTINCT FROM v_connection OR v_session.state IS DISTINCT FROM 'requires_selection' OR v_session.provider_session_id IS NULL OR v_session.expires_at IS NULL OR v_session.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PUBLISH_AUTH_RESTART_REQUIRED';END IF;
   IF v_session.revision IS DISTINCT FROM (v_request->>'expectedRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_AUTH_REVISION_CONFLICT';END IF;
   FOR v_x IN SELECT * FROM jsonb_array_elements(v_request->'choiceIds') LOOP
    SELECT x INTO v_choices FROM jsonb_array_elements(v_session.choices) x WHERE x->>'id'=v_x#>>'{}';IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_AUTH_SELECTION_INVALID';END IF;
    v_accounts=v_accounts||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('platformUid',v_choices->>'platformUid','account',v_choices->>'account')));
   END LOOP;
   v_provider=jsonb_build_object('accounts',v_accounts);v_kind='select';v_subject=v_session.provider_session_id||':selection';
  ELSE
   SELECT * INTO v_binding FROM public.pub4_account_bindings WHERE id=(v_request->>'bindingId')::uuid AND owner_id=p_user_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_AUTH_BINDING_NOT_FOUND';END IF;
   IF v_binding.connection_id IS DISTINCT FROM v_connection THEN RAISE EXCEPTION 'PUBLISH_AUTH_CONNECTION_CHANGED';END IF;
   IF v_binding.revision IS DISTINCT FROM (v_request->>'expectedRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_AUTH_REVISION_CONFLICT';END IF;
   IF v_action='move-binding' AND v_request->'groupId'<>'null'::jsonb THEN SELECT * INTO v_group FROM public.pub2_groups WHERE id=(v_request->>'groupId')::uuid AND user_id=p_user_id FOR UPDATE;IF NOT FOUND OR v_group.revision IS DISTINCT FROM (v_request->>'expectedGroupRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_AUTH_GROUP_CHANGED';END IF;END IF;
   IF v_action='disconnect-binding' THEN UPDATE public.pub4_account_bindings SET status='disconnected',disconnected_at=clock_timestamp(),revision=revision+1,updated_at=now() WHERE id=v_binding.id RETURNING * INTO v_binding;v_kind='disconnect_binding';
   ELSE UPDATE public.pub4_account_bindings SET group_id=(v_request->>'groupId')::uuid,revision=revision+1,updated_at=now() WHERE id=v_binding.id RETURNING * INTO v_binding;v_kind='move_binding';END IF;
   INSERT INTO public.pub4_auth_operations(id,owner_id,connection_id,kind,request_key,request_payload,request_hash,binding_id,provider_request_hash,dispatch_state,result) VALUES((p_input->>'operationId')::uuid,p_user_id,v_connection,v_kind,v_request->>'requestKey',v_request,v_hash,v_binding.id,encode(sha256(convert_to('{}','UTF8')),'hex'),'settled',jsonb_build_object('binding',to_jsonb(v_binding))) RETURNING * INTO v_op;
   INSERT INTO public.pub4_auth_events(owner_id,operation_id,binding_id,kind,source,safe_payload) VALUES(p_user_id,v_op.id,v_binding.id,v_kind,'system',jsonb_build_object('revision',v_binding.revision));
   RETURN jsonb_build_object('operation',to_jsonb(v_op),'binding',to_jsonb(v_binding),'alreadyFulfilled',false);
  END IF;
  IF p_input->'providerRequest' IS DISTINCT FROM v_provider OR NOT public.pub4_text(p_input->'providerRequestHash',64) THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
  v_provider_hash=encode(sha256(convert_to(public.pub4_canonical_json(v_provider),'UTF8')),'hex');
  IF p_input->>'providerRequestHash' IS DISTINCT FROM v_provider_hash THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
  INSERT INTO public.pub4_auth_operations(id,owner_id,connection_id,kind,request_key,request_payload,request_hash,session_id,provider_request,provider_request_hash,grant_kind,grant_subject) VALUES((p_input->>'operationId')::uuid,p_user_id,v_connection,v_kind,v_request->>'requestKey',v_request,v_hash,v_session.id,v_provider,v_provider_hash,'authorization',v_subject) RETURNING * INTO v_op;
  INSERT INTO public.pub4_auth_events(owner_id,session_id,operation_id,kind,source) VALUES(p_user_id,v_session.id,v_op.id,'prepared','system');
  RETURN jsonb_build_object('operation',to_jsonb(v_op),'session',to_jsonb(v_session),'alreadyFulfilled',false);
 END IF;
 IF v_action IN ('dispatch','consume-grant','record-start','record-unknown') THEN
  IF NOT public.pub4_uuid(p_input->'operationId') THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
  -- Actor lock serializes this owner; lock session before operation consistently.
  SELECT s.* INTO v_session FROM public.pub4_auth_sessions s JOIN public.pub4_auth_operations o ON o.session_id=s.id AND o.owner_id=s.owner_id WHERE o.id=(p_input->>'operationId')::uuid AND o.owner_id=p_user_id FOR UPDATE OF s;
  SELECT * INTO v_op FROM public.pub4_auth_operations WHERE id=(p_input->>'operationId')::uuid AND owner_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_op.connection_id IS DISTINCT FROM v_connection OR v_op.kind NOT IN ('start','select') THEN RAISE EXCEPTION 'PUBLISH_AUTH_OPERATION_NOT_FOUND';END IF;
  IF v_action='dispatch' THEN
   PERFORM public.pub4_keys(p_input,ARRAY['action','connectionId','operationId'],ARRAY['action','connectionId','operationId']);
   IF v_op.dispatch_state<>'ready' THEN RETURN jsonb_build_object('operation',to_jsonb(v_op),'shouldSend',false);END IF;
   IF v_op.kind='select' AND (v_session.state<>'requires_selection' OR v_session.expires_at IS NULL OR v_session.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'PUBLISH_AUTH_RESTART_REQUIRED';END IF;
   UPDATE public.pub4_auth_operations SET dispatch_state='dispatching',revision=revision+1,updated_at=now() WHERE id=v_op.id RETURNING * INTO v_op;
   RETURN jsonb_build_object('operation',to_jsonb(v_op),'shouldSend',true);
  ELSIF v_action='consume-grant' THEN
   PERFORM public.pub4_keys(p_input,ARRAY['action','connectionId','operationId','grantKind','grantSubject','providerRequestHash'],ARRAY['action','connectionId','operationId','grantKind','grantSubject','providerRequestHash']);
   IF NOT public.pub4_text(p_input->'grantKind',40) OR NOT public.pub4_text(p_input->'grantSubject',300) OR NOT public.pub4_text(p_input->'providerRequestHash',64) OR p_input->>'providerRequestHash' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
   IF v_op.dispatch_state IS DISTINCT FROM 'dispatching' OR v_op.grant_used OR p_input->>'grantKind' IS DISTINCT FROM v_op.grant_kind OR p_input->>'grantSubject' IS DISTINCT FROM v_op.grant_subject OR p_input->>'providerRequestHash' IS DISTINCT FROM v_op.provider_request_hash THEN RETURN jsonb_build_object('operation',to_jsonb(v_op),'consumed',false);END IF;
   IF v_op.kind='select' AND (v_session.state<>'requires_selection' OR v_session.expires_at IS NULL OR v_session.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'PUBLISH_AUTH_RESTART_REQUIRED';END IF;
   UPDATE public.pub4_auth_operations SET grant_used=true,revision=revision+1,updated_at=now() WHERE id=v_op.id RETURNING * INTO v_op;
   INSERT INTO public.pub4_auth_events(owner_id,session_id,operation_id,kind,source) VALUES(p_user_id,v_session.id,v_op.id,'grant_consumed','system');RETURN jsonb_build_object('operation',to_jsonb(v_op),'consumed',true);
  ELSIF v_action='record-start' THEN
   PERFORM public.pub4_keys(p_input,ARRAY['action','connectionId','operationId','expectedRevision','providerSessionId','expiresAt','display'],ARRAY['action','connectionId','operationId','expectedRevision','providerSessionId','expiresAt','display']);
   IF NOT public.pub4_revision(p_input->'expectedRevision') OR v_op.revision IS DISTINCT FROM (p_input->>'expectedRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_AUTH_REVISION_CONFLICT';END IF;
   IF v_op.kind<>'start' OR NOT v_op.grant_used OR v_op.dispatch_state NOT IN ('dispatching','unknown') OR NOT public.pub4_text(p_input->'providerSessionId',240) OR p_input->>'providerSessionId' !~ '^[A-Za-z0-9_.:-]+$' OR NOT public.pub4_text(p_input->'expiresAt',80) THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
   v_expiry=(p_input->>'expiresAt')::timestamptz;IF v_expiry<=clock_timestamp() OR v_expiry>clock_timestamp()+interval '30 minutes' THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
   PERFORM public.pub4_assert_display(p_input->'display',v_session.platform,p_input->>'providerSessionId');
   IF v_session.provider_session_id IS NOT NULL AND v_session.provider_session_id IS DISTINCT FROM p_input->>'providerSessionId' THEN RAISE EXCEPTION 'PUBLISH_AUTH_OUTCOME_CONFLICT';END IF;
   UPDATE public.pub4_auth_sessions SET provider_session_id=p_input->>'providerSessionId',expires_at=v_expiry,display=p_input->'display',state='pending',revision=revision+1,updated_at=now() WHERE id=v_session.id RETURNING * INTO v_session;
   UPDATE public.pub4_auth_operations SET dispatch_state='dispatched',revision=revision+1,result=jsonb_build_object('sessionId',v_session.id),updated_at=now() WHERE id=v_op.id RETURNING * INTO v_op;
   INSERT INTO public.pub4_auth_events(owner_id,session_id,operation_id,kind,source,safe_payload) VALUES(p_user_id,v_session.id,v_op.id,'started','provider_reported',jsonb_build_object('revision',v_session.revision));RETURN jsonb_build_object('operation',to_jsonb(v_op),'session',to_jsonb(v_session));
  ELSE
   PERFORM public.pub4_keys(p_input,ARRAY['action','connectionId','operationId','expectedRevision','errorCode'],ARRAY['action','connectionId','operationId','expectedRevision','errorCode']);
   IF NOT public.pub4_revision(p_input->'expectedRevision') OR v_op.revision IS DISTINCT FROM (p_input->>'expectedRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_AUTH_REVISION_CONFLICT';END IF;
   IF NOT public.pub4_text(p_input->'errorCode',100) OR p_input->>'errorCode' !~ '^[A-Z0-9_]+$' OR v_op.dispatch_state NOT IN ('dispatching','dispatched','unknown') THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
   UPDATE public.pub4_auth_operations SET dispatch_state='unknown',error_code=p_input->>'errorCode',revision=revision+1,updated_at=now() WHERE id=v_op.id RETURNING * INTO v_op;
   UPDATE public.pub4_auth_sessions SET state='unknown',revision=revision+1,error_code=p_input->>'errorCode',updated_at=now() WHERE id=v_session.id AND state IN ('prepared','pending','requires_selection','unknown');
   INSERT INTO public.pub4_auth_events(owner_id,session_id,operation_id,kind,source,safe_payload) VALUES(p_user_id,v_session.id,v_op.id,'outcome_unknown','system',jsonb_build_object('errorCode',p_input->>'errorCode'));RETURN jsonb_build_object('operation',to_jsonb(v_op));
  END IF;
 END IF;
 IF v_action='record-observation' THEN
  PERFORM public.pub4_keys(p_input,ARRAY['action','connectionId','sessionId','expectedRevision','providerSessionId','platform','state','choices','accounts','errorCode'],ARRAY['action','connectionId','sessionId','expectedRevision','providerSessionId','platform','state','choices','accounts']);
  IF NOT public.pub4_uuid(p_input->'sessionId') OR NOT public.pub4_revision(p_input->'expectedRevision') OR NOT public.pub4_text(p_input->'providerSessionId',240) OR p_input->>'providerSessionId' !~ '^[A-Za-z0-9_.:-]+$' OR NOT public.pub4_text(p_input->'platform',30) THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
  SELECT * INTO v_session FROM public.pub4_auth_sessions WHERE id=(p_input->>'sessionId')::uuid AND owner_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_session.connection_id IS DISTINCT FROM v_connection THEN RAISE EXCEPTION 'PUBLISH_AUTH_SESSION_NOT_FOUND';END IF;
  IF v_session.revision IS DISTINCT FROM (p_input->>'expectedRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_AUTH_REVISION_CONFLICT';END IF;
  IF p_input->>'providerSessionId' IS DISTINCT FROM v_session.provider_session_id OR v_session.provider_session_id IS NULL OR p_input->>'platform' IS DISTINCT FROM v_session.platform THEN RAISE EXCEPTION 'PUBLISH_AUTH_PLATFORM_MISMATCH';END IF;
  v_state=p_input->>'state';IF jsonb_typeof(p_input->'state') IS DISTINCT FROM 'string' OR v_state NOT IN ('pending','requires_selection','completed','failed') THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
  PERFORM public.pub4_assert_identities(p_input->'choices',true,v_session.platform);PERFORM public.pub4_assert_identities(p_input->'accounts',false,v_session.platform);
  IF p_input ? 'errorCode' AND (NOT public.pub4_text(p_input->'errorCode',100) OR p_input->>'errorCode' !~ '^[A-Z0-9_]+$') THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
  IF v_state='completed' AND jsonb_array_length(p_input->'accounts')=0 OR v_state<>'completed' AND p_input->'accounts'<>'[]' OR v_state='requires_selection' AND jsonb_array_length(p_input->'choices')=0 THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';END IF;
  IF v_session.state IN ('completed','failed') THEN
   IF v_state IS DISTINCT FROM v_session.state OR v_state='completed' AND p_input->'accounts' IS DISTINCT FROM v_session.completed_accounts THEN RAISE EXCEPTION 'PUBLISH_AUTH_OUTCOME_CONFLICT';END IF;
   RETURN jsonb_build_object('session',to_jsonb(v_session));
  END IF;
  IF v_session.expires_at IS NULL OR v_session.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PUBLISH_AUTH_RESTART_REQUIRED';END IF;
  IF p_input->'choices'<>'[]' AND v_session.choices<>'[]' AND p_input->'choices' IS DISTINCT FROM v_session.choices THEN RAISE EXCEPTION 'PUBLISH_AUTH_OUTCOME_CONFLICT';END IF;
  IF v_state='completed' THEN
   SELECT * INTO v_op FROM public.pub4_auth_operations WHERE owner_id=p_user_id AND session_id=v_session.id AND kind='select' AND grant_used ORDER BY created_at,id LIMIT 1 FOR UPDATE;
   FOR v_x IN SELECT * FROM jsonb_array_elements(p_input->'accounts') LOOP
    -- Fixed upstream account identity uses the additional account field only for YouTube.
    -- Other platforms' mutable handles must not replace a stable platform UID identity.
    v_identity_account=CASE WHEN v_session.platform='youtube' THEN coalesce(v_x->>'account','') ELSE '' END;
    IF v_session.choices<>'[]' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_session.choices) x WHERE x->>'platformUid'=v_x->>'platformUid' AND coalesce(x->>'account','')=coalesce(v_x->>'account','')) THEN RAISE EXCEPTION 'PUBLISH_AUTH_SELECTION_INVALID';END IF;
    -- An official owner-scoped completed status can finish an upstream browser selection.
    -- Once this host sent a selection, only its frozen chosen identities may bind.
    IF v_op.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_op.provider_request->'accounts') x WHERE x->>'platformUid'=v_x->>'platformUid' AND coalesce(x->>'account','')=coalesce(v_x->>'account','')) THEN RAISE EXCEPTION 'PUBLISH_AUTH_SELECTION_INVALID';END IF;
    SELECT * INTO v_binding FROM public.pub4_account_bindings WHERE connection_id=v_connection AND provider_account_id=v_x->>'providerAccountId' FOR UPDATE;
    IF FOUND AND (v_binding.owner_id IS DISTINCT FROM p_user_id OR v_binding.platform IS DISTINCT FROM v_session.platform OR v_binding.platform_uid IS DISTINCT FROM v_x->>'platformUid' OR v_binding.account IS DISTINCT FROM v_identity_account) THEN RAISE EXCEPTION 'PUBLISH_AUTH_ACCOUNT_ALREADY_OWNED';END IF;
    SELECT * INTO v_binding FROM public.pub4_account_bindings WHERE owner_id=p_user_id AND connection_id=v_connection AND platform=v_session.platform AND platform_uid=v_x->>'platformUid' AND account=v_identity_account FOR UPDATE;
    IF FOUND THEN
     IF v_binding.provider_account_id IS DISTINCT FROM v_x->>'providerAccountId' THEN RAISE EXCEPTION 'PUBLISH_AUTH_OUTCOME_CONFLICT';END IF;
     IF v_binding.status='disconnected' AND v_session.created_at<=v_binding.disconnected_at THEN RAISE EXCEPTION 'PUBLISH_AUTH_FRESH_SESSION_REQUIRED';END IF;
     IF (v_binding.status,v_binding.display_name,v_binding.avatar,v_binding.auth_session_id) IS DISTINCT FROM ('active',v_x->>'displayName',v_x->>'avatar',v_session.id) THEN
      UPDATE public.pub4_account_bindings SET status='active',display_name=v_x->>'displayName',avatar=v_x->>'avatar',auth_session_id=v_session.id,disconnected_at=NULL,revision=revision+1,updated_at=now() WHERE id=v_binding.id RETURNING * INTO v_binding;
     END IF;
    ELSE
     INSERT INTO public.pub4_account_bindings(owner_id,connection_id,platform,provider_account_id,platform_uid,account,display_name,avatar,auth_session_id,group_id) VALUES(p_user_id,v_connection,v_session.platform,v_x->>'providerAccountId',v_x->>'platformUid',v_identity_account,v_x->>'displayName',v_x->>'avatar',v_session.id,v_session.target_group_id) RETURNING * INTO v_binding;
    END IF;
    v_ids=v_ids||jsonb_build_array(v_binding.id);
   END LOOP;
  END IF;
  UPDATE public.pub4_auth_sessions SET state=v_state,choices=CASE WHEN choices='[]' THEN p_input->'choices' ELSE choices END,completed_accounts=CASE WHEN v_state='completed' THEN p_input->'accounts' ELSE completed_accounts END,binding_ids=CASE WHEN v_state='completed' THEN v_ids ELSE binding_ids END,error_code=p_input->>'errorCode',revision=revision+1,updated_at=now() WHERE id=v_session.id RETURNING * INTO v_session;
  IF v_state IN ('completed','failed') THEN UPDATE public.pub4_auth_operations SET dispatch_state='settled',result=jsonb_build_object('sessionId',v_session.id,'state',v_state,'bindingIds',v_session.binding_ids),revision=revision+1,updated_at=now() WHERE session_id=v_session.id AND owner_id=p_user_id AND dispatch_state<>'settled';END IF;
  INSERT INTO public.pub4_auth_events(owner_id,session_id,kind,source,safe_payload) VALUES(p_user_id,v_session.id,'observed','provider_reported',jsonb_build_object('state',v_state,'revision',v_session.revision,'bindingIds',v_session.binding_ids));
  RETURN jsonb_build_object('session',to_jsonb(v_session));
 END IF;
 RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN RAISE EXCEPTION 'PUBLISH_AUTH_INPUT_INVALID';
 WHEN unique_violation THEN GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
  IF v_constraint='pub4_account_bindings_connection_id_provider_account_id_key' THEN RAISE EXCEPTION 'PUBLISH_AUTH_ACCOUNT_ALREADY_OWNED';
  ELSIF v_constraint='pub4_selection_once' THEN RAISE EXCEPTION 'PUBLISH_AUTH_SELECTION_ALREADY_SUBMITTED';
  ELSE RAISE EXCEPTION 'PUBLISH_AUTH_OUTCOME_CONFLICT';END IF;
END$$;
REVOKE ALL ON FUNCTION public.mutate_publishing_authorization_atomic(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_publishing_authorization_atomic(text,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.pub4_canonical_json(jsonb),public.pub4_keys(jsonb,text[],text[]),public.pub4_uuid(jsonb),public.pub4_revision(jsonb),public.pub4_text(jsonb,integer,boolean),public.pub4_assert_display(jsonb,text,text),public.pub4_assert_request(jsonb),public.pub4_assert_identities(jsonb,boolean,text),public.pub4_history_guard(),public.pub4_group_unset_audit(),public.pub4_session_group_unset_audit() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
