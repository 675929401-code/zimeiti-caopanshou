BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM public.pub_native_media_bridges) OR EXISTS(SELECT 1 FROM public.pub_native_media_bridge_phases) OR EXISTS(SELECT 1 FROM public.pub_native_media_bridge_requests) OR EXISTS(SELECT 1 FROM public.pub_native_media_bridge_events) THEN RAISE EXCEPTION 'NATIVE_BRIDGE_ROLLBACK_REQUIRES_PRESERVED_HISTORY';END IF;
END$$;
CREATE OR REPLACE FUNCTION public.mutate_native_auxiliary_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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

CREATE OR REPLACE FUNCTION public.native_core_media_usage_facts(p_owner text,p_entry_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$DECLARE selected public.pub_native_media_entries%ROWTYPE;BEGIN
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

CREATE OR REPLACE FUNCTION public.mutate_publish_v3_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
DROP FUNCTION public.mutate_native_media_bridge_atomic(text,jsonb);
DROP FUNCTION public.read_native_media_bridge_atomic(text,jsonb);
DROP FUNCTION public.native_media_bridge_assert_intent(text,text,jsonb);
DROP FUNCTION public.native_media_bridge_assert_targets(text,text,jsonb,jsonb,jsonb,jsonb);
DROP FUNCTION public.native_media_bridge_proven(text,text,jsonb,uuid,jsonb);
DROP FUNCTION public.native_media_bridge_assert_snapshot(text,uuid,text,jsonb);
DROP FUNCTION public.native_media_bridge_dto(public.pub_native_media_bridges,text);
DROP FUNCTION public.native_media_bridge_phase_dto(public.pub_native_media_bridge_phases);
DROP FUNCTION public.native_media_source_fingerprint(text,jsonb);
DROP TABLE public.pub_native_media_bridge_events;
DROP TABLE public.pub_native_media_bridge_requests;
DROP TABLE public.pub_native_media_bridge_phases;
DROP TABLE public.pub_native_media_bridges;
DROP FUNCTION public.native_media_bridge_history_guard();
NOTIFY pgrst,'reload schema';
COMMIT;
