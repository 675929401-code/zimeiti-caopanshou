BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';

-- Existing provider uploads keep their pub3 FK. Main-site results keep their
-- real owner ledger references and never receive fabricated pub3 asset rows.
ALTER TABLE public.pub_native_media_entries ALTER COLUMN asset_id DROP NOT NULL;
ALTER TABLE public.pub_native_media_entries ADD COLUMN source_kind text NOT NULL DEFAULT 'provider_asset',ADD COLUMN main_reference jsonb;
ALTER TABLE public.pub_native_media_entries ADD CONSTRAINT native_media_source_xor CHECK((
 (source_kind='provider_asset' AND asset_id IS NOT NULL AND main_reference IS NULL)
 OR (source_kind='main_asset' AND asset_id IS NULL AND jsonb_typeof(main_reference)='object'
  AND main_reference ?& ARRAY['kind','id'] AND (main_reference-ARRAY['kind','id'])='{}'::jsonb
  AND main_reference->>'kind' IN ('image_record','image_asset','video_task')
  AND jsonb_typeof(main_reference->'id')='string' AND length(main_reference->>'id') BETWEEN 1 AND 256 AND main_reference->>'id'~'^[A-Za-z0-9_.:-]+$'
  AND (main_reference->>'kind'<>'image_asset' OR main_reference->>'id'~*'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'))) IS TRUE);
CREATE UNIQUE INDEX native_original_main_media_once ON public.pub_native_media_entries(owner_id,(main_reference->>'kind'),(main_reference->>'id'),collection_id) WHERE source_kind='main_asset' AND NOT is_copy AND NOT archived;

CREATE FUNCTION public.native_media_entry_source(e public.pub_native_media_entries) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$SELECT CASE WHEN e.source_kind='provider_asset' THEN jsonb_build_object('kind','provider_asset','assetId',e.asset_id) ELSE jsonb_build_object('kind','main_asset','reference',e.main_reference) END$$;
CREATE FUNCTION public.native_media_source_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF (NEW.id,NEW.owner_id,NEW.source_kind,NEW.asset_id,NEW.main_reference,NEW.source_entry_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.source_kind,OLD.asset_id,OLD.main_reference,OLD.source_entry_id,OLD.created_at) THEN RAISE EXCEPTION 'NATIVE_MEDIA_SOURCE_IMMUTABLE';END IF;RETURN NEW;
END$$;
CREATE TRIGGER native_media_source_identity BEFORE UPDATE ON public.pub_native_media_entries FOR EACH ROW EXECUTE FUNCTION public.native_media_source_immutable();

