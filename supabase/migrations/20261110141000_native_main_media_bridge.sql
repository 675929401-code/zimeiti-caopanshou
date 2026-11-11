BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';

CREATE TABLE public.pub_native_media_bridges(
 id uuid PRIMARY KEY,owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,namespace text NOT NULL,media_id uuid NOT NULL,reference jsonb NOT NULL,
 snapshot jsonb NOT NULL,snapshot_hash text NOT NULL CHECK(snapshot_hash~'^[a-f0-9]{64}$'),request_key text NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','uploading','confirming','ready','unknown','failed_known')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),phase text CHECK(phase IN ('sign','put','confirm')),asset_id uuid REFERENCES public.pub3_assets(id),error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,namespace,media_id),UNIQUE(owner_id,request_key)
);
CREATE TABLE public.pub_native_media_bridge_phases(
 owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,bridge_id uuid NOT NULL REFERENCES public.pub_native_media_bridges(id) ON DELETE CASCADE,phase text NOT NULL CHECK(phase IN ('sign','put','confirm')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','recorded','unknown','failed_known')),dispatch_id uuid UNIQUE,operation_request_key text NOT NULL,
 operation_id uuid REFERENCES public.pub3_operations(id),asset_id uuid REFERENCES public.pub3_assets(id),provider_asset_id text,proof jsonb,
 claimed_at timestamptz,recorded_at timestamptz,PRIMARY KEY(bridge_id,phase),UNIQUE(owner_id,operation_request_key)
);
CREATE TABLE public.pub_native_media_bridge_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,bridge_id uuid NOT NULL REFERENCES public.pub_native_media_bridges(id) ON DELETE CASCADE,request_key text NOT NULL,payload jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,request_key));
CREATE TABLE public.pub_native_media_bridge_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,bridge_id uuid NOT NULL REFERENCES public.pub_native_media_bridges(id) ON DELETE CASCADE,phase text,kind text NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX native_media_bridge_owner_created ON public.pub_native_media_bridges(owner_id,created_at DESC,id);
CREATE INDEX native_media_bridge_asset ON public.pub_native_media_bridges(owner_id,namespace,asset_id) WHERE asset_id IS NOT NULL;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['pub_native_media_bridges','pub_native_media_bridge_phases','pub_native_media_bridge_requests','pub_native_media_bridge_events'] LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',t);EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',t);END LOOP;END$$;

CREATE FUNCTION public.native_media_bridge_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.users WHERE id=OLD.owner_id) THEN RETURN OLD;END IF;
 IF TG_OP='DELETE' OR TG_TABLE_NAME IN ('pub_native_media_bridge_requests','pub_native_media_bridge_events') THEN RAISE EXCEPTION 'NATIVE_BRIDGE_HISTORY_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='pub_native_media_bridges' THEN
  IF (NEW.id,NEW.owner_id,NEW.namespace,NEW.media_id,NEW.reference,NEW.snapshot,NEW.snapshot_hash,NEW.request_key,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.namespace,OLD.media_id,OLD.reference,OLD.snapshot,OLD.snapshot_hash,OLD.request_key,OLD.created_at) OR OLD.asset_id IS NOT NULL AND NEW.asset_id IS DISTINCT FROM OLD.asset_id OR OLD.state='ready' AND NEW.state<>'ready' THEN RAISE EXCEPTION 'NATIVE_BRIDGE_HISTORY_IMMUTABLE';END IF;
 ELSIF TG_TABLE_NAME='pub_native_media_bridge_phases' THEN
  IF (NEW.owner_id,NEW.bridge_id,NEW.phase,NEW.operation_request_key) IS DISTINCT FROM (OLD.owner_id,OLD.bridge_id,OLD.phase,OLD.operation_request_key) OR OLD.dispatch_id IS NOT NULL AND (NEW.dispatch_id,NEW.claimed_at) IS DISTINCT FROM (OLD.dispatch_id,OLD.claimed_at) OR OLD.operation_id IS NOT NULL AND NEW.operation_id IS DISTINCT FROM OLD.operation_id OR OLD.asset_id IS NOT NULL AND NEW.asset_id IS DISTINCT FROM OLD.asset_id OR OLD.provider_asset_id IS NOT NULL AND NEW.provider_asset_id IS DISTINCT FROM OLD.provider_asset_id OR OLD.proof IS NOT NULL AND NEW.proof IS DISTINCT FROM OLD.proof OR OLD.state='recorded' AND (NEW.state,NEW.recorded_at) IS DISTINCT FROM (OLD.state,OLD.recorded_at) THEN RAISE EXCEPTION 'NATIVE_BRIDGE_HISTORY_IMMUTABLE';END IF;
 END IF;RETURN NEW;
END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['pub_native_media_bridges','pub_native_media_bridge_phases','pub_native_media_bridge_requests','pub_native_media_bridge_events'] LOOP EXECUTE format('CREATE TRIGGER native_bridge_history BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.native_media_bridge_history_guard()',t);END LOOP;END$$;

