BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';

-- Adjunct orchestration only. This migration never reserves, settles or refunds money.
CREATE TABLE public.pub_native_ai_batches(
 id uuid PRIMARY KEY,owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 request_key text NOT NULL,snapshot jsonb NOT NULL,request_hash text NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id),UNIQUE(owner_id,request_key));
CREATE TABLE public.pub_native_ai_items(
 id uuid PRIMARY KEY,owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,batch_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 9),root_action_id uuid NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id),UNIQUE(owner_id,batch_id,id),UNIQUE(batch_id,ordinal),UNIQUE(root_action_id),
 FOREIGN KEY(owner_id,batch_id) REFERENCES public.pub_native_ai_batches(owner_id,id) ON DELETE CASCADE);
CREATE TABLE public.pub_native_ai_actions(
 id uuid PRIMARY KEY,owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 scope jsonb NOT NULL,task_id uuid,turn_id uuid,batch_id uuid,item_id uuid,source_action_id uuid,
 kind text NOT NULL CHECK(kind IN ('plan_text','generate_image','generate_video','save_draft','propose_publish')),
 snapshot jsonb NOT NULL,action_hash text NOT NULL CHECK(action_hash~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','approved','rejected','dispatch_claimed','awaiting_result','succeeded','failed_known','unknown')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id),
 CHECK((task_id IS NOT NULL AND turn_id IS NOT NULL AND batch_id IS NULL AND item_id IS NULL) OR (task_id IS NULL AND turn_id IS NULL AND batch_id IS NOT NULL AND item_id IS NOT NULL)),
 FOREIGN KEY(owner_id,task_id,turn_id) REFERENCES public.pub_native_agent_turns(owner_id,task_id,id),
 FOREIGN KEY(owner_id,batch_id,item_id) REFERENCES public.pub_native_ai_items(owner_id,batch_id,id),
 FOREIGN KEY(owner_id,source_action_id) REFERENCES public.pub_native_ai_actions(owner_id,id));
ALTER TABLE public.pub_native_ai_items ADD CONSTRAINT native_ai_item_root_owner FOREIGN KEY(owner_id,root_action_id) REFERENCES public.pub_native_ai_actions(owner_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE public.pub_native_ai_slots(
 owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,action_id uuid NOT NULL,slot integer NOT NULL CHECK(slot BETWEEN 0 AND 8),
 consumer text NOT NULL CHECK(consumer IN ('main_llm','main_image','main_video','native_core','publish_manifest')),
 main_request_key text NOT NULL,wire_request jsonb NOT NULL,wire_request_hash text NOT NULL CHECK(wire_request_hash~'^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','approved','rejected','dispatch_claimed','awaiting_result','succeeded','failed_known','unknown')),
 dispatch_id uuid UNIQUE,claimed_at timestamptz,admitted_at timestamptz,reservation_amount text,unit text,receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(action_id,slot),UNIQUE(owner_id,consumer,main_request_key),
 FOREIGN KEY(owner_id,action_id) REFERENCES public.pub_native_ai_actions(owner_id,id) ON DELETE CASCADE,
 CHECK((dispatch_id IS NULL)=(claimed_at IS NULL)),CHECK((admitted_at IS NULL)=(reservation_amount IS NULL)),CHECK((admitted_at IS NULL)=(unit IS NULL)));
CREATE TABLE public.pub_native_ai_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 request_key text NOT NULL,request_hash text NOT NULL,request_payload jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,request_key));
CREATE TABLE public.pub_native_ai_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 action_id uuid NOT NULL,kind text NOT NULL,safe_payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,action_id) REFERENCES public.pub_native_ai_actions(owner_id,id) ON DELETE CASCADE);
CREATE TABLE public.pub_native_ai_publish_manifests(
 id uuid PRIMARY KEY,owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,action_id uuid NOT NULL,
 draft_id uuid NOT NULL,draft_version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,action_id),
 FOREIGN KEY(owner_id,action_id) REFERENCES public.pub_native_ai_actions(owner_id,id),FOREIGN KEY(draft_id,draft_version) REFERENCES public.pub2_draft_versions(draft_id,version));
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['pub_native_ai_batches','pub_native_ai_items','pub_native_ai_actions','pub_native_ai_slots','pub_native_ai_requests','pub_native_ai_events','pub_native_ai_publish_manifests'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',t);
 EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',t);
 EXECUTE format('CREATE INDEX %I ON public.%I(owner_id,created_at DESC)',t||'_owner_created',t);
END LOOP;END$$;

CREATE FUNCTION public.native_ai_hash(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$SELECT encode(sha256(convert_to(public.pub4_canonical_json(p),'UTF8')),'hex')$$;
CREATE FUNCTION public.native_ai_decimal(p text) RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$BEGIN
 IF p IS NULL OR p!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{0,5}[1-9])?$' THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;RETURN p::numeric;
END$$;
CREATE FUNCTION public.native_ai_no_credentials(p jsonb,depth integer DEFAULT 0) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$DECLARE e record;v jsonb;BEGIN
 IF p IS NULL OR depth>20 OR octet_length(p::text)>2097152 THEN RETURN false;END IF;
 IF jsonb_typeof(p)='object' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p))>200 THEN RETURN false;END IF;
  FOR e IN SELECT * FROM jsonb_each(p) LOOP
   IF e.key='tokenBilling' THEN
    IF jsonb_typeof(e.value) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(e.value))<>2 OR NOT(e.value?'maxChargeYuan') OR NOT(e.value?'priceVersion') OR jsonb_typeof(e.value->'maxChargeYuan') IS DISTINCT FROM 'number' OR jsonb_typeof(e.value->'priceVersion') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
    IF (e.value->>'maxChargeYuan')::numeric<=0 OR scale((e.value->>'maxChargeYuan')::numeric)>2 OR (e.value->>'maxChargeYuan')::numeric*100>9007199254740991 OR length(e.value->>'priceVersion')>1024 OR left(e.value->>'priceVersion',length('video_token_sale.v1:'))<>'video_token_sale.v1:' THEN RETURN false;END IF;
    BEGIN v:=substring(e.value->>'priceVersion' FROM length('video_token_sale.v1:')+1)::jsonb;EXCEPTION WHEN OTHERS THEN RETURN false;END;
    IF jsonb_typeof(v) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(v))<>2 OR NOT(v?'720p:no_reference_video') OR NOT(v?'720p:reference_video') OR jsonb_typeof(v->'720p:no_reference_video') IS DISTINCT FROM 'number' OR jsonb_typeof(v->'720p:reference_video') IS DISTINCT FROM 'number' THEN RETURN false;END IF;
    IF (v->>'720p:no_reference_video')::numeric<=0 OR (v->>'720p:reference_video')::numeric<=0 OR (v->>'720p:no_reference_video')::numeric>9007199254740991 OR (v->>'720p:reference_video')::numeric>9007199254740991 THEN RETURN false;END IF;
    CONTINUE;
   END IF;
   IF e.key IN ('__proto__','constructor','prototype') OR e.key~*'(cookie|token|secret|password|authorization|credential|api.?key|upload.?url|continuation|headers)' AND NOT(e.key IN ('maxReplyTokens','maxContextTokens','max_reply_tokens','max_context_tokens') AND jsonb_typeof(e.value)='number') OR NOT public.native_ai_no_credentials(e.value,depth+1) THEN RETURN false;END IF;
  END LOOP;
 ELSIF jsonb_typeof(p)='array' THEN
  IF jsonb_array_length(p)>200 THEN RETURN false;END IF;
  FOR v IN SELECT * FROM jsonb_array_elements(p) LOOP IF NOT public.native_ai_no_credentials(v,depth+1) THEN RETURN false;END IF;END LOOP;
 END IF;RETURN true;