-- Preserve the original validator and every V1 caller, including provider-file
-- name/hash/size/dimensions/namespace validation. Only the V2 branch is new.
ALTER FUNCTION public.native_assert_draft_metadata(jsonb,jsonb,text,text) RENAME TO native_assert_draft_metadata_v1;
REVOKE ALL ON FUNCTION public.native_assert_draft_metadata_v1(jsonb,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.native_assert_draft_metadata(p jsonb,d jsonb,p_user_id text,p_connection text) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE mapping jsonb;media jsonb;source jsonb;index integer:=0;k text;BEGIN
 IF p->'schemaVersion'='1'::jsonb THEN PERFORM public.native_assert_draft_metadata_v1(p,d,p_user_id,p_connection);RETURN;END IF;
 PERFORM public.pub2_assert_json_keys(p,ARRAY['schemaVersion','media','coverMediaId','accountTypes','maxUseCountByAccountType'],ARRAY['schemaVersion','media','coverMediaId','accountTypes','maxUseCountByAccountType']);
 IF p->'schemaVersion' IS DISTINCT FROM '2'::jsonb OR jsonb_typeof(p->'media') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'media')>30 OR jsonb_typeof(d->'media') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'media')<>jsonb_array_length(d->'media') OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'media') x GROUP BY x->>'mediaId' HAVING count(*)>1)
  OR jsonb_typeof(p->'accountTypes') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'accountTypes')>14 OR NOT(p->'accountTypes'<@'["linkedin","wxSph","xhs","douyin","tiktok","KWAI","youtube","bilibili","twitter","wxGzh","facebook","instagram","threads","pinterest"]'::jsonb) OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'accountTypes') x GROUP BY x HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
 PERFORM public.pub2_assert_json_keys(p->'maxUseCountByAccountType',ARRAY['linkedin','wxSph','xhs','douyin','tiktok','KWAI','youtube','bilibili','twitter','wxGzh','facebook','instagram','threads','pinterest'],ARRAY[]::text[]);
 IF (SELECT count(*) FROM jsonb_object_keys(p->'maxUseCountByAccountType'))<>jsonb_array_length(p->'accountTypes') THEN RAISE EXCEPTION 'NATIVE_METADATA_INPUT_INVALID';END IF;
 FOR k IN SELECT jsonb_object_keys(p->'maxUseCountByAccountType') LOOP IF NOT(p->'accountTypes'?k) OR p->'maxUseCountByAccountType'->k IS DISTINCT FROM '999999'::jsonb THEN RAISE EXCEPTION 'NATIVE_LIMIT_POLICY_NOT_CONNECTED';END IF;END LOOP;
 IF p->'coverMediaId'<>'null'::jsonb AND (NOT public.native_ai_uuid(p->'coverMediaId') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'media') x WHERE x->'id'=p->'coverMediaId' AND x->>'role' IN ('image','cover'))) THEN RAISE EXCEPTION 'NATIVE_METADATA_ASSET_INVALID';END IF;
 FOR mapping IN SELECT * FROM jsonb_array_elements(p->'media') LOOP
  PERFORM public.pub2_assert_json_keys(mapping,ARRAY['mediaId','source'],ARRAY['mediaId','source']);media:=d->'media'->index;source:=mapping->'source';index:=index+1;
  IF NOT public.native_ai_uuid(mapping->'mediaId') OR mapping->'mediaId' IS DISTINCT FROM media->'id' THEN RAISE EXCEPTION 'NATIVE_METADATA_ASSET_INVALID';END IF;
  IF source->>'kind'='provider_asset' THEN
   PERFORM public.pub2_assert_json_keys(source,ARRAY['kind','assetId'],ARRAY['kind','assetId']);
   PERFORM public.native_assert_draft_metadata_v1(jsonb_build_object('schemaVersion',1,'media',jsonb_build_array(jsonb_build_object('mediaId',mapping->'mediaId','assetId',source->'assetId')),'coverMediaId',NULL,'accountTypes','[]'::jsonb,'maxUseCountByAccountType','{}'::jsonb),jsonb_build_object('media',jsonb_build_array(media)),p_user_id,p_connection);
  ELSIF source->>'kind'='main_asset' THEN
   PERFORM public.pub2_assert_json_keys(source,ARRAY['kind','reference'],ARRAY['kind','reference']);
   IF media->>'source' IS DISTINCT FROM 'main_asset' OR media->'requiresReselection' IS DISTINCT FROM 'false'::jsonb OR media->'reference' IS DISTINCT FROM source->'reference' THEN RAISE EXCEPTION 'NATIVE_METADATA_ASSET_INVALID';END IF;
   PERFORM public.native_ai_assert_source(p_user_id,source,media->>'role');
   PERFORM public.pub2_assert_media(p_user_id,jsonb_build_object('media',jsonb_build_array(media)));
  ELSE RAISE EXCEPTION 'NATIVE_METADATA_ASSET_INVALID';END IF;
 END LOOP;
END$$;
REVOKE ALL ON FUNCTION public.native_assert_draft_metadata(jsonb,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.native_media_register_source(p_owner text,p_collection uuid,p_source jsonb,p_title text) RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE v_id uuid;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pub2_collections WHERE user_id=p_owner AND id=p_collection AND NOT archived) THEN RAISE EXCEPTION 'NATIVE_CORE_OWNER_MISMATCH';END IF;
 PERFORM public.native_ai_assert_source(p_owner,p_source);
 IF p_source->>'kind'='provider_asset' THEN
  SELECT id INTO v_id FROM public.pub_native_media_entries WHERE owner_id=p_owner AND collection_id=p_collection AND source_kind='provider_asset' AND asset_id=(p_source->>'assetId')::uuid AND NOT is_copy AND NOT archived;
 ELSE
  SELECT id INTO v_id FROM public.pub_native_media_entries WHERE owner_id=p_owner AND collection_id=p_collection AND source_kind='main_asset' AND main_reference=p_source->'reference' AND NOT is_copy AND NOT archived;
 END IF;
 IF v_id IS NOT NULL THEN RETURN v_id;END IF;
 INSERT INTO public.pub_native_media_entries(owner_id,asset_id,source_kind,main_reference,collection_id,title) VALUES(p_owner,(p_source->>'assetId')::uuid,p_source->>'kind',p_source->'reference',p_collection,p_title) RETURNING id INTO v_id;RETURN v_id;
