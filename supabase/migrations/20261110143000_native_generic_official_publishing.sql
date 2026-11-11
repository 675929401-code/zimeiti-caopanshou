-- CANDIDATE ONLY. Applying this migration requires the separate database gate.
-- Reuses pub_assert_actor's users row lock. No second wallet or provider engine.
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';

ALTER TABLE public.pub_config_versions DROP CONSTRAINT pub_config_versions_enabled_platforms_check;
ALTER TABLE public.pub_config_versions ADD CONSTRAINT pub_config_versions_enabled_platforms_check CHECK(jsonb_typeof(enabled_platforms)='array' AND enabled_platforms <@ '["xhs","douyin","wxSph","linkedin","threads","instagram","KWAI","pinterest","wxGzh","bilibili","facebook","youtube","tiktok","twitter"]');
ALTER TABLE public.pub_plan_versions DROP CONSTRAINT pub_plan_versions_platforms_check;
ALTER TABLE public.pub_plan_versions ADD CONSTRAINT pub_plan_versions_platforms_check CHECK(jsonb_typeof(platforms)='array' AND jsonb_array_length(platforms)>0 AND platforms <@ '["xhs","douyin","wxSph","linkedin","threads","instagram","KWAI","pinterest","wxGzh","bilibili","facebook","youtube","tiktok","twitter"]');

CREATE TABLE public.pub5_studio_drafts(
 id uuid PRIMARY KEY,owner_id varchar(36) NOT NULL REFERENCES public.users(id),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 archived boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,id)
);
CREATE TABLE public.pub5_draft_profiles(
 owner_id varchar(36) NOT NULL REFERENCES public.users(id),draft_id uuid NOT NULL,draft_version integer NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(draft_id,draft_version),FOREIGN KEY(owner_id,draft_id) REFERENCES public.pub5_studio_drafts(owner_id,id)
);
CREATE TABLE public.pub5_operations(
 id uuid PRIMARY KEY,owner_id varchar(36) NOT NULL REFERENCES public.users(id),namespace text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('publish','task_change')),request_key text NOT NULL,request_payload jsonb NOT NULL,
 snapshot jsonb NOT NULL,snapshot_hash text NOT NULL CHECK(snapshot_hash~'^[a-f0-9]{64}$'),
 provider_request_hash text NOT NULL CHECK(provider_request_hash~'^[a-f0-9]{64}$'),
 grant_kind text NOT NULL CHECK(grant_kind IN ('create_flow','task_change')),grant_subject text NOT NULL,grant_used boolean NOT NULL DEFAULT false,
 dispatch_id uuid,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','dispatching','submitted','succeeded','partial','failed_known','unknown','blocked')),
 target_ids uuid[] NOT NULL,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id),UNIQUE(owner_id,request_key),UNIQUE(namespace,grant_kind,grant_subject,request_key)
);
CREATE TABLE public.pub5_targets(
 id uuid PRIMARY KEY,owner_id varchar(36) NOT NULL REFERENCES public.users(id),operation_id uuid NOT NULL,
 draft_id uuid NOT NULL,draft_version integer NOT NULL,profile_target_id uuid NOT NULL,
 binding_id uuid NOT NULL,binding_revision integer NOT NULL,platform text NOT NULL CHECK(platform IN ('linkedin','threads','instagram','KWAI','pinterest','wxGzh','bilibili','facebook','youtube','tiktok','twitter')),
 entitlement_id uuid REFERENCES public.pub_entitlements(id),admitted boolean NOT NULL DEFAULT false,released boolean NOT NULL DEFAULT false,
 payload jsonb NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','queued','publishing','published','failed_known','cancelled','unknown','blocked')),
 publish_at timestamptz NOT NULL,provider_record_id text,provider_task_id text,work_id text,work_link text,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id),UNIQUE(owner_id,draft_id,draft_version,profile_target_id),
 FOREIGN KEY(owner_id,operation_id) REFERENCES public.pub5_operations(owner_id,id),
 FOREIGN KEY(owner_id,binding_id) REFERENCES public.pub4_account_bindings(owner_id,id),
 FOREIGN KEY(draft_id,draft_version) REFERENCES public.pub5_draft_profiles(draft_id,draft_version),
 CHECK(NOT released OR admitted),CHECK(NOT admitted OR entitlement_id IS NOT NULL)
);
CREATE UNIQUE INDEX pub5_provider_record_once ON public.pub5_targets(operation_id,provider_record_id) WHERE provider_record_id IS NOT NULL;
CREATE INDEX pub5_calendar_owner ON public.pub5_targets(owner_id,publish_at,id);
CREATE TABLE public.pub5_target_media_refs(
 owner_id varchar(36) NOT NULL,target_id uuid NOT NULL,media_id uuid NOT NULL,asset_id uuid NOT NULL REFERENCES public.pub3_assets(id),
 source jsonb NOT NULL,bridge_id uuid REFERENCES public.pub_native_media_bridges(id),media_entry_id uuid REFERENCES public.pub_native_media_entries(id),
 PRIMARY KEY(target_id,media_id),FOREIGN KEY(owner_id,target_id) REFERENCES public.pub5_targets(owner_id,id)
);
CREATE TABLE public.pub5_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id varchar(36) NOT NULL,operation_id uuid NOT NULL,
 kind text NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,operation_id) REFERENCES public.pub5_operations(owner_id,id)
);
CREATE TABLE public.pub5_requests(
 owner_id varchar(36) NOT NULL REFERENCES public.users(id),request_key text NOT NULL,payload jsonb NOT NULL,input jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,request_key)
);
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['pub5_studio_drafts','pub5_draft_profiles','pub5_operations','pub5_targets','pub5_target_media_refs','pub5_events','pub5_requests'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',t);
 END LOOP;
END $$;
CREATE FUNCTION public.pub5_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_HISTORY_IMMUTABLE';END IF;
 IF TG_TABLE_NAME IN ('pub5_events','pub5_requests','pub5_target_media_refs','pub5_draft_profiles','pub5_browser_plans') THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_HISTORY_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='pub5_operations' AND (to_jsonb(NEW)-ARRAY['state','revision','dispatch_id','grant_used','error_code','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','dispatch_id','grant_used','error_code','updated_at']) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_HISTORY_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='pub5_targets' AND (to_jsonb(NEW)-ARRAY['state','revision','entitlement_id','admitted','released','publish_at','provider_record_id','provider_task_id','work_id','work_link','error_code','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','entitlement_id','admitted','released','publish_at','provider_record_id','provider_task_id','work_id','work_link','error_code','updated_at']) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_HISTORY_IMMUTABLE';END IF;
 RETURN NEW;
END $$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['pub5_draft_profiles','pub5_operations','pub5_targets','pub5_target_media_refs','pub5_events','pub5_requests'] LOOP
 EXECUTE format('CREATE TRIGGER pub5_history BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.pub5_history_guard()',t);
END LOOP;END $$;

CREATE FUNCTION public.publishing_accounted_used(p_entitlement uuid) RETURNS bigint LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT (SELECT count(*) FROM public.pub_tasks WHERE entitlement_id=p_entitlement)
 +(SELECT count(*) FROM public.pub2_attempts WHERE entitlement_id=p_entitlement)
 +(SELECT count(*) FROM public.pub3_operations WHERE entitlement_id=p_entitlement AND kind='publish')
 -(SELECT count(*) FROM public.pub3_quota_releases WHERE entitlement_id=p_entitlement)
 +(SELECT count(*) FROM public.pub5_targets WHERE entitlement_id=p_entitlement AND admitted AND NOT released)
$$;

CREATE FUNCTION public.pub5_assert_profile(p_owner text,p_draft jsonb,p_profile jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t jsonb;m text;v_kind text;v_platform text;BEGIN
 PERFORM public.pub2_assert_json_keys(p_profile,ARRAY['schemaVersion','targets'],ARRAY['schemaVersion','targets']);
 IF p_profile->>'schemaVersion'<>'1' OR jsonb_typeof(p_profile->'targets')<>'array' OR jsonb_array_length(p_profile->'targets')>100 THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_INPUT_INVALID';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_profile->'targets') x GROUP BY x->>'id' HAVING count(*)>1) OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_profile->'targets') x GROUP BY x->>'accountId' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_INPUT_INVALID';END IF;
 FOR t IN SELECT * FROM jsonb_array_elements(p_profile->'targets') LOOP
  PERFORM public.pub2_assert_json_keys(t,ARRAY['id','accountId','accountKind','platform','accountRevision','title','body','topics','mediaIds','coverMediaId','publishAt','options'],ARRAY['id','accountId','accountKind','platform','accountRevision','title','body','topics','mediaIds','publishAt','options']);
  v_kind:=t->>'accountKind';v_platform:=t->>'platform';
  IF (v_kind='browser' AND v_platform NOT IN ('xhs','wxSph','douyin')) OR (v_kind='official' AND v_platform<>'douyin') OR (v_kind='generic' AND v_platform NOT IN ('linkedin','threads','instagram','KWAI','pinterest','wxGzh','bilibili','facebook','youtube','tiktok','twitter')) OR v_kind NOT IN ('browser','official','generic') THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_INPUT_INVALID';END IF;
  IF jsonb_typeof(t->'mediaIds')<>'array' OR jsonb_array_length(t->'mediaIds')>100 OR jsonb_typeof(t->'topics')<>'array' OR jsonb_typeof(t->'options')<>'object' OR (t->>'accountRevision')::integer<1 THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_INPUT_INVALID';END IF;
  IF (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(t->'mediaIds'))<>jsonb_array_length(t->'mediaIds') THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_INPUT_INVALID';END IF;
  FOR m IN SELECT value FROM jsonb_array_elements_text(t->'mediaIds'||CASE WHEN t ? 'coverMediaId' THEN jsonb_build_array(t->>'coverMediaId') ELSE '[]'::jsonb END) LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_draft->'media') x WHERE x->>'id'=m) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
  END LOOP;
  IF v_kind='generic' AND NOT EXISTS(SELECT 1 FROM public.pub4_account_bindings WHERE owner_id=p_owner AND id=(t->>'accountId')::uuid AND platform=v_platform) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_OWNER_MISMATCH';END IF;
  IF v_kind='official' AND NOT EXISTS(SELECT 1 FROM public.pub3_account_bindings WHERE owner_id=p_owner AND id=(t->>'accountId')::uuid) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_OWNER_MISMATCH';END IF;
  IF v_kind='browser' AND NOT EXISTS(SELECT 1 FROM public.pub_accounts WHERE user_id=p_owner AND id=(t->>'accountId')::uuid AND platform=v_platform) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_OWNER_MISMATCH';END IF;
 END LOOP;
