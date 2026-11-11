BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
-- Preserve a selected image in the gallery when it is also the target cover.
CREATE OR REPLACE FUNCTION public.mutate_publish_v2_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a text:=p_input->>'action'; v_id uuid; v_row jsonb; v_draft public.pub2_drafts%ROWTYPE; v_payload jsonb; v_version integer; v_target jsonb; v_account public.pub_accounts%ROWTYPE; v_batch public.pub2_batches%ROWTYPE; v_schedule public.pub2_schedules%ROWTYPE; v_attempt public.pub2_attempts%ROWTYPE; v_event public.pub2_attempt_events%ROWTYPE; v_ent public.pub_entitlements%ROWTYPE; v_config public.pub_config_versions%ROWTYPE; v_fingerprint text; v_snapshot jsonb; v_receipt jsonb; v_kind text; v_accounts jsonb; v_binding jsonb; v_media jsonb; v_cover jsonb;
BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 PERFORM public.pub2_assert_input_shape(p_input);
 IF p_input ? 'id' THEN v_id:=(p_input->>'id')::uuid; END IF;
 IF a='save-collection' THEN
  IF v_id IS NULL THEN
   IF (p_input->>'expectedRevision')::integer<>0 THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
   INSERT INTO public.pub2_collections(user_id,name,description,archived) VALUES(p_user_id,p_input->>'name',p_input->>'description',(p_input->>'archived')::boolean) RETURNING to_jsonb(pub2_collections.*) INTO v_row;
  ELSE
   UPDATE public.pub2_collections SET name=p_input->>'name',description=p_input->>'description',archived=(p_input->>'archived')::boolean,revision=revision+1,updated_at=now() WHERE id=v_id AND user_id=p_user_id AND revision=(p_input->>'expectedRevision')::integer RETURNING to_jsonb(pub2_collections.*) INTO v_row;
   IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
  END IF;
  RETURN jsonb_build_object('kind','collection','row',v_row);
 ELSIF a IN ('save-draft','archive-draft') THEN
  IF v_id IS NULL THEN
   IF (p_input->>'expectedRevision')::integer<>0 OR a='archive-draft' THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
   INSERT INTO public.pub2_drafts(user_id) VALUES(p_user_id) RETURNING * INTO v_draft;
  ELSE
   SELECT * INTO v_draft FROM public.pub2_drafts WHERE id=v_id AND user_id=p_user_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_DRAFT_NOT_FOUND'; END IF;
   IF v_draft.revision<>(p_input->>'expectedRevision')::integer OR v_draft.archived THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
   v_draft.revision:=v_draft.revision+1;
  END IF;
  IF a='archive-draft' THEN
   SELECT payload INTO v_payload FROM public.pub2_draft_versions WHERE draft_id=v_draft.id AND version=v_draft.revision-1;
  ELSE v_payload:=p_input->'draft'; END IF;
  IF a='save-draft' THEN PERFORM public.pub2_assert_media(p_user_id,v_payload); END IF;
  IF a='save-draft' AND v_payload->>'collectionId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.pub2_collections WHERE id=(v_payload->>'collectionId')::uuid AND user_id=p_user_id AND NOT archived) THEN RAISE EXCEPTION 'PUBLISH_V2_COLLECTION_NOT_FOUND'; END IF;
  IF a='save-draft' AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'targets') t WHERE NOT EXISTS(SELECT 1 FROM public.pub_accounts ac WHERE ac.id=(t->>'accountId')::uuid AND ac.user_id=p_user_id AND ac.platform=t->>'platform')) THEN RAISE EXCEPTION 'PUBLISH_ACCOUNT_NOT_FOUND'; END IF;
  UPDATE public.pub2_drafts SET collection_id=(v_payload->>'collectionId')::uuid,revision=v_draft.revision,archived=(a='archive-draft'),updated_at=now() WHERE id=v_draft.id RETURNING * INTO v_draft;
  INSERT INTO public.pub2_draft_versions(user_id,draft_id,version,payload) VALUES(p_user_id,v_draft.id,v_draft.revision,v_payload);
  RETURN jsonb_build_object('kind','draft','row',to_jsonb(v_draft)||jsonb_build_object('payload',v_payload));
 ELSIF a='save-group' THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_input->'accountIds') i WHERE NOT EXISTS(SELECT 1 FROM public.pub_accounts ac WHERE ac.id=i::uuid AND ac.user_id=p_user_id)) THEN RAISE EXCEPTION 'PUBLISH_ACCOUNT_NOT_FOUND'; END IF;
  IF v_id IS NULL THEN
   IF (p_input->>'expectedRevision')::integer<>0 THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
   INSERT INTO public.pub2_groups(user_id,name,account_ids) VALUES(p_user_id,p_input->>'name',p_input->'accountIds') RETURNING to_jsonb(pub2_groups.*) INTO v_row;
  ELSE
   UPDATE public.pub2_groups SET name=p_input->>'name',account_ids=p_input->'accountIds',revision=revision+1,updated_at=now() WHERE id=v_id AND user_id=p_user_id AND revision=(p_input->>'expectedRevision')::integer RETURNING to_jsonb(pub2_groups.*) INTO v_row;
   IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
  END IF;
  RETURN jsonb_build_object('kind','group','row',v_row);
 ELSIF a='delete-group' THEN
  DELETE FROM public.pub2_groups WHERE id=v_id AND user_id=p_user_id AND revision=(p_input->>'expectedRevision')::integer;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
  RETURN jsonb_build_object('deleted',true);
 ELSIF a='save-account-meta' THEN
  IF NOT EXISTS(SELECT 1 FROM public.pub_accounts WHERE id=(p_input->>'accountId')::uuid AND user_id=p_user_id) THEN RAISE EXCEPTION 'PUBLISH_ACCOUNT_NOT_FOUND'; END IF;
  INSERT INTO public.pub2_account_meta(account_id,user_id,label,notes) VALUES((p_input->>'accountId')::uuid,p_user_id,p_input->>'label',p_input->>'notes') ON CONFLICT(account_id) DO UPDATE SET label=EXCLUDED.label,notes=EXCLUDED.notes,updated_at=now() RETURNING to_jsonb(pub2_account_meta.*) INTO v_row;
  RETURN jsonb_build_object('kind','accountMeta','row',v_row);
 ELSIF a IN ('create-batch','save-schedule') THEN
  SELECT * INTO v_draft FROM public.pub2_drafts WHERE id=(p_input->>'draftId')::uuid AND user_id=p_user_id AND NOT archived;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_DRAFT_NOT_FOUND'; END IF;
  v_version:=(p_input->>'draftVersion')::integer;
  SELECT payload INTO v_payload FROM public.pub2_draft_versions WHERE draft_id=v_draft.id AND user_id=p_user_id AND version=v_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
  IF a='create-batch' THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_input->'targetIds') i WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'targets') t WHERE t->>'id'=i)) THEN RAISE EXCEPTION 'PUBLISH_V2_TARGET_NOT_FOUND'; END IF;
   v_fingerprint:=encode(sha256(convert_to((p_input-'idempotencyKey')::text,'UTF8')),'hex');
   SELECT * INTO v_batch FROM public.pub2_batches WHERE user_id=p_user_id AND request_key=p_input->>'idempotencyKey';
   IF FOUND THEN
    IF v_batch.fingerprint<>v_fingerprint THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN jsonb_build_object('kind','batch','row',to_jsonb(v_batch),'alreadyFulfilled',true);
   END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'targets') t WHERE p_input->'targetIds' ? (t->>'id') AND NOT EXISTS(SELECT 1 FROM public.pub_accounts ac WHERE ac.id=(t->>'accountId')::uuid AND ac.user_id=p_user_id AND ac.platform=t->>'platform')) THEN RAISE EXCEPTION 'PUBLISH_ACCOUNT_NOT_FOUND'; END IF;
   SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('id',ac.id,'platform',ac.platform,'platformAccountId',ac.platform_account_id,'displayName',ac.display_name,'updatedAt',ac.updated_at)),'[]') INTO v_accounts FROM public.pub_accounts ac JOIN jsonb_array_elements(v_payload->'targets') t ON ac.id=(t->>'accountId')::uuid WHERE ac.user_id=p_user_id AND p_input->'targetIds' ? (t->>'id');
   INSERT INTO public.pub2_batches(user_id,draft_id,draft_version,target_ids,account_snapshots,request_key,fingerprint) VALUES(p_user_id,v_draft.id,v_version,p_input->'targetIds',v_accounts,p_input->>'idempotencyKey',v_fingerprint) RETURNING * INTO v_batch;
   RETURN jsonb_build_object('kind','batch','row',to_jsonb(v_batch));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'targets') t WHERE t->>'id'=p_input->>'targetId') THEN RAISE EXCEPTION 'PUBLISH_V2_TARGET_NOT_FOUND'; END IF;
  IF (p_input->>'scheduledAt')::timestamptz<=now() THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM public.pub2_attempts at JOIN public.pub2_batches b ON b.id=at.batch_id WHERE at.user_id=p_user_id AND b.draft_id=v_draft.id AND b.draft_version=v_version AND at.target_id=(p_input->>'targetId')::uuid) THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_LOCKED'; END IF;
  INSERT INTO public.pub2_schedules(user_id,draft_id,draft_version,target_id,scheduled_at) VALUES(p_user_id,v_draft.id,v_version,(p_input->>'targetId')::uuid,(p_input->>'scheduledAt')::timestamptz) RETURNING * INTO v_schedule;
  RETURN jsonb_build_object('kind','schedule','row',to_jsonb(v_schedule));
 ELSIF a IN ('reschedule','cancel-schedule') THEN
  IF a='reschedule' AND (p_input->>'scheduledAt')::timestamptz<=now() THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_INVALID'; END IF;
  UPDATE public.pub2_schedules SET scheduled_at=CASE WHEN a='reschedule' THEN (p_input->>'scheduledAt')::timestamptz ELSE scheduled_at END,state=CASE WHEN a='cancel-schedule' THEN 'cancelled' ELSE 'planned' END,revision=revision+1,updated_at=now() WHERE id=v_id AND user_id=p_user_id AND revision=(p_input->>'expectedRevision')::integer AND state='planned' RETURNING * INTO v_schedule;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_LOCKED'; END IF;
  RETURN jsonb_build_object('kind','schedule','row',to_jsonb(v_schedule));
 ELSIF a='claim' THEN
  v_fingerprint:=encode(sha256(convert_to((p_input-'idempotencyKey')::text,'UTF8')),'hex');
  SELECT * INTO v_attempt FROM public.pub2_attempts WHERE user_id=p_user_id AND request_key=p_input->>'idempotencyKey';
  IF FOUND THEN
   IF v_attempt.fingerprint<>v_fingerprint THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT'; END IF;
   RETURN jsonb_build_object('kind','attempt','row',to_jsonb(v_attempt),'shouldExecute',false,'alreadyFulfilled',true);
  END IF;
  SELECT * INTO v_batch FROM public.pub2_batches WHERE id=(p_input->>'batchId')::uuid AND user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_V2_BATCH_NOT_FOUND'; END IF;
  IF NOT (v_batch.target_ids ? (p_input->>'targetId')) THEN RAISE EXCEPTION 'PUBLISH_V2_TARGET_NOT_FOUND'; END IF;
  SELECT * INTO v_attempt FROM public.pub2_attempts WHERE batch_id=v_batch.id AND target_id=(p_input->>'targetId')::uuid;
  IF FOUND THEN RAISE EXCEPTION 'PUBLISH_V2_TARGET_ALREADY_CLAIMED'; END IF;
  SELECT * INTO v_draft FROM public.pub2_drafts WHERE id=v_batch.draft_id AND user_id=p_user_id AND NOT archived;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_DRAFT_NOT_FOUND'; END IF;
  SELECT payload INTO v_payload FROM public.pub2_draft_versions WHERE draft_id=v_batch.draft_id AND version=v_batch.draft_version AND user_id=p_user_id;
  SELECT t INTO v_target FROM jsonb_array_elements(v_payload->'targets') t WHERE t->>'id'=p_input->>'targetId';
  IF v_target IS NULL THEN RAISE EXCEPTION 'PUBLISH_V2_TARGET_NOT_FOUND'; END IF;
  IF v_target->>'platform' NOT IN ('xhs','wxSph') THEN RAISE EXCEPTION 'PUBLISH_V2_TRANSPORT_UNCONFIGURED'; END IF;
  SELECT * INTO v_config FROM public.pub_config_versions ORDER BY version DESC LIMIT 1 FOR SHARE;
  IF NOT FOUND OR v_config.execution_enabled IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_EXECUTION_DISABLED'; END IF;
  IF coalesce(v_config.enabled_platforms ? (v_target->>'platform'),false) IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_PLATFORM_DISABLED'; END IF;
  SELECT * INTO v_account FROM public.pub_accounts WHERE id=(v_target->>'accountId')::uuid AND user_id=p_user_id AND platform=v_target->>'platform' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_ACCOUNT_NOT_FOUND'; END IF;
  SELECT x INTO v_binding FROM jsonb_array_elements(v_batch.account_snapshots) x WHERE x->>'id'=v_account.id::text;
  IF v_binding IS NULL OR v_binding->'updatedAt'<>to_jsonb(v_account.updated_at) OR v_binding->>'platformAccountId'<>v_account.platform_account_id THEN RAISE EXCEPTION 'PUBLISH_V2_ACCOUNT_CHANGED'; END IF;
  v_media:=v_payload->'media';
  IF v_target ? 'mediaIds' THEN SELECT coalesce(jsonb_agg(m ORDER BY i.ordinality),'[]') INTO v_media FROM jsonb_array_elements_text(v_target->'mediaIds') WITH ORDINALITY i(id,ordinality) JOIN jsonb_array_elements(v_payload->'media') m ON m->>'id'=i.id; END IF;
  IF v_target ? 'coverMediaId' THEN
   SELECT m||'{"role":"cover"}'::jsonb INTO v_cover FROM jsonb_array_elements(v_payload->'media') m WHERE m->>'id'=v_target->>'coverMediaId';
   SELECT coalesce(jsonb_agg(m),'[]') INTO v_media FROM jsonb_array_elements(v_media) m WHERE m->>'role'<>'cover' AND (v_payload->>'contentType'='image' OR m->>'id'<>v_target->>'coverMediaId');
   v_media:=v_media||jsonb_build_array(v_cover);
  END IF;
  PERFORM public.pub2_assert_media(p_user_id,jsonb_build_object('media',v_media));
  IF v_payload->>'contentType'='image' AND (v_target->>'platform'<>'xhs' OR (SELECT count(*) FROM jsonb_array_elements(v_media) m WHERE m->>'role'='image') NOT BETWEEN 1 AND 9) THEN RAISE EXCEPTION 'PUBLISH_V2_MEDIA_INVALID'; END IF;
  IF v_payload->>'contentType'='video' AND ((SELECT count(*) FROM jsonb_array_elements(v_media) m WHERE m->>'role'='video')<>1 OR (SELECT count(*) FROM jsonb_array_elements(v_media) m WHERE m->>'role'='cover')<>1) THEN RAISE EXCEPTION 'PUBLISH_V2_MEDIA_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_media) m WHERE coalesce((m->>'size')::numeric,0)<=0 OR (m->>'role'='video' AND m->>'type' NOT LIKE 'video/%') OR (m->>'role'<>'video' AND m->>'type' NOT LIKE 'image/%')) THEN RAISE EXCEPTION 'PUBLISH_V2_MEDIA_INVALID'; END IF;
  IF v_target->>'platform'='wxSph' AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_media) m WHERE m->>'role'='video' AND (coalesce((m->>'width')::numeric,0)<=0 OR coalesce((m->>'height')::numeric,0)<=0 OR coalesce((m->>'duration')::numeric,0)<=0)) THEN RAISE EXCEPTION 'PUBLISH_V2_MEDIA_INVALID'; END IF;
  IF v_target->>'platform'='xhs' AND v_target->>'scheduledAt' IS NOT NULL THEN RAISE EXCEPTION 'PUBLISH_V2_NATIVE_SCHEDULE_UNAVAILABLE'; END IF;
  IF v_target->>'scheduledAt' IS NOT NULL AND (v_target->>'scheduledAt')::timestamptz<=now() THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_INVALID'; END IF;
  IF p_input ? 'scheduleId' THEN
   SELECT * INTO v_schedule FROM public.pub2_schedules WHERE id=(p_input->>'scheduleId')::uuid AND user_id=p_user_id AND draft_id=v_batch.draft_id AND draft_version=v_batch.draft_version AND target_id=(p_input->>'targetId')::uuid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_NOT_FOUND'; END IF;
   IF v_schedule.state<>'planned' THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_LOCKED'; END IF;
   IF v_schedule.scheduled_at>now() THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_NOT_DUE'; END IF;
  END IF;
  SELECT * INTO v_ent FROM public.pub_entitlements WHERE id=(p_input->>'entitlementId')::uuid AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_ENTITLEMENT_NOT_FOUND'; END IF;
  IF v_ent.expires_at<=now() THEN RAISE EXCEPTION 'PUBLISH_ENTITLEMENT_EXPIRED'; END IF;
  IF v_ent.used>=v_ent.quota THEN RAISE EXCEPTION 'PUBLISH_NO_QUOTA'; END IF;
  IF NOT (v_ent.platforms ? (v_target->>'platform')) THEN RAISE EXCEPTION 'PUBLISH_PLATFORM_NOT_ALLOWED'; END IF;
  v_snapshot:=jsonb_build_object('draft',v_payload,'draftId',v_batch.draft_id,'draftVersion',v_batch.draft_version,'target',v_target,'account',v_binding,'transport','browser_plugin','localSchedule',CASE WHEN v_schedule.id IS NULL THEN NULL ELSE jsonb_build_object('id',v_schedule.id,'scheduledAt',v_schedule.scheduled_at) END);
  UPDATE public.pub_entitlements SET used=used+1 WHERE id=v_ent.id;
  INSERT INTO public.pub2_attempts(user_id,batch_id,target_id,entitlement_id,platform,snapshot,snapshot_hash,request_key,fingerprint) VALUES(p_user_id,v_batch.id,(p_input->>'targetId')::uuid,v_ent.id,v_target->>'platform',v_snapshot,encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex'),p_input->>'idempotencyKey',v_fingerprint) RETURNING * INTO v_attempt;
  IF v_schedule.id IS NOT NULL THEN UPDATE public.pub2_schedules SET state='claimed',revision=revision+1,updated_at=now() WHERE id=v_schedule.id; END IF;
  RETURN jsonb_build_object('kind','attempt','row',to_jsonb(v_attempt),'shouldExecute',true,'alreadyFulfilled',false);
 ELSIF a IN ('report','append-link') THEN
  SELECT * INTO v_attempt FROM public.pub2_attempts WHERE id=(p_input->>'attemptId')::uuid AND user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_V2_ATTEMPT_NOT_FOUND'; END IF;
  v_kind:=CASE WHEN a='report' THEN 'browser_report' ELSE 'append_link' END;
  v_receipt:=p_input-'action'-'attemptId'-'idempotencyKey';
  IF p_input ? 'shareLink' AND NOT (CASE WHEN v_attempt.platform='xhs' THEN p_input->>'shareLink' ~* '^https://([A-Za-z0-9-]+\.)*(xiaohongshu\.com|xhslink\.com)(:443)?([/?#]|$)' ELSE p_input->>'shareLink' ~* '^https://([A-Za-z0-9-]+\.)*weixin\.qq\.com(:443)?([/?#]|$)' END) THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  SELECT * INTO v_event FROM public.pub2_attempt_events WHERE user_id=p_user_id AND request_key=p_input->>'idempotencyKey';
  IF FOUND THEN
   IF v_event.attempt_id<>v_attempt.id OR v_event.kind<>v_kind OR v_event.payload<>v_receipt THEN RAISE EXCEPTION 'PUBLISH_RECEIPT_CONFLICT'; END IF;
   RETURN jsonb_build_object('kind','event','row',to_jsonb(v_event),'alreadyFulfilled',true);
  END IF;
  IF a='report' AND EXISTS(SELECT 1 FROM public.pub2_attempt_events WHERE attempt_id=v_attempt.id AND kind='browser_report' AND payload<>v_receipt) THEN RAISE EXCEPTION 'PUBLISH_RECEIPT_CONFLICT'; END IF;
  INSERT INTO public.pub2_attempt_events(user_id,attempt_id,kind,request_key,payload,source) VALUES(p_user_id,v_attempt.id,v_kind,p_input->>'idempotencyKey',v_receipt,CASE WHEN a='report' THEN 'browser_reported' ELSE 'user_reported' END) RETURNING * INTO v_event;
  RETURN jsonb_build_object('kind','event','row',to_jsonb(v_event));
 END IF;
 RAISE EXCEPTION 'PUBLISH_INPUT_INVALID';
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