-- The digest is deliberately PG-owned. Only the digest leaves the source
-- ledger; storage locators and provider URLs never enter a public bridge DTO.
CREATE FUNCTION public.native_media_source_fingerprint(p_owner text,p_reference jsonb) RETURNS text LANGUAGE plpgsql SET search_path=public,pg_temp SET timezone='UTC' AS $$DECLARE source jsonb;facts jsonb;BEGIN
 PERFORM public.native_ai_assert_source(p_owner,jsonb_build_object('kind','main_asset','reference',p_reference));
 IF p_reference->>'kind'='image_asset' THEN
  SELECT to_jsonb(f) INTO source FROM public.user_files f WHERE f.user_id::text=p_owner AND f.id::text=p_reference->>'id';
  facts:=jsonb_build_object('id',source->'id','user_id',source->'user_id','storage_provider',source->'storage_provider','storage_key',source->'storage_key','content_type',source->'content_type','file_size',source->'file_size');
 ELSIF p_reference->>'kind'='image_record' THEN
  SELECT to_jsonb(r) INTO source FROM public.image_generation_requests r WHERE r.user_id::text=p_owner AND r.record_id=p_reference->>'id';
  facts:=jsonb_build_object('record_id',source->'record_id','user_id',source->'user_id','state',source->'state','delivery_state',source->'delivery_state','response',jsonb_build_object('deliveryMode',source->'response'->'deliveryMode','providerUrl',source->'response'->'providerUrl','provider',source->'response'->'provider','apiEndpoint',source->'response'->'apiEndpoint','sourceExpiredAt',source->'response'->'sourceExpiredAt'));
 ELSE
  SELECT to_jsonb(v) INTO source FROM public.video_tasks v WHERE v.user_id::text=p_owner AND v.id::text=p_reference->>'id';
  facts:=jsonb_build_object('id',source->'id','user_id',source->'user_id','status',source->'status','video_url',source->'video_url','provider_result_url',source->'provider_result_url','storage_url',source->'storage_url','source_expired_at',source->'source_expired_at','history_hidden_at',source->'history_hidden_at','task_label',source->'task_label','completed_at',source->'completed_at','storyboard_archive_expires_at',source->'storyboard_archive_expires_at');
 END IF;
 IF source IS NULL THEN RAISE EXCEPTION 'NATIVE_BRIDGE_SOURCE_UNAVAILABLE';END IF;
 RETURN encode(sha256(convert_to(jsonb_build_object('version',1,'owner',p_owner,'reference',p_reference,'facts',facts)::text,'UTF8')),'hex');