END$$;
REVOKE ALL ON FUNCTION public.native_media_register_source(text,uuid,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.mutate_native_core_atomic(text,jsonb) RENAME TO mutate_native_core_v1_atomic;
REVOKE ALL ON FUNCTION public.mutate_native_core_v1_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.mutate_native_core_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op text:=p_input->>'action';is_v2 boolean:=p_input->'save'->'metadata'->'schemaVersion'='2'::jsonb;has_main boolean:=false;
 cached public.pub_native_core_requests%ROWTYPE;entry public.pub_native_media_entries%ROWTYPE;body jsonb;h text;save jsonb;metadata jsonb;draft jsonb;mapping jsonb;ref jsonb;result jsonb;base_result jsonb;row_data jsonb;items jsonb:='[]'::jsonb;source jsonb;
 draft_id uuid;version integer;old_version integer;old_id uuid;collection uuid;entry_id uuid;new_id uuid;new_revision integer;item jsonb;actual_revision integer;target_revision integer;BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 IF op='transfer-media' AND jsonb_typeof(p_input->'items')='array' THEN SELECT EXISTS(SELECT 1 FROM public.pub_native_media_entries e JOIN jsonb_array_elements(p_input->'items') i ON e.id::text=i->>'id' WHERE e.owner_id=p_user_id AND e.source_kind='main_asset') INTO has_main;END IF;
 IF NOT(op='save-native-draft' AND is_v2 IS TRUE OR op='transfer-media' AND has_main) THEN RETURN public.mutate_native_core_v1_atomic(p_user_id,p_input);END IF;
 IF op='save-native-draft' THEN PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','requestKey','requestHash','connectionId','save','mediaEntryRefs'],ARRAY['action','requestKey','requestHash','connectionId','save','mediaEntryRefs']);
 ELSE PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','requestKey','requestHash','connectionId','items','targetCollectionId','expectedTargetCollectionRevision','mode'],ARRAY['action','requestKey','requestHash','connectionId','items','targetCollectionId','expectedTargetCollectionRevision','mode']);END IF;
 IF NOT public.native_ai_no_credentials(p_input) OR jsonb_typeof(p_input->'requestKey') IS DISTINCT FROM 'string' OR length(p_input->>'requestKey') NOT BETWEEN 8 AND 160 OR p_input->>'requestKey'!~'^[A-Za-z0-9_.:-]+$' OR p_input->>'requestHash' IS NULL OR p_input->>'requestHash'!~'^[a-f0-9]{64}$' OR jsonb_typeof(p_input->'connectionId') IS DISTINCT FROM 'string' OR length(p_input->>'connectionId') NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
 body:=p_input-ARRAY['requestKey','requestHash','connectionId'];h:=encode(sha256(convert_to(body::text,'UTF8')),'hex');
 SELECT * INTO cached FROM public.pub_native_core_requests WHERE owner_id=p_user_id AND request_key=p_input->>'requestKey';IF FOUND THEN IF cached.request_hash IS DISTINCT FROM h OR cached.request_payload IS DISTINCT FROM body THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;RETURN cached.result||jsonb_build_object('alreadyFulfilled',true);END IF;
 IF op='save-native-draft' THEN
  save:=p_input->'save';IF save->>'action' IS DISTINCT FROM 'save-draft' OR jsonb_typeof(p_input->'mediaEntryRefs') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'mediaEntryRefs')>30 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'mediaEntryRefs') x GROUP BY x->>'mediaId' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
  old_id:=(save->'base'->>'id')::uuid;old_version:=(save->'base'->>'expectedRevision')::integer;
  -- The existing metadata/base RPC remains the single owner + revision writer.
  base_result:=public.mutate_native_metadata_atomic(p_user_id,save||jsonb_build_object('connectionId',p_input->>'connectionId'));
  row_data:=base_result->'base'->'row';draft_id:=(row_data->>'id')::uuid;version:=(row_data->>'revision')::integer;draft:=row_data->'payload';metadata:=base_result->'metadata';collection:=(draft->>'collectionId')::uuid;
  FOR ref IN SELECT * FROM jsonb_array_elements(p_input->'mediaEntryRefs') LOOP
   PERFORM public.pub2_assert_json_keys(ref,ARRAY['mediaId','mediaEntryId'],ARRAY['mediaId','mediaEntryId']);IF NOT public.native_ai_uuid(ref->'mediaId') OR NOT public.native_ai_uuid(ref->'mediaEntryId') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(metadata->'media') x WHERE x->'mediaId'=ref->'mediaId') THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
  END LOOP;
  FOR mapping IN SELECT * FROM jsonb_array_elements(metadata->'media') LOOP
   source:=mapping->'source';entry_id:=NULL;
   SELECT x INTO ref FROM jsonb_array_elements(p_input->'mediaEntryRefs') x WHERE x->'mediaId'=mapping->'mediaId';
   IF FOUND THEN
    SELECT * INTO entry FROM public.pub_native_media_entries WHERE owner_id=p_user_id AND id=(ref->>'mediaEntryId')::uuid AND NOT archived FOR SHARE;
    IF NOT FOUND OR public.native_media_entry_source(entry) IS DISTINCT FROM source THEN RAISE EXCEPTION 'NATIVE_CORE_OWNER_MISMATCH';END IF;entry_id:=entry.id;
   ELSIF old_id IS NOT NULL THEN
    SELECT e.* INTO entry FROM public.pub_native_media_usage_refs u JOIN public.pub_native_media_entries e ON e.owner_id=u.owner_id AND e.id=u.media_entry_id WHERE u.owner_id=p_user_id AND u.draft_id=old_id AND u.draft_version=old_version AND u.media_id::text=mapping->>'mediaId' AND NOT e.archived;
    IF FOUND AND public.native_media_entry_source(entry)=source THEN entry_id:=entry.id;END IF;
   END IF;
   IF entry_id IS NULL AND collection IS NOT NULL THEN SELECT x INTO ref FROM jsonb_array_elements(draft->'media') x WHERE x->'id'=mapping->'mediaId';entry_id:=public.native_media_register_source(p_user_id,collection,source,coalesce(ref->>'fileName',draft->>'title',''));END IF;
   IF entry_id IS NOT NULL THEN INSERT INTO public.pub_native_media_usage_refs(owner_id,draft_id,draft_version,media_id,media_entry_id) VALUES(p_user_id,draft_id,version,(mapping->>'mediaId')::uuid,entry_id);END IF;
  END LOOP;
  result:=jsonb_build_object('ok',true,'count',1,'items',jsonb_build_array(jsonb_build_object('id',draft_id,'revision',version,'metadataRevision',base_result->'metadataRevision')),'alreadyFulfilled',false)||base_result;
 ELSE
  IF NOT public.native_ai_uuid(p_input->'targetCollectionId') OR NOT public.native_ai_integer(p_input->'expectedTargetCollectionRevision',1,2147483647) OR p_input->>'mode' IS NULL OR p_input->>'mode' NOT IN ('move','copy') OR jsonb_array_length(p_input->'items') NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'items') x GROUP BY x->>'id' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
  collection:=(p_input->>'targetCollectionId')::uuid;
  SELECT c.revision INTO target_revision FROM public.pub2_collections c WHERE c.id=collection AND c.user_id=p_user_id AND NOT c.archived FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_CORE_OWNER_MISMATCH';END IF;IF target_revision::numeric IS DISTINCT FROM (p_input->>'expectedTargetCollectionRevision')::numeric THEN RAISE EXCEPTION 'NATIVE_CORE_REVISION_CONFLICT';END IF;
  -- Validate every owner and CAS value before the first clone/move.
  FOR item IN SELECT * FROM jsonb_array_elements(p_input->'items') LOOP
   PERFORM public.pub2_assert_json_keys(item,ARRAY['id','expectedRevision'],ARRAY['id','expectedRevision']);IF NOT public.native_ai_uuid(item->'id') OR NOT public.native_ai_integer(item->'expectedRevision',1,2147483647) THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
   SELECT e.revision INTO actual_revision FROM public.pub_native_media_entries e WHERE e.owner_id=p_user_id AND e.id=(item->>'id')::uuid AND NOT e.archived FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_CORE_OWNER_MISMATCH';END IF;IF actual_revision::numeric IS DISTINCT FROM (item->>'expectedRevision')::numeric THEN RAISE EXCEPTION 'NATIVE_CORE_REVISION_CONFLICT';END IF;
  END LOOP;
  FOR item IN SELECT * FROM jsonb_array_elements(p_input->'items') LOOP
   SELECT * INTO entry FROM public.pub_native_media_entries WHERE owner_id=p_user_id AND id=(item->>'id')::uuid;new_id:=entry.id;
   IF p_input->>'mode'='copy' THEN
    INSERT INTO public.pub_native_media_entries(owner_id,asset_id,source_kind,main_reference,collection_id,title,is_copy,source_entry_id) VALUES(p_user_id,entry.asset_id,entry.source_kind,entry.main_reference,collection,entry.title,true,entry.id) RETURNING id,revision INTO new_id,new_revision;
   ELSE
    UPDATE public.pub_native_media_entries e SET collection_id=collection,revision=e.revision+1,updated_at=now(),is_copy=e.is_copy OR EXISTS(SELECT 1 FROM public.pub_native_media_entries other WHERE other.owner_id=p_user_id AND other.collection_id=collection AND other.id<>entry.id AND NOT other.is_copy AND NOT other.archived AND public.native_media_entry_source(other)=public.native_media_entry_source(entry)) WHERE e.id=entry.id AND e.owner_id=p_user_id RETURNING e.revision INTO new_revision;
   END IF;
   items:=items||jsonb_build_array(jsonb_build_object('id',new_id,'sourceId',entry.id,'revision',new_revision,'metadataRevision',0));
  END LOOP;
  result:=jsonb_build_object('ok',true,'count',jsonb_array_length(items),'items',items,'alreadyFulfilled',false);
 END IF;
 INSERT INTO public.pub_native_core_requests(owner_id,request_key,request_hash,request_payload,result) VALUES(p_user_id,p_input->>'requestKey',h,body,result) RETURNING * INTO cached;
 INSERT INTO public.pub_native_core_events(owner_id,request_id,kind,safe_snapshot) VALUES(p_user_id,cached.id,op,result);RETURN result;
