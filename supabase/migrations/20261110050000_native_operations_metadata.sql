BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
CREATE TABLE public.pub_native_collection_meta(collection_id uuid PRIMARY KEY REFERENCES public.pub2_collections(id) ON DELETE CASCADE,owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,revision integer NOT NULL CHECK(revision>0),payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.pub_native_draft_meta(draft_id uuid NOT NULL,draft_version integer NOT NULL,owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,revision integer NOT NULL CHECK(revision>0),payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(draft_id,draft_version),FOREIGN KEY(draft_id,draft_version) REFERENCES public.pub2_draft_versions(draft_id,version) ON DELETE CASCADE);
CREATE TABLE public.pub_native_group_meta(group_id uuid PRIMARY KEY REFERENCES public.pub2_groups(id) ON DELETE CASCADE,owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,rank integer NOT NULL CHECK(rank>=0),revision integer NOT NULL CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.pub_native_account_meta(owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,account_kind text NOT NULL CHECK(account_kind IN ('browser','official')),account_id uuid NOT NULL,group_id uuid REFERENCES public.pub2_groups(id) ON DELETE SET NULL,rank integer NOT NULL CHECK(rank>=0),revision integer NOT NULL CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,account_kind,account_id));
CREATE TABLE public.pub_native_meta_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,entity_kind text NOT NULL CHECK(entity_kind IN ('collection','draft','group','account')),entity_id uuid NOT NULL,entity_version integer,revision integer NOT NULL,payload_hash text NOT NULL,safe_snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.pub_native_publish_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,connection_id text NOT NULL,request_key text NOT NULL,request_hash text NOT NULL,plan_hash text NOT NULL,request_payload jsonb NOT NULL,result_mapping jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,request_key));
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['pub_native_collection_meta','pub_native_draft_meta','pub_native_group_meta','pub_native_account_meta','pub_native_meta_events','pub_native_publish_plans'] LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',t);EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',t);END LOOP;END$$;
CREATE FUNCTION public.native_metadata_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.users WHERE id=OLD.owner_id) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'NATIVE_METADATA_HISTORY_IMMUTABLE';
END$$;
CREATE TRIGGER native_draft_meta_immutable BEFORE UPDATE OR DELETE ON public.pub_native_draft_meta FOR EACH ROW EXECUTE FUNCTION public.native_metadata_history_guard();
CREATE TRIGGER native_meta_events_immutable BEFORE UPDATE OR DELETE ON public.pub_native_meta_events FOR EACH ROW EXECUTE FUNCTION public.native_metadata_history_guard();
CREATE TRIGGER native_publish_plan_immutable BEFORE UPDATE OR DELETE ON public.pub_native_publish_plans FOR EACH ROW EXECUTE FUNCTION public.native_metadata_history_guard();
CREATE FUNCTION public.native_account_group_removed() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE v_snapshot jsonb;BEGIN
 IF OLD.group_id IS NOT NULL AND NEW.group_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.pub2_groups WHERE id=OLD.group_id) AND EXISTS(SELECT 1 FROM public.users WHERE id=OLD.owner_id) THEN
  NEW.revision:=OLD.revision+1;NEW.updated_at:=now();v_snapshot:=jsonb_build_object('accountKind',NEW.account_kind,'rank',NEW.rank,'groupId',NULL,'reason','group_removed');
  INSERT INTO public.pub_native_meta_events(owner_id,entity_kind,entity_id,revision,payload_hash,safe_snapshot) VALUES(NEW.owner_id,'account',NEW.account_id,NEW.revision,encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex'),v_snapshot);
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER native_group_removal_account_revision BEFORE UPDATE OF group_id ON public.pub_native_account_meta FOR EACH ROW EXECUTE FUNCTION public.native_account_group_removed();
CREATE FUNCTION public.native_assert_draft_metadata(p jsonb,d jsonb,p_user_id text,p_connection text) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE m jsonb;a public.pub3_assets%ROWTYPE;v jsonb;k text;v_index integer:=0;BEGIN
 PERFORM public.pub2_assert_json_keys(p,ARRAY['schemaVersion','media','coverMediaId','accountTypes','maxUseCountByAccountType'],ARRAY['schemaVersion','media','coverMediaId','accountTypes','maxUseCountByAccountType']);
 IF p->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p->'media') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'media')>30 OR jsonb_typeof(p->'accountTypes') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'accountTypes')>14 OR NOT(p->'accountTypes' <@ '["linkedin","wxSph","xhs","douyin","tiktok","KWAI","youtube","bilibili","twitter","wxGzh","facebook","instagram","threads","pinterest"]'::jsonb) OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'accountTypes') x GROUP BY x HAVING count(*)>1) OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'media') x GROUP BY x->>'mediaId' HAVING count(*)>1) OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'media') x GROUP BY x->>'assetId' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
 PERFORM public.pub2_assert_json_keys(p->'maxUseCountByAccountType',ARRAY['linkedin','wxSph','xhs','douyin','tiktok','KWAI','youtube','bilibili','twitter','wxGzh','facebook','instagram','threads','pinterest'],ARRAY[]::text[]);
 FOR k IN SELECT jsonb_object_keys(p->'maxUseCountByAccountType') LOOP IF NOT(p->'accountTypes' ? k) OR p->'maxUseCountByAccountType'->k IS DISTINCT FROM '999999'::jsonb THEN RAISE EXCEPTION 'NATIVE_LIMIT_POLICY_NOT_CONNECTED';END IF;END LOOP;
 IF (SELECT count(*) FROM jsonb_object_keys(p->'maxUseCountByAccountType'))<>jsonb_array_length(p->'accountTypes') THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
 IF jsonb_array_length(p->'media')<>jsonb_array_length(d->'media') THEN RAISE EXCEPTION 'NATIVE_METADATA_ASSET_INVALID';END IF;
 IF p->'coverMediaId' IS DISTINCT FROM 'null'::jsonb AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'media') x WHERE x->>'id'=p->>'coverMediaId' AND x->>'role' IN ('image','cover')) THEN RAISE EXCEPTION 'NATIVE_METADATA_ASSET_INVALID';END IF;
 FOR m IN SELECT * FROM jsonb_array_elements(p->'media') LOOP
  PERFORM public.pub2_assert_json_keys(m,ARRAY['mediaId','assetId'],ARRAY['mediaId','assetId']);
  IF m->>'mediaId' IS DISTINCT FROM d->'media'->v_index->>'id' THEN RAISE EXCEPTION 'NATIVE_METADATA_ASSET_INVALID';END IF;v_index:=v_index+1;
  IF jsonb_typeof(m->'mediaId') IS DISTINCT FROM 'string' OR jsonb_typeof(m->'assetId') IS DISTINCT FROM 'string' OR m->>'mediaId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR m->>'assetId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'NATIVE_METADATA_ASSET_INVALID';END IF;
  SELECT * INTO a FROM public.pub3_assets WHERE id=(m->>'assetId')::uuid AND owner_id=p_user_id AND connection_id=p_connection AND state='ready' AND (expires_at IS NULL OR expires_at>now()) FOR SHARE;
  IF NOT FOUND OR a.local_media_id::text IS DISTINCT FROM m->>'mediaId' THEN RAISE EXCEPTION 'NATIVE_METADATA_ASSET_INVALID';END IF;
  SELECT x INTO v FROM jsonb_array_elements(d->'media') x WHERE x->>'id'=m->>'mediaId';
  IF NOT FOUND OR v->>'source' IS DISTINCT FROM 'local_file' OR v->'requiresReselection' IS DISTINCT FROM 'true'::jsonb OR a.size IS DISTINCT FROM (v->>'size')::bigint OR a.mime IS DISTINCT FROM v->>'type' OR a.sha256 IS DISTINCT FROM v->>'hash' OR a.file_name IS DISTINCT FROM v->>'fileName' OR v->'lastModified' IS DISTINCT FROM '0'::jsonb THEN RAISE EXCEPTION 'NATIVE_METADATA_ASSET_INVALID';END IF;
  FOREACH k IN ARRAY ARRAY['width','height','duration'] LOOP IF v->k IS DISTINCT FROM a.metadata->k THEN RAISE EXCEPTION 'NATIVE_METADATA_ASSET_INVALID';END IF;END LOOP;
 END LOOP;
