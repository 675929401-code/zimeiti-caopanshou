-- Forward-only correction of SQL aliases in the already applied 143 RPC.
-- No data, account, quota, permission, pricing or publishing state changes.
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
DO $repair$
DECLARE definition text;original_body text;changed_body text;old_fragment text;new_fragment text;pair jsonb;BEGIN
 SELECT p.prosrc,pg_get_functiondef(p.oid) INTO original_body,definition
 FROM pg_proc p WHERE p.oid='public.mutate_native_official_atomic(text,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(original_body,'UTF8')),'hex')<>'0b3138dee10ac03d0722792fe39a78dffe40aeb456d00f7b476f524e457e97fb' THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_ALIAS_SOURCE_DRIFT';END IF;
 changed_body:=original_body;
 FOR pair IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
  jsonb_build_array($old$jsonb_array_elements(s->'sources') x GROUP BY x->>'mediaId'$old$,$new$jsonb_array_elements(s->'sources') AS source_item GROUP BY source_item->>'mediaId'$new$),
  jsonb_build_array($old$jsonb_array_elements(s->'media') x WHERE x->>'id'=m->>'mediaId'$old$,$new$jsonb_array_elements(s->'media') AS media_item WHERE media_item->>'id'=m->>'mediaId'$new$),
  jsonb_build_array($old$jsonb_array_elements(s->'media') x ON x->>'id'=m->>'mediaId' WHERE a.id=(m->'source'->>'assetId')::uuid AND a.owner_id=p_user_id AND a.connection_id=v_namespace AND a.state='ready' AND a.sha256=x->>'hash' AND a.size=(x->>'size')::bigint AND a.mime=x->>'type'$old$,$new$jsonb_array_elements(s->'media') AS media_item ON media_item->>'id'=m->>'mediaId' WHERE a.id=(m->'source'->>'assetId')::uuid AND a.owner_id=p_user_id AND a.connection_id=v_namespace AND a.state='ready' AND a.sha256=media_item->>'hash' AND a.size=(media_item->>'size')::bigint AND a.mime=media_item->>'type'$new$),
  jsonb_build_array($old$public.pub_native_media_entries e WHERE e.id=(m->>'mediaEntryId')::uuid AND e.owner_id=p_user_id AND NOT e.archived AND public.native_media_entry_source(e)=m->'source'$old$,$new$public.pub_native_media_entries AS source_entry WHERE source_entry.id=(m->>'mediaEntryId')::uuid AND source_entry.owner_id=p_user_id AND NOT source_entry.archived AND public.native_media_entry_source(source_entry)=m->'source'$new$),
  jsonb_build_array($old$array_agg(x ORDER BY x) FROM jsonb_array_elements_text(v_request->'targetIds') x$old$,$new$array_agg(selected_target_id ORDER BY selected_target_id) FROM jsonb_array_elements_text(v_request->'targetIds') AS selected_target_id$new$),
  jsonb_build_array($old$public.pub5_targets t JOIN public.pub4_account_bindings b ON b.id=t.binding_id AND b.owner_id=p_user_id WHERE t.id=ANY(o.target_ids) ORDER BY b.id$old$,$new$public.pub5_targets AS dispatch_target JOIN public.pub4_account_bindings b ON b.id=dispatch_target.binding_id AND b.owner_id=p_user_id WHERE dispatch_target.id=ANY(o.target_ids) ORDER BY b.id$new$)
 )) LOOP
  old_fragment:=pair->>0;new_fragment:=pair->>1;
  IF (length(changed_body)-length(replace(changed_body,old_fragment,'')))/length(old_fragment)<>1 THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_ALIAS_ANCHOR_DRIFT';END IF;
  changed_body:=replace(changed_body,old_fragment,new_fragment);
 END LOOP;
 IF encode(sha256(convert_to(changed_body,'UTF8')),'hex')<>'9e806de0296954e9d0ec9328c823c58a922e8a6bfc913630adef55b0b160b459' THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_ALIAS_PATCH_DRIFT';END IF;
 IF (length(definition)-length(replace(definition,original_body,'')))/length(original_body)<>1 THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_ALIAS_DEFINITION_DRIFT';END IF;
 EXECUTE replace(definition,original_body,changed_body);
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.mutate_native_official_atomic(text,jsonb)'::regprocedure)<>'9e806de0296954e9d0ec9328c823c58a922e8a6bfc913630adef55b0b160b459' THEN RAISE EXCEPTION 'NATIVE_OFFICIAL_ALIAS_POSTCHECK_FAILED';END IF;
END $repair$;
COMMIT;