END$$;
CREATE FUNCTION public.native_media_bridge_phase_dto(p public.pub_native_media_bridge_phases) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$SELECT jsonb_build_object('phase',p.phase,'state',p.state,'dispatchId',p.dispatch_id,'operationRequestKey',p.operation_request_key,'operationId',p.operation_id,'assetId',p.asset_id,'providerAssetId',p.provider_asset_id,'claimedAt',p.claimed_at,'recordedAt',p.recorded_at)$$;
CREATE FUNCTION public.native_media_bridge_dto(b public.pub_native_media_bridges,p_namespace text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$SELECT jsonb_build_object('id',b.id,'requestKey',b.request_key,'reference',b.reference,'mediaId',b.media_id,'state',b.state,'revision',b.revision,'phase',b.phase,'file',(b.snapshot->'file')-'fileName','connectionCurrent',b.namespace=p_namespace,'resultReference',CASE WHEN b.state='ready' THEN jsonb_build_object('kind','provider_asset','assetId',b.asset_id,'mediaId',b.media_id) ELSE NULL END,'errorCode',b.error_code,'createdAt',b.created_at,'updatedAt',b.updated_at)$$;
CREATE FUNCTION public.native_media_bridge_assert_snapshot(p_owner text,p_id uuid,p_namespace text,s jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE f jsonb:=s->'file';BEGIN
 PERFORM public.pub2_assert_json_keys(s,ARRAY['version','reference','mediaId','namespace','sourceFingerprint','file'],ARRAY['version','reference','mediaId','namespace','sourceFingerprint','file']);PERFORM public.pub2_assert_json_keys(f,ARRAY['fileName','mime','size','sha256'],ARRAY['fileName','mime','size','sha256']);
 IF s->'version' IS DISTINCT FROM '1'::jsonb OR NOT public.native_ai_uuid(s->'mediaId') OR s->>'namespace' IS DISTINCT FROM p_namespace OR jsonb_typeof(s->'namespace') IS DISTINCT FROM 'string' OR length(p_namespace) NOT BETWEEN 1 AND 200 OR NOT public.native_ai_no_credentials(s) OR s->>'sourceFingerprint' IS NULL OR s->>'sourceFingerprint'!~'^[a-f0-9]{64}$' OR f->>'sha256' IS NULL OR f->>'sha256'!~'^[a-f0-9]{64}$' OR jsonb_typeof(f->'fileName') IS DISTINCT FROM 'string' OR f->>'fileName' IS DISTINCT FROM ('native-bridge-'||p_id::text||(CASE f->>'mime' WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/png' THEN '.png' WHEN 'video/mp4' THEN '.mp4' ELSE '' END)) OR f->>'mime' IS NULL OR f->>'mime' NOT IN ('image/jpeg','image/png','video/mp4') OR NOT public.native_ai_integer(f->'size',1,104857600) OR f->>'mime' LIKE 'image/%' AND (f->>'size')::bigint>20971520 THEN RAISE EXCEPTION 'NATIVE_BRIDGE_INPUT_INVALID';END IF;
 IF (s->'reference'->>'kind'='video_task') IS DISTINCT FROM (f->>'mime'='video/mp4') THEN RAISE EXCEPTION 'NATIVE_BRIDGE_INPUT_INVALID';END IF;
 IF public.native_media_source_fingerprint(p_owner,s->'reference') IS DISTINCT FROM s->>'sourceFingerprint' THEN RAISE EXCEPTION 'NATIVE_BRIDGE_SOURCE_CHANGED';END IF;
END$$;

CREATE FUNCTION public.read_native_media_bridge_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$DECLARE b public.pub_native_media_bridges%ROWTYPE;p public.pub_native_media_bridge_phases%ROWTYPE;BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 IF p_input->>'action'='source-evidence' THEN PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','reference'],ARRAY['action','reference']);RETURN jsonb_build_object('sourceFingerprint',public.native_media_source_fingerprint(p_user_id,p_input->'reference'));END IF;
 IF p_input->>'action'='bridge' THEN PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','bridgeId','currentNamespace'],ARRAY['action','bridgeId','currentNamespace']);IF NOT public.native_ai_uuid(p_input->'bridgeId') THEN RAISE EXCEPTION 'NATIVE_BRIDGE_INPUT_INVALID';END IF;SELECT * INTO b FROM public.pub_native_media_bridges WHERE owner_id=p_user_id AND id=(p_input->>'bridgeId')::uuid;
 ELSIF p_input->>'action'='by-request-key' THEN PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','requestKey','currentNamespace'],ARRAY['action','requestKey','currentNamespace']);SELECT * INTO b FROM public.pub_native_media_bridges WHERE owner_id=p_user_id AND request_key=p_input->>'requestKey';
 ELSIF p_input->>'action'='invocation' THEN PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','bridgeId','phase','dispatchId','currentNamespace'],ARRAY['action','bridgeId','phase','dispatchId','currentNamespace']);IF NOT public.native_ai_uuid(p_input->'bridgeId') OR p_input->'dispatchId' IS DISTINCT FROM 'null'::jsonb AND NOT public.native_ai_uuid(p_input->'dispatchId') OR p_input->>'phase' IS NULL OR p_input->>'phase' NOT IN ('sign','put','confirm') THEN RAISE EXCEPTION 'NATIVE_BRIDGE_INPUT_INVALID';END IF;SELECT * INTO b FROM public.pub_native_media_bridges WHERE owner_id=p_user_id AND id=(p_input->>'bridgeId')::uuid;
 ELSE RAISE EXCEPTION 'NATIVE_BRIDGE_INPUT_INVALID';END IF;
 IF jsonb_typeof(p_input->'currentNamespace') IS DISTINCT FROM 'string' OR length(p_input->>'currentNamespace') NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'NATIVE_BRIDGE_INPUT_INVALID';END IF;
 IF b.id IS NULL THEN IF p_input->>'action'='invocation' THEN RAISE EXCEPTION 'NATIVE_BRIDGE_NOT_FOUND';END IF;RETURN jsonb_build_object('found',false);END IF;
 IF p_input->>'action'='invocation' THEN SELECT * INTO p FROM public.pub_native_media_bridge_phases WHERE owner_id=p_user_id AND bridge_id=b.id AND phase=p_input->>'phase' AND (p_input->'dispatchId'='null'::jsonb AND state='pending' AND dispatch_id IS NULL OR p_input->'dispatchId'<>'null'::jsonb AND dispatch_id=(p_input->>'dispatchId')::uuid);IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_BRIDGE_PHASE_INVALID';END IF;RETURN jsonb_build_object('bridge',public.native_media_bridge_dto(b,p_input->>'currentNamespace'),'snapshot',b.snapshot,'phase',public.native_media_bridge_phase_dto(p));END IF;
 RETURN jsonb_build_object('found',true,'bridge',public.native_media_bridge_dto(b,p_input->>'currentNamespace'));
END$$;

CREATE FUNCTION public.mutate_native_media_bridge_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b public.pub_native_media_bridges%ROWTYPE;p public.pub_native_media_bridge_phases%ROWTYPE;prior public.pub_native_media_bridge_requests%ROWTYPE;op public.pub3_operations%ROWTYPE;asset public.pub3_assets%ROWTYPE;s jsonb;f jsonb;v3 jsonb;result jsonb;phase_name text;key_prefix text;changed boolean:=false;next_state text;BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 IF jsonb_typeof(p_input->'requestKey') IS DISTINCT FROM 'string' OR length(p_input->>'requestKey') NOT BETWEEN 8 AND 160 OR p_input->>'requestKey'!~'^[A-Za-z0-9_.:-]+$' OR NOT public.native_ai_uuid(p_input->'bridgeId') OR jsonb_typeof(p_input->'currentNamespace') IS DISTINCT FROM 'string' OR length(p_input->>'currentNamespace') NOT BETWEEN 1 AND 200 OR NOT public.native_ai_no_credentials(p_input) THEN RAISE EXCEPTION 'NATIVE_BRIDGE_INPUT_INVALID';END IF;
 SELECT * INTO prior FROM public.pub_native_media_bridge_requests WHERE owner_id=p_user_id AND request_key=p_input->>'requestKey';
 IF FOUND THEN IF prior.payload IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;RETURN CASE WHEN prior.result?'shouldDispatch' THEN jsonb_set(prior.result,'{shouldDispatch}','false') WHEN prior.result?'alreadyFulfilled' THEN jsonb_set(prior.result,'{alreadyFulfilled}','true') ELSE prior.result END;END IF;
 key_prefix:='native-bridge:'||(p_input->>'bridgeId');
 IF p_input->>'action'='prepare' THEN
  PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','requestKey','currentNamespace','bridgeId','snapshot','snapshotHash'],ARRAY['action','requestKey','currentNamespace','bridgeId','snapshot','snapshotHash']);s:=p_input->'snapshot';
  IF p_input->>'snapshotHash' IS NULL OR p_input->>'snapshotHash'!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'NATIVE_BRIDGE_INPUT_INVALID';END IF;PERFORM public.native_media_bridge_assert_snapshot(p_user_id,(p_input->>'bridgeId')::uuid,p_input->>'currentNamespace',s);
  IF EXISTS(SELECT 1 FROM public.pub_native_media_bridges WHERE owner_id=p_user_id AND (id=(p_input->>'bridgeId')::uuid OR namespace=s->>'namespace' AND media_id=(s->>'mediaId')::uuid)) OR EXISTS(SELECT 1 FROM public.pub3_assets WHERE owner_id=p_user_id AND connection_id=s->>'namespace' AND local_media_id=(s->>'mediaId')::uuid) THEN RAISE EXCEPTION 'NATIVE_BRIDGE_MEDIA_RESERVED';END IF;
  INSERT INTO public.pub_native_media_bridges(id,owner_id,namespace,media_id,reference,snapshot,snapshot_hash,request_key) VALUES((p_input->>'bridgeId')::uuid,p_user_id,s->>'namespace',(s->>'mediaId')::uuid,s->'reference',s,p_input->>'snapshotHash',p_input->>'requestKey') RETURNING * INTO b;
  INSERT INTO public.pub_native_media_bridge_phases(owner_id,bridge_id,phase,operation_request_key) SELECT p_user_id,b.id,x,key_prefix||':'||x FROM unnest(ARRAY['sign','put','confirm']) x;
  INSERT INTO public.pub_native_media_bridge_events(owner_id,bridge_id,kind,evidence) VALUES(p_user_id,b.id,'prepared',jsonb_build_object('snapshotHash',b.snapshot_hash));result:=jsonb_build_object('bridge',public.native_media_bridge_dto(b,p_input->>'currentNamespace'),'alreadyFulfilled',false);
 ELSE
  SELECT * INTO b FROM public.pub_native_media_bridges WHERE owner_id=p_user_id AND id=(p_input->>'bridgeId')::uuid FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_BRIDGE_NOT_FOUND';END IF;s:=b.snapshot;f:=s->'file';
  IF p_input->>'action'='claim-phase' THEN
   PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','requestKey','currentNamespace','bridgeId','expectedRevision','phase'],ARRAY['action','requestKey','currentNamespace','bridgeId','expectedRevision','phase']);phase_name:=p_input->>'phase';
   IF phase_name IS NULL OR phase_name NOT IN ('sign','put','confirm') OR p_input->>'requestKey' IS DISTINCT FROM key_prefix||':claim:'||phase_name OR NOT public.native_ai_integer(p_input->'expectedRevision',1,2147483647) THEN RAISE EXCEPTION 'NATIVE_BRIDGE_INPUT_INVALID';END IF;
   IF b.namespace IS DISTINCT FROM p_input->>'currentNamespace' THEN RAISE EXCEPTION 'NATIVE_BRIDGE_NAMESPACE_CHANGED';END IF;
   SELECT * INTO p FROM public.pub_native_media_bridge_phases WHERE owner_id=p_user_id AND bridge_id=b.id AND phase=phase_name FOR UPDATE;
   IF p.dispatch_id IS NOT NULL THEN result:=jsonb_build_object('bridge',public.native_media_bridge_dto(b,p_input->>'currentNamespace'),'phase',public.native_media_bridge_phase_dto(p),'shouldDispatch',false);
   ELSE
    IF b.revision IS DISTINCT FROM (p_input->>'expectedRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT';END IF;PERFORM public.native_media_bridge_assert_snapshot(p_user_id,b.id,b.namespace,b.snapshot);
    IF b.state IN ('ready','failed_known') OR phase_name='sign' AND EXISTS(SELECT 1 FROM public.pub_native_media_bridge_phases WHERE owner_id=p_user_id AND bridge_id=b.id AND (state<>'pending' OR dispatch_id IS NOT NULL OR operation_id IS NOT NULL OR proof IS NOT NULL)) OR phase_name='put' AND NOT EXISTS(SELECT 1 FROM public.pub_native_media_bridge_phases WHERE bridge_id=b.id AND owner_id=p_user_id AND phase='sign' AND state='recorded') OR phase_name='confirm' AND NOT EXISTS(SELECT 1 FROM public.pub_native_media_bridge_phases WHERE bridge_id=b.id AND owner_id=p_user_id AND phase='put' AND state='recorded') THEN RAISE EXCEPTION 'NATIVE_BRIDGE_PHASE_INVALID';END IF;
    UPDATE public.pub_native_media_bridge_phases SET state='claimed',dispatch_id=gen_random_uuid(),claimed_at=now(),asset_id=CASE WHEN phase_name IN ('put','confirm') THEN b.asset_id ELSE asset_id END,provider_asset_id=CASE WHEN phase_name IN ('put','confirm') THEN (SELECT provider_asset_id FROM public.pub_native_media_bridge_phases WHERE bridge_id=b.id AND phase='sign') ELSE provider_asset_id END WHERE bridge_id=b.id AND phase=phase_name RETURNING * INTO p;
    UPDATE public.pub_native_media_bridges SET state=CASE WHEN phase_name='confirm' THEN 'confirming' ELSE 'uploading' END,phase=phase_name,revision=revision+1,updated_at=now(),error_code=NULL WHERE id=b.id RETURNING * INTO b;
    INSERT INTO public.pub_native_media_bridge_events(owner_id,bridge_id,phase,kind,evidence) VALUES(p_user_id,b.id,phase_name,'claimed',jsonb_build_object('dispatchId',p.dispatch_id));result:=jsonb_build_object('bridge',public.native_media_bridge_dto(b,p_input->>'currentNamespace'),'phase',public.native_media_bridge_phase_dto(p),'shouldDispatch',true);
   END IF;
  ELSIF p_input->>'action'='prepare-v3' THEN
   PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','requestKey','currentNamespace','bridgeId','phase','dispatchId','input'],ARRAY['action','requestKey','currentNamespace','bridgeId','phase','dispatchId','input']);phase_name:=p_input->>'phase';v3:=p_input->'input';
   IF phase_name IS NULL OR phase_name NOT IN ('sign','confirm') OR NOT public.native_ai_uuid(p_input->'dispatchId') OR p_input->>'requestKey' IS DISTINCT FROM key_prefix||':prepare-v3:'||phase_name OR v3->>'requestKey' IS DISTINCT FROM key_prefix||':'||phase_name OR v3->>'connectionId' IS DISTINCT FROM b.namespace THEN RAISE EXCEPTION 'NATIVE_BRIDGE_INPUT_INVALID';END IF;
   IF b.namespace IS DISTINCT FROM p_input->>'currentNamespace' THEN RAISE EXCEPTION 'NATIVE_BRIDGE_NAMESPACE_CHANGED';END IF;PERFORM public.native_media_bridge_assert_snapshot(p_user_id,b.id,b.namespace,b.snapshot);
   SELECT * INTO p FROM public.pub_native_media_bridge_phases WHERE owner_id=p_user_id AND bridge_id=b.id AND phase=phase_name AND dispatch_id=(p_input->>'dispatchId')::uuid FOR UPDATE;IF NOT FOUND OR p.state NOT IN ('claimed','unknown') THEN RAISE EXCEPTION 'NATIVE_BRIDGE_PHASE_INVALID';END IF;
   IF phase_name='sign' THEN
    IF v3->>'action' IS DISTINCT FROM 'prepare-upload' OR v3->'asset' IS DISTINCT FROM jsonb_build_object('mediaId',b.media_id,'fileName',f->'fileName','mime',f->'mime','size',f->'size','sha256',f->'sha256') OR v3->'snapshot' IS DISTINCT FROM jsonb_build_object('request',jsonb_build_object('filename',f->'fileName','size',f->'size','type','publishMedia')) THEN RAISE EXCEPTION 'NATIVE_BRIDGE_INPUT_INVALID';END IF;
   ELSE
    IF v3->>'action' IS DISTINCT FROM 'prepare-confirm' OR v3->>'assetId' IS DISTINCT FROM b.asset_id::text OR v3->'snapshot' IS DISTINCT FROM jsonb_build_object('request',jsonb_build_object('assetId',p.provider_asset_id)) OR NOT EXISTS(SELECT 1 FROM public.pub_native_media_bridge_phases WHERE owner_id=p_user_id AND bridge_id=b.id AND phase='put' AND state='recorded') THEN RAISE EXCEPTION 'NATIVE_BRIDGE_PHASE_INVALID';END IF;
   END IF;
   result:=public.mutate_publish_v3_media_v1_atomic(p_user_id,v3);op:=jsonb_populate_record(NULL::public.pub3_operations,result->'operation');
   IF op.owner_id IS DISTINCT FROM p_user_id OR op.connection_id IS DISTINCT FROM b.namespace OR op.kind IS DISTINCT FROM (CASE phase_name WHEN 'sign' THEN 'asset_sign' ELSE 'asset_confirm' END) OR op.request_key IS DISTINCT FROM p.operation_request_key OR p.operation_id IS NOT NULL AND p.operation_id IS DISTINCT FROM op.id THEN RAISE EXCEPTION 'NATIVE_BRIDGE_PHASE_INVALID';END IF;
   UPDATE public.pub_native_media_bridge_phases SET operation_id=op.id,asset_id=op.subject_id WHERE bridge_id=b.id AND phase=phase_name RETURNING * INTO p;
   IF phase_name='sign' THEN UPDATE public.pub_native_media_bridges SET asset_id=op.subject_id,revision=revision+1,updated_at=now() WHERE id=b.id RETURNING * INTO b;END IF;
   INSERT INTO public.pub_native_media_bridge_events(owner_id,bridge_id,phase,kind,evidence) VALUES(p_user_id,b.id,phase_name,'v3_prepared',jsonb_build_object('operationId',op.id,'assetId',op.subject_id));
  ELSIF p_input->>'action'='record-put' THEN
   PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','requestKey','currentNamespace','bridgeId','dispatchId','proof'],ARRAY['action','requestKey','currentNamespace','bridgeId','dispatchId','proof']);PERFORM public.pub2_assert_json_keys(p_input->'proof',ARRAY['httpStatus','sha256','size','mime'],ARRAY['httpStatus','sha256','size','mime']);
   IF NOT public.native_ai_uuid(p_input->'dispatchId') OR p_input->>'requestKey' IS DISTINCT FROM key_prefix||':put-receipt' OR NOT public.native_ai_integer(p_input->'proof'->'httpStatus',200,299) OR p_input->'proof'->'sha256' IS DISTINCT FROM f->'sha256' OR p_input->'proof'->'size' IS DISTINCT FROM f->'size' OR p_input->'proof'->'mime' IS DISTINCT FROM f->'mime' THEN RAISE EXCEPTION 'NATIVE_BRIDGE_PUT_PROOF_INVALID';END IF;
   SELECT * INTO p FROM public.pub_native_media_bridge_phases WHERE owner_id=p_user_id AND bridge_id=b.id AND phase='put' AND dispatch_id=(p_input->>'dispatchId')::uuid FOR UPDATE;IF NOT FOUND OR p.state NOT IN ('claimed','unknown') THEN RAISE EXCEPTION 'NATIVE_BRIDGE_PHASE_INVALID';END IF;
   UPDATE public.pub_native_media_bridge_phases SET state='recorded',recorded_at=now(),proof=p_input->'proof' WHERE bridge_id=b.id AND phase='put';
   UPDATE public.pub_native_media_bridges SET revision=revision+1,updated_at=now() WHERE id=b.id RETURNING * INTO b;
   INSERT INTO public.pub_native_media_bridge_events(owner_id,bridge_id,phase,kind,evidence) VALUES(p_user_id,b.id,'put','server_put_ack',p_input->'proof');result:=jsonb_build_object('bridge',public.native_media_bridge_dto(b,p_input->>'currentNamespace'),'alreadyFulfilled',false);
  ELSIF p_input->>'action'='reconcile' THEN
   PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','requestKey','currentNamespace','bridgeId'],ARRAY['action','requestKey','currentNamespace','bridgeId']);
   FOR p IN SELECT * FROM public.pub_native_media_bridge_phases WHERE owner_id=p_user_id AND bridge_id=b.id AND dispatch_id IS NOT NULL AND state<>'recorded' ORDER BY CASE phase WHEN 'sign' THEN 0 WHEN 'put' THEN 1 ELSE 2 END FOR UPDATE LOOP
    IF p.phase='put' THEN IF p.state<>'unknown' THEN UPDATE public.pub_native_media_bridge_phases SET state='unknown' WHERE bridge_id=b.id AND phase='put';changed:=true;END IF;CONTINUE;END IF;
    SELECT * INTO op FROM public.pub3_operations WHERE owner_id=p_user_id AND id=p.operation_id AND connection_id=b.namespace AND request_key=p.operation_request_key AND kind=CASE p.phase WHEN 'sign' THEN 'asset_sign' ELSE 'asset_confirm' END AND subject_id=p.asset_id;
    SELECT * INTO asset FROM public.pub3_assets WHERE owner_id=p_user_id AND id=p.asset_id AND connection_id=b.namespace AND local_media_id=b.media_id AND file_name=f->>'fileName' AND mime=f->>'mime' AND size=(f->>'size')::bigint AND sha256=f->>'sha256';
    IF op.id IS NOT NULL AND asset.id IS NOT NULL AND op.grant_used AND op.dispatch_state='settled' AND asset.provider_asset_id IS NOT NULL AND (p.phase='sign' AND asset.state IN ('uploading','confirming','ready') OR p.phase='confirm' AND asset.state='ready') THEN
     UPDATE public.pub_native_media_bridge_phases SET state='recorded',provider_asset_id=asset.provider_asset_id,recorded_at=now() WHERE bridge_id=b.id AND phase=p.phase;
     INSERT INTO public.pub_native_media_bridge_events(owner_id,bridge_id,phase,kind,evidence) VALUES(p_user_id,b.id,p.phase,CASE p.phase WHEN 'sign' THEN 'provider_sign' ELSE 'provider_confirm' END,jsonb_build_object('operationId',op.id,'assetId',asset.id,'evidence','grant_used_settled_exact_file'));changed:=true;
    ELSIF p.state NOT IN ('unknown','failed_known') AND NOT(op.id IS NULL AND p.claimed_at>now()-interval '30 seconds') THEN UPDATE public.pub_native_media_bridge_phases SET state=CASE WHEN asset.state='failed' OR op.outcome IN ('failed','cancelled') THEN 'failed_known' ELSE 'unknown' END WHERE bridge_id=b.id AND phase=p.phase;changed:=true;
    END IF;
   END LOOP;
   SELECT CASE WHEN bool_and(state='recorded') THEN 'ready' WHEN bool_or(state='failed_known') THEN 'failed_known' WHEN bool_or(state='unknown') OR EXISTS(SELECT 1 FROM public.pub_native_media_bridge_phases sign_phase JOIN public.pub_native_media_bridge_phases put_phase ON put_phase.bridge_id=sign_phase.bridge_id AND put_phase.phase='put' WHERE sign_phase.owner_id=p_user_id AND sign_phase.bridge_id=b.id AND sign_phase.phase='sign' AND sign_phase.state='recorded' AND sign_phase.recorded_at<now()-interval '30 seconds' AND put_phase.dispatch_id IS NULL) THEN 'unknown' WHEN bool_or(phase='put' AND state='recorded') OR bool_or(phase='confirm' AND dispatch_id IS NOT NULL) THEN 'confirming' WHEN bool_or(dispatch_id IS NOT NULL) THEN 'uploading' ELSE 'prepared' END INTO next_state FROM public.pub_native_media_bridge_phases WHERE owner_id=p_user_id AND bridge_id=b.id;
   IF b.state<>next_state OR changed THEN UPDATE public.pub_native_media_bridges SET state=next_state,phase=CASE WHEN next_state='ready' THEN NULL ELSE phase END,error_code=CASE next_state WHEN 'unknown' THEN 'NATIVE_BRIDGE_RESULT_UNKNOWN' WHEN 'failed_known' THEN 'NATIVE_BRIDGE_FAILED_KNOWN' ELSE NULL END,revision=revision+1,updated_at=now() WHERE id=b.id RETURNING * INTO b;END IF;
   result:=jsonb_build_object('bridge',public.native_media_bridge_dto(b,p_input->>'currentNamespace'),'alreadyFulfilled',false);
  ELSE RAISE EXCEPTION 'NATIVE_BRIDGE_INPUT_INVALID';END IF;
 END IF;
 INSERT INTO public.pub_native_media_bridge_requests(owner_id,bridge_id,request_key,payload,result) VALUES(p_user_id,b.id,p_input->>'requestKey',p_input,result);RETURN result;
END$$;

-- A ready bridge proves these exact bytes on this immutable local provider
-- asset. It does not upgrade pub3 hash_source or assert a provider-side hash.
CREATE FUNCTION public.native_media_bridge_proven(p_owner text,p_namespace text,p_reference jsonb,p_media_id uuid,p_asset jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$SELECT EXISTS(
 SELECT 1 FROM public.pub_native_media_bridges b WHERE b.owner_id=p_owner AND b.namespace=p_namespace AND b.reference=p_reference AND b.media_id=p_media_id AND b.state='ready' AND b.asset_id::text=p_asset->>'id' AND p_asset->>'mediaId'=p_media_id::text AND p_asset->'sha256'=b.snapshot->'file'->'sha256' AND p_asset->'size'=b.snapshot->'file'->'size' AND p_asset->'mime'=b.snapshot->'file'->'mime'
 AND (SELECT count(*)=3 AND bool_and(state='recorded') FROM public.pub_native_media_bridge_phases WHERE owner_id=p_owner AND bridge_id=b.id)
)$$;
CREATE FUNCTION public.native_media_bridge_assert_targets(p_owner text,p_namespace text,p_metadata jsonb,p_media_ids jsonb,p_cover jsonb,p_asset_ids jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE mapping jsonb;BEGIN
 IF p_metadata->'schemaVersion' IS DISTINCT FROM '2'::jsonb THEN RETURN;END IF;
 FOR mapping IN SELECT * FROM jsonb_array_elements(p_metadata->'media') m WHERE m->'source'->>'kind'='main_asset' AND (p_media_ids?(m->>'mediaId') OR p_cover=m->'mediaId') LOOP
  IF NOT EXISTS(SELECT 1 FROM public.pub3_assets a WHERE a.owner_id=p_owner AND a.connection_id=p_namespace AND a.state='ready' AND p_asset_ids?a.id::text AND public.native_media_bridge_proven(p_owner,p_namespace,mapping->'source'->'reference',(mapping->>'mediaId')::uuid,jsonb_build_object('id',a.id,'mediaId',a.local_media_id,'sha256',a.sha256,'size',a.size,'mime',a.mime))) THEN RAISE EXCEPTION 'NATIVE_MAIN_BRIDGE_REQUIRED';END IF;
 END LOOP;
END$$;
CREATE FUNCTION public.native_media_bridge_assert_intent(p_owner text,p_namespace text,p_payload jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$DECLARE metadata jsonb;BEGIN
 SELECT payload INTO metadata FROM public.pub_native_draft_meta WHERE owner_id=p_owner AND draft_id=(p_payload->>'draftId')::uuid AND draft_version=(p_payload->>'draftVersion')::integer;
 IF FOUND THEN PERFORM public.native_media_bridge_assert_targets(p_owner,p_namespace,metadata,p_payload->'mediaIds',p_payload->'coverMediaId',p_payload->'assetIds');END IF;
END$$;

CREATE OR REPLACE FUNCTION public.mutate_publish_v3_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$DECLARE op public.pub3_operations%ROWTYPE;intent public.pub3_intents%ROWTYPE;asset public.pub3_assets%ROWTYPE;reserved public.pub_native_media_bridges%ROWTYPE;BEGIN
 PERFORM public.pub_assert_actor(p_user_id);PERFORM public.pub3_assert_input(p_input);
 IF p_input->>'action'='prepare-upload' THEN
  IF p_input->'asset'->>'fileName' LIKE 'native-bridge-%' OR EXISTS(SELECT 1 FROM public.pub_native_media_bridges WHERE owner_id=p_user_id AND namespace=p_input->>'connectionId' AND media_id::text=p_input->'asset'->>'mediaId') THEN RAISE EXCEPTION 'NATIVE_BRIDGE_MEDIA_RESERVED';END IF;
 ELSIF p_input->>'action'='prepare-confirm' THEN
  IF EXISTS(SELECT 1 FROM public.pub_native_media_bridges b JOIN public.pub3_assets a ON a.owner_id=b.owner_id AND a.connection_id=b.namespace AND a.local_media_id=b.media_id WHERE b.owner_id=p_user_id AND b.namespace=p_input->>'connectionId' AND a.id::text=p_input->>'assetId') THEN RAISE EXCEPTION 'NATIVE_BRIDGE_MEDIA_RESERVED';END IF;
 ELSIF p_input->>'action' IN ('dispatch','consume-grant') THEN
  SELECT * INTO op FROM public.pub3_operations WHERE owner_id=p_user_id AND id=(p_input->>'operationId')::uuid AND connection_id=p_input->>'connectionId' FOR UPDATE;
  IF FOUND THEN
   IF op.kind IN ('asset_sign','asset_confirm') THEN
    SELECT * INTO asset FROM public.pub3_assets WHERE owner_id=p_user_id AND id=op.subject_id AND connection_id=op.connection_id;
    IF FOUND THEN
     SELECT * INTO reserved FROM public.pub_native_media_bridges WHERE owner_id=p_user_id AND namespace=op.connection_id AND media_id=asset.local_media_id;
     IF FOUND AND NOT EXISTS(SELECT 1 FROM public.pub_native_media_bridge_phases p WHERE p.owner_id=p_user_id AND p.bridge_id=reserved.id AND p.operation_id=op.id AND p.asset_id=op.subject_id AND p.operation_request_key=op.request_key AND p.dispatch_id IS NOT NULL AND p.phase=(CASE op.kind WHEN 'asset_sign' THEN 'sign' ELSE 'confirm' END)) THEN RAISE EXCEPTION 'NATIVE_BRIDGE_MEDIA_RESERVED';END IF;
    END IF;
   ELSIF op.kind='publish' AND NOT op.grant_used AND (p_input->>'action'='dispatch' AND op.dispatch_state='ready' OR p_input->>'action'='consume-grant' AND op.dispatch_state='dispatching') THEN PERFORM public.native_media_bridge_assert_intent(p_user_id,op.connection_id,op.snapshot->'intent');
   END IF;
  END IF;
 ELSIF p_input->>'action'='save-intent' THEN
  PERFORM public.pub3_assert_intent(p_input->'payload');PERFORM public.native_media_bridge_assert_intent(p_user_id,p_input->>'connectionId',p_input->'payload');
 ELSIF p_input->>'action'='submit' THEN
  IF EXISTS(SELECT 1 FROM public.pub3_operations WHERE owner_id=p_user_id AND request_key=p_input->>'requestKey') THEN RETURN public.mutate_publish_v3_media_v1_atomic(p_user_id,p_input);END IF;
  SELECT * INTO intent FROM public.pub3_intents WHERE owner_id=p_user_id AND id=(p_input->>'intentId')::uuid FOR UPDATE;IF FOUND THEN PERFORM public.native_media_bridge_assert_intent(p_user_id,p_input->>'connectionId',intent.payload);END IF;
 END IF;
 RETURN public.mutate_publish_v3_media_v1_atomic(p_user_id,p_input);
END$$;

-- Source-aware auxiliary/usage bodies are inserted below without changing
-- their legacy delegates, owner locks, replay receipts or V1 behavior.

CREATE OR REPLACE FUNCTION public.mutate_native_auxiliary_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE body jsonb;h text;prior public.pub_native_core_requests%ROWTYPE;plan jsonb;grp jsonb;groups jsonb:='[]'::jsonb;ref jsonb;target jsonb;refs jsonb;result jsonb;execution jsonb;actual jsonb;idx integer:=0;draft uuid;version integer;entry public.pub_native_media_entries%ROWTYPE;BEGIN
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
  FOR target IN SELECT * FROM jsonb_array_elements(grp->'officialTargets') LOOP PERFORM public.native_media_bridge_assert_targets(p_user_id,p_input->>'connectionId',grp->'metadata',target->'mediaIds',target->'coverMediaId',target->'assetIds');END LOOP;
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
  SELECT o.id,o.revision,o.outcome,o.dispatch_state,o.grant_used,EXISTS(SELECT 1 FROM jsonb_array_elements(o.snapshot->'assets') asset WHERE asset->>'mediaId'=r.media_id::text AND (selected.source_kind='provider_asset' AND asset->>'id'=selected.asset_id::text OR selected.source_kind='main_asset' AND public.native_media_bridge_proven(p_owner,o.connection_id,selected.main_reference,r.media_id,asset))) AS proven
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

DO $$DECLARE signature text;BEGIN
 FOREACH signature IN ARRAY ARRAY['native_media_bridge_history_guard()','native_media_source_fingerprint(text,jsonb)','native_media_bridge_phase_dto(public.pub_native_media_bridge_phases)','native_media_bridge_dto(public.pub_native_media_bridges,text)','native_media_bridge_assert_snapshot(text,uuid,text,jsonb)','native_media_bridge_proven(text,text,jsonb,uuid,jsonb)','native_media_bridge_assert_targets(text,text,jsonb,jsonb,jsonb,jsonb)','native_media_bridge_assert_intent(text,text,jsonb)'] LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.'||signature||' FROM PUBLIC,anon,authenticated,service_role';END LOOP;
END$$;
REVOKE ALL ON FUNCTION public.read_native_media_bridge_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mutate_native_media_bridge_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.read_native_media_bridge_atomic(text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.mutate_native_media_bridge_atomic(text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