END $$;

CREATE FUNCTION public.pub5_wire_body(p_body text,p_topics jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE topic text;normalized text;tags text[]:='{}';seen text[]:='{}';clean text;BEGIN
 clean:=regexp_replace(regexp_replace(coalesce(p_body,''),'#([^\s#]+)(\[话题\])?#?','','g'),'^\s+|\s+$','','g');
 FOR topic IN SELECT (regexp_matches(coalesce(p_body,''),'#([^\s#]+)(\[话题\])?#?','g'))[1] UNION ALL SELECT value FROM jsonb_array_elements_text(p_topics) LOOP
  normalized:=regexp_replace(regexp_replace(replace(topic,'[话题]',''),'^#+|#+$','','g'),'^\s+|\s+$','','g');
  IF normalized<>'' AND NOT lower(normalized)=ANY(seen) THEN seen:=array_append(seen,lower(normalized));tags:=array_append(tags,'#'||normalized);END IF;
 END LOOP;
 RETURN concat_ws(E'\n',nullif(clean,''),nullif(array_to_string(tags,' '),''));
END $$;

CREATE FUNCTION public.pub5_assert_snapshot(p_owner text,p_namespace text,s jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t jsonb;m jsonb;w jsonb;v_content jsonb;v_media jsonb;v_cover jsonb;v_options jsonb;v_body text;a public.pub3_assets%ROWTYPE;b public.pub4_account_bindings%ROWTYPE;v_payload jsonb;v_profile jsonb;v_meta jsonb;v_config public.pub_config_versions%ROWTYPE;BEGIN
 PERFORM public.pub2_assert_json_keys(s,ARRAY['version','kind','namespace','draftId','draftVersion','draftPayload','profileRevision','profilePayload','configVersion','capabilitiesHash','expiresAt','targets','wireRequest'],ARRAY['version','kind','namespace','draftId','draftVersion','draftPayload','profileRevision','profilePayload','configVersion','capabilitiesHash','expiresAt','targets','wireRequest']);
 IF s->>'version'<>'1' OR s->>'kind'<>'publish' OR s->>'namespace' IS DISTINCT FROM p_namespace OR (s->>'expiresAt')::timestamptz<=now() OR jsonb_array_length(s->'targets') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_SNAPSHOT_INVALID';END IF;
 SELECT v.payload INTO v_payload FROM public.pub5_studio_drafts d JOIN public.pub5_draft_profiles v ON v.draft_id=d.id AND v.draft_version=d.revision WHERE d.owner_id=p_owner AND NOT d.archived AND d.id=(s->>'draftId')::uuid AND d.revision=(s->>'draftVersion')::integer;
 IF NOT FOUND OR v_payload IS DISTINCT FROM s->'draftPayload' THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_DRAFT_CHANGED';END IF;
 SELECT payload->'profile' INTO v_profile FROM public.pub5_draft_profiles WHERE owner_id=p_owner AND draft_id=(s->>'draftId')::uuid AND draft_version=(s->>'draftVersion')::integer AND revision=(s->>'profileRevision')::integer;
 IF NOT FOUND OR v_profile IS DISTINCT FROM s->'profilePayload' THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_DRAFT_CHANGED';END IF;
 v_meta:=jsonb_build_object('media',v_payload->'sources');
 SELECT * INTO v_config FROM public.pub_config_versions ORDER BY version DESC LIMIT 1;
 IF v_config.version IS DISTINCT FROM (s->>'configVersion')::integer OR NOT v_config.execution_enabled THEN RAISE EXCEPTION 'PUBLISH_EXECUTION_DISABLED';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'targets') x GROUP BY x->>'bindingId' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_INPUT_INVALID';END IF;
 PERFORM public.pub2_assert_json_keys(s->'wireRequest',ARRAY['flowId','publishAt','content','items'],ARRAY['flowId','publishAt','content','items']);
 IF jsonb_typeof(s->'wireRequest'->'items')<>'array' OR jsonb_array_length(s->'wireRequest'->'items')<>jsonb_array_length(s->'targets') OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'wireRequest'->'items') x GROUP BY x->>'accountId' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_WIRE_INVALID';END IF;
 FOR t IN SELECT * FROM jsonb_array_elements(s->'targets') LOOP
  PERFORM public.pub2_assert_json_keys(t,ARRAY['id','profileTargetId','bindingId','bindingRevision','platform','providerAccountId','accountName','profile','media'],ARRAY['id','profileTargetId','bindingId','bindingRevision','platform','providerAccountId','accountName','profile','media']);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_profile->'targets') x WHERE x=t->'profile' AND x->>'id'=t->>'profileTargetId' AND x->>'accountId'=t->>'bindingId' AND x->>'accountKind'='generic') THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_SNAPSHOT_INVALID';END IF;
  IF t->'profile'->>'publishAt' IS NOT NULL THEN
   IF (t->'profile'->>'publishAt')::timestamptz IS DISTINCT FROM (s->'wireRequest'->>'publishAt')::timestamptz THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_WIRE_INVALID';END IF;
  ELSIF (s->'wireRequest'->>'publishAt')::timestamptz NOT BETWEEN (s->>'expiresAt')::timestamptz-interval '16 minutes' AND (s->>'expiresAt')::timestamptz-interval '14 minutes' THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_WIRE_INVALID';END IF;
  SELECT * INTO b FROM public.pub4_account_bindings WHERE owner_id=p_owner AND id=(t->>'bindingId')::uuid AND connection_id=p_namespace AND status='active' FOR SHARE;
  IF NOT FOUND OR b.revision IS DISTINCT FROM (t->>'bindingRevision')::integer OR b.platform IS DISTINCT FROM t->>'platform' OR b.provider_account_id IS DISTINCT FROM t->>'providerAccountId' OR NOT(v_config.enabled_platforms ? b.platform) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_BINDING_CHANGED';END IF;
  IF jsonb_array_length(t->'media')<>(SELECT count(DISTINCT value) FROM jsonb_array_elements_text((t->'profile'->'mediaIds')||CASE WHEN t->'profile' ? 'coverMediaId' THEN jsonb_build_array(t->'profile'->>'coverMediaId') ELSE '[]'::jsonb END)) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(t->'media') x GROUP BY x->>'mediaId' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
  FOR m IN SELECT * FROM jsonb_array_elements(t->'media') LOOP
   PERFORM public.pub2_assert_json_keys(m,ARRAY['mediaId','assetId','source','bridgeId','mediaEntryId'],ARRAY['mediaId','assetId','source','bridgeId','mediaEntryId']);
   IF NOT((t->'profile'->'mediaIds') ? (m->>'mediaId')) AND t->'profile'->>'coverMediaId' IS DISTINCT FROM m->>'mediaId' THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
   SELECT * INTO a FROM public.pub3_assets WHERE id=(m->>'assetId')::uuid AND owner_id=p_owner AND connection_id=p_namespace AND state='ready' FOR SHARE;
   IF NOT FOUND OR a.provider_asset_id IS NULL OR a.public_url IS NULL THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'media') x WHERE x->>'id'=m->>'mediaId' AND (x->>'size')::bigint=a.size AND x->>'type'=a.mime AND x->>'hash'=a.sha256) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_meta->'media') x WHERE x->>'mediaId'=m->>'mediaId' AND ((x->>'assetId'=a.id::text AND m->'source'->>'kind'='provider_asset' AND m->'source'->>'assetId'=a.id::text) OR x->'source'=m->'source')) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
   IF m->'source'->>'kind'='provider_asset' THEN
    IF m->'source'->>'assetId'<>a.id::text OR m->>'bridgeId' IS NOT NULL THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
   ELSE
    IF NOT EXISTS(SELECT 1 FROM public.pub_native_media_bridges br WHERE br.id=(m->>'bridgeId')::uuid AND br.owner_id=p_owner AND br.namespace=p_namespace AND br.media_id=(m->>'mediaId')::uuid AND br.reference=m->'source'->'reference' AND br.state='ready' AND br.asset_id=a.id AND (br.snapshot->'file'->>'size')::bigint=a.size AND br.snapshot->'file'->>'mime'=a.mime AND br.snapshot->'file'->>'sha256'=a.sha256) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
    IF NOT EXISTS(SELECT 1 FROM public.pub_native_media_bridges br WHERE br.id=(m->>'bridgeId')::uuid AND br.snapshot->>'sourceFingerprint'=public.native_media_source_fingerprint(p_owner,m->'source'->'reference') AND public.native_media_bridge_proven(p_owner,p_namespace,m->'source'->'reference',(m->>'mediaId')::uuid,jsonb_build_object('id',a.id,'mediaId',a.local_media_id,'sha256',a.sha256,'size',a.size,'mime',a.mime))) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
   END IF;
   IF m->>'mediaEntryId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.pub_native_media_entries e WHERE e.id=(m->>'mediaEntryId')::uuid AND e.owner_id=p_owner AND public.native_media_entry_source(e)=m->'source' AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'sources') src WHERE src->>'mediaId'=m->>'mediaId' AND src->>'mediaEntryId'=e.id::text)) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
  END LOOP;
  SELECT x INTO w FROM jsonb_array_elements(s->'wireRequest'->'items') x WHERE x->>'accountId'=b.provider_account_id;
  PERFORM public.pub2_assert_json_keys(w,ARRAY['platform','accountId','option','overrides'],ARRAY['platform','accountId','option','overrides']);
  IF w->>'platform' IS DISTINCT FROM b.platform THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_WIRE_INVALID';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('url',a2.public_url) ORDER BY ids.n),'[]'::jsonb) INTO v_media FROM jsonb_array_elements_text(t->'profile'->'mediaIds') WITH ORDINALITY ids(id,n) JOIN jsonb_array_elements(t->'media') m2 ON m2->>'mediaId'=ids.id JOIN public.pub3_assets a2 ON a2.id=(m2->>'assetId')::uuid AND a2.owner_id=p_owner;
  v_cover:=NULL;IF t->'profile' ? 'coverMediaId' THEN SELECT jsonb_build_object('url',a2.public_url) INTO v_cover FROM jsonb_array_elements(t->'media') m2 JOIN public.pub3_assets a2 ON a2.id=(m2->>'assetId')::uuid AND a2.owner_id=p_owner WHERE m2->>'mediaId'=t->'profile'->>'coverMediaId';END IF;
  v_options:=t->'profile'->'options';IF b.platform='pinterest' AND v_payload->>'contentType'='video' AND v_cover IS NOT NULL THEN v_options:=v_options||jsonb_build_object('coverImageUrl',v_cover->'url');END IF;
  IF w->'option' IS DISTINCT FROM v_options THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_WIRE_INVALID';END IF;
  v_body:=CASE WHEN b.platform='linkedin' AND jsonb_typeof(v_options->'commentary')='string' THEN v_options->>'commentary' ELSE public.pub5_wire_body(t->'profile'->>'body',t->'profile'->'topics') END;
  v_content:=jsonb_build_object('body',v_body,'media',v_media)||CASE WHEN w->'overrides' ? 'title' THEN jsonb_build_object('title',t->'profile'->'title') ELSE '{}'::jsonb END||CASE WHEN v_cover IS NOT NULL THEN jsonb_build_object('cover',v_cover) ELSE '{}'::jsonb END;
  IF w->'overrides' IS DISTINCT FROM v_content THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_WIRE_INVALID';END IF;
 END LOOP;
 IF s->'wireRequest'->'content' IS DISTINCT FROM s->'wireRequest'->'items'->0->'overrides' THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_WIRE_INVALID';END IF;