END$$;
REVOKE ALL ON FUNCTION public.mutate_native_core_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mutate_native_core_atomic(text,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.native_media_entry_source(public.pub_native_media_entries) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.native_media_source_immutable() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.native_media_mapping_source(p jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$SELECT CASE WHEN p?'source' THEN p->'source' ELSE jsonb_build_object('kind','provider_asset','assetId',p->'assetId') END$$;
REVOKE ALL ON FUNCTION public.native_media_mapping_source(jsonb) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.mutate_native_auxiliary_atomic(text,jsonb) RENAME TO mutate_native_auxiliary_v1_atomic;
REVOKE ALL ON FUNCTION public.mutate_native_auxiliary_v1_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.mutate_native_auxiliary_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE body jsonb;h text;prior public.pub_native_core_requests%ROWTYPE;plan jsonb;grp jsonb;groups jsonb:='[]'::jsonb;ref jsonb;refs jsonb;result jsonb;execution jsonb;actual jsonb;idx integer:=0;draft uuid;version integer;entry public.pub_native_media_entries%ROWTYPE;BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 IF p_input->>'action' IS DISTINCT FROM 'prepare-publish' THEN RETURN public.mutate_native_auxiliary_v1_atomic(p_user_id,p_input);END IF;
 plan:=p_input->'plan';
 IF jsonb_typeof(plan->'groups') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'groups') g WHERE g->'metadata'->'schemaVersion'='2'::jsonb) THEN RETURN public.mutate_native_auxiliary_v1_atomic(p_user_id,p_input);END IF;
 PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','requestKey','connectionId','plan'],ARRAY['action','requestKey','connectionId','plan']);
 IF NOT public.native_ai_no_credentials(p_input) OR jsonb_typeof(p_input->'requestKey') IS DISTINCT FROM 'string' OR length(p_input->>'requestKey') NOT BETWEEN 8 AND 160 OR p_input->>'requestKey'!~'^[A-Za-z0-9_.:-]+$' OR jsonb_typeof(p_input->'connectionId') IS DISTINCT FROM 'string' OR length(p_input->>'connectionId') NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
 body:=p_input-ARRAY['requestKey','connectionId'];h:=encode(sha256(convert_to(body::text,'UTF8')),'hex');
 SELECT * INTO prior FROM public.pub_native_core_requests WHERE owner_id=p_user_id AND request_key=p_input->>'requestKey';
 IF FOUND THEN IF prior.request_hash IS DISTINCT FROM h OR prior.request_payload IS DISTINCT FROM body THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;RETURN prior.result||jsonb_build_object('alreadyFulfilled',true);END IF;
 PERFORM public.pub2_assert_json_keys(plan,ARRAY['requestKey','planHash','sourceDraftId','sourceDraftVersion','groups'],ARRAY['requestKey','planHash','groups']);
 IF plan->>'requestKey' IS DISTINCT FROM p_input->>'requestKey' OR jsonb_array_length(plan->'groups') NOT BETWEEN 1 AND 2 THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
 FOR grp IN SELECT * FROM jsonb_array_elements(plan->'groups') LOOP
  PERFORM public.pub2_assert_json_keys(grp,ARRAY['key','draft','metadata','officialTargets','mediaEntryRefs'],ARRAY['key','draft','metadata','officialTargets','mediaEntryRefs']);refs:=grp->'mediaEntryRefs';
  IF jsonb_typeof(grp->'officialTargets') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
  IF grp->'metadata'->'schemaVersion'='2'::jsonb AND EXISTS(SELECT 1 FROM jsonb_array_elements(grp->'officialTargets') target CROSS JOIN LATERAL jsonb_array_elements(grp->'metadata'->'media') mapping WHERE mapping->'source'->>'kind'='main_asset' AND (target->'mediaIds'?(mapping->>'mediaId') OR target->>'coverMediaId'=mapping->>'mediaId')) THEN RAISE EXCEPTION 'NATIVE_MAIN_BRIDGE_REQUIRED';END IF;
  IF jsonb_typeof(refs) IS DISTINCT FROM 'array' OR jsonb_array_length(refs)>30 OR EXISTS(SELECT 1 FROM jsonb_array_elements(refs) x GROUP BY x->>'mediaId' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
  FOR ref IN SELECT * FROM jsonb_array_elements(refs) LOOP PERFORM public.pub2_assert_json_keys(ref,ARRAY['mediaId','mediaEntryId'],ARRAY['mediaId','mediaEntryId']);IF NOT public.native_ai_uuid(ref->'mediaId') OR NOT public.native_ai_uuid(ref->'mediaEntryId') THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;END LOOP;
  groups:=groups||jsonb_build_array(grp-'mediaEntryRefs');
 END LOOP;
 result:=public.mutate_native_metadata_atomic(p_user_id,jsonb_set(plan,'{groups}',groups)||jsonb_build_object('action','prepare-publish','connectionId',p_input->>'connectionId'));
 IF result->'alreadyFulfilled'='true'::jsonb THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;
 FOR grp IN SELECT * FROM jsonb_array_elements(plan->'groups') LOOP
  execution:=result->'groups'->idx;idx:=idx+1;draft:=(execution->'draft'->>'id')::uuid;version:=(execution->'draft'->>'revision')::integer;
  SELECT m.payload INTO actual FROM public.pub_native_draft_meta m WHERE m.owner_id=p_user_id AND m.draft_id=draft AND m.draft_version=version;IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_CORE_OWNER_MISMATCH';END IF;
  FOR ref IN SELECT * FROM jsonb_array_elements(grp->'mediaEntryRefs') LOOP
   SELECT * INTO entry FROM public.pub_native_media_entries WHERE owner_id=p_user_id AND id=(ref->>'mediaEntryId')::uuid AND NOT archived FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_CORE_OWNER_MISMATCH';END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(actual->'media') x WHERE x->'mediaId'=ref->'mediaId' AND public.native_media_mapping_source(x)=public.native_media_entry_source(entry)) THEN RAISE EXCEPTION 'NATIVE_CORE_OWNER_MISMATCH';END IF;
   -- A main reference cannot be pasted onto an unrelated provider upload. An
   -- official upload bridge needs separate immutable owner-bound evidence.
   IF EXISTS(SELECT 1 FROM public.pub_native_media_usage_refs r WHERE r.owner_id=p_user_id AND r.draft_id=draft AND r.draft_version=version AND r.media_id=(ref->>'mediaId')::uuid AND r.media_entry_id<>entry.id) THEN RAISE EXCEPTION 'NATIVE_CORE_REVISION_CONFLICT';END IF;
   INSERT INTO public.pub_native_media_usage_refs(owner_id,draft_id,draft_version,media_id,media_entry_id) VALUES(p_user_id,draft,version,(ref->>'mediaId')::uuid,entry.id) ON CONFLICT(draft_id,draft_version,media_id) DO NOTHING;
  END LOOP;
  IF plan?'sourceDraftId' THEN
   INSERT INTO public.pub_native_media_usage_refs(owner_id,draft_id,draft_version,media_id,media_entry_id)
   SELECT p_user_id,draft,version,r.media_id,r.media_entry_id FROM public.pub_native_media_usage_refs r JOIN public.pub_native_media_entries e ON e.id=r.media_entry_id AND e.owner_id=p_user_id
   WHERE r.owner_id=p_user_id AND r.draft_id=(plan->>'sourceDraftId')::uuid AND r.draft_version=(plan->>'sourceDraftVersion')::integer AND NOT e.archived AND EXISTS(SELECT 1 FROM jsonb_array_elements(actual->'media') x WHERE x->>'mediaId'=r.media_id::text AND public.native_media_mapping_source(x)=public.native_media_entry_source(e)) AND NOT EXISTS(SELECT 1 FROM public.pub_native_media_usage_refs n WHERE n.draft_id=draft AND n.draft_version=version AND n.media_id=r.media_id);
  END IF;
 END LOOP;
 INSERT INTO public.pub_native_core_requests(owner_id,request_key,request_hash,request_payload,result) VALUES(p_user_id,p_input->>'requestKey',h,body,result) RETURNING * INTO prior;
 INSERT INTO public.pub_native_core_events(owner_id,request_id,kind,safe_snapshot) VALUES(p_user_id,prior.id,'prepare-publish',jsonb_build_object('action','prepare-publish','requestId',prior.id));RETURN result;
END$$;
REVOKE ALL ON FUNCTION public.mutate_native_auxiliary_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mutate_native_auxiliary_atomic(text,jsonb) TO service_role;

ALTER FUNCTION public.native_core_media_usage_facts(text,uuid) RENAME TO native_core_media_usage_facts_v1;
REVOKE ALL ON FUNCTION public.native_core_media_usage_facts_v1(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.native_core_media_usage_facts(p_owner text,p_entry_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$DECLARE selected public.pub_native_media_entries%ROWTYPE;BEGIN
 SELECT * INTO selected FROM public.pub_native_media_entries WHERE owner_id=p_owner AND id=p_entry_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_CORE_OWNER_MISMATCH';END IF;
 IF selected.source_kind='provider_asset' AND NOT EXISTS(SELECT 1 FROM public.pub_native_media_usage_refs r JOIN public.pub_native_draft_meta m ON m.owner_id=r.owner_id AND m.draft_id=r.draft_id AND m.draft_version=r.draft_version WHERE r.owner_id=p_owner AND r.media_entry_id=p_entry_id AND m.payload->'schemaVersion'='2'::jsonb) THEN RETURN public.native_core_media_usage_facts_v1(p_owner,p_entry_id);END IF;
 RETURN (WITH refs AS(SELECT * FROM public.pub_native_media_usage_refs WHERE owner_id=p_owner AND media_entry_id=p_entry_id),official_refs AS(
  SELECT o.id,o.revision,o.outcome,o.dispatch_state,o.grant_used,selected.source_kind='provider_asset' AND EXISTS(SELECT 1 FROM jsonb_array_elements(o.snapshot->'assets') asset WHERE asset->>'id'=selected.asset_id::text AND asset->>'mediaId'=r.media_id::text) AS proven
  FROM public.pub3_operations o JOIN refs r ON (o.snapshot->'intent'->>'draftId'=r.draft_id::text AND o.snapshot->'intent'->>'draftVersion'=r.draft_version::text OR EXISTS(SELECT 1 FROM public.pub_native_publish_plans p CROSS JOIN LATERAL jsonb_array_elements(p.result_mapping) g CROSS JOIN LATERAL jsonb_array_elements(g->'officialTargets') t WHERE p.owner_id=p_owner AND p.request_payload->>'sourceDraftId'=r.draft_id::text AND p.request_payload->>'sourceDraftVersion'=r.draft_version::text AND t->'intent'->>'id'=o.subject_id::text))
  WHERE o.owner_id=p_owner AND o.kind='publish' AND (o.snapshot->'intent'->'mediaIds'?r.media_id::text OR o.snapshot->'intent'->>'coverMediaId'=r.media_id::text)
 ),official AS(SELECT id,revision,outcome,dispatch_state,grant_used,bool_or(proven) AS proven FROM official_refs GROUP BY id,revision,outcome,dispatch_state,grant_used),browser AS(
  SELECT a.id,q.has_receipt,q.payload FROM public.pub2_attempts a LEFT JOIN LATERAL(SELECT count(*)>0 AS has_receipt,min(e.payload::text)::jsonb AS payload FROM public.pub2_attempt_events e WHERE e.attempt_id=a.id AND e.user_id=p_owner AND e.kind='browser_report') q ON true
  WHERE a.user_id=p_owner AND EXISTS(SELECT 1 FROM refs r WHERE (a.snapshot->>'draftId'=r.draft_id::text AND a.snapshot->>'draftVersion'=r.draft_version::text OR EXISTS(SELECT 1 FROM public.pub_native_publish_plans p CROSS JOIN LATERAL jsonb_array_elements(p.result_mapping) g WHERE p.owner_id=p_owner AND p.request_payload->>'sourceDraftId'=r.draft_id::text AND p.request_payload->>'sourceDraftVersion'=r.draft_version::text AND g->'batch'->>'id'=a.batch_id::text))
   AND EXISTS(SELECT 1 FROM public.pub_native_draft_meta m CROSS JOIN LATERAL jsonb_array_elements(m.payload->'media') actual WHERE m.owner_id=p_owner AND m.draft_id::text=a.snapshot->>'draftId' AND m.draft_version::text=a.snapshot->>'draftVersion' AND actual->>'mediaId'=r.media_id::text AND public.native_media_mapping_source(actual)=public.native_media_entry_source(selected))
   AND (selected.source_kind='provider_asset' OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.snapshot->'draft'->'media') media WHERE media->>'id'=r.media_id::text AND media->>'source'='main_asset' AND media->'reference'=selected.main_reference))
   AND (a.snapshot->'target'->'mediaIds'?r.media_id::text OR NOT(a.snapshot->'target'?'mediaIds') AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.snapshot->'draft'->'media') media WHERE media->>'id'=r.media_id::text AND media->>'role'<>'cover') OR a.snapshot->'target'->>'coverMediaId'=r.media_id::text OR NOT(a.snapshot->'target'?'mediaIds') AND NOT(a.snapshot->'target'?'coverMediaId') AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.snapshot->'draft'->'media') media WHERE media->>'id'=r.media_id::text AND media->>'role'='cover')))
 ),unproven AS(SELECT * FROM official WHERE NOT proven AND (outcome IN ('published','unknown') OR grant_used AND outcome NOT IN ('failed','cancelled'))),facts AS(
  SELECT jsonb_build_object('source',public.native_media_entry_source(selected),'official',coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM official o),'[]'::jsonb),'browser',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM browser b),'[]'::jsonb)) AS value
 ) SELECT jsonb_build_object('entryId',p_entry_id,'confirmedUses',CASE WHEN EXISTS(SELECT 1 FROM unproven) THEN NULL WHEN EXISTS(SELECT 1 FROM refs) OR selected.is_copy AND selected.source_entry_id IS NOT NULL THEN (SELECT count(*) FROM official WHERE proven AND outcome='published') ELSE NULL END,
  'browserReportedUses',(SELECT count(*) FROM browser WHERE payload->'success'='true'::jsonb),
  'unknownUses',(SELECT count(*) FROM official WHERE proven AND (outcome='unknown' OR grant_used AND outcome NOT IN ('published','failed','cancelled')))+(SELECT count(*) FROM unproven)+(SELECT count(*) FROM browser WHERE NOT has_receipt),
  'nativeUsageAttribution',CASE WHEN EXISTS(SELECT 1 FROM unproven) THEN 'source_attribution_incomplete' WHEN EXISTS(SELECT 1 FROM refs) OR selected.is_copy AND selected.source_entry_id IS NOT NULL THEN 'entry_provenance' ELSE 'not_recorded' END,
  'usageFingerprint',encode(sha256(convert_to(value::text,'UTF8')),'hex')) FROM facts);
