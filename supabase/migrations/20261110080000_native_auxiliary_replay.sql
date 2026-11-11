BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
CREATE FUNCTION public.mutate_native_auxiliary_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_action text:=p_input->>'action';v_body jsonb;v_hash text;v_prior public.pub_native_core_requests%ROWTYPE;v_result jsonb;v_meta jsonb;v_plan jsonb;v_group jsonb;v_groups jsonb:='[]';v_refs jsonb;v_ref jsonb;v_index integer:=0;v_execution jsonb;v_draft uuid;v_version integer;v_actual jsonb;v_entry public.pub_native_media_entries%ROWTYPE;BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 IF v_action='metadata' THEN PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','requestKey','connectionId','metadata'],ARRAY['action','requestKey','connectionId','metadata']);
 ELSIF v_action='prepare-publish' THEN PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','requestKey','connectionId','plan'],ARRAY['action','requestKey','connectionId','plan']);ELSE RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
 IF public.pub3_no_credentials(p_input) IS NOT TRUE OR jsonb_typeof(p_input->'requestKey') IS DISTINCT FROM 'string' OR length(p_input->>'requestKey') NOT BETWEEN 8 AND 160 OR p_input->>'requestKey' !~ '^[A-Za-z0-9_.:-]+$' OR jsonb_typeof(p_input->'connectionId') IS DISTINCT FROM 'string' OR length(p_input->>'connectionId') NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
 v_body:=p_input-ARRAY['requestKey','connectionId'];v_hash:=encode(sha256(convert_to(v_body::text,'UTF8')),'hex');
 SELECT * INTO v_prior FROM public.pub_native_core_requests WHERE owner_id=p_user_id AND request_key=p_input->>'requestKey';
 IF FOUND THEN IF v_prior.request_hash IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;RETURN v_prior.result||jsonb_build_object('alreadyFulfilled',true);END IF;
 IF v_action='metadata' THEN
  v_meta:=p_input->'metadata';IF v_meta->>'action' IS NULL OR v_meta->>'action' NOT IN ('save-collection','save-draft','save-group','save-account','reorder-groups','reorder-accounts','save-browser-account') THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
  v_result:=public.mutate_native_metadata_atomic(p_user_id,v_meta||jsonb_build_object('connectionId',p_input->>'connectionId'));
 ELSE
  v_plan:=p_input->'plan';PERFORM public.pub2_assert_json_keys(v_plan,ARRAY['requestKey','planHash','sourceDraftId','sourceDraftVersion','groups'],ARRAY['requestKey','planHash','groups']);
  IF v_plan->>'requestKey' IS DISTINCT FROM p_input->>'requestKey' OR jsonb_typeof(v_plan->'groups') IS DISTINCT FROM 'array' OR jsonb_array_length(v_plan->'groups') NOT BETWEEN 1 AND 2 THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
  FOR v_group IN SELECT * FROM jsonb_array_elements(v_plan->'groups') LOOP
   PERFORM public.pub2_assert_json_keys(v_group,ARRAY['key','draft','metadata','officialTargets','mediaEntryRefs'],ARRAY['key','draft','metadata','officialTargets','mediaEntryRefs']);v_refs:=v_group->'mediaEntryRefs';
   IF jsonb_typeof(v_refs) IS DISTINCT FROM 'array' OR jsonb_array_length(v_refs)>30 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_refs) x GROUP BY x->>'mediaId' HAVING count(*)>1) THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;
   FOR v_ref IN SELECT * FROM jsonb_array_elements(v_refs) LOOP PERFORM public.pub2_assert_json_keys(v_ref,ARRAY['mediaId','mediaEntryId'],ARRAY['mediaId','mediaEntryId']);IF jsonb_typeof(v_ref->'mediaId') IS DISTINCT FROM 'string' OR v_ref->>'mediaId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR jsonb_typeof(v_ref->'mediaEntryId') IS DISTINCT FROM 'string' OR v_ref->>'mediaEntryId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'NATIVE_CORE_INPUT_INVALID';END IF;END LOOP;
   v_groups:=v_groups||jsonb_build_array(v_group-'mediaEntryRefs');
  END LOOP;
  -- The full outer fingerprint retains ordered entry references. The legacy
  -- RPC computes its own separate fingerprint for this closed projection.
  v_result:=public.mutate_native_metadata_atomic(p_user_id,jsonb_set(v_plan,'{groups}',v_groups)||jsonb_build_object('action','prepare-publish','connectionId',p_input->>'connectionId'));
  IF v_result->'alreadyFulfilled' IS NOT DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;
  FOR v_group IN SELECT * FROM jsonb_array_elements(v_plan->'groups') LOOP
   v_execution:=v_result->'groups'->v_index;v_index:=v_index+1;v_draft:=(v_execution->'draft'->>'id')::uuid;v_version:=(v_execution->'draft'->>'revision')::integer;
   SELECT payload INTO v_actual FROM public.pub_native_draft_meta WHERE owner_id=p_user_id AND draft_id=v_draft AND draft_version=v_version;IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_CORE_OWNER_MISMATCH';END IF;
   FOR v_ref IN SELECT * FROM jsonb_array_elements(v_group->'mediaEntryRefs') LOOP
    SELECT * INTO v_entry FROM public.pub_native_media_entries WHERE id=(v_ref->>'mediaEntryId')::uuid AND owner_id=p_user_id AND NOT archived FOR SHARE;
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.pub3_assets a WHERE a.id=v_entry.asset_id AND a.owner_id=p_user_id) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_actual->'media') x WHERE x->>'mediaId'=v_ref->>'mediaId' AND x->>'assetId'=v_entry.asset_id::text) THEN RAISE EXCEPTION 'NATIVE_CORE_OWNER_MISMATCH';END IF;
    IF EXISTS(SELECT 1 FROM public.pub_native_media_usage_refs r WHERE r.owner_id=p_user_id AND r.draft_id=v_draft AND r.draft_version=v_version AND r.media_id=(v_ref->>'mediaId')::uuid AND r.media_entry_id<>v_entry.id) THEN RAISE EXCEPTION 'NATIVE_CORE_REVISION_CONFLICT';END IF;
    INSERT INTO public.pub_native_media_usage_refs(owner_id,draft_id,draft_version,media_id,media_entry_id) VALUES(p_user_id,v_draft,v_version,(v_ref->>'mediaId')::uuid,v_entry.id) ON CONFLICT(draft_id,draft_version,media_id) DO NOTHING;
   END LOOP;
   IF v_plan ? 'sourceDraftId' THEN
    INSERT INTO public.pub_native_media_usage_refs(owner_id,draft_id,draft_version,media_id,media_entry_id)
    SELECT p_user_id,v_draft,v_version,r.media_id,r.media_entry_id FROM public.pub_native_media_usage_refs r JOIN public.pub_native_media_entries e ON e.id=r.media_entry_id AND e.owner_id=p_user_id JOIN public.pub3_assets a ON a.id=e.asset_id AND a.owner_id=p_user_id
    WHERE r.owner_id=p_user_id AND r.draft_id=(v_plan->>'sourceDraftId')::uuid AND r.draft_version=(v_plan->>'sourceDraftVersion')::integer AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_actual->'media') x WHERE x->>'mediaId'=r.media_id::text AND x->>'assetId'=e.asset_id::text) AND NOT EXISTS(SELECT 1 FROM public.pub_native_media_usage_refs n WHERE n.draft_id=v_draft AND n.draft_version=v_version AND n.media_id=r.media_id);
   END IF;
  END LOOP;
 END IF;
 INSERT INTO public.pub_native_core_requests(owner_id,request_key,request_hash,request_payload,result) VALUES(p_user_id,p_input->>'requestKey',v_hash,v_body,v_result) RETURNING * INTO v_prior;
 INSERT INTO public.pub_native_core_events(owner_id,request_id,kind,safe_snapshot) VALUES(p_user_id,v_prior.id,v_action,jsonb_build_object('action',v_action,'requestId',v_prior.id));
 RETURN v_result;
END$$;
REVOKE ALL ON FUNCTION public.mutate_native_auxiliary_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mutate_native_auxiliary_atomic(text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