END $$;

CREATE FUNCTION public.mutate_native_official_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_action text:=p_input->>'action';v_namespace text:=p_input->>'namespace';o public.pub5_operations%ROWTYPE;t public.pub5_targets%ROWTYPE;e public.pub_entitlements%ROWTYPE;r public.pub5_requests%ROWTYPE;d public.pub5_studio_drafts%ROWTYPE;s jsonb;g jsonb;x jsonb;m jsonb;v_ids uuid[]:='{}';v_targets uuid[];v_result jsonb;v_count integer;v_state text;v_request jsonb:=p_input->'request';v_change text;BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 IF v_namespace IS NULL OR length(v_namespace)>240 THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_INPUT_INVALID';END IF;
 IF v_action IN ('save-draft','prepare','prepare-change') THEN
  SELECT * INTO r FROM public.pub5_requests WHERE owner_id=p_user_id AND request_key=p_input->>'requestKey';
  IF FOUND THEN IF r.payload IS DISTINCT FROM v_request OR r.input IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;RETURN r.result||'{"alreadyFulfilled":true}'::jsonb;END IF;
 END IF;
 IF v_action='save-draft' THEN
  PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','namespace','requestKey','request','draftId','expectedRevision','draft'],ARRAY['action','namespace','requestKey','request','draftId','expectedRevision','draft']);
  s:=p_input->'draft';PERFORM public.pub2_assert_json_keys(s,ARRAY['schemaVersion','contentType','title','body','topics','media','coverMediaId','publishAt','sources','profile'],ARRAY['schemaVersion','contentType','title','body','topics','media','publishAt','sources','profile']);
  IF v_request->'draft' IS DISTINCT FROM s OR v_request->>'action'<>'save-draft' OR v_request->>'requestKey' IS DISTINCT FROM p_input->>'requestKey' OR (v_request->>'expectedRevision')::integer IS DISTINCT FROM (p_input->>'expectedRevision')::integer OR (v_request ? 'id' AND v_request->>'id' IS DISTINCT FROM p_input->>'draftId') THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;
  IF s->>'schemaVersion'<>'1' OR s->>'contentType' NOT IN ('text','image','video') OR length(s->>'body')>100000 OR length(s->>'title')>10000 OR jsonb_typeof(s->'media')<>'array' OR jsonb_array_length(s->'media')>100 OR jsonb_typeof(s->'sources')<>'array' OR jsonb_array_length(s->'sources')<>jsonb_array_length(s->'media') THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_DRAFT_INVALID';END IF;
  PERFORM public.pub5_assert_profile(p_user_id,s,s->'profile');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'sources') x GROUP BY x->>'mediaId' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
  FOR m IN SELECT * FROM jsonb_array_elements(s->'sources') LOOP
   PERFORM public.pub2_assert_json_keys(m,ARRAY['mediaId','source','mediaEntryId'],ARRAY['mediaId','source']);
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'media') x WHERE x->>'id'=m->>'mediaId') THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
   IF m->'source'->>'kind'='provider_asset' THEN
    IF NOT EXISTS(SELECT 1 FROM public.pub3_assets a JOIN jsonb_array_elements(s->'media') x ON x->>'id'=m->>'mediaId' WHERE a.id=(m->'source'->>'assetId')::uuid AND a.owner_id=p_user_id AND a.connection_id=v_namespace AND a.state='ready' AND a.sha256=x->>'hash' AND a.size=(x->>'size')::bigint AND a.mime=x->>'type') THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
   ELSIF m->'source'->>'kind'='main_asset' THEN PERFORM public.native_ai_assert_source(p_user_id,m->'source');
   ELSE RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
   IF m->>'mediaEntryId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.pub_native_media_entries e WHERE e.id=(m->>'mediaEntryId')::uuid AND e.owner_id=p_user_id AND NOT e.archived AND public.native_media_entry_source(e)=m->'source') THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_MEDIA_INVALID';END IF;
  END LOOP;
  IF (p_input->>'expectedRevision')::integer=0 THEN
   INSERT INTO public.pub5_studio_drafts(id,owner_id) VALUES((p_input->>'draftId')::uuid,p_user_id) RETURNING * INTO d;
  ELSE
   SELECT * INTO d FROM public.pub5_studio_drafts WHERE id=(p_input->>'draftId')::uuid AND owner_id=p_user_id AND NOT archived FOR UPDATE;
   IF NOT FOUND OR d.revision IS DISTINCT FROM (p_input->>'expectedRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT';END IF;
   UPDATE public.pub5_studio_drafts SET revision=revision+1,updated_at=now() WHERE id=d.id RETURNING * INTO d;
  END IF;
  INSERT INTO public.pub5_draft_profiles(owner_id,draft_id,draft_version,payload) VALUES(p_user_id,d.id,d.revision,s);
  v_result:=jsonb_build_object('draftId',d.id,'draftVersion',d.revision,'profileRevision',1,'operationIds','[]'::jsonb,'alreadyFulfilled',false);
 ELSIF v_action='prepare' THEN
  PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','namespace','requestKey','request','groups'],ARRAY['action','namespace','requestKey','request','groups']);
  IF jsonb_typeof(p_input->'groups')<>'array' OR jsonb_array_length(p_input->'groups') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_INPUT_INVALID';END IF;
  IF v_request->>'action'<>'prepare' OR v_request->>'requestKey' IS DISTINCT FROM p_input->>'requestKey' OR jsonb_typeof(v_request->'targetIds')<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'groups') gr WHERE gr->'snapshot'->>'draftId' IS DISTINCT FROM v_request->>'draftId' OR gr->'snapshot'->'draftVersion' IS DISTINCT FROM v_request->'draftVersion' OR gr->'snapshot'->'profileRevision' IS DISTINCT FROM v_request->'profileRevision') OR (SELECT array_agg(x ORDER BY x) FROM jsonb_array_elements_text(v_request->'targetIds') x) IS DISTINCT FROM (SELECT array_agg(tg->>'profileTargetId' ORDER BY tg->>'profileTargetId') FROM jsonb_array_elements(p_input->'groups') gr CROSS JOIN LATERAL jsonb_array_elements(gr->'snapshot'->'targets') tg) THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;
  FOR g IN SELECT * FROM jsonb_array_elements(p_input->'groups') LOOP
   PERFORM public.pub2_assert_json_keys(g,ARRAY['id','requestKey','snapshot','snapshotHash','providerRequestHash'],ARRAY['id','requestKey','snapshot','snapshotHash','providerRequestHash']);
   s:=g->'snapshot';PERFORM public.pub5_assert_snapshot(p_user_id,v_namespace,s);
   SELECT array_agg((q->>'id')::uuid ORDER BY ord) INTO v_targets FROM jsonb_array_elements(s->'targets') WITH ORDINALITY f(q,ord);
   INSERT INTO public.pub5_operations(id,owner_id,namespace,kind,request_key,request_payload,snapshot,snapshot_hash,provider_request_hash,grant_kind,grant_subject,target_ids)
    VALUES((g->>'id')::uuid,p_user_id,v_namespace,'publish',g->>'requestKey',v_request,s,g->>'snapshotHash',g->>'providerRequestHash','create_flow',s->'wireRequest'->>'flowId',v_targets) RETURNING * INTO o;
   IF o.grant_subject IS DISTINCT FROM 'native-official:'||o.id::text THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_INPUT_INVALID';END IF;
   FOR x IN SELECT * FROM jsonb_array_elements(s->'targets') LOOP
    INSERT INTO public.pub5_targets(id,owner_id,operation_id,draft_id,draft_version,profile_target_id,binding_id,binding_revision,platform,payload,publish_at)
     VALUES((x->>'id')::uuid,p_user_id,o.id,(s->>'draftId')::uuid,(s->>'draftVersion')::integer,(x->>'profileTargetId')::uuid,(x->>'bindingId')::uuid,(x->>'bindingRevision')::integer,x->>'platform',x,(s->'wireRequest'->>'publishAt')::timestamptz);
    FOR m IN SELECT * FROM jsonb_array_elements(x->'media') LOOP INSERT INTO public.pub5_target_media_refs(owner_id,target_id,media_id,asset_id,source,bridge_id,media_entry_id) VALUES(p_user_id,(x->>'id')::uuid,(m->>'mediaId')::uuid,(m->>'assetId')::uuid,m->'source',(m->>'bridgeId')::uuid,(m->>'mediaEntryId')::uuid);END LOOP;
   END LOOP;
   INSERT INTO public.pub5_events(owner_id,operation_id,kind,evidence) VALUES(p_user_id,o.id,'prepared',jsonb_build_object('snapshotHash',o.snapshot_hash));
   v_ids:=array_append(v_ids,o.id);
  END LOOP;
  v_result:=jsonb_build_object('operationIds',to_jsonb(v_ids),'alreadyFulfilled',false);
 ELSIF v_action='prepare-change' THEN
  PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','namespace','requestKey','request','operationId','targetId','expectedRevision','snapshot','snapshotHash','providerRequestHash'],ARRAY['action','namespace','requestKey','request','operationId','targetId','expectedRevision','snapshot','snapshotHash','providerRequestHash']);
  SELECT * INTO t FROM public.pub5_targets WHERE id=(p_input->>'targetId')::uuid AND owner_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR t.revision IS DISTINCT FROM (p_input->>'expectedRevision')::integer OR t.state NOT IN ('queued','failed_known') OR t.provider_task_id IS NULL THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_TASK_STATE_INVALID';END IF;
  SELECT * INTO o FROM public.pub5_operations WHERE id=t.operation_id AND owner_id=p_user_id;
  IF o.namespace IS DISTINCT FROM v_namespace THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_CONNECTION_CHANGED';END IF;
  IF EXISTS(SELECT 1 FROM public.pub5_operations WHERE owner_id=p_user_id AND kind='task_change' AND t.id=ANY(target_ids) AND state IN ('prepared','dispatching','unknown','submitted')) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_TASK_PENDING';END IF;
  s:=p_input->'snapshot';v_change:=s->>'change';
  IF v_request->>'action'<>'change-task' OR v_request->>'requestKey' IS DISTINCT FROM p_input->>'requestKey' OR v_request->>'targetId' IS DISTINCT FROM t.id::text OR (v_request->>'expectedRevision')::integer IS DISTINCT FROM t.revision OR (CASE WHEN v_request->>'change'='publish_now' THEN 'publish-now' ELSE v_request->>'change' END) IS DISTINCT FROM v_change OR coalesce(v_request->'publishAt','null'::jsonb) IS DISTINCT FROM s->'publishAt' THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;
  IF v_change NOT IN ('cancel','reschedule','publish-now') OR s->>'taskId' IS DISTINCT FROM t.provider_task_id OR s->>'recordId' IS DISTINCT FROM t.provider_record_id OR s->>'targetId' IS DISTINCT FROM t.id::text OR (s->>'targetRevision')::integer IS DISTINCT FROM t.revision OR s->>'accountId' IS DISTINCT FROM t.payload->>'providerAccountId' THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_SNAPSHOT_INVALID';END IF;
  IF v_change='reschedule' AND (s->>'publishAt')::timestamptz<=now() THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_INPUT_INVALID';END IF;
  INSERT INTO public.pub5_operations(id,owner_id,namespace,kind,request_key,request_payload,snapshot,snapshot_hash,provider_request_hash,grant_kind,grant_subject,target_ids)
   VALUES((p_input->>'operationId')::uuid,p_user_id,v_namespace,'task_change',p_input->>'requestKey',v_request,s,p_input->>'snapshotHash',p_input->>'providerRequestHash','task_change',t.provider_task_id||':'||v_change,ARRAY[t.id]) RETURNING * INTO o;
  v_result:=jsonb_build_object('operationIds',jsonb_build_array(o.id),'alreadyFulfilled',false);
 ELSIF v_action='claim' THEN
  PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','namespace','operationId','expectedRevision','snapshotHash','dispatchId'],ARRAY['action','namespace','operationId','expectedRevision','snapshotHash','dispatchId']);
  SELECT * INTO o FROM public.pub5_operations WHERE owner_id=p_user_id AND id=(p_input->>'operationId')::uuid FOR UPDATE;
  IF NOT FOUND OR o.namespace IS DISTINCT FROM v_namespace THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_OPERATION_NOT_FOUND';END IF;
  IF o.state<>'prepared' THEN RETURN jsonb_build_object('operationIds',jsonb_build_array(o.id),'shouldDispatch',false,'alreadyFulfilled',true);END IF;
  IF o.revision IS DISTINCT FROM (p_input->>'expectedRevision')::integer OR o.snapshot_hash IS DISTINCT FROM p_input->>'snapshotHash' THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT';END IF;
  PERFORM public.pub5_acquire_dispatch(p_user_id,v_namespace,o.id,ARRAY(SELECT b.platform||':'||b.platform_uid||CASE WHEN b.platform='youtube' THEN ':'||b.account ELSE '' END FROM public.pub5_targets t JOIN public.pub4_account_bindings b ON b.id=t.binding_id AND b.owner_id=p_user_id WHERE t.id=ANY(o.target_ids) ORDER BY b.id));
  IF o.kind='publish' THEN
   PERFORM public.pub5_assert_snapshot(p_user_id,v_namespace,o.snapshot);
   FOR t IN SELECT * FROM public.pub5_targets WHERE operation_id=o.id AND owner_id=p_user_id ORDER BY id FOR UPDATE LOOP
    SELECT * INTO e FROM public.pub_entitlements WHERE user_id=p_user_id AND expires_at>now() AND platforms ? t.platform AND used<quota ORDER BY expires_at,id LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_NO_QUOTA';END IF;
    IF e.used::bigint IS DISTINCT FROM public.publishing_accounted_used(e.id) THEN RAISE EXCEPTION 'NATIVE_QUOTA_ACCOUNTING_MISMATCH';END IF;
    UPDATE public.pub_entitlements SET used=used+1 WHERE id=e.id;
    UPDATE public.pub5_targets SET admitted=true,entitlement_id=e.id,revision=revision+1,updated_at=now() WHERE id=t.id;
   END LOOP;
   INSERT INTO public.pub5_events(owner_id,operation_id,kind,evidence) VALUES(p_user_id,o.id,'admitted',jsonb_build_object('units',cardinality(o.target_ids)));
  ELSE
   SELECT * INTO t FROM public.pub5_targets WHERE id=o.target_ids[1] AND owner_id=p_user_id FOR UPDATE;
   IF t.revision IS DISTINCT FROM (o.snapshot->>'targetRevision')::integer OR t.state NOT IN ('queued','failed_known') THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_TASK_STATE_INVALID';END IF;
  END IF;
  UPDATE public.pub5_operations SET state='dispatching',dispatch_id=(p_input->>'dispatchId')::uuid,revision=revision+1,updated_at=now() WHERE id=o.id RETURNING * INTO o;
  RETURN jsonb_build_object('operationIds',jsonb_build_array(o.id),'shouldDispatch',true,'alreadyFulfilled',false);
 ELSIF v_action='consume-grant' THEN
  PERFORM public.pub5_assert_dispatch(p_user_id,v_namespace,(p_input->>'operationId')::uuid);
  PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','namespace','operationId','dispatchId','grantKind','grantSubject','providerRequestHash'],ARRAY['action','namespace','operationId','dispatchId','grantKind','grantSubject','providerRequestHash']);
  SELECT * INTO o FROM public.pub5_operations WHERE owner_id=p_user_id AND id=(p_input->>'operationId')::uuid FOR UPDATE;
  IF NOT FOUND OR o.namespace IS DISTINCT FROM v_namespace OR o.dispatch_id IS DISTINCT FROM (p_input->>'dispatchId')::uuid OR o.grant_kind IS DISTINCT FROM p_input->>'grantKind' OR o.grant_subject IS DISTINCT FROM p_input->>'grantSubject' OR o.provider_request_hash IS DISTINCT FROM p_input->>'providerRequestHash' THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_GRANT_INVALID';END IF;
  IF o.grant_used OR o.state<>'dispatching' THEN RETURN '{"consumed":false}'::jsonb;END IF;
  IF o.kind='publish' THEN PERFORM public.pub5_assert_snapshot(p_user_id,v_namespace,o.snapshot);
  ELSE
   SELECT * INTO t FROM public.pub5_targets WHERE owner_id=p_user_id AND id=o.target_ids[1] FOR UPDATE;
   IF NOT FOUND OR t.revision IS DISTINCT FROM (o.snapshot->>'targetRevision')::integer OR t.state<>'queued' OR t.provider_record_id IS DISTINCT FROM o.snapshot->>'recordId' OR t.provider_task_id IS DISTINCT FROM o.snapshot->>'taskId' OR t.payload->>'providerAccountId' IS DISTINCT FROM o.snapshot->>'accountId' THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_TASK_STATE_INVALID';END IF;
   IF NOT EXISTS(SELECT 1 FROM public.pub4_account_bindings WHERE owner_id=p_user_id AND id=t.binding_id AND connection_id=v_namespace AND status='active' AND revision=t.binding_revision AND provider_account_id=o.snapshot->>'accountId') THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_BINDING_CHANGED';END IF;
  END IF;
  UPDATE public.pub5_operations SET grant_used=true,revision=revision+1,updated_at=now() WHERE id=o.id;
  INSERT INTO public.pub5_events(owner_id,operation_id,kind,evidence) VALUES(p_user_id,o.id,'provider_attempt',jsonb_build_object('dispatchId',o.dispatch_id));
  RETURN '{"consumed":true}'::jsonb;
 ELSIF v_action IN ('record-result','record-unknown','block-unissued') THEN
  PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','namespace','operationId','dispatchId','expectedRevision','results','errorCode'],ARRAY['action','namespace','operationId','dispatchId','expectedRevision']);
  SELECT * INTO o FROM public.pub5_operations WHERE owner_id=p_user_id AND id=(p_input->>'operationId')::uuid FOR UPDATE;
  IF NOT FOUND OR o.namespace IS DISTINCT FROM v_namespace OR o.dispatch_id IS DISTINCT FROM (p_input->>'dispatchId')::uuid OR o.revision IS DISTINCT FROM (p_input->>'expectedRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT';END IF;
  IF v_action='block-unissued' THEN
   IF o.grant_used OR o.state NOT IN ('prepared','dispatching') OR EXISTS(SELECT 1 FROM public.pub5_events WHERE operation_id=o.id AND kind IN ('provider_attempt','provider_result','unknown')) THEN RAISE EXCEPTION 'NATIVE_QUOTA_NOT_UNISSUED';END IF;
   FOR t IN SELECT * FROM public.pub5_targets WHERE operation_id=o.id AND owner_id=p_user_id AND admitted AND NOT released ORDER BY id FOR UPDATE LOOP
    SELECT * INTO e FROM public.pub_entitlements WHERE id=t.entitlement_id AND user_id=p_user_id FOR UPDATE;
    IF e.used<1 OR e.used::bigint IS DISTINCT FROM public.publishing_accounted_used(e.id) THEN RAISE EXCEPTION 'NATIVE_QUOTA_ACCOUNTING_MISMATCH';END IF;
    UPDATE public.pub_entitlements SET used=used-1 WHERE id=e.id;
    UPDATE public.pub5_targets SET released=true,state='blocked',revision=revision+1,updated_at=now() WHERE id=t.id;
   END LOOP;
   UPDATE public.pub5_targets SET state='blocked',revision=revision+1,updated_at=now() WHERE operation_id=o.id AND state='prepared' AND NOT admitted;
   UPDATE public.pub5_operations SET state='blocked',error_code=p_input->>'errorCode',revision=revision+1,updated_at=now() WHERE id=o.id;
   INSERT INTO public.pub5_events(owner_id,operation_id,kind,evidence) VALUES(p_user_id,o.id,'blocked_unissued',jsonb_build_object('errorCode',p_input->>'errorCode'));
  ELSIF v_action='record-unknown' THEN
   IF o.state IN ('succeeded','blocked') THEN RETURN jsonb_build_object('operationIds',jsonb_build_array(o.id),'alreadyFulfilled',true);END IF;
   UPDATE public.pub5_operations SET state='unknown',error_code=p_input->>'errorCode',revision=revision+1,updated_at=now() WHERE id=o.id;
   UPDATE public.pub5_targets SET state='unknown',revision=revision+1,updated_at=now() WHERE operation_id=o.id AND state NOT IN ('published','cancelled');
   INSERT INTO public.pub5_events(owner_id,operation_id,kind,evidence) VALUES(p_user_id,o.id,'unknown',jsonb_build_object('errorCode',p_input->>'errorCode'));
  ELSE
   IF NOT o.grant_used OR jsonb_typeof(p_input->'results')<>'array' OR jsonb_array_length(p_input->'results')<>cardinality(o.target_ids) OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'results') q GROUP BY q->>'targetId' HAVING count(*)>1) OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'results') q GROUP BY q->>'recordId' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_RESULT_INVALID';END IF;
   FOR x IN SELECT * FROM jsonb_array_elements(p_input->'results') LOOP
    PERFORM public.pub2_assert_json_keys(x,ARRAY['targetId','expectedRevision','accountId','platform','recordId','taskId','state','workId','workLink','publishAt','errorCode'],ARRAY['targetId','expectedRevision','accountId','platform','recordId','taskId','state','workId','workLink','publishAt','errorCode']);
    SELECT * INTO t FROM public.pub5_targets WHERE id=(x->>'targetId')::uuid AND owner_id=p_user_id AND id=ANY(o.target_ids) FOR UPDATE;
    IF NOT FOUND OR t.revision IS DISTINCT FROM (x->>'expectedRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT';END IF;
    IF t.state='cancelled' AND x->>'state'<>'cancelled' THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_RESULT_CONFLICT';END IF;
    IF NOT FOUND OR x->>'accountId' IS DISTINCT FROM t.payload->>'providerAccountId' OR x->>'platform' IS DISTINCT FROM t.platform OR x->>'recordId' IS NULL OR (t.provider_record_id IS NOT NULL AND t.provider_record_id IS DISTINCT FROM x->>'recordId') OR (t.provider_task_id IS NOT NULL AND t.provider_task_id IS DISTINCT FROM x->>'taskId') OR x->>'state' NOT IN ('queued','publishing','published','failed_known','cancelled','unknown') THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_RESULT_INVALID';END IF;
    IF t.state='published' AND (x->>'state'<>'published' OR t.work_id IS DISTINCT FROM x->>'workId' OR t.work_link IS DISTINCT FROM x->>'workLink') THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_RESULT_CONFLICT';END IF;
    IF x->>'state'='published' AND (x->>'workId' IS NULL OR public.pub2_safe_https(x->>'workLink') IS NOT TRUE) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_RESULT_UNVERIFIED';END IF;
    IF o.kind='task_change' THEN
     IF (o.snapshot->>'change'='cancel' AND x->>'state'<>'cancelled') OR (o.snapshot->>'change'='reschedule' AND (x->>'state'<>'queued' OR (x->>'publishAt')::timestamptz IS DISTINCT FROM (o.snapshot->>'publishAt')::timestamptz)) OR (o.snapshot->>'change'='publish-now' AND x->>'state' NOT IN ('publishing','published','failed_known')) THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_TASK_UNCONFIRMED';END IF;
    END IF;
    IF ROW(t.state,t.provider_record_id,t.provider_task_id,t.work_id,t.work_link,t.publish_at,t.error_code) IS DISTINCT FROM ROW(x->>'state',x->>'recordId',x->>'taskId',x->>'workId',x->>'workLink',(x->>'publishAt')::timestamptz,x->>'errorCode') THEN
     UPDATE public.pub5_targets SET state=x->>'state',provider_record_id=x->>'recordId',provider_task_id=x->>'taskId',work_id=x->>'workId',work_link=x->>'workLink',publish_at=(x->>'publishAt')::timestamptz,error_code=x->>'errorCode',revision=revision+1,updated_at=now() WHERE id=t.id;
    END IF;
   END LOOP;
   SELECT CASE WHEN o.kind='task_change' THEN 'succeeded' WHEN bool_and(state='published') THEN 'succeeded' WHEN bool_or(state='unknown') THEN 'unknown' WHEN bool_and(state IN ('failed_known','cancelled')) THEN 'failed_known' WHEN bool_or(state IN ('failed_known','cancelled')) THEN 'partial' ELSE 'submitted' END INTO v_state FROM public.pub5_targets WHERE id=ANY(o.target_ids) AND owner_id=p_user_id;
   IF o.state IS DISTINCT FROM v_state OR o.error_code IS NOT NULL THEN UPDATE public.pub5_operations SET state=v_state,error_code=NULL,revision=revision+1,updated_at=now() WHERE id=o.id;END IF;
   INSERT INTO public.pub5_events(owner_id,operation_id,kind,evidence) VALUES(p_user_id,o.id,'provider_result',jsonb_build_object('results',p_input->'results'));
  END IF;
  RETURN jsonb_build_object('operationIds',jsonb_build_array(o.id),'alreadyFulfilled',false);
 ELSE RAISE EXCEPTION 'NATIVE_OFFICIAL_INPUT_INVALID';
 END IF;
 INSERT INTO public.pub5_requests(owner_id,request_key,payload,input,result) VALUES(p_user_id,p_input->>'requestKey',v_request,p_input,v_result);
 RETURN v_result;
END $$;

-- Forward replacement only: retain every original release proof/guard and replace
-- its accounting expression. Fail closed if the reviewed source has drifted.
DO $$DECLARE body text;old_expression text;BEGIN
 body:=pg_get_functiondef('public.release_native_unissued_quota_atomic(text,uuid,integer)'::regprocedure);
 old_expression:='SELECT (SELECT count(*) FROM public.pub_tasks WHERE entitlement_id=v_ent.id)'
 ||E'\n       +(SELECT count(*) FROM public.pub2_attempts WHERE entitlement_id=v_ent.id)'
 ||E'\n       +(SELECT count(*) FROM public.pub3_operations WHERE entitlement_id=v_ent.id AND kind=''publish'')'
 ||E'\n       -(SELECT count(*) FROM public.pub3_quota_releases WHERE entitlement_id=v_ent.id)';
 IF position(old_expression IN body)=0 THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_RELEASE_SOURCE_DRIFT';END IF;
 EXECUTE replace(body,old_expression,'SELECT public.publishing_accounted_used(v_ent.id)');
END $$;


-- Verified official bindings alone can reserve canonical identities. Browser UID
-- summaries never enter this table and cannot exclude another member.
CREATE TABLE public.pub5_official_identity_claims(
 namespace text NOT NULL,platform text NOT NULL,platform_uid text NOT NULL,subaccount text NOT NULL DEFAULT '',
 owner_id varchar(36) NOT NULL REFERENCES public.users(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(namespace,platform,platform_uid,subaccount)
);
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM (
  SELECT connection_id AS namespace,platform,platform_uid,''::text AS subaccount,owner_id FROM public.pub3_account_bindings
  UNION ALL SELECT connection_id,platform,platform_uid,CASE WHEN platform='youtube' THEN account ELSE '' END,owner_id FROM public.pub4_account_bindings
 ) b GROUP BY namespace,platform,platform_uid,subaccount HAVING count(DISTINCT owner_id)>1) THEN RAISE EXCEPTION 'PUBLISH_OFFICIAL_IDENTITY_CONFLICT_PREFLIGHT';END IF;
 INSERT INTO public.pub5_official_identity_claims(namespace,platform,platform_uid,subaccount,owner_id)
 SELECT namespace,platform,platform_uid,subaccount,min(owner_id) FROM (
  SELECT connection_id AS namespace,platform,platform_uid,''::text AS subaccount,owner_id FROM public.pub3_account_bindings
  UNION ALL SELECT connection_id,platform,platform_uid,CASE WHEN platform='youtube' THEN account ELSE '' END,owner_id FROM public.pub4_account_bindings
 ) b GROUP BY namespace,platform,platform_uid,subaccount;
END $$;
CREATE FUNCTION public.pub5_claim_official_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sub text;claim_owner text;BEGIN
 IF TG_TABLE_NAME NOT IN ('pub3_account_bindings','pub4_account_bindings') OR length(coalesce(NEW.platform_uid,''))=0 THEN RAISE EXCEPTION 'PUBLISH_OFFICIAL_IDENTITY_INVALID';END IF;
 sub:=CASE WHEN TG_TABLE_NAME='pub4_account_bindings' AND NEW.platform='youtube' THEN to_jsonb(NEW)->>'account' ELSE '' END;
 IF TG_OP='UPDATE' AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN RAISE EXCEPTION 'PUBLISH_OFFICIAL_IDENTITY_CONFLICT';END IF;
 INSERT INTO public.pub5_official_identity_claims(namespace,platform,platform_uid,subaccount,owner_id) VALUES(NEW.connection_id,NEW.platform,NEW.platform_uid,coalesce(sub,''),NEW.owner_id) ON CONFLICT DO NOTHING;
 SELECT owner_id INTO claim_owner FROM public.pub5_official_identity_claims WHERE namespace=NEW.connection_id AND platform=NEW.platform AND platform_uid=NEW.platform_uid AND subaccount=coalesce(sub,'') FOR UPDATE;
 IF claim_owner IS DISTINCT FROM NEW.owner_id THEN RAISE EXCEPTION 'PUBLISH_OFFICIAL_IDENTITY_CONFLICT';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pub5_official_identity BEFORE INSERT OR UPDATE ON public.pub3_account_bindings FOR EACH ROW EXECUTE FUNCTION public.pub5_claim_official_identity();
CREATE TRIGGER pub5_official_identity BEFORE INSERT OR UPDATE ON public.pub4_account_bindings FOR EACH ROW EXECUTE FUNCTION public.pub5_claim_official_identity();

-- Across instances: at most four in-flight publishing mutations per provider
-- namespace. HTTP timeout is twenty seconds; sixty seconds releases a crashed
-- process's network slot only, never its unknown account/request ownership.
CREATE TABLE public.pub5_dispatch_leases(
 operation_id uuid PRIMARY KEY,owner_id varchar(36) NOT NULL REFERENCES public.users(id),namespace text NOT NULL,
 account_keys text[] NOT NULL,active_until timestamptz NOT NULL,account_held boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Preserve already admitted legacy work, including unknown outcomes. Never open
-- a new account dispatch merely because these records predate the lease table.
DO $$DECLARE o public.pub3_operations%ROWTYPE;identity text;BEGIN
 FOR o IN SELECT * FROM public.pub3_operations WHERE kind IN ('publish','task_change') AND (dispatch_state IN ('ready','dispatching','unknown') OR outcome='unknown') LOOP
  IF o.kind='publish' THEN identity:=o.snapshot->'binding'->>'platformUid';
  ELSE SELECT snapshot->'binding'->>'platformUid' INTO identity FROM public.pub3_operations WHERE id=o.subject_id AND owner_id=o.owner_id AND kind='publish';END IF;
  IF coalesce(identity,'')='' THEN RAISE EXCEPTION 'PUBLISH_LEGACY_DISPATCH_IDENTITY_PREFLIGHT';END IF;
  INSERT INTO public.pub5_dispatch_leases(operation_id,owner_id,namespace,account_keys,active_until) VALUES(o.id,o.owner_id,o.connection_id,ARRAY['douyin:'||identity],clock_timestamp()+interval '60 seconds');
 END LOOP;
END $$;
CREATE FUNCTION public.pub5_acquire_dispatch(p_owner text,p_namespace text,p_operation uuid,p_accounts text[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE prior public.pub5_dispatch_leases%ROWTYPE;BEGIN
 IF cardinality(p_accounts)<1 OR EXISTS(SELECT 1 FROM unnest(p_accounts) a WHERE a IS NULL OR a='') THEN RAISE EXCEPTION 'PUBLISH_DISPATCH_IDENTITY_INVALID';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('publishing-dispatch:'||p_namespace,0));
 SELECT * INTO prior FROM public.pub5_dispatch_leases WHERE operation_id=p_operation FOR UPDATE;
 IF FOUND THEN
  IF prior.owner_id IS DISTINCT FROM p_owner OR prior.namespace IS DISTINCT FROM p_namespace OR prior.account_keys IS DISTINCT FROM p_accounts THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;
  IF prior.active_until>clock_timestamp() AND prior.account_held THEN RETURN;END IF;
  IF prior.account_held AND EXISTS(SELECT 1 FROM public.pub3_operations WHERE id=p_operation AND owner_id=p_owner AND NOT grant_used AND dispatch_state IN ('ready','dispatching')) THEN
   IF (SELECT count(*) FROM public.pub5_dispatch_leases WHERE namespace=p_namespace AND operation_id<>p_operation AND active_until>clock_timestamp())>=4 THEN RAISE EXCEPTION 'PUBLISH_PROVIDER_BUSY';END IF;
   UPDATE public.pub5_dispatch_leases SET active_until=clock_timestamp()+interval '60 seconds' WHERE operation_id=p_operation;RETURN;
  END IF;
  RAISE EXCEPTION 'PUBLISH_DISPATCH_EXPIRED';
 END IF;
 IF EXISTS(SELECT 1 FROM public.pub5_dispatch_leases WHERE namespace=p_namespace AND account_held AND account_keys&&p_accounts) OR (SELECT count(*) FROM public.pub5_dispatch_leases WHERE namespace=p_namespace AND active_until>clock_timestamp())>=4 THEN RAISE EXCEPTION 'PUBLISH_PROVIDER_BUSY';END IF;
 INSERT INTO public.pub5_dispatch_leases(operation_id,owner_id,namespace,account_keys,active_until) VALUES(p_operation,p_owner,p_namespace,p_accounts,clock_timestamp()+interval '60 seconds');
END $$;
CREATE FUNCTION public.pub5_assert_dispatch(p_owner text,p_namespace text,p_operation uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pub5_dispatch_leases WHERE operation_id=p_operation AND owner_id=p_owner AND namespace=p_namespace AND account_held AND active_until>clock_timestamp()) THEN RAISE EXCEPTION 'PUBLISH_DISPATCH_EXPIRED';END IF;
END $$;
CREATE FUNCTION public.pub5_finish_dispatch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE state text;known boolean;BEGIN
 state:=CASE WHEN TG_TABLE_NAME='pub5_operations' THEN to_jsonb(NEW)->>'state' ELSE to_jsonb(NEW)->>'dispatch_state' END;
 IF state IN ('prepared','ready','dispatching') THEN RETURN NEW;END IF;
 known:=state='blocked' OR state<>'unknown' AND coalesce(to_jsonb(NEW)->>'outcome','')<>'unknown';
 UPDATE public.pub5_dispatch_leases SET active_until=least(active_until,clock_timestamp()),account_held=NOT known WHERE operation_id=NEW.id AND owner_id=NEW.owner_id;
 RETURN NEW;
END $$;
CREATE TRIGGER pub5_dispatch_finish AFTER UPDATE ON public.pub5_operations FOR EACH ROW EXECUTE FUNCTION public.pub5_finish_dispatch();
CREATE TRIGGER pub5_dispatch_finish AFTER UPDATE ON public.pub3_operations FOR EACH ROW EXECUTE FUNCTION public.pub5_finish_dispatch();

-- Extend the existing official wrapper before its quota claim. Existing engine,
-- bridge checks and once-only permits continue to own dispatch.
DO $$DECLARE body text;anchor text;BEGIN
 body:=pg_get_functiondef('public.mutate_publish_v3_atomic(text,jsonb)'::regprocedure);
 anchor:='PERFORM public.pub_assert_actor(p_user_id);PERFORM public.pub3_assert_input(p_input);';
 IF position(anchor IN body)=0 THEN RAISE EXCEPTION 'PUBLISH_DISPATCH_V3_SOURCE_DRIFT';END IF;
 body:=replace(body,anchor,anchor||$forward$
 IF p_input->>'action' IN ('submit','prepare-change') AND NOT EXISTS(SELECT 1 FROM public.pub3_operations WHERE owner_id=p_user_id AND request_key=p_input->>'requestKey') THEN
  IF p_input->>'action'='submit' THEN
   SELECT * INTO intent FROM public.pub3_intents WHERE id=(p_input->>'intentId')::uuid AND owner_id=p_user_id;
   PERFORM public.pub5_acquire_dispatch(p_user_id,p_input->>'connectionId',(p_input->>'operationId')::uuid,ARRAY[(SELECT platform||':'||platform_uid FROM public.pub3_account_bindings WHERE id=intent.binding_id AND owner_id=p_user_id)]);
  ELSE
   SELECT * INTO op FROM public.pub3_operations WHERE id=(p_input->>'parentOperationId')::uuid AND owner_id=p_user_id;
   PERFORM public.pub5_acquire_dispatch(p_user_id,p_input->>'connectionId',(p_input->>'operationId')::uuid,ARRAY['douyin:'||(op.snapshot->'binding'->>'platformUid')]);
  END IF;
 ELSIF p_input->>'action' IN ('dispatch','consume-grant') THEN
  SELECT * INTO op FROM public.pub3_operations WHERE id=(p_input->>'operationId')::uuid AND owner_id=p_user_id;
  IF op.kind IN ('publish','task_change') AND NOT op.grant_used THEN
   IF op.kind='publish' THEN PERFORM public.pub5_acquire_dispatch(p_user_id,p_input->>'connectionId',op.id,ARRAY['douyin:'||(op.snapshot->'binding'->>'platformUid')]);
   ELSE PERFORM public.pub5_acquire_dispatch(p_user_id,p_input->>'connectionId',op.id,ARRAY[(SELECT 'douyin:'||(snapshot->'binding'->>'platformUid') FROM public.pub3_operations WHERE id=op.subject_id AND owner_id=p_user_id)]);END IF;
   IF p_input->>'action'='consume-grant' THEN PERFORM public.pub5_assert_dispatch(p_user_id,p_input->>'connectionId',op.id);END IF;
  END IF;
 END IF;
$forward$);
 EXECUTE body;
END $$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['pub5_official_identity_claims','pub5_dispatch_leases'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',t);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.pub5_claim_official_identity(),public.pub5_acquire_dispatch(text,text,uuid,text[]),public.pub5_assert_dispatch(text,text,uuid),public.pub5_finish_dispatch() FROM PUBLIC,anon,authenticated,service_role;


CREATE TABLE public.pub5_browser_plans(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id varchar(36) NOT NULL REFERENCES public.users(id),
 request_key text NOT NULL,plan_hash text NOT NULL CHECK(plan_hash~'^[a-f0-9]{64}$'),
 plan jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,request_key)
);
ALTER TABLE public.pub5_browser_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pub5_browser_plans FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.pub5_browser_plans TO service_role;
CREATE TRIGGER pub5_history BEFORE UPDATE OR DELETE ON public.pub5_browser_plans FOR EACH ROW EXECUTE FUNCTION public.pub5_history_guard();
CREATE FUNCTION public.prepare_browser_local_atomic(p_owner text,p_plan jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE prior public.pub5_browser_plans%ROWTYPE;a jsonb;m jsonb;d jsonb;b jsonb;v_result jsonb;v_id uuid:=gen_random_uuid();BEGIN
 PERFORM public.pub_assert_actor(p_owner);
 PERFORM public.pub2_assert_json_keys(p_plan,ARRAY['requestKey','planHash','accounts','draft'],ARRAY['requestKey','planHash','accounts','draft']);
 IF p_plan->>'requestKey' IS DISTINCT FROM 'studio-browser:'||(p_plan->>'planHash') OR coalesce(p_plan->>'planHash','') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'NATIVE_BROWSER_INPUT_INVALID';END IF;
 SELECT * INTO prior FROM public.pub5_browser_plans WHERE owner_id=p_owner AND request_key=p_plan->>'requestKey';
 IF FOUND THEN IF prior.plan IS DISTINCT FROM p_plan THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;RETURN prior.result||jsonb_build_object('alreadyFulfilled',true);END IF;
 IF jsonb_typeof(p_plan->'accounts')<>'array' OR jsonb_array_length(p_plan->'accounts') NOT BETWEEN 1 AND 100 OR jsonb_array_length(p_plan->'accounts')<>jsonb_array_length(p_plan->'draft'->'targets') OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'accounts') x GROUP BY x->>'id' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_BROWSER_INPUT_INVALID';END IF;
 FOR a IN SELECT * FROM jsonb_array_elements(p_plan->'accounts') LOOP
  PERFORM public.pub2_assert_json_keys(a,ARRAY['id','platform','uid','revision','metadataRevision'],ARRAY['id','platform','uid','revision','metadataRevision']);
  IF a->>'platform' NOT IN ('xhs','wxSph','douyin') OR (a->>'revision')::integer<>1 OR NOT EXISTS(SELECT 1 FROM public.pub_accounts ac LEFT JOIN public.pub_native_account_meta meta ON meta.account_id=ac.id AND meta.owner_id=p_owner AND meta.account_kind='browser' WHERE ac.id=(a->>'id')::uuid AND ac.user_id=p_owner AND ac.platform=a->>'platform' AND ac.platform_account_id=a->>'uid' AND NOT coalesce(meta.disconnected,false) AND coalesce(meta.revision,0)=(a->>'metadataRevision')::integer) OR (SELECT count(*) FROM jsonb_array_elements(p_plan->'draft'->'targets') t WHERE t->>'accountId'=a->>'id' AND t->>'platform'=a->>'platform')<>1 THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_BINDING_CHANGED';END IF;
 END LOOP;
 FOR m IN SELECT * FROM jsonb_array_elements(p_plan->'draft'->'media') LOOP
  IF m->>'source'<>'local_file' OR m->'requiresReselection'<>'true'::jsonb OR coalesce(m->>'hash','') !~ '^[a-f0-9]{64}$' OR (m->>'size')::bigint<=0 OR m ? 'reference' OR m->>'fileName' ~ '[\\/[:cntrl:]]' THEN RAISE EXCEPTION 'NATIVE_BROWSER_INPUT_INVALID';END IF;
 END LOOP;
 d:=public.mutate_publish_v2_atomic(p_owner,jsonb_build_object('action','save-draft','expectedRevision',0,'draft',p_plan->'draft'));
 b:=public.mutate_publish_v2_atomic(p_owner,jsonb_build_object('action','create-batch','draftId',d->'row'->>'id','draftVersion',d->'row'->'revision','targetIds',(SELECT jsonb_agg(t->'id') FROM jsonb_array_elements(p_plan->'draft'->'targets') t),'idempotencyKey','studio-browser-batch:'||v_id::text));
 v_result:=jsonb_build_object('manifestId',v_id,'connectionCurrent',true,'groups',jsonb_build_array(jsonb_build_object('key',p_plan->'draft'->>'contentType','draft',d->'row','batch',b->'row','officialTargets','[]'::jsonb)),'alreadyFulfilled',false);
 INSERT INTO public.pub5_browser_plans(id,owner_id,request_key,plan_hash,plan,result) VALUES(v_id,p_owner,p_plan->>'requestKey',p_plan->>'planHash',p_plan,v_result);
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.prepare_browser_local_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.prepare_browser_local_atomic(text,jsonb) TO service_role;

-- Durable reads only: one owner-scoped union, stable ordering and bounded page.
-- Keep the original claim engine; due local plans execute now from their original
-- version. The stored draft remains unchanged, and its localSchedule proof is kept.
DO $$DECLARE body text;old_guard text;BEGIN
 body:=pg_get_functiondef('public.mutate_publish_v2_atomic(text,jsonb)'::regprocedure);
 old_guard:='IF v_target->>''platform''=''xhs'' AND v_target->>''scheduledAt'' IS NOT NULL THEN RAISE EXCEPTION ''PUBLISH_V2_NATIVE_SCHEDULE_UNAVAILABLE''; END IF;';
 IF position(old_guard IN body)=0 THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_V2_SOURCE_DRIFT';END IF;
 body:=replace(body,old_guard,'IF p_input ? ''scheduleId'' THEN v_target:=v_target||''{"scheduledAt":null}''::jsonb; END IF;');
 EXECUTE body;
END $$;

-- Current browser API supports three platforms. Keep the existing account and
-- claim RPCs, with platform-specific media limits and public-only Douyin.
DO $$DECLARE body text;sig text;BEGIN
 body:=pg_get_functiondef('public.mutate_publish_v2_atomic(text,jsonb)'::regprocedure);
 IF position('v_target->>''platform'' NOT IN (''xhs'',''wxSph'')' IN body)=0 THEN RAISE EXCEPTION 'NATIVE_BROWSER_V2_SOURCE_DRIFT';END IF;
 body:=replace(body,'v_target->>''platform'' NOT IN (''xhs'',''wxSph'')','v_target->>''platform'' NOT IN (''xhs'',''wxSph'',''douyin'')');
 body:=replace(body,'IF v_payload->>''contentType''=''image'' AND (v_target->>''platform''<>''xhs'' OR (SELECT count(*) FROM jsonb_array_elements(v_media) m WHERE m->>''role''=''image'') NOT BETWEEN 1 AND 9)','IF v_payload->>''contentType''=''image'' AND (v_target->>''platform''=''wxSph'' OR (SELECT count(*) FROM jsonb_array_elements(v_media) m WHERE m->>''role''=''image'') NOT BETWEEN 1 AND CASE WHEN v_target->>''platform''=''douyin'' THEN 35 ELSE 9 END)');
 body:=replace(body,'(SELECT count(*) FROM jsonb_array_elements(v_media) m WHERE m->>''role''=''cover'')<>1','(v_target->>''platform''<>''douyin'' AND (SELECT count(*) FROM jsonb_array_elements(v_media) m WHERE m->>''role''=''cover'')<>1)');
 body:=replace(body,'SELECT * INTO v_ent FROM public.pub_entitlements WHERE id=(p_input->>''entitlementId'')::uuid AND user_id=p_user_id FOR UPDATE;',
 $guard$IF v_target->>'platform'='douyin' AND (v_target->'options'->>'privacyLevel'='private' OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_media) m WHERE m->>'role'<>'video' AND m->>'type' NOT IN ('image/jpeg','image/png'))) THEN RAISE EXCEPTION 'PUBLISH_V2_MEDIA_INVALID';END IF;
 SELECT * INTO v_ent FROM public.pub_entitlements WHERE id=(p_input->>'entitlementId')::uuid AND user_id=p_user_id FOR UPDATE;$guard$);
 EXECUTE body;
 body:=pg_get_functiondef('public.pub2_assert_input_shape(jsonb)'::regprocedure);
 IF position('jsonb_array_length(d->''media'')>30' IN body)=0 THEN RAISE EXCEPTION 'NATIVE_BROWSER_INPUT_SOURCE_DRIFT';END IF;
 body:=replace(body,'jsonb_array_length(d->''media'')>30','jsonb_array_length(d->''media'')>100');
 body:=replace(body,'jsonb_array_length(t->''mediaIds'') NOT BETWEEN 1 AND 30','jsonb_array_length(t->''mediaIds'') NOT BETWEEN 1 AND 35');
 EXECUTE body;
 body:=pg_get_functiondef('public.mutate_native_metadata_atomic(text,jsonb)'::regprocedure);
 IF position('v_item->>''platform'' NOT IN (''xhs'',''wxSph'')' IN body)=0 THEN RAISE EXCEPTION 'NATIVE_BROWSER_ACCOUNT_SOURCE_DRIFT';END IF;
 EXECUTE replace(body,'v_item->>''platform'' NOT IN (''xhs'',''wxSph'')','v_item->>''platform'' NOT IN (''xhs'',''wxSph'',''douyin'')');
END $$;
CREATE FUNCTION public.resume_native_schedule_atomic(p_owner text,p_schedule uuid,p_expected_revision integer,p_entitlement uuid,p_request_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.pub2_schedules%ROWTYPE;a public.pub2_attempts%ROWTYPE;b jsonb;BEGIN
 PERFORM public.pub_assert_actor(p_owner);
 SELECT * INTO s FROM public.pub2_schedules WHERE id=p_schedule AND user_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_NOT_FOUND';END IF;
 SELECT * INTO a FROM public.pub2_attempts WHERE user_id=p_owner AND request_key=p_request_key;
 IF FOUND THEN
  IF a.snapshot->'localSchedule'->>'id' IS DISTINCT FROM p_schedule::text OR a.entitlement_id IS DISTINCT FROM p_entitlement THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;
  RETURN jsonb_build_object('kind','attempt','row',to_jsonb(a),'shouldExecute',false,'alreadyFulfilled',true);
 END IF;
 IF s.state<>'planned' OR s.revision IS DISTINCT FROM p_expected_revision OR s.scheduled_at>now() THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_LOCKED';END IF;
 b:=public.mutate_publish_v2_atomic(p_owner,jsonb_build_object('action','create-batch','draftId',s.draft_id,'draftVersion',s.draft_version,'targetIds',jsonb_build_array(s.target_id),'idempotencyKey','studio-resume-batch:'||s.id::text));
 RETURN public.mutate_publish_v2_atomic(p_owner,jsonb_build_object('action','claim','batchId',b->'row'->>'id','targetId',s.target_id,'entitlementId',p_entitlement,'scheduleId',s.id,'idempotencyKey',p_request_key));
END $$;

CREATE FUNCTION public.read_publishing_studio_history(p_owner text,p_page integer,p_page_size integer,p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;BEGIN
 IF p_page NOT BETWEEN 1 AND 100000 OR p_page_size NOT BETWEEN 1 AND 100 OR p_from>=p_to THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_INPUT_INVALID';END IF;
 WITH records AS (
  SELECT id,'attempt'::text AS source,created_at AS at FROM public.pub2_attempts WHERE user_id=p_owner
  UNION ALL SELECT id,'schedule',scheduled_at FROM public.pub2_schedules WHERE user_id=p_owner AND state<>'claimed'
  UNION ALL SELECT id,'official',coalesce((snapshot->'intent'->>'publishAt')::timestamptz,created_at) FROM public.pub3_operations WHERE owner_id=p_owner AND kind='publish'
  UNION ALL SELECT id,'generic',publish_at FROM public.pub5_targets WHERE owner_id=p_owner
 ), filtered AS (SELECT * FROM records WHERE (p_from IS NULL OR at>=p_from) AND (p_to IS NULL OR at<p_to)), page AS (SELECT * FROM filtered ORDER BY at DESC,id DESC,source LIMIT p_page_size OFFSET (p_page::bigint-1)*p_page_size)
 SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'source',source) ORDER BY at DESC,id DESC,source) FROM page),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.read_publishing_studio_history(text,integer,integer,timestamptz,timestamptz),public.pub5_wire_body(text,jsonb),public.pub5_history_guard(),public.publishing_accounted_used(uuid),public.pub5_assert_profile(text,jsonb,jsonb),public.pub5_assert_snapshot(text,text,jsonb),public.mutate_native_official_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mutate_native_official_atomic(text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_publishing_studio_history(text,integer,integer,timestamptz,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.resume_native_schedule_atomic(text,uuid,integer,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.resume_native_schedule_atomic(text,uuid,integer,uuid,text) TO service_role;

-- Keep the complete 141 attribution path (including its provider-asset v1
-- fallback). Only an explicitly selected entry is credited for a pub5 target.
ALTER FUNCTION public.native_core_media_usage_facts(text,uuid) RENAME TO native_core_media_usage_facts_v2;
CREATE FUNCTION public.native_core_media_usage_facts(p_owner text,p_entry_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE selected public.pub_native_media_entries%ROWTYPE;legacy jsonb;facts jsonb;confirmed bigint;unknown_count bigint;incomplete boolean;BEGIN
 SELECT * INTO selected FROM public.pub_native_media_entries WHERE owner_id=p_owner AND id=p_entry_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_CORE_OWNER_MISMATCH';END IF;
 legacy:=public.native_core_media_usage_facts_v2(p_owner,p_entry_id);
 WITH refs AS (
  SELECT t.id,t.revision,t.state,o.grant_used,
   r.source=public.native_media_entry_source(selected)
   AND a.id IS NOT NULL AND a.owner_id=p_owner AND a.connection_id=o.namespace AND a.state='ready'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.payload->'media') m WHERE m->>'mediaId'=r.media_id::text AND m->>'assetId'=r.asset_id::text AND m->>'mediaEntryId'=p_entry_id::text AND m->'source'=r.source)
   AND (t.payload->'profile'->'mediaIds'?r.media_id::text OR t.payload->'profile'->>'coverMediaId'=r.media_id::text)
   AND CASE WHEN selected.source_kind='provider_asset' THEN r.asset_id=selected.asset_id
    ELSE EXISTS(SELECT 1 FROM public.pub_native_media_bridges br WHERE br.id=r.bridge_id AND br.owner_id=p_owner AND br.namespace=o.namespace AND br.asset_id=r.asset_id AND br.media_id=r.media_id AND br.reference=selected.main_reference AND br.state='ready')
     AND public.native_media_bridge_proven(p_owner,o.namespace,selected.main_reference,r.media_id,jsonb_build_object('id',a.id,'mediaId',a.local_media_id,'sha256',a.sha256,'size',a.size,'mime',a.mime)) END AS proven
  FROM public.pub5_target_media_refs r JOIN public.pub5_targets t ON t.id=r.target_id AND t.owner_id=r.owner_id
   JOIN public.pub5_operations o ON o.id=t.operation_id AND o.owner_id=t.owner_id AND o.kind='publish'
   LEFT JOIN public.pub3_assets a ON a.id=r.asset_id AND a.owner_id=r.owner_id
  WHERE r.owner_id=p_owner AND r.media_entry_id=p_entry_id
 ), targets AS (SELECT id,revision,state,grant_used,bool_and(coalesce(proven,false)) AS proven FROM refs GROUP BY id,revision,state,grant_used)
 SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb),count(*) FILTER(WHERE proven AND state='published'),
  count(*) FILTER(WHERE state='unknown' OR grant_used AND state NOT IN ('published','failed_known','cancelled','blocked') OR NOT proven AND state='published'),
  coalesce(bool_or(NOT proven AND (state IN ('published','unknown') OR grant_used AND state NOT IN ('failed_known','cancelled','blocked'))),false)
 INTO facts,confirmed,unknown_count,incomplete FROM targets t;
 IF jsonb_array_length(facts)=0 THEN RETURN legacy;END IF;
 RETURN legacy||jsonb_build_object(
  'confirmedUses',CASE WHEN incomplete OR legacy->>'nativeUsageAttribution'='source_attribution_incomplete' THEN NULL ELSE coalesce((legacy->>'confirmedUses')::bigint,0)+confirmed END,
  'unknownUses',coalesce((legacy->>'unknownUses')::bigint,0)+unknown_count,
  'nativeUsageAttribution',CASE WHEN incomplete OR legacy->>'nativeUsageAttribution'='source_attribution_incomplete' THEN 'source_attribution_incomplete' ELSE 'entry_provenance' END,
  'usageFingerprint',encode(sha256(convert_to(jsonb_build_object('legacy',legacy->'usageFingerprint','source',public.native_media_entry_source(selected),'genericTargets',facts)::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION public.native_core_media_usage_facts(text,uuid),public.native_core_media_usage_facts_v2(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