END$$;
CREATE FUNCTION public.native_ai_assert_snapshot(p_owner text,p_id uuid,p_scope jsonb,p jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE k text;r jsonb;a jsonb:=p->'args';q jsonb:=p->'quote';s jsonb;v_consumer text;v_surface text;v_count integer;v_index integer:=0;v_key text;v_revision text;v_turn public.pub_native_agent_turns%ROWTYPE;BEGIN
 PERFORM public.pub2_assert_json_keys(p_scope,CASE WHEN p_scope->>'kind'='agent' THEN ARRAY['kind','taskId','turnId'] ELSE ARRAY['kind','batchId','itemId'] END,CASE WHEN p_scope->>'kind'='agent' THEN ARRAY['kind','taskId','turnId'] ELSE ARRAY['kind','batchId','itemId'] END);
 IF p_scope->>'kind'='agent' THEN
  IF NOT public.native_ai_uuid(p_scope->'taskId') OR NOT public.native_ai_uuid(p_scope->'turnId') THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  SELECT t.* INTO v_turn FROM public.pub_native_agent_turns t JOIN public.pub_native_agent_tasks x ON x.id=t.task_id AND x.owner_id=t.owner_id WHERE t.owner_id=p_owner AND t.id=(p_scope->>'turnId')::uuid AND t.task_id=(p_scope->>'taskId')::uuid AND NOT x.archived;
  IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AI_RESOURCE_SCOPE_INVALID';END IF;
 ELSIF p_scope->>'kind'='batch' THEN
  IF NOT public.native_ai_uuid(p_scope->'batchId') OR NOT public.native_ai_uuid(p_scope->'itemId') OR NOT EXISTS(SELECT 1 FROM public.pub_native_ai_items WHERE owner_id=p_owner AND id=(p_scope->>'itemId')::uuid AND batch_id=(p_scope->>'batchId')::uuid) THEN RAISE EXCEPTION 'NATIVE_AI_RESOURCE_SCOPE_INVALID';END IF;
 ELSE RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
 PERFORM public.pub2_assert_json_keys(p,ARRAY['version','kind','args','sourceActionId','resources','quote','surface','permissionRevision','slots'],ARRAY['version','kind','args','sourceActionId','resources','quote','surface','permissionRevision','slots']);
 IF p->>'version' IS DISTINCT FROM 'native-ai-action.v1' OR p->>'kind' IS NULL OR p->>'kind' NOT IN ('plan_text','generate_image','generate_video','save_draft','propose_publish') OR octet_length(p::text)>1048576 OR NOT public.native_ai_no_credentials(p)
  OR jsonb_typeof(p->'permissionRevision') IS DISTINCT FROM 'string' OR length(p->>'permissionRevision') NOT BETWEEN 1 AND 240 THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
 IF p->'sourceActionId'<>'null'::jsonb THEN
  IF NOT public.native_ai_uuid(p->'sourceActionId') OR p->>'sourceActionId'=p_id::text OR NOT EXISTS(SELECT 1 FROM public.pub_native_ai_actions WHERE id=(p->>'sourceActionId')::uuid AND owner_id=p_owner AND scope=p_scope AND state='succeeded') THEN RAISE EXCEPTION 'NATIVE_AI_SOURCE_ACTION_INVALID';END IF;
 END IF;
 IF jsonb_typeof(p->'resources') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'resources')>100 THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
 FOR r IN SELECT * FROM jsonb_array_elements(p->'resources') LOOP
  PERFORM public.pub2_assert_json_keys(r,ARRAY['kind','id','revision'],ARRAY['kind','id','revision']);
  IF NOT public.native_ai_uuid(r->'id') OR NOT public.native_ai_integer(r->'revision',0,2147483647) THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  v_revision:=NULL;
  CASE r->>'kind'
   WHEN 'collection' THEN SELECT revision::text INTO v_revision FROM public.pub2_collections WHERE id=(r->>'id')::uuid AND user_id=p_owner AND NOT archived;
   WHEN 'draft' THEN SELECT revision::text INTO v_revision FROM public.pub2_drafts WHERE id=(r->>'id')::uuid AND user_id=p_owner AND NOT archived;
   WHEN 'binding' THEN SELECT revision::text INTO v_revision FROM public.pub3_account_bindings WHERE id=(r->>'id')::uuid AND owner_id=p_owner AND status='active';IF NOT FOUND THEN SELECT revision::text INTO v_revision FROM public.pub4_account_bindings WHERE id=(r->>'id')::uuid AND owner_id=p_owner AND status='active';END IF;
   WHEN 'account' THEN IF EXISTS(SELECT 1 FROM public.pub_accounts WHERE id=(r->>'id')::uuid AND user_id=p_owner) THEN SELECT coalesce((SELECT revision FROM public.pub_native_account_meta WHERE owner_id=p_owner AND account_kind='browser' AND account_id=(r->>'id')::uuid),0)::text INTO v_revision;END IF;
   WHEN 'asset' THEN SELECT to_jsonb(x)->>'revision' INTO v_revision FROM public.pub3_assets x WHERE id=(r->>'id')::uuid AND owner_id=p_owner AND state='ready';
   ELSE RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';
  END CASE;
  IF v_revision IS NULL OR v_revision::numeric IS DISTINCT FROM (r->>'revision')::numeric THEN RAISE EXCEPTION 'NATIVE_AI_RESOURCE_CHANGED';END IF;
 END LOOP;
 PERFORM public.pub2_assert_json_keys(q,ARRAY['unit','quotedAmount','maxAmount','priceHash','expiresAt'],ARRAY['unit','quotedAmount','maxAmount','priceHash','expiresAt']);
 IF q->>'unit' IS NULL OR q->>'unit' NOT IN ('credits','CNY','metadata_write','publish_count') OR jsonb_typeof(q->'quotedAmount') IS DISTINCT FROM 'string' OR jsonb_typeof(q->'maxAmount') IS DISTINCT FROM 'string' OR public.native_ai_decimal(q->>'quotedAmount')>public.native_ai_decimal(q->>'maxAmount') OR q->>'priceHash' IS NULL OR q->>'priceHash'!~'^[a-f0-9]{64}$' OR jsonb_typeof(q->'expiresAt') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
 PERFORM public.pub2_assert_timestamp(q->>'expiresAt');IF (q->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'NATIVE_AI_QUOTE_EXPIRED';END IF;
 IF p->>'kind' IN ('generate_image','generate_video','plan_text') THEN
  IF p->>'kind'='generate_image' THEN PERFORM public.pub2_assert_json_keys(a,ARRAY['modelId','prompt','aspectRatio','resolution','referenceAssets','count'],ARRAY['modelId','prompt','aspectRatio','resolution','referenceAssets','count']);v_consumer:='main_image';v_surface:='publish-center-image';IF NOT public.native_ai_integer(a->'count',1,9) THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;v_count:=(a->>'count')::integer;
  ELSIF p->>'kind'='generate_video' THEN PERFORM public.pub2_assert_json_keys(a,ARRAY['modelId','prompt','aspectRatio','resolution','referenceAssets','duration'],ARRAY['modelId','prompt','aspectRatio','resolution','referenceAssets','duration']);v_consumer:='main_video';v_surface:='publish-center-video';v_count:=1;IF NOT public.native_ai_integer(a->'duration',1,120) THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  ELSE PERFORM public.pub2_assert_json_keys(a,ARRAY['modelId','prompt','contextSnapshotHash','maxReplyTokens','maxContextRounds','maxContextTokens'],ARRAY['modelId','prompt','contextSnapshotHash','maxReplyTokens','maxContextRounds','maxContextTokens']);v_consumer:='main_llm';v_surface:='native-agent-text';v_count:=1;IF a->>'contextSnapshotHash' IS NULL OR a->>'contextSnapshotHash'!~'^[a-f0-9]{64}$' OR NOT public.native_ai_integer(a->'maxReplyTokens',1,4096) OR NOT public.native_ai_integer(a->'maxContextRounds',0,8) OR NOT public.native_ai_integer(a->'maxContextTokens',1,32768) THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  END IF;
  IF a->>'modelId' IS NULL OR a->>'modelId'!~'^pm_[A-Za-z0-9_-]+$' OR length(a->>'modelId')>160 OR jsonb_typeof(a->'prompt') IS DISTINCT FROM 'string' OR length(btrim(a->>'prompt')) NOT BETWEEN 1 AND 24000 OR p->>'surface' IS DISTINCT FROM v_surface THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  IF p->>'kind'<>'plan_text' THEN
   IF jsonb_typeof(a->'aspectRatio') IS DISTINCT FROM 'string' OR length(a->>'aspectRatio') NOT BETWEEN 1 AND 24 OR jsonb_typeof(a->'resolution') IS DISTINCT FROM 'string' OR length(a->>'resolution') NOT BETWEEN 1 AND 32 OR jsonb_typeof(a->'referenceAssets') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'referenceAssets')>9 THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
   FOR r IN SELECT * FROM jsonb_array_elements(a->'referenceAssets') LOOP PERFORM public.native_ai_assert_source(p_owner,jsonb_build_object('kind','main_asset','reference',r));END LOOP;
  END IF;
 ELSIF p->>'kind'='save_draft' THEN
  PERFORM public.pub2_assert_json_keys(a,ARRAY['draftId','expectedRevision','expectedMetadataRevision','collectionId','contentType','title','body','topics','media','platforms'],ARRAY['expectedRevision','expectedMetadataRevision','collectionId','contentType','title','body','topics','media','platforms']);v_consumer:='native_core';v_count:=1;
  IF NOT public.native_ai_integer(a->'expectedRevision',0,2147483647) OR NOT public.native_ai_integer(a->'expectedMetadataRevision',0,2147483647) OR a->>'contentType' IS NULL OR a->>'contentType' NOT IN ('image','video') OR jsonb_typeof(a->'title') IS DISTINCT FROM 'string' OR length(a->>'title')>200 OR jsonb_typeof(a->'body') IS DISTINCT FROM 'string' OR length(a->>'body')>50000 OR jsonb_typeof(a->'topics') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'topics')>30 OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'topics') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR length(btrim(x#>>'{}')) NOT BETWEEN 1 AND 100) THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  IF a?'draftId' THEN IF NOT public.native_ai_uuid(a->'draftId') OR NOT EXISTS(SELECT 1 FROM public.pub2_drafts WHERE id=(a->>'draftId')::uuid AND user_id=p_owner AND revision::numeric=(a->>'expectedRevision')::numeric AND NOT archived) OR coalesce((SELECT revision FROM public.pub_native_draft_meta WHERE owner_id=p_owner AND draft_id=(a->>'draftId')::uuid AND draft_version=(a->>'expectedRevision')::integer),0)::numeric IS DISTINCT FROM (a->>'expectedMetadataRevision')::numeric THEN RAISE EXCEPTION 'NATIVE_AI_RESOURCE_CHANGED';END IF;
  ELSIF a->'expectedRevision'<>'0'::jsonb OR a->'expectedMetadataRevision'<>'0'::jsonb THEN RAISE EXCEPTION 'NATIVE_AI_RESOURCE_CHANGED';END IF;
  IF a->'collectionId'<>'null'::jsonb AND (NOT public.native_ai_uuid(a->'collectionId') OR NOT EXISTS(SELECT 1 FROM public.pub2_collections WHERE id=(a->>'collectionId')::uuid AND user_id=p_owner AND NOT archived)) THEN RAISE EXCEPTION 'NATIVE_AI_RESOURCE_SCOPE_INVALID';END IF;
  IF jsonb_typeof(a->'media') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'media')>30 THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(a->'media') LOOP PERFORM public.pub2_assert_json_keys(r,ARRAY['role','source'],ARRAY['role','source']);IF r->>'role' IS NULL OR r->>'role' NOT IN ('image','video','cover') OR a->>'contentType'='image' AND r->>'role'='video' THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;PERFORM public.native_ai_assert_source(p_owner,r->'source',r->>'role');END LOOP;
 ELSE
  PERFORM public.pub2_assert_json_keys(a,ARRAY['draftId','expectedRevision','expectedMetadataRevision','browserAccountIds','officialBindingIds','scheduledAt'],ARRAY['draftId','expectedRevision','expectedMetadataRevision','browserAccountIds','officialBindingIds','scheduledAt']);v_consumer:='publish_manifest';v_count:=1;
  IF NOT public.native_ai_uuid(a->'draftId') OR NOT public.native_ai_integer(a->'expectedRevision',1,2147483647) OR NOT public.native_ai_integer(a->'expectedMetadataRevision',0,2147483647) OR NOT EXISTS(SELECT 1 FROM public.pub2_drafts WHERE id=(a->>'draftId')::uuid AND user_id=p_owner AND revision::numeric=(a->>'expectedRevision')::numeric AND NOT archived) OR coalesce((SELECT revision FROM public.pub_native_draft_meta WHERE owner_id=p_owner AND draft_id=(a->>'draftId')::uuid AND draft_version=(a->>'expectedRevision')::integer),0)::numeric IS DISTINCT FROM (a->>'expectedMetadataRevision')::numeric THEN RAISE EXCEPTION 'NATIVE_AI_RESOURCE_CHANGED';END IF;
  FOREACH k IN ARRAY ARRAY['browserAccountIds','officialBindingIds'] LOOP
   IF jsonb_typeof(a->k) IS DISTINCT FROM 'array' OR jsonb_array_length(a->k)>100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->k) x WHERE NOT public.native_ai_uuid(x)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->k) x GROUP BY x HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  END LOOP;
  IF jsonb_array_length(a->'browserAccountIds')+jsonb_array_length(a->'officialBindingIds')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a->'browserAccountIds') x WHERE NOT EXISTS(SELECT 1 FROM public.pub_accounts WHERE id=x::uuid AND user_id=p_owner)) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a->'officialBindingIds') x WHERE NOT EXISTS(SELECT 1 FROM public.pub3_account_bindings WHERE id=x::uuid AND owner_id=p_owner AND status='active') AND NOT EXISTS(SELECT 1 FROM public.pub4_account_bindings WHERE id=x::uuid AND owner_id=p_owner AND status='active')) THEN RAISE EXCEPTION 'NATIVE_AI_RESOURCE_SCOPE_INVALID';END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'resources') x WHERE x->>'kind'='draft' AND x->'id'=a->'draftId')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a->'browserAccountIds') id WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'resources') x WHERE x->>'kind'='account' AND x->>'id'=id) OR EXISTS(SELECT 1 FROM public.pub_native_account_meta WHERE owner_id=p_owner AND account_kind='browser' AND account_id=id::uuid AND disconnected))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a->'officialBindingIds') id WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'resources') x WHERE x->>'kind'='binding' AND x->>'id'=id) OR EXISTS(SELECT 1 FROM public.pub_native_account_meta WHERE owner_id=p_owner AND account_kind='official' AND account_id=id::uuid AND disconnected)) THEN RAISE EXCEPTION 'NATIVE_AI_RESOURCE_CHANGED';END IF;
  IF a->'scheduledAt'<>'null'::jsonb THEN IF jsonb_typeof(a->'scheduledAt') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;PERFORM public.pub2_assert_timestamp(a->>'scheduledAt');IF (a->>'scheduledAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;END IF;
 END IF;
 IF p->>'kind' IN ('save_draft','propose_publish') AND p->'surface'<>'null'::jsonb THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
 IF q->>'unit' IS DISTINCT FROM (CASE WHEN p->>'kind'='plan_text' THEN 'credits' WHEN p->>'kind' IN ('generate_image','generate_video') THEN 'CNY' ELSE 'metadata_write' END) OR p->>'kind' IN ('save_draft','propose_publish') AND (q->>'quotedAmount'<>'0' OR q->>'maxAmount'<>'0') THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
 IF p->>'kind'='save_draft' THEN
  IF jsonb_typeof(a->'platforms') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'platforms')>14 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a->'platforms') x WHERE x NOT IN ('linkedin','wxSph','xhs','douyin','tiktok','KWAI','youtube','bilibili','twitter','wxGzh','facebook','instagram','threads','pinterest')) THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
 END IF;
 IF jsonb_typeof(p->'slots') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'slots')<>v_count THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
 FOR s IN SELECT * FROM jsonb_array_elements(p->'slots') LOOP
  PERFORM public.pub2_assert_json_keys(s,ARRAY['slot','consumer','requestKey','wireRequest','wireRequestHash'],ARRAY['slot','consumer','requestKey','wireRequest','wireRequestHash']);
  v_key:='native_'||p_id::text||'_'||v_index::text;
  IF p->>'kind'='plan_text' AND p_scope->>'kind'='agent' THEN v_key:=v_turn.main_request_key;IF s->'wireRequest' IS DISTINCT FROM v_turn.policy_snapshot->'mainRequest' OR a->>'modelId' IS DISTINCT FROM v_turn.model_public_id THEN RAISE EXCEPTION 'NATIVE_AI_LEGACY_TURN_CHANGED';END IF;END IF;
  IF s->'slot' IS DISTINCT FROM to_jsonb(v_index) OR s->>'consumer' IS DISTINCT FROM v_consumer OR s->>'requestKey' IS DISTINCT FROM v_key OR jsonb_typeof(s->'wireRequest') IS DISTINCT FROM 'object' OR s->>'wireRequestHash' IS NULL OR s->>'wireRequestHash'!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  IF s->'wireRequest'->>(CASE v_consumer WHEN 'main_image' THEN 'clientIdempotencyKey' WHEN 'main_video' THEN 'client_request_id' WHEN 'main_llm' THEN 'client_request_id' ELSE 'requestKey' END) IS DISTINCT FROM v_key THEN RAISE EXCEPTION 'NATIVE_AI_MAIN_REQUEST_CHANGED';END IF;
  v_index:=v_index+1;
 END LOOP;