END$$;
REVOKE ALL ON FUNCTION public.native_core_media_usage_facts(text,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- A provider asset with the same local media UUID is not an upload receipt for
-- a native main reference. The future bridge must provide immutable evidence.
-- Scope this temporary gate to persisted native V2 metadata: older non-native
-- and V1 official contracts retain their original validation and replay rules.
CREATE FUNCTION public.native_media_assert_official_source(p_owner text,p_draft uuid,p_version integer,p_media_ids jsonb,p_cover jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF EXISTS(SELECT 1 FROM public.pub_native_draft_meta m CROSS JOIN LATERAL jsonb_array_elements(m.payload->'media') mapping WHERE m.owner_id=p_owner AND m.draft_id=p_draft AND m.draft_version=p_version AND m.payload->'schemaVersion'='2'::jsonb AND mapping->'source'->>'kind'='main_asset' AND (p_media_ids?(mapping->>'mediaId') OR p_cover= mapping->'mediaId')) THEN RAISE EXCEPTION 'NATIVE_MAIN_BRIDGE_REQUIRED';END IF;
END$$;
REVOKE ALL ON FUNCTION public.native_media_assert_official_source(text,uuid,integer,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.mutate_publish_v3_atomic(text,jsonb) RENAME TO mutate_publish_v3_media_v1_atomic;
REVOKE ALL ON FUNCTION public.mutate_publish_v3_media_v1_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.mutate_publish_v3_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op public.pub3_operations%ROWTYPE;intent public.pub3_intents%ROWTYPE;payload jsonb;BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 PERFORM public.pub3_assert_input(p_input);
 IF p_input->>'action'='save-intent' THEN
  payload:=p_input->'payload';PERFORM public.pub3_assert_intent(payload);
  PERFORM public.native_media_assert_official_source(p_user_id,(payload->>'draftId')::uuid,(payload->>'draftVersion')::integer,payload->'mediaIds',payload->'coverMediaId');
 ELSIF p_input->>'action'='submit' THEN
  -- The original RPC performs the full exact key/hash/connection replay check.
  IF EXISTS(SELECT 1 FROM public.pub3_operations WHERE owner_id=p_user_id AND request_key=p_input->>'requestKey') THEN RETURN public.mutate_publish_v3_media_v1_atomic(p_user_id,p_input);END IF;
  SELECT * INTO intent FROM public.pub3_intents WHERE owner_id=p_user_id AND id=(p_input->>'intentId')::uuid FOR UPDATE;
  IF FOUND THEN PERFORM public.native_media_assert_official_source(p_user_id,intent.draft_id,intent.draft_version,intent.payload->'mediaIds',intent.payload->'coverMediaId');END IF;
 ELSIF p_input->>'action' IN ('dispatch','consume-grant') THEN
  SELECT * INTO op FROM public.pub3_operations WHERE owner_id=p_user_id AND id=(p_input->>'operationId')::uuid AND connection_id=p_input->>'connectionId' FOR UPDATE;
  IF FOUND THEN
   IF op.kind='publish' AND NOT op.grant_used AND (p_input->>'action'='dispatch' AND op.dispatch_state='ready' OR p_input->>'action'='consume-grant' AND op.dispatch_state='dispatching') THEN
    payload:=op.snapshot->'intent';PERFORM public.native_media_assert_official_source(p_user_id,(payload->>'draftId')::uuid,(payload->>'draftVersion')::integer,payload->'mediaIds',payload->'coverMediaId');
   END IF;
  END IF;
 END IF;
 RETURN public.mutate_publish_v3_media_v1_atomic(p_user_id,p_input);
END$$;
REVOKE ALL ON FUNCTION public.mutate_publish_v3_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mutate_publish_v3_atomic(text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