END$$;
CREATE FUNCTION public.mutate_native_metadata_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_action text:=p_input->>'action';v_conn text:=p_input->>'connectionId';v_result jsonb;v_row jsonb;v_meta jsonb:=p_input->'metadata';v_id uuid;v_revision integer;v_expected integer;v_version integer;v_kind text;v_item jsonb;v_items jsonb;v_account_kind text;v_group uuid;v_rank integer;v_base jsonb:=p_input->'base';v_plan public.pub_native_publish_plans%ROWTYPE;v_request jsonb;v_hash text;v_groups jsonb:='[]';v_plan_group jsonb;v_batch jsonb;v_official jsonb;v_official_result jsonb;v_target jsonb;v_intent jsonb;v_entry jsonb;BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR public.pub3_no_credentials(p_input) IS NOT TRUE OR jsonb_typeof(p_input->'connectionId') IS DISTINCT FROM 'string' OR length(v_conn) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
 IF v_action='prepare-publish' THEN
  PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','connectionId','requestKey','planHash','sourceDraftId','sourceDraftVersion','groups'],ARRAY['action','connectionId','requestKey','planHash','groups']);
  IF jsonb_typeof(p_input->'requestKey') IS DISTINCT FROM 'string' OR length(p_input->>'requestKey') NOT BETWEEN 8 AND 160 OR p_input->>'requestKey' !~ '^[A-Za-z0-9_.:-]+$' OR jsonb_typeof(p_input->'planHash') IS DISTINCT FROM 'string' OR p_input->>'planHash' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
  v_request:=p_input-ARRAY['action','requestKey'];v_hash:=encode(sha256(convert_to(v_request::text,'UTF8')),'hex');
  SELECT * INTO v_plan FROM public.pub_native_publish_plans WHERE owner_id=p_user_id AND request_key=p_input->>'requestKey';
  IF FOUND THEN IF v_plan.request_hash IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;RETURN jsonb_build_object('manifestId',v_plan.id,'groups',v_plan.result_mapping,'alreadyFulfilled',true);END IF;
  IF (p_input ? 'sourceDraftId') IS DISTINCT FROM (p_input ? 'sourceDraftVersion') THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
  IF p_input ? 'sourceDraftId' THEN IF jsonb_typeof(p_input->'sourceDraftId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_input->'sourceDraftVersion') IS DISTINCT FROM 'number' OR p_input->>'sourceDraftId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_input->>'sourceDraftVersion' !~ '^[1-9]\d*$' THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;PERFORM 1 FROM public.pub2_draft_versions WHERE draft_id=(p_input->>'sourceDraftId')::uuid AND version=(p_input->>'sourceDraftVersion')::integer AND user_id=p_user_id;IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_METADATA_OWNER_MISMATCH';END IF;END IF;
  IF jsonb_typeof(p_input->'groups') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'groups') NOT BETWEEN 1 AND 2 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'groups') g GROUP BY g->>'key' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
  v_items:='[]';
  FOR v_plan_group IN SELECT * FROM jsonb_array_elements(p_input->'groups') LOOP
   PERFORM public.pub2_assert_json_keys(v_plan_group,ARRAY['key','draft','metadata','officialTargets'],ARRAY['key','draft','metadata','officialTargets']);
   IF jsonb_typeof(v_plan_group->'key') IS DISTINCT FROM 'string' OR v_plan_group->>'key' NOT IN ('image','video') OR v_plan_group->>'key' IS DISTINCT FROM v_plan_group->'draft'->>'contentType' OR jsonb_typeof(v_plan_group->'officialTargets') IS DISTINCT FROM 'array' OR jsonb_array_length(v_plan_group->'officialTargets')>100 THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
   FOR v_target IN SELECT * FROM jsonb_array_elements(v_plan_group->'draft'->'targets') LOOP IF v_target->>'platform' NOT IN ('xhs','wxSph') THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;v_items:=v_items||jsonb_build_array(v_target->'id');END LOOP;
   FOR v_target IN SELECT * FROM jsonb_array_elements(v_plan_group->'officialTargets') LOOP v_items:=v_items||jsonb_build_array(v_target->'id');END LOOP;
  END LOOP;
  IF jsonb_array_length(v_items)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_items) x GROUP BY x HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
  FOR v_plan_group IN SELECT * FROM jsonb_array_elements(p_input->'groups') LOOP
   v_result:=public.mutate_native_metadata_atomic(p_user_id,jsonb_build_object('action','save-draft','connectionId',v_conn,'base',jsonb_build_object('action','save-draft','expectedRevision',0,'draft',v_plan_group->'draft'),'expectedMetadataRevision',0,'metadata',v_plan_group->'metadata'));v_row:=v_result->'base'->'row';v_batch:=NULL;v_official_result:='[]';
   IF jsonb_array_length(v_plan_group->'draft'->'targets')>0 THEN SELECT jsonb_agg(t->'id') INTO v_items FROM jsonb_array_elements(v_plan_group->'draft'->'targets') t;v_batch:=public.mutate_publish_v2_atomic(p_user_id,jsonb_build_object('action','create-batch','draftId',v_row->'id','draftVersion',v_row->'revision','targetIds',v_items,'idempotencyKey','native-batch:'||(v_row->>'id')));END IF;
   FOR v_target IN SELECT * FROM jsonb_array_elements(v_plan_group->'officialTargets') LOOP
    PERFORM public.pub2_assert_json_keys(v_target,ARRAY['id','bindingId','bindingRevision','titleOverride','bodyOverride','topicsOverride','mediaIds','coverMediaId','assetIds','publishAt','options'],ARRAY['id','bindingId','bindingRevision','mediaIds','assetIds','publishAt','options']);
    IF jsonb_typeof(v_target->'id') IS DISTINCT FROM 'string' OR v_target->>'id' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
    v_intent:=(v_target-'id')||jsonb_build_object('draftId',v_row->'id','draftVersion',v_row->'revision');
    v_official:=public.mutate_publish_v3_atomic(p_user_id,jsonb_build_object('action','save-intent','connectionId',v_conn,'expectedRevision',0,'payload',v_intent));v_official_result:=v_official_result||jsonb_build_array(jsonb_build_object('targetId',v_target->'id','intent',v_official->'intent'));
   END LOOP;
   v_entry:=jsonb_build_object('key',v_plan_group->'key','draft',v_row,'officialTargets',v_official_result);IF v_batch IS NOT NULL THEN v_entry:=v_entry||jsonb_build_object('batch',v_batch->'row');END IF;v_groups:=v_groups||jsonb_build_array(v_entry);
  END LOOP;
  INSERT INTO public.pub_native_publish_plans(owner_id,connection_id,request_key,request_hash,plan_hash,request_payload,result_mapping) VALUES(p_user_id,v_conn,p_input->>'requestKey',v_hash,p_input->>'planHash',v_request,v_groups) RETURNING * INTO v_plan;
  RETURN jsonb_build_object('manifestId',v_plan.id,'groups',v_groups,'alreadyFulfilled',false);
 ELSIF v_action='archive-draft' THEN
  PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','connectionId','id','expectedRevision'],ARRAY['action','connectionId','id','expectedRevision']);
  v_result:=public.mutate_publish_v2_atomic(p_user_id,p_input-ARRAY['connectionId']);v_row:=v_result->'row';v_id:=(v_row->>'id')::uuid;v_version:=(v_row->>'revision')::integer;
  SELECT payload,revision INTO v_meta,v_revision FROM public.pub_native_draft_meta WHERE owner_id=p_user_id AND draft_id=v_id ORDER BY draft_version DESC LIMIT 1;
  IF FOUND THEN INSERT INTO public.pub_native_draft_meta(draft_id,draft_version,owner_id,revision,payload) VALUES(v_id,v_version,p_user_id,v_revision+1,v_meta);INSERT INTO public.pub_native_meta_events(owner_id,entity_kind,entity_id,entity_version,revision,payload_hash,safe_snapshot) VALUES(p_user_id,'draft',v_id,v_version,v_revision+1,encode(sha256(convert_to(v_meta::text,'UTF8')),'hex'),v_meta);END IF;
  RETURN jsonb_build_object('base',v_result,'archived',true);
 ELSIF v_action='save-browser-account' THEN
  PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','connectionId','account','groupId','expectedMetadataRevision'],ARRAY['action','connectionId','account']);
  v_item:=p_input->'account';PERFORM public.pub2_assert_json_keys(v_item,ARRAY['platform','platformAccountId','displayName','avatar'],ARRAY['platform','platformAccountId','displayName']);
  IF v_item->>'platform' NOT IN ('xhs','wxSph') OR jsonb_typeof(v_item->'platformAccountId') IS DISTINCT FROM 'string' OR length(trim(v_item->>'platformAccountId')) NOT BETWEEN 1 AND 160 OR jsonb_typeof(v_item->'displayName') IS DISTINCT FROM 'string' OR length(trim(v_item->>'displayName')) NOT BETWEEN 1 AND 200 OR v_item ? 'avatar' AND public.pub2_safe_https(v_item->>'avatar') IS NOT TRUE THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
  IF p_input ? 'groupId' AND p_input->'groupId' IS DISTINCT FROM 'null'::jsonb THEN PERFORM 1 FROM public.pub2_groups WHERE id=(p_input->>'groupId')::uuid AND user_id=p_user_id FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_METADATA_OWNER_MISMATCH';END IF;END IF;
  SELECT to_jsonb(a) INTO v_row FROM public.pub_accounts a WHERE a.user_id=p_user_id AND a.platform=v_item->>'platform' AND a.platform_account_id=v_item->>'platformAccountId';
  IF v_row IS NULL OR v_row->>'display_name' IS DISTINCT FROM v_item->>'displayName' OR v_row->>'avatar' IS DISTINCT FROM v_item->>'avatar' THEN v_row:=public.save_publish_account_atomic(p_user_id,v_item->>'platform',v_item->>'platformAccountId',v_item->>'displayName',v_item->>'avatar');END IF;
  IF p_input ? 'groupId' THEN
   SELECT revision,rank INTO v_revision,v_rank FROM public.pub_native_account_meta WHERE owner_id=p_user_id AND account_kind='browser' AND account_id=(v_row->>'id')::uuid;
   IF FOUND AND NOT(p_input ? 'expectedMetadataRevision') THEN RAISE EXCEPTION 'NATIVE_METADATA_REVISION_CONFLICT';END IF;
   v_result:=public.mutate_native_metadata_atomic(p_user_id,jsonb_build_object('action','save-account','connectionId',v_conn,'accountKind','browser','accountId',v_row->'id','groupId',p_input->'groupId','rank',coalesce(v_rank,0),'expectedRevision',coalesce((p_input->>'expectedMetadataRevision')::integer,0)));
  END IF;RETURN jsonb_build_object('account',v_row);
 ELSIF v_action IN ('save-collection','save-draft','save-group') THEN
  IF v_action='save-group' THEN PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','connectionId','base','expectedMetadataRevision','rank'],ARRAY['action','connectionId','base','expectedMetadataRevision','rank']);ELSE PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','connectionId','base','expectedMetadataRevision','metadata'],ARRAY['action','connectionId','base','expectedMetadataRevision','metadata']);END IF;
  IF jsonb_typeof(p_input->'expectedMetadataRevision') IS DISTINCT FROM 'number' OR p_input->>'expectedMetadataRevision' !~ '^\d+$' OR v_base->>'action' IS DISTINCT FROM v_action THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
  v_expected:=(p_input->>'expectedMetadataRevision')::integer;v_revision:=0;
  IF v_base ? 'id' THEN
   v_id:=(v_base->>'id')::uuid;
   IF v_action='save-collection' THEN SELECT revision INTO v_revision FROM public.pub_native_collection_meta WHERE collection_id=v_id AND owner_id=p_user_id FOR UPDATE;
   ELSIF v_action='save-draft' THEN SELECT revision INTO v_revision FROM public.pub_native_draft_meta WHERE draft_id=v_id AND owner_id=p_user_id ORDER BY draft_version DESC LIMIT 1;
   ELSE SELECT revision INTO v_revision FROM public.pub_native_group_meta WHERE group_id=v_id AND owner_id=p_user_id FOR UPDATE;END IF;
  END IF;
  IF coalesce(v_revision,0) IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'NATIVE_METADATA_REVISION_CONFLICT';END IF;
  IF v_action='save-collection' THEN
   PERFORM public.pub2_assert_json_keys(v_meta,ARRAY['schemaVersion','platforms','useScene','useSceneRelId'],ARRAY['schemaVersion','platforms','useScene','useSceneRelId']);
   IF v_meta->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(v_meta->'platforms') IS DISTINCT FROM 'array' OR jsonb_array_length(v_meta->'platforms')>14 OR NOT(v_meta->'platforms' <@ '["linkedin","wxSph","xhs","douyin","tiktok","KWAI","youtube","bilibili","twitter","wxGzh","facebook","instagram","threads","pinterest"]'::jsonb) OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_meta->'platforms') x GROUP BY x HAVING count(*)>1) OR v_meta->'useScene' IS DISTINCT FROM 'null'::jsonb OR v_meta->'useSceneRelId' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
  ELSIF v_action='save-draft' THEN PERFORM public.native_assert_draft_metadata(v_meta,v_base->'draft',p_user_id,v_conn);
  ELSE IF jsonb_typeof(p_input->'rank') IS DISTINCT FROM 'number' OR p_input->>'rank' !~ '^\d+$' THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;END IF;
  v_result:=public.mutate_publish_v2_atomic(p_user_id,v_base);v_row:=v_result->'row';v_id:=(v_row->>'id')::uuid;v_revision:=v_expected+1;
  IF v_action='save-collection' THEN v_kind:='collection';INSERT INTO public.pub_native_collection_meta(collection_id,owner_id,revision,payload) VALUES(v_id,p_user_id,v_revision,v_meta) ON CONFLICT(collection_id) DO UPDATE SET revision=EXCLUDED.revision,payload=EXCLUDED.payload,updated_at=now();
  ELSIF v_action='save-draft' THEN v_kind:='draft';v_version:=(v_row->>'revision')::integer;INSERT INTO public.pub_native_draft_meta(draft_id,draft_version,owner_id,revision,payload) VALUES(v_id,v_version,p_user_id,v_revision,v_meta);
  ELSE v_kind:='group';v_meta:=jsonb_build_object('rank',(p_input->>'rank')::integer);INSERT INTO public.pub_native_group_meta(group_id,owner_id,rank,revision) VALUES(v_id,p_user_id,(p_input->>'rank')::integer,v_revision) ON CONFLICT(group_id) DO UPDATE SET rank=EXCLUDED.rank,revision=EXCLUDED.revision,updated_at=now();END IF;
  INSERT INTO public.pub_native_meta_events(owner_id,entity_kind,entity_id,entity_version,revision,payload_hash,safe_snapshot) VALUES(p_user_id,v_kind,v_id,v_version,v_revision,encode(sha256(convert_to(v_meta::text,'UTF8')),'hex'),v_meta);
  RETURN jsonb_build_object('base',v_result,'metadata',v_meta,'metadataRevision',v_revision);
 ELSIF v_action IN ('save-account','reorder-accounts','reorder-groups') THEN
  IF v_action='save-account' THEN PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','connectionId','accountKind','accountId','groupId','rank','expectedRevision'],ARRAY['action','connectionId','accountKind','accountId','groupId','rank','expectedRevision']);v_items:=jsonb_build_array(jsonb_build_object('id',p_input->'accountId','accountKind',p_input->'accountKind','groupId',p_input->'groupId','rank',p_input->'rank','expectedRevision',p_input->'expectedRevision'));
  ELSE PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','connectionId','items'],ARRAY['action','connectionId','items']);v_items:=p_input->'items';END IF;
  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' OR jsonb_array_length(v_items) NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_items) x GROUP BY x->>'id',x->>'accountKind' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
   IF v_action='reorder-groups' THEN PERFORM public.pub2_assert_json_keys(v_item,ARRAY['id','rank','expectedRevision'],ARRAY['id','rank','expectedRevision']);ELSIF v_action='save-account' THEN PERFORM public.pub2_assert_json_keys(v_item,ARRAY['id','accountKind','groupId','rank','expectedRevision'],ARRAY['id','accountKind','groupId','rank','expectedRevision']);ELSE PERFORM public.pub2_assert_json_keys(v_item,ARRAY['id','accountKind','rank','expectedRevision'],ARRAY['id','accountKind','rank','expectedRevision']);END IF;
   IF jsonb_typeof(v_item->'id') IS DISTINCT FROM 'string' OR v_item->>'id' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR jsonb_typeof(v_item->'rank') IS DISTINCT FROM 'number' OR v_item->>'rank' !~ '^\d+$' OR jsonb_typeof(v_item->'expectedRevision') IS DISTINCT FROM 'number' OR v_item->>'expectedRevision' !~ '^\d+$' THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
   v_id:=(v_item->>'id')::uuid;v_rank:=(v_item->>'rank')::integer;v_expected:=(v_item->>'expectedRevision')::integer;v_revision:=0;v_account_kind:=v_item->>'accountKind';v_group:=NULL;
   IF v_action='reorder-groups' THEN
    PERFORM 1 FROM public.pub2_groups WHERE id=v_id AND user_id=p_user_id FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_METADATA_OWNER_MISMATCH';END IF;
    SELECT revision INTO v_revision FROM public.pub_native_group_meta WHERE group_id=v_id AND owner_id=p_user_id FOR UPDATE;IF coalesce(v_revision,0) IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'NATIVE_METADATA_REVISION_CONFLICT';END IF;
    v_kind:='group';v_meta:=jsonb_build_object('rank',v_rank);INSERT INTO public.pub_native_group_meta(group_id,owner_id,rank,revision) VALUES(v_id,p_user_id,v_rank,v_expected+1) ON CONFLICT(group_id) DO UPDATE SET rank=EXCLUDED.rank,revision=EXCLUDED.revision,updated_at=now();
   ELSE
    IF v_account_kind='browser' THEN PERFORM 1 FROM public.pub_accounts WHERE id=v_id AND user_id=p_user_id FOR SHARE;ELSIF v_account_kind='official' THEN PERFORM 1 FROM public.pub3_account_bindings WHERE id=v_id AND owner_id=p_user_id AND connection_id=v_conn FOR SHARE;ELSE RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_METADATA_OWNER_MISMATCH';END IF;
    SELECT revision,group_id INTO v_revision,v_group FROM public.pub_native_account_meta WHERE account_id=v_id AND account_kind=v_account_kind AND owner_id=p_user_id FOR UPDATE;IF coalesce(v_revision,0) IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'NATIVE_METADATA_REVISION_CONFLICT';END IF;
    IF v_action='save-account' THEN IF v_item->'groupId'='null'::jsonb THEN v_group:=NULL;ELSE IF jsonb_typeof(v_item->'groupId') IS DISTINCT FROM 'string' OR v_item->>'groupId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;v_group:=(v_item->>'groupId')::uuid;END IF;END IF;
    IF v_group IS NOT NULL THEN PERFORM 1 FROM public.pub2_groups WHERE id=v_group AND user_id=p_user_id FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_METADATA_OWNER_MISMATCH';END IF;END IF;
    v_kind:='account';v_meta:=jsonb_build_object('accountKind',v_account_kind,'rank',v_rank,'groupId',v_group);INSERT INTO public.pub_native_account_meta(owner_id,account_kind,account_id,group_id,rank,revision) VALUES(p_user_id,v_account_kind,v_id,v_group,v_rank,v_expected+1) ON CONFLICT(owner_id,account_kind,account_id) DO UPDATE SET group_id=EXCLUDED.group_id,rank=EXCLUDED.rank,revision=EXCLUDED.revision,updated_at=now();
   END IF;
   INSERT INTO public.pub_native_meta_events(owner_id,entity_kind,entity_id,revision,payload_hash,safe_snapshot) VALUES(p_user_id,v_kind,v_id,v_expected+1,encode(sha256(convert_to(v_meta::text,'UTF8')),'hex'),v_meta);
  END LOOP;RETURN jsonb_build_object('ok',true);
 ELSE RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
END$$;
REVOKE ALL ON FUNCTION public.native_metadata_history_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.native_account_group_removed() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.native_assert_draft_metadata(jsonb,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mutate_native_metadata_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mutate_native_metadata_atomic(text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