END$$;
CREATE FUNCTION public.native_ai_uuid(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$SELECT coalesce(jsonb_typeof(p)='string' AND p#>>'{}'~*'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$',false)$$;
CREATE FUNCTION public.native_ai_integer(p jsonb,lo bigint,hi bigint) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$SELECT coalesce(jsonb_typeof(p)='number' AND p#>>'{}'~'^[0-9]+$' AND (p#>>'{}')::numeric BETWEEN lo AND hi,false)$$;
CREATE FUNCTION public.native_ai_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF TG_OP='DELETE' THEN IF EXISTS(SELECT 1 FROM public.users WHERE id=OLD.owner_id) THEN RAISE EXCEPTION 'NATIVE_AI_HISTORY_IMMUTABLE';END IF;RETURN OLD;END IF;
 IF TG_TABLE_NAME IN ('pub_native_ai_events','pub_native_ai_requests','pub_native_ai_publish_manifests') THEN RAISE EXCEPTION 'NATIVE_AI_HISTORY_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='pub_native_ai_actions' THEN
  IF (NEW.id,NEW.owner_id,NEW.scope,NEW.task_id,NEW.turn_id,NEW.batch_id,NEW.item_id,NEW.source_action_id,NEW.kind,NEW.snapshot,NEW.action_hash,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.scope,OLD.task_id,OLD.turn_id,OLD.batch_id,OLD.item_id,OLD.source_action_id,OLD.kind,OLD.snapshot,OLD.action_hash,OLD.created_at) THEN RAISE EXCEPTION 'NATIVE_AI_HISTORY_IMMUTABLE';END IF;
 ELSIF TG_TABLE_NAME='pub_native_ai_batches' THEN
  IF (NEW.id,NEW.owner_id,NEW.request_key,NEW.snapshot,NEW.request_hash,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.request_key,OLD.snapshot,OLD.request_hash,OLD.created_at) THEN RAISE EXCEPTION 'NATIVE_AI_HISTORY_IMMUTABLE';END IF;
 ELSIF TG_TABLE_NAME='pub_native_ai_items' THEN
  IF (NEW.id,NEW.owner_id,NEW.batch_id,NEW.ordinal,NEW.root_action_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.batch_id,OLD.ordinal,OLD.root_action_id,OLD.created_at) THEN RAISE EXCEPTION 'NATIVE_AI_HISTORY_IMMUTABLE';END IF;
 END IF;
 IF TG_TABLE_NAME='pub_native_ai_slots' THEN
  IF (NEW.owner_id,NEW.action_id,NEW.slot,NEW.consumer,NEW.main_request_key,NEW.wire_request,NEW.wire_request_hash,NEW.created_at) IS DISTINCT FROM (OLD.owner_id,OLD.action_id,OLD.slot,OLD.consumer,OLD.main_request_key,OLD.wire_request,OLD.wire_request_hash,OLD.created_at)
   OR OLD.dispatch_id IS NOT NULL AND (NEW.dispatch_id,NEW.claimed_at) IS DISTINCT FROM (OLD.dispatch_id,OLD.claimed_at)
   OR OLD.admitted_at IS NOT NULL AND (NEW.admitted_at,NEW.reservation_amount,NEW.unit) IS DISTINCT FROM (OLD.admitted_at,OLD.reservation_amount,OLD.unit)
   OR OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt THEN RAISE EXCEPTION 'NATIVE_AI_HISTORY_IMMUTABLE';END IF;
 END IF;RETURN NEW;
END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['pub_native_ai_batches','pub_native_ai_items','pub_native_ai_actions','pub_native_ai_slots','pub_native_ai_requests','pub_native_ai_events','pub_native_ai_publish_manifests'] LOOP EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.native_ai_history_guard()',t||'_history',t);END LOOP;END$$;

CREATE FUNCTION public.native_ai_assert_source(p_owner text,p jsonb,p_role text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE r jsonb;BEGIN
 IF p->>'kind'='provider_asset' THEN
  PERFORM public.pub2_assert_json_keys(p,ARRAY['kind','assetId'],ARRAY['kind','assetId']);
  IF NOT public.native_ai_uuid(p->'assetId') OR NOT EXISTS(SELECT 1 FROM public.pub3_assets WHERE id=(p->>'assetId')::uuid AND owner_id=p_owner AND state='ready' AND (p_role IS NULL OR (p_role='video')=(mime LIKE 'video/%'))) THEN RAISE EXCEPTION 'NATIVE_AI_RESOURCE_SCOPE_INVALID';END IF;
 ELSIF p->>'kind'='main_asset' THEN
  PERFORM public.pub2_assert_json_keys(p,ARRAY['kind','reference'],ARRAY['kind','reference']);r:=p->'reference';PERFORM public.pub2_assert_json_keys(r,ARRAY['kind','id'],ARRAY['kind','id']);
  IF r->>'kind' IS NULL OR r->>'kind' NOT IN ('image_record','image_asset','video_task') OR jsonb_typeof(r->'id') IS DISTINCT FROM 'string' OR length(r->>'id') NOT BETWEEN 1 AND 256 OR r->>'id'!~'^[A-Za-z0-9_.:-]+$' OR r->>'kind'='image_asset' AND NOT public.native_ai_uuid(r->'id') THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  PERFORM public.pub2_assert_media(p_owner,jsonb_build_object('media',jsonb_build_array(jsonb_build_object('source','main_asset','role',coalesce(p_role,CASE WHEN r->>'kind'='video_task' THEN 'video' ELSE 'image' END),'reference',r))));
 ELSE RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
END$$;

CREATE FUNCTION public.native_ai_aggregate(p text[]) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$SELECT CASE
 WHEN 'unknown'=ANY(p) THEN 'unknown' WHEN 'dispatch_claimed'=ANY(p) THEN 'dispatch_claimed' WHEN 'awaiting_result'=ANY(p) THEN 'awaiting_result'
 WHEN 'approved'=ANY(p) THEN 'approved' WHEN 'proposed'=ANY(p) THEN 'proposed' WHEN 'failed_known'=ANY(p) THEN 'failed_known' WHEN 'rejected'=ANY(p) THEN 'rejected' ELSE 'succeeded' END$$;
CREATE FUNCTION public.native_ai_slot_dto(s public.pub_native_ai_slots) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$SELECT jsonb_build_object('slot',s.slot,'requestKey',s.main_request_key,'consumer',s.consumer,'state',s.state,'dispatchId',s.dispatch_id,'receipt',s.receipt)$$;
CREATE FUNCTION public.native_ai_action_dto(a public.pub_native_ai_actions) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$SELECT jsonb_build_object(
 'id',a.id,'scope',a.scope,'revision',a.revision,'state',a.state,'kind',a.kind,'actionHash',a.action_hash,'args',a.snapshot->'args','quote',a.snapshot->'quote',
 'slots',coalesce((SELECT jsonb_agg(public.native_ai_slot_dto(s) ORDER BY slot) FROM public.pub_native_ai_slots s WHERE s.owner_id=a.owner_id AND s.action_id=a.id),'[]'::jsonb),'createdAt',a.created_at,'updatedAt',a.updated_at)||CASE WHEN a.last_error IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('lastError',a.last_error) END$$;
CREATE FUNCTION public.native_ai_manifest(p_owner text,p_batch uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',i.id,'ordinal',i.ordinal,'actionId',a.id,'actionHash',a.action_hash) ORDER BY i.ordinal,a.id),'[]'::jsonb) FROM public.pub_native_ai_items i JOIN public.pub_native_ai_actions a ON a.owner_id=i.owner_id AND a.item_id=i.id AND a.batch_id=i.batch_id WHERE i.owner_id=p_owner AND i.batch_id=p_batch AND a.state='proposed'$$;
CREATE FUNCTION public.native_ai_batch_dto(b public.pub_native_ai_batches) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$SELECT jsonb_build_object('id',b.id,'revision',b.revision,'state',coalesce((SELECT public.native_ai_aggregate(array_agg(state)) FROM public.pub_native_ai_actions WHERE owner_id=b.owner_id AND batch_id=b.id),'proposed'),'mode',b.snapshot->>'mode','quantity',b.snapshot->'quantity','manifestHash',public.native_ai_hash(public.native_ai_manifest(b.owner_id,b.id)),'snapshot',b.snapshot,'createdAt',b.created_at,'updatedAt',b.updated_at)$$;
CREATE FUNCTION public.native_ai_item_dto(i public.pub_native_ai_items) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$SELECT jsonb_build_object('id',i.id,'batchId',i.batch_id,'ordinal',i.ordinal,'revision',i.revision,'state',coalesce((SELECT public.native_ai_aggregate(array_agg(state)) FROM public.pub_native_ai_actions WHERE owner_id=i.owner_id AND item_id=i.id),'proposed'),'rootActionId',i.root_action_id,'actionIds',coalesce((SELECT jsonb_agg(id ORDER BY created_at,id) FROM public.pub_native_ai_actions WHERE owner_id=i.owner_id AND item_id=i.id),'[]'::jsonb),'createdAt',i.created_at,'updatedAt',i.updated_at)$$;
CREATE FUNCTION public.native_ai_batch_result(b public.pub_native_ai_batches) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$SELECT jsonb_build_object('batch',public.native_ai_batch_dto(b),'items',coalesce((SELECT jsonb_agg(public.native_ai_item_dto(i) ORDER BY ordinal) FROM public.pub_native_ai_items i WHERE owner_id=b.owner_id AND batch_id=b.id),'[]'::jsonb),'actions',coalesce((SELECT jsonb_agg(public.native_ai_action_dto(a) ORDER BY i.ordinal,a.created_at,a.id) FROM public.pub_native_ai_actions a JOIN public.pub_native_ai_items i ON i.owner_id=a.owner_id AND i.id=a.item_id WHERE a.owner_id=b.owner_id AND a.batch_id=b.id),'[]'::jsonb))$$;
CREATE FUNCTION public.native_ai_touch(p_owner text,p_id uuid,p_kind text) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE a public.pub_native_ai_actions%ROWTYPE;BEGIN
 UPDATE public.pub_native_ai_actions SET state=(SELECT public.native_ai_aggregate(array_agg(state)) FROM public.pub_native_ai_slots WHERE owner_id=p_owner AND action_id=p_id),revision=revision+1,updated_at=now() WHERE owner_id=p_owner AND id=p_id RETURNING * INTO a;
 IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AI_NOT_FOUND';END IF;
 IF a.batch_id IS NOT NULL THEN UPDATE public.pub_native_ai_items SET revision=revision+1,updated_at=now() WHERE owner_id=p_owner AND id=a.item_id;UPDATE public.pub_native_ai_batches SET revision=revision+1,updated_at=now() WHERE owner_id=p_owner AND id=a.batch_id;END IF;
 INSERT INTO public.pub_native_ai_events(owner_id,action_id,kind,safe_payload) VALUES(p_owner,p_id,p_kind,jsonb_build_object('state',a.state,'revision',a.revision));
END$$;
CREATE FUNCTION public.native_ai_insert_action(p_owner text,p_id uuid,p_scope jsonb,p_snapshot jsonb,p_hash text) RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE a public.pub_native_ai_actions%ROWTYPE;s jsonb;BEGIN
 -- The server supplies its JavaScript canonical digest. JSONB equality below
 -- independently seals the immutable bytes without inventing numeric formatting.
 IF p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'NATIVE_AI_ACTION_HASH_INVALID';END IF;
 SELECT * INTO a FROM public.pub_native_ai_actions WHERE owner_id=p_owner AND id=p_id;
 IF FOUND THEN IF a.scope IS DISTINCT FROM p_scope OR a.action_hash IS DISTINCT FROM p_hash OR a.snapshot IS DISTINCT FROM p_snapshot THEN RAISE EXCEPTION 'NATIVE_AI_IDEMPOTENCY_CONFLICT';END IF;RETURN false;END IF;
 PERFORM public.native_ai_assert_snapshot(p_owner,p_id,p_scope,p_snapshot);
 INSERT INTO public.pub_native_ai_actions(id,owner_id,scope,task_id,turn_id,batch_id,item_id,source_action_id,kind,snapshot,action_hash) VALUES(p_id,p_owner,p_scope,(p_scope->>'taskId')::uuid,(p_scope->>'turnId')::uuid,(p_scope->>'batchId')::uuid,(p_scope->>'itemId')::uuid,(p_snapshot->>'sourceActionId')::uuid,p_snapshot->>'kind',p_snapshot,p_hash);
 FOR s IN SELECT * FROM jsonb_array_elements(p_snapshot->'slots') LOOP INSERT INTO public.pub_native_ai_slots(owner_id,action_id,slot,consumer,main_request_key,wire_request,wire_request_hash) VALUES(p_owner,p_id,(s->>'slot')::integer,s->>'consumer',s->>'requestKey',s->'wireRequest',s->>'wireRequestHash');END LOOP;
 IF p_scope->>'kind'='batch' THEN UPDATE public.pub_native_ai_items SET revision=revision+1,updated_at=now() WHERE owner_id=p_owner AND id=(p_scope->>'itemId')::uuid;UPDATE public.pub_native_ai_batches SET revision=revision+1,updated_at=now() WHERE owner_id=p_owner AND id=(p_scope->>'batchId')::uuid;END IF;
 INSERT INTO public.pub_native_ai_events(owner_id,action_id,kind,safe_payload) VALUES(p_owner,p_id,'prepared',jsonb_build_object('actionHash',p_hash,'state','proposed'));RETURN true;
END$$;

CREATE FUNCTION public.mutate_native_ai_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op text:=p_input->>'action';allowed text[];required text[];k text;h text;r public.pub_native_ai_requests%ROWTYPE;a public.pub_native_ai_actions%ROWTYPE;s public.pub_native_ai_slots%ROWTYPE;b public.pub_native_ai_batches%ROWTYPE;
 v_id uuid;v_batch uuid;v_scope jsonb;v_snapshot jsonb;v_item jsonb;v_initial jsonb;v_slot integer;v_count integer;v_index integer:=0;v_result jsonb;v_manifest jsonb;v_dispatch boolean:=false;v_amount numeric;v_sum numeric;v_budget numeric;v_state text;v_receipt jsonb;v_record_id text;v_refs jsonb;
BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 CASE op
  WHEN 'prepare-action' THEN allowed:=ARRAY['action','requestKey','actionId','scope','snapshot','actionHash'];
  WHEN 'decide' THEN allowed:=ARRAY['action','requestKey','proposalId','expectedRevision','decision'];
  WHEN 'claim-dispatch' THEN allowed:=ARRAY['action','requestKey','actionId','expectedRevision','slot'];
  WHEN 'admit-consumer' THEN allowed:=ARRAY['action','requestKey','actionId','slot','dispatchId','wireRequestHash','consumer','modelPublicId','surface','priceHash','reservationAmount','unit'];
  WHEN 'reconcile' THEN allowed:=ARRAY['action','requestKey','actionId','slot'];
  WHEN 'prepare-batch' THEN allowed:=ARRAY['action','requestKey','batchId','snapshot','items'];
  WHEN 'decide-batch' THEN allowed:=ARRAY['action','requestKey','batchId','expectedRevision','manifestHash','decision'];
  ELSE RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';
 END CASE;
 PERFORM public.pub2_assert_json_keys(p_input,allowed,allowed);
 IF jsonb_typeof(p_input->'requestKey') IS DISTINCT FROM 'string' OR length(p_input->>'requestKey') NOT BETWEEN 8 AND 160 OR p_input->>'requestKey'!~'^[A-Za-z0-9_.:-]+$' OR NOT public.native_ai_no_credentials(p_input) THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
 h:=public.native_ai_hash(p_input);SELECT * INTO r FROM public.pub_native_ai_requests WHERE owner_id=p_user_id AND request_key=p_input->>'requestKey';
 IF FOUND THEN
  IF r.request_hash IS DISTINCT FROM h OR r.request_payload IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'NATIVE_AI_IDEMPOTENCY_CONFLICT';END IF;
  IF op='claim-dispatch' THEN RETURN jsonb_set(r.result,'{shouldDispatch}','false');ELSIF op='admit-consumer' THEN RETURN jsonb_set(r.result,'{admission,newlyAdmitted}','false');ELSE RETURN r.result;END IF;
 END IF;
 FOREACH k IN ARRAY ARRAY['actionId','proposalId','batchId','dispatchId'] LOOP IF p_input?k AND NOT public.native_ai_uuid(p_input->k) THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;END LOOP;
 IF p_input?'expectedRevision' AND NOT public.native_ai_integer(p_input->'expectedRevision',1,2147483647) OR p_input?'slot' AND NOT public.native_ai_integer(p_input->'slot',0,8) THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
 IF op='prepare-batch' THEN
  v_id:=(p_input->>'batchId')::uuid;v_snapshot:=p_input->'snapshot';
  PERFORM public.pub2_assert_json_keys(v_snapshot,ARRAY['version','mode','collectionId','prompt','captionPrompt','quantity','imageCount','plannerModelId','generationModelId','options','platforms','budget','savePolicy'],ARRAY['version','mode','collectionId','prompt','captionPrompt','quantity','imageCount','plannerModelId','generationModelId','options','platforms','budget','savePolicy']);
  IF v_snapshot->>'version' IS DISTINCT FROM 'native-ai-batch.v1' OR v_snapshot->>'mode' IS NULL OR v_snapshot->>'mode' NOT IN ('image_text','video') OR v_snapshot->>'savePolicy' IS DISTINCT FROM 'confirm_resolved_drafts' OR NOT public.native_ai_integer(v_snapshot->'quantity',1,10) OR jsonb_typeof(v_snapshot->'prompt') IS DISTINCT FROM 'string' OR length(btrim(v_snapshot->>'prompt')) NOT BETWEEN 1 AND 24000 OR jsonb_typeof(v_snapshot->'captionPrompt') IS DISTINCT FROM 'string' OR length(v_snapshot->>'captionPrompt')>24000 OR v_snapshot->>'plannerModelId' IS NULL OR v_snapshot->>'plannerModelId'!~'^pm_[A-Za-z0-9_-]+$' OR v_snapshot->>'generationModelId' IS NULL OR v_snapshot->>'generationModelId'!~'^pm_[A-Za-z0-9_-]+$' THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  IF v_snapshot->>'mode'='image_text' AND NOT public.native_ai_integer(v_snapshot->'imageCount',1,9) OR v_snapshot->>'mode'='video' AND v_snapshot->'imageCount'<>'null'::jsonb THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  IF v_snapshot->'collectionId'<>'null'::jsonb AND (NOT public.native_ai_uuid(v_snapshot->'collectionId') OR NOT EXISTS(SELECT 1 FROM public.pub2_collections WHERE id=(v_snapshot->>'collectionId')::uuid AND user_id=p_user_id AND NOT archived)) THEN RAISE EXCEPTION 'NATIVE_AI_RESOURCE_SCOPE_INVALID';END IF;
  PERFORM public.pub2_assert_json_keys(v_snapshot->'options',ARRAY['aspectRatio','resolution','duration'],ARRAY['aspectRatio','resolution','duration']);
  IF jsonb_typeof(v_snapshot->'options'->'aspectRatio') IS DISTINCT FROM 'string' OR length(v_snapshot->'options'->>'aspectRatio') NOT BETWEEN 1 AND 24 OR jsonb_typeof(v_snapshot->'options'->'resolution') IS DISTINCT FROM 'string' OR length(v_snapshot->'options'->>'resolution') NOT BETWEEN 1 AND 32 OR v_snapshot->>'mode'='video' AND NOT public.native_ai_integer(v_snapshot->'options'->'duration',1,120) OR v_snapshot->>'mode'='image_text' AND v_snapshot->'options'->'duration'<>'null'::jsonb THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  PERFORM public.pub2_assert_json_keys(v_snapshot->'budget',ARRAY['credits','CNY'],ARRAY['credits','CNY']);PERFORM public.native_ai_decimal(v_snapshot->'budget'->>'credits');PERFORM public.native_ai_decimal(v_snapshot->'budget'->>'CNY');
  IF jsonb_typeof(v_snapshot->'platforms') IS DISTINCT FROM 'array' OR jsonb_array_length(v_snapshot->'platforms')>14 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_snapshot->'platforms') x WHERE x NOT IN ('linkedin','wxSph','xhs','douyin','tiktok','KWAI','youtube','bilibili','twitter','wxGzh','facebook','instagram','threads','pinterest')) OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_snapshot->'platforms') x GROUP BY x HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  v_count:=(v_snapshot->>'quantity')::integer;
  IF jsonb_typeof(p_input->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'items')<>v_count OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'items') x GROUP BY x->>'id' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  IF EXISTS(SELECT 1 FROM public.pub_native_ai_batches WHERE id=v_id) THEN RAISE EXCEPTION 'NATIVE_AI_IDEMPOTENCY_CONFLICT';END IF;
  INSERT INTO public.pub_native_ai_batches(id,owner_id,request_key,snapshot,request_hash) VALUES(v_id,p_user_id,p_input->>'requestKey',v_snapshot,public.native_ai_hash(v_snapshot));
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_input->'items') LOOP
   PERFORM public.pub2_assert_json_keys(v_item,ARRAY['id','ordinal','initialAction'],ARRAY['id','ordinal','initialAction']);v_initial:=v_item->'initialAction';PERFORM public.pub2_assert_json_keys(v_initial,ARRAY['id','snapshot','actionHash'],ARRAY['id','snapshot','actionHash']);
   IF NOT public.native_ai_uuid(v_item->'id') OR v_item->'ordinal' IS DISTINCT FROM to_jsonb(v_index) OR NOT public.native_ai_uuid(v_initial->'id') OR v_initial->'snapshot'->>'kind' IS DISTINCT FROM 'plan_text' OR v_initial->'snapshot'->'sourceActionId'<>'null'::jsonb THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
   INSERT INTO public.pub_native_ai_items(id,owner_id,batch_id,ordinal,root_action_id) VALUES((v_item->>'id')::uuid,p_user_id,v_id,v_index,(v_initial->>'id')::uuid);
   v_scope:=jsonb_build_object('kind','batch','batchId',v_id,'itemId',v_item->>'id');PERFORM public.native_ai_insert_action(p_user_id,(v_initial->>'id')::uuid,v_scope,v_initial->'snapshot',v_initial->>'actionHash');v_index:=v_index+1;
  END LOOP;
  SELECT * INTO b FROM public.pub_native_ai_batches WHERE owner_id=p_user_id AND id=v_id;v_result:=public.native_ai_batch_result(b);
 ELSIF op='prepare-action' THEN
  v_id:=(p_input->>'actionId')::uuid;v_scope:=p_input->'scope';
  IF v_scope->>'kind'='batch' THEN IF NOT public.native_ai_uuid(v_scope->'batchId') THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;PERFORM 1 FROM public.pub_native_ai_batches WHERE owner_id=p_user_id AND id=(v_scope->>'batchId')::uuid FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AI_NOT_FOUND';END IF;END IF;
  PERFORM public.native_ai_insert_action(p_user_id,v_id,v_scope,p_input->'snapshot',p_input->>'actionHash');SELECT * INTO a FROM public.pub_native_ai_actions WHERE owner_id=p_user_id AND id=v_id;v_result:=jsonb_build_object('action',public.native_ai_action_dto(a));
 ELSIF op='decide-batch' THEN
  SELECT * INTO b FROM public.pub_native_ai_batches WHERE owner_id=p_user_id AND id=(p_input->>'batchId')::uuid FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AI_NOT_FOUND';END IF;
  IF b.revision::numeric IS DISTINCT FROM (p_input->>'expectedRevision')::numeric THEN RAISE EXCEPTION 'NATIVE_AI_REVISION_CONFLICT';END IF;
  v_manifest:=public.native_ai_manifest(p_user_id,b.id);IF jsonb_array_length(v_manifest)=0 OR p_input->>'manifestHash' IS DISTINCT FROM public.native_ai_hash(v_manifest) THEN RAISE EXCEPTION 'NATIVE_AI_MANIFEST_CHANGED';END IF;
  IF p_input->>'decision' IS NULL OR p_input->>'decision' NOT IN ('approve','reject') THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  FOR a IN SELECT * FROM public.pub_native_ai_actions WHERE owner_id=p_user_id AND batch_id=b.id AND state='proposed' ORDER BY id FOR UPDATE LOOP
   IF p_input->>'decision'='approve' THEN PERFORM public.native_ai_assert_snapshot(p_user_id,a.id,a.scope,a.snapshot);END IF;
   UPDATE public.pub_native_ai_slots SET state=CASE WHEN p_input->>'decision'='approve' THEN 'approved' ELSE 'rejected' END,updated_at=now() WHERE owner_id=p_user_id AND action_id=a.id;
   PERFORM public.native_ai_touch(p_user_id,a.id,'batch_'||(p_input->>'decision'));
  END LOOP;
     SELECT x.* INTO b FROM public.pub_native_ai_batches x WHERE x.owner_id=p_user_id AND x.id=b.id;v_result:=public.native_ai_batch_result(b);
 ELSE
  v_id:=coalesce(p_input->>'actionId',p_input->>'proposalId')::uuid;
  SELECT batch_id INTO v_batch FROM public.pub_native_ai_actions WHERE owner_id=p_user_id AND id=v_id;IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AI_NOT_FOUND';END IF;
  IF v_batch IS NOT NULL THEN PERFORM 1 FROM public.pub_native_ai_batches WHERE owner_id=p_user_id AND id=v_batch FOR UPDATE;END IF;
  SELECT * INTO a FROM public.pub_native_ai_actions WHERE owner_id=p_user_id AND id=v_id FOR UPDATE;
  IF op='decide' THEN
   IF a.revision::numeric IS DISTINCT FROM (p_input->>'expectedRevision')::numeric THEN RAISE EXCEPTION 'NATIVE_AI_REVISION_CONFLICT';END IF;
   IF a.state<>'proposed' OR p_input->>'decision' IS NULL OR p_input->>'decision' NOT IN ('approve','reject') THEN RAISE EXCEPTION 'NATIVE_AI_STATE_CONFLICT';END IF;
   IF p_input->>'decision'='approve' THEN PERFORM public.native_ai_assert_snapshot(p_user_id,a.id,a.scope,a.snapshot);END IF;
   UPDATE public.pub_native_ai_slots SET state=CASE WHEN p_input->>'decision'='approve' THEN 'approved' ELSE 'rejected' END,updated_at=now() WHERE owner_id=p_user_id AND action_id=a.id;
   PERFORM public.native_ai_touch(p_user_id,a.id,p_input->>'decision');SELECT * INTO a FROM public.pub_native_ai_actions WHERE owner_id=p_user_id AND id=v_id;v_result:=jsonb_build_object('action',public.native_ai_action_dto(a));
  ELSE
   v_slot:=(p_input->>'slot')::integer;SELECT * INTO s FROM public.pub_native_ai_slots WHERE owner_id=p_user_id AND action_id=v_id AND slot=v_slot FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AI_NOT_FOUND';END IF;
   IF op='claim-dispatch' THEN
    IF a.revision::numeric IS DISTINCT FROM (p_input->>'expectedRevision')::numeric THEN RAISE EXCEPTION 'NATIVE_AI_REVISION_CONFLICT';END IF;
    IF s.dispatch_id IS NOT NULL THEN v_dispatch:=false;
    ELSE
     IF s.state<>'approved' THEN RAISE EXCEPTION 'NATIVE_AI_STATE_CONFLICT';END IF;
     PERFORM public.native_ai_assert_snapshot(p_user_id,a.id,a.scope,a.snapshot);
     v_dispatch:=true;
     IF s.consumer='main_image' AND EXISTS(SELECT 1 FROM public.image_generation_requests WHERE user_id::text=p_user_id AND client_idempotency_key=s.main_request_key)
      OR s.consumer='main_video' AND EXISTS(SELECT 1 FROM public.video_tasks WHERE user_id::text=p_user_id AND client_request_id=s.main_request_key)
      OR s.consumer='main_llm' AND EXISTS(SELECT 1 FROM public.llm_request_attempts WHERE user_id=p_user_id AND client_request_id=s.main_request_key)
      OR s.consumer='native_core' AND EXISTS(SELECT 1 FROM public.pub_native_core_requests WHERE owner_id=p_user_id AND request_key=s.main_request_key)
      OR s.consumer='publish_manifest' AND EXISTS(SELECT 1 FROM public.pub_native_ai_publish_manifests WHERE owner_id=p_user_id AND action_id=a.id)
      OR a.kind='plan_text' AND a.turn_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.pub_native_agent_turns WHERE owner_id=p_user_id AND id=a.turn_id AND lease_owner IS NOT NULL)
     THEN v_dispatch:=false;END IF;
     UPDATE public.pub_native_ai_slots SET dispatch_id=gen_random_uuid(),claimed_at=clock_timestamp(),state=CASE WHEN v_dispatch THEN 'dispatch_claimed' ELSE 'awaiting_result' END,updated_at=now() WHERE action_id=v_id AND slot=v_slot;PERFORM public.native_ai_touch(p_user_id,a.id,'dispatch_claimed');
    END IF;
    SELECT * INTO a FROM public.pub_native_ai_actions WHERE owner_id=p_user_id AND id=v_id;SELECT * INTO s FROM public.pub_native_ai_slots WHERE owner_id=p_user_id AND action_id=v_id AND slot=v_slot;
    v_result:=jsonb_build_object('action',public.native_ai_action_dto(a),'slot',public.native_ai_slot_dto(s),'shouldDispatch',v_dispatch,'dispatchId',s.dispatch_id);
   ELSIF op='admit-consumer' THEN
    IF s.consumer NOT IN ('main_llm','main_image','main_video') OR s.dispatch_id IS NULL OR s.dispatch_id::text IS DISTINCT FROM p_input->>'dispatchId' OR s.wire_request_hash IS DISTINCT FROM p_input->>'wireRequestHash' OR s.consumer IS DISTINCT FROM p_input->>'consumer' OR a.snapshot->'args'->>'modelId' IS DISTINCT FROM p_input->>'modelPublicId' OR a.snapshot->'surface' IS DISTINCT FROM p_input->'surface' OR a.snapshot->'quote'->>'priceHash' IS DISTINCT FROM p_input->>'priceHash' OR a.snapshot->'quote'->>'unit' IS DISTINCT FROM p_input->>'unit' OR jsonb_typeof(p_input->'reservationAmount') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'NATIVE_AI_ADMISSION_MISMATCH';END IF;
    v_amount:=public.native_ai_decimal(p_input->>'reservationAmount');
    IF s.admitted_at IS NOT NULL THEN IF s.reservation_amount IS DISTINCT FROM p_input->>'reservationAmount' OR s.unit IS DISTINCT FROM p_input->>'unit' THEN RAISE EXCEPTION 'NATIVE_AI_ADMISSION_MISMATCH';END IF;v_dispatch:=false;
    ELSE
     IF s.state<>'dispatch_claimed' THEN RAISE EXCEPTION 'NATIVE_AI_STATE_CONFLICT';END IF;PERFORM public.native_ai_assert_snapshot(p_user_id,a.id,a.scope,a.snapshot);
     SELECT coalesce(sum(public.native_ai_decimal(reservation_amount)),0) INTO v_sum FROM public.pub_native_ai_slots WHERE owner_id=p_user_id AND action_id=v_id AND admitted_at IS NOT NULL;
     IF v_sum+v_amount>public.native_ai_decimal(a.snapshot->'quote'->>'maxAmount') THEN RAISE EXCEPTION 'NATIVE_AI_BUDGET_EXCEEDED';END IF;
     IF v_batch IS NOT NULL THEN
      SELECT public.native_ai_decimal(snapshot->'budget'->>(p_input->>'unit')) INTO v_budget FROM public.pub_native_ai_batches WHERE owner_id=p_user_id AND id=v_batch;
      SELECT coalesce(sum(public.native_ai_decimal(x.reservation_amount)),0) INTO v_sum FROM public.pub_native_ai_slots x JOIN public.pub_native_ai_actions y ON y.owner_id=x.owner_id AND y.id=x.action_id WHERE x.owner_id=p_user_id AND y.batch_id=v_batch AND x.unit=p_input->>'unit' AND x.admitted_at IS NOT NULL;
      IF v_sum+v_amount>v_budget THEN RAISE EXCEPTION 'NATIVE_AI_BUDGET_EXCEEDED';END IF;
     END IF;
     UPDATE public.pub_native_ai_slots SET admitted_at=clock_timestamp(),reservation_amount=p_input->>'reservationAmount',unit=p_input->>'unit',state='awaiting_result',updated_at=now() WHERE action_id=v_id AND slot=v_slot;PERFORM public.native_ai_touch(p_user_id,a.id,'consumer_admitted');v_dispatch:=true;
    END IF;
    SELECT * INTO a FROM public.pub_native_ai_actions WHERE owner_id=p_user_id AND id=v_id;SELECT * INTO s FROM public.pub_native_ai_slots WHERE owner_id=p_user_id AND action_id=v_id AND slot=v_slot;v_result:=jsonb_build_object('action',public.native_ai_action_dto(a),'slot',public.native_ai_slot_dto(s),'admission',jsonb_build_object('newlyAdmitted',v_dispatch,'reservationAmount',s.reservation_amount,'unit',s.unit));
   ELSE
    -- Reconciliation is observation only. Absence never restores a dispatch grant.
    IF s.dispatch_id IS NULL OR s.state IN ('proposed','approved','rejected') THEN RAISE EXCEPTION 'NATIVE_AI_STATE_CONFLICT';END IF;
    IF s.receipt IS NULL THEN
     v_state:='unknown';v_receipt:=NULL;v_refs:='[]'::jsonb;v_record_id:=NULL;
     IF s.consumer='main_image' THEN
      SELECT to_jsonb(x) INTO v_result FROM public.image_generation_requests x WHERE x.user_id::text=p_user_id AND x.client_idempotency_key=s.main_request_key FOR SHARE NOWAIT;
      IF FOUND THEN
       v_record_id:=v_result->>'record_id';v_state:='awaiting_result';
       IF v_result->>'state'='failed' THEN v_state:='failed_known';
       ELSIF v_result->>'state'='completed' AND v_result->>'delivery_state'='delivered' THEN
        IF v_result->>'delivery_asset_id' IS NOT NULL AND EXISTS(SELECT 1 FROM public.user_files WHERE id::text=v_result->>'delivery_asset_id' AND user_id::text=p_user_id AND content_type LIKE 'image/%') THEN v_state:='succeeded';v_refs:=jsonb_build_array(jsonb_build_object('kind','image_asset','id',v_result->>'delivery_asset_id'));
        ELSIF v_result->'response'->>'deliveryMode'='provider_url' AND coalesce(v_result->'response'->>'sourceExpiredAt','')='' THEN v_state:='succeeded';v_refs:=jsonb_build_array(jsonb_build_object('kind','image_record','id',v_record_id));END IF;
       END IF;
      END IF;
     ELSIF s.consumer='main_video' THEN
      SELECT to_jsonb(x) INTO v_result FROM public.video_tasks x WHERE x.user_id::text=p_user_id AND x.client_request_id=s.main_request_key FOR SHARE NOWAIT;
      IF FOUND THEN v_record_id:=v_result->>'id';v_state:='awaiting_result';IF v_result->>'status'='failed' THEN v_state:='failed_known';ELSIF v_result->>'status'='completed' AND v_result->>'source_expired_at' IS NULL THEN v_state:='succeeded';v_refs:=jsonb_build_array(jsonb_build_object('kind','video_task','id',v_record_id));END IF;END IF;
     ELSIF s.consumer='main_llm' THEN
      SELECT to_jsonb(x) INTO v_result FROM public.llm_request_attempts x WHERE x.user_id=p_user_id AND x.client_request_id=s.main_request_key FOR SHARE NOWAIT;
      IF FOUND THEN v_record_id:=v_result->>'record_id';v_state:='awaiting_result';IF v_result->>'state'='failed' THEN v_state:='failed_known';ELSIF v_result->>'state'='succeeded' AND (v_result->>'http_status')::integer BETWEEN 200 AND 299 AND v_result->>'response_body' IS NOT NULL AND v_result->>'response_fingerprint'=encode(sha256(convert_to(v_result->>'response_body','UTF8')),'hex') AND length(coalesce(v_result->>'result_reference',''))>0 THEN v_state:='succeeded';v_refs:=jsonb_build_array(jsonb_build_object('kind','llm_attempt','id',v_record_id));END IF;END IF;
     ELSIF s.consumer='native_core' THEN
      SELECT to_jsonb(x) INTO v_result FROM public.pub_native_core_requests x WHERE x.owner_id=p_user_id AND x.request_key=s.main_request_key FOR SHARE NOWAIT;
      IF FOUND THEN
       IF s.wire_request->>'action' IS DISTINCT FROM 'save-native-draft' OR v_result->'request_payload' IS DISTINCT FROM s.wire_request-ARRAY['requestKey','requestHash','connectionId'] THEN RAISE EXCEPTION 'NATIVE_AI_LOCAL_RECEIPT_MISMATCH';END IF;
       IF v_result->'result'->>'ok'='true' AND EXISTS(SELECT 1 FROM public.pub2_draft_versions WHERE user_id=p_user_id AND draft_id::text=v_result->'result'->'base'->'row'->>'id' AND version::text=v_result->'result'->'base'->'row'->>'revision') THEN v_state:='succeeded';v_record_id:=v_result->>'id';v_refs:=jsonb_build_array(jsonb_build_object('kind','draft','id',v_result->'result'->'base'->'row'->>'id'));END IF;
      END IF;
     ELSIF s.consumer='publish_manifest' THEN
      -- This is a local confirmation handoff. It is never a provider/API publish.
      PERFORM public.native_ai_assert_snapshot(p_user_id,a.id,a.scope,a.snapshot);
      INSERT INTO public.pub_native_ai_publish_manifests(id,owner_id,action_id,draft_id,draft_version,snapshot)
       VALUES(a.id,p_user_id,a.id,(a.snapshot->'args'->>'draftId')::uuid,(a.snapshot->'args'->>'expectedRevision')::integer,jsonb_build_object('version','native-ai-publish-manifest.v1','state','awaiting_user_confirmation','actionId',a.id,'draftId',a.snapshot->'args'->'draftId','draftVersion',a.snapshot->'args'->'expectedRevision','confirmation',a.snapshot->'args','resources',a.snapshot->'resources'));
      v_state:='succeeded';v_record_id:=a.id::text;v_refs:=jsonb_build_array(jsonb_build_object('kind','manifest','id',v_record_id));
     END IF;
     IF v_state IN ('succeeded','failed_known') THEN v_receipt:=jsonb_build_object('source',s.consumer,'id',v_record_id,'status',v_state,'resultRefs',v_refs);END IF;
     IF s.state IS DISTINCT FROM v_state OR v_receipt IS NOT NULL THEN UPDATE public.pub_native_ai_slots SET state=v_state,receipt=v_receipt,updated_at=now() WHERE action_id=v_id AND slot=v_slot;PERFORM public.native_ai_touch(p_user_id,a.id,'reconciled');END IF;
    END IF;
    SELECT * INTO a FROM public.pub_native_ai_actions WHERE owner_id=p_user_id AND id=v_id;SELECT * INTO s FROM public.pub_native_ai_slots WHERE owner_id=p_user_id AND action_id=v_id AND slot=v_slot;v_result:=jsonb_build_object('action',public.native_ai_action_dto(a),'slot',public.native_ai_slot_dto(s));
   END IF;
  END IF;
 END IF;
 INSERT INTO public.pub_native_ai_requests(owner_id,request_key,request_hash,request_payload,result) VALUES(p_user_id,p_input->>'requestKey',h,p_input,v_result);
 RETURN v_result;
END$$;

CREATE FUNCTION public.read_native_ai_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op text:=p_input->>'action';allowed text[];a public.pub_native_ai_actions%ROWTYPE;s public.pub_native_ai_slots%ROWTYPE;b public.pub_native_ai_batches%ROWTYPE;r public.pub_native_ai_requests%ROWTYPE;n bigint;v_page integer;v_size integer;v_items jsonb;v_counts jsonb;BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 CASE op
  WHEN 'action' THEN allowed:=ARRAY['action','actionId'];
  WHEN 'action-by-request-key' THEN allowed:=ARRAY['action','requestKey'];
  WHEN 'actions-for-task' THEN allowed:=ARRAY['action','taskId','page','pageSize'];
  WHEN 'consumer-invocation' THEN allowed:=ARRAY['action','consumer','mainRequestKey'];
  WHEN 'batch' THEN allowed:=ARRAY['action','batchId'];
  WHEN 'batches' THEN allowed:=ARRAY['action','page','pageSize'];
  WHEN 'batch-stats' THEN allowed:=ARRAY['action'];
  ELSE RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';
 END CASE;
 PERFORM public.pub2_assert_json_keys(p_input,allowed,allowed);
 IF op='consumer-invocation' THEN
  IF p_input->>'consumer' IS NULL OR p_input->>'consumer' NOT IN ('main_llm','main_image','main_video') OR jsonb_typeof(p_input->'mainRequestKey') IS DISTINCT FROM 'string' OR length(p_input->>'mainRequestKey') NOT BETWEEN 8 AND 160 OR p_input->>'mainRequestKey'!~'^[A-Za-z0-9_.:-]+$' THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  SELECT * INTO s FROM public.pub_native_ai_slots WHERE owner_id=p_user_id AND consumer=p_input->>'consumer' AND main_request_key=p_input->>'mainRequestKey';
  IF NOT FOUND THEN RETURN jsonb_build_object('found',false);END IF;
  SELECT * INTO a FROM public.pub_native_ai_actions WHERE owner_id=p_user_id AND id=s.action_id;IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AI_NOT_FOUND';END IF;
  -- Server-only admission lookup: the HTTP projection must not expose snapshot.wireRequest.
  RETURN jsonb_build_object('found',true,'action',public.native_ai_action_dto(a),'slot',public.native_ai_slot_dto(s),'snapshot',a.snapshot);
 ELSIF op='actions-for-task' THEN
  IF NOT public.native_ai_uuid(p_input->'taskId') OR NOT public.native_ai_integer(p_input->'page',1,1000000) OR NOT public.native_ai_integer(p_input->'pageSize',1,50) THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pub_native_agent_tasks WHERE owner_id=p_user_id AND id=(p_input->>'taskId')::uuid) THEN RAISE EXCEPTION 'NATIVE_AI_NOT_FOUND';END IF;
  v_page:=(p_input->>'page')::integer;v_size:=(p_input->>'pageSize')::integer;
  SELECT count(*) INTO n FROM public.pub_native_ai_actions WHERE owner_id=p_user_id AND task_id=(p_input->>'taskId')::uuid;
  SELECT coalesce(jsonb_agg(public.native_ai_action_dto(x::public.pub_native_ai_actions) ORDER BY x.created_at DESC,x.id),'[]'::jsonb) INTO v_items FROM (SELECT * FROM public.pub_native_ai_actions WHERE owner_id=p_user_id AND task_id=(p_input->>'taskId')::uuid ORDER BY created_at DESC,id LIMIT v_size OFFSET (v_page-1)*v_size) x;
  RETURN jsonb_build_object('items',v_items,'page',v_page,'pageSize',v_size,'total',n);
 ELSIF op IN ('action','action-by-request-key') THEN
  IF op='action' THEN IF NOT public.native_ai_uuid(p_input->'actionId') THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;SELECT * INTO a FROM public.pub_native_ai_actions WHERE owner_id=p_user_id AND id=(p_input->>'actionId')::uuid;
  ELSE
   IF jsonb_typeof(p_input->'requestKey') IS DISTINCT FROM 'string' OR length(p_input->>'requestKey') NOT BETWEEN 8 AND 160 OR p_input->>'requestKey'!~'^[A-Za-z0-9_.:-]+$' THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;
   SELECT * INTO r FROM public.pub_native_ai_requests WHERE owner_id=p_user_id AND request_key=p_input->>'requestKey';IF NOT FOUND OR r.result->'action'->>'id' IS NULL THEN RAISE EXCEPTION 'NATIVE_AI_NOT_FOUND';END IF;
   SELECT * INTO a FROM public.pub_native_ai_actions WHERE owner_id=p_user_id AND id=(r.result->'action'->>'id')::uuid;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AI_NOT_FOUND';END IF;RETURN jsonb_build_object('action',public.native_ai_action_dto(a));
 ELSIF op='batch' THEN
  IF NOT public.native_ai_uuid(p_input->'batchId') THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;SELECT * INTO b FROM public.pub_native_ai_batches WHERE owner_id=p_user_id AND id=(p_input->>'batchId')::uuid;IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_AI_NOT_FOUND';END IF;RETURN public.native_ai_batch_result(b);
 ELSIF op='batches' THEN
  IF NOT public.native_ai_integer(p_input->'page',1,1000000) OR NOT public.native_ai_integer(p_input->'pageSize',1,50) THEN RAISE EXCEPTION 'NATIVE_AI_INPUT_INVALID';END IF;v_page:=(p_input->>'page')::integer;v_size:=(p_input->>'pageSize')::integer;
  SELECT count(*) INTO n FROM public.pub_native_ai_batches WHERE owner_id=p_user_id;
  SELECT coalesce(jsonb_agg(public.native_ai_batch_dto(x::public.pub_native_ai_batches) ORDER BY x.created_at DESC,x.id),'[]'::jsonb) INTO v_items FROM (SELECT * FROM public.pub_native_ai_batches WHERE owner_id=p_user_id ORDER BY created_at DESC,id LIMIT v_size OFFSET (v_page-1)*v_size) x;
  RETURN jsonb_build_object('items',v_items,'page',v_page,'pageSize',v_size,'total',n);
 ELSE
  SELECT count(*) INTO n FROM public.pub_native_ai_batches WHERE owner_id=p_user_id;
  SELECT jsonb_object_agg(state,c) INTO v_counts FROM (SELECT public.native_ai_batch_dto(x)->>'state' AS state,count(*) AS c FROM public.pub_native_ai_batches x WHERE owner_id=p_user_id GROUP BY public.native_ai_batch_dto(x)->>'state') grouped;
  RETURN jsonb_build_object('total',n,'counts','{"proposed":0,"approved":0,"rejected":0,"dispatch_claimed":0,"awaiting_result":0,"succeeded":0,"failed_known":0,"unknown":0}'::jsonb||coalesce(v_counts,'{}'::jsonb));
 END IF;
END$$;

DO $$DECLARE f regprocedure;BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'native_ai_%' OR p.proname IN ('mutate_native_ai_atomic','read_native_ai_atomic')) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);END LOOP;
END$$;
GRANT EXECUTE ON FUNCTION public.mutate_native_ai_atomic(text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_native_ai_atomic(text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
