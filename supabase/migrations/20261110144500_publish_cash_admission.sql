-- Reviewed local candidate; execute only through the fixed 145 migration tool.
-- The exact statement body passed isolated PostgreSQL and independent review.
-- Local candidate: explicit site retail CNY 0.20/target; never enables execution.
-- Uses the main wallet ledger. No entitlement or package is fabricated.
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';

CREATE TABLE public.pub_cash_price_versions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),revision integer NOT NULL UNIQUE CHECK(revision>0),
 default_charge_cents integer NOT NULL CHECK(default_charge_cents BETWEEN 1 AND 100000000),
 overrides jsonb NOT NULL CHECK(jsonb_typeof(overrides)='array'),created_by varchar(36) REFERENCES public.users(id),
 decision_source text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.pub_cash_price_head(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision integer NOT NULL REFERENCES public.pub_cash_price_versions(revision));
CREATE TABLE public.pub_cash_price_requests(
 actor_id varchar(36) NOT NULL REFERENCES public.users(id),request_key text NOT NULL,request_payload jsonb NOT NULL,
 request_hash text NOT NULL,version_id uuid NOT NULL REFERENCES public.pub_cash_price_versions(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor_id,request_key)
);
CREATE TABLE public.pub_cash_admissions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id varchar(36) NOT NULL REFERENCES public.users(id),
 execution_kind text NOT NULL CHECK(execution_kind IN ('v2','v3','v5')),operation_id uuid NOT NULL,target_id uuid NOT NULL,
 account_id uuid NOT NULL,account_kind text NOT NULL CHECK(account_kind IN ('browser','official','generic')),
 content_digest text NOT NULL CHECK(content_digest~'^[a-f0-9]{64}$'),snapshot_hash text NOT NULL CHECK(snapshot_hash~'^[a-f0-9]{64}$'),
 quote_hash text NOT NULL CHECK(quote_hash~'^[a-f0-9]{64}$'),quote_proof jsonb NOT NULL,
 price_version_id uuid NOT NULL REFERENCES public.pub_cash_price_versions(id),charge_cents integer NOT NULL CHECK(charge_cents>0),
 charge_wallet_operation_id bigint NOT NULL REFERENCES public.wallet_operations(id),refund_wallet_operation_id bigint REFERENCES public.wallet_operations(id),
 state text NOT NULL DEFAULT 'charged' CHECK(state IN ('charged','refunded')),revision integer NOT NULL DEFAULT 1,
 charged_at timestamptz NOT NULL DEFAULT now(),refunded_at timestamptz,
 UNIQUE(owner_id,execution_kind,operation_id,target_id),UNIQUE(owner_id,id),UNIQUE(charge_wallet_operation_id),UNIQUE(refund_wallet_operation_id),
 CHECK((state='charged' AND refund_wallet_operation_id IS NULL AND refunded_at IS NULL) OR (state='refunded' AND refund_wallet_operation_id IS NOT NULL AND refunded_at IS NOT NULL))
);
INSERT INTO public.pub_cash_price_versions(revision,default_charge_cents,overrides,decision_source) VALUES(1,20,'[]','site-retail-decision-2026-11-10');
INSERT INTO public.pub_cash_price_head(singleton,revision) VALUES(true,1);

CREATE FUNCTION public.pub_cash_hash(p_value jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$SELECT encode(sha256(convert_to(p_value::text,'UTF8')),'hex')$$;
CREATE FUNCTION public.pub_cash_assert_reader(p_actor text) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user public.users%ROWTYPE;v_permission jsonb;
BEGIN
 SELECT * INTO v_user FROM public.users WHERE id=p_actor;
 IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_USER_NOT_FOUND';END IF;
 IF v_user.is_active IS FALSE OR lower(trim(coalesce(v_user.status,''))) IN ('blocked','suspended','disabled','inactive') THEN RAISE EXCEPTION 'PUBLISH_USER_DISABLED';END IF;
 v_permission:=public.read_member_permission_snapshot(p_actor);
 IF v_permission->>'authority_status'<>'ready' OR coalesce((v_permission->>'integrity_valid')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_PERMISSION_UNAVAILABLE';END IF;
 IF NOT coalesce(v_permission->'feature_navigation_keys' ? 'publish_center',false) THEN RAISE EXCEPTION 'PUBLISH_ACCESS_DENIED';END IF;
END $$;
CREATE FUNCTION public.pub_cash_assert_admin(p_actor text) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_access jsonb;BEGIN
 v_access:=public.read_admin_access_snapshot(p_actor);
 IF v_access->>'authority_status' IS DISTINCT FROM 'ready' OR (v_access->>'integrity_valid')::boolean IS DISTINCT FROM true OR NOT coalesce(v_access->'permission_keys' ? 'integrations.manage',false) THEN RAISE EXCEPTION 'PUBLISH_ACCESS_DENIED';END IF;
END $$;
CREATE FUNCTION public.pub_cash_price_dto(p_row public.pub_cash_price_versions) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',p_row.id,'revision',p_row.revision,'currency','CNY','defaultChargeCents',p_row.default_charge_cents,'overrides',p_row.overrides,'createdAt',p_row.created_at)
$$;
CREATE FUNCTION public.read_publish_cash_pricing() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('schemaReady',true,'current',public.pub_cash_price_dto(v)) FROM public.pub_cash_price_head h JOIN public.pub_cash_price_versions v ON v.revision=h.revision WHERE h.singleton
$$;
CREATE FUNCTION public.pub_cash_pricing_input(p_input jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE v_item jsonb;v_overrides jsonb;
BEGIN
 PERFORM public.pub2_assert_json_keys(p_input,ARRAY['expectedRevision','defaultChargeCents','overrides'],ARRAY['expectedRevision','defaultChargeCents','overrides']);
 IF jsonb_typeof(p_input->'expectedRevision')<>'number' OR (p_input->>'expectedRevision') !~ '^\d+$' OR (p_input->>'expectedRevision')::numeric>2147483647 OR jsonb_typeof(p_input->'defaultChargeCents')<>'number' OR (p_input->>'defaultChargeCents') !~ '^\d+$' OR (p_input->>'defaultChargeCents')::numeric NOT BETWEEN 1 AND 100000000 OR jsonb_typeof(p_input->'overrides')<>'array' OR jsonb_array_length(p_input->'overrides')>28 THEN RAISE EXCEPTION 'PUBLISH_CASH_INPUT_INVALID';END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(p_input->'overrides') LOOP
  PERFORM public.pub2_assert_json_keys(v_item,ARRAY['platform','transport','chargeCents'],ARRAY['platform','transport','chargeCents']);
  IF v_item->>'platform' NOT IN ('xhs','wxSph','douyin','linkedin','threads','instagram','KWAI','pinterest','wxGzh','bilibili','facebook','youtube','tiktok','twitter') OR v_item->>'transport' NOT IN ('browser_plugin','official_api') OR (v_item->>'transport'='browser_plugin' AND v_item->>'platform' NOT IN ('xhs','wxSph','douyin')) OR jsonb_typeof(v_item->'chargeCents')<>'number' OR (v_item->>'chargeCents') !~ '^\d+$' OR (v_item->>'chargeCents')::numeric NOT BETWEEN 1 AND 100000000 THEN RAISE EXCEPTION 'PUBLISH_CASH_INPUT_INVALID';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'overrides') q GROUP BY q->>'platform',q->>'transport' HAVING count(*)>1) THEN RAISE EXCEPTION 'PUBLISH_CASH_INPUT_INVALID';END IF;
 SELECT coalesce(jsonb_agg(q ORDER BY q->>'platform',q->>'transport'),'[]') INTO v_overrides FROM jsonb_array_elements(p_input->'overrides') q;
 RETURN jsonb_build_object('expectedRevision',(p_input->>'expectedRevision')::integer,'defaultChargeCents',(p_input->>'defaultChargeCents')::integer,'overrides',v_overrides);
END $$;
CREATE FUNCTION public.preview_publish_cash_pricing(p_actor text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_input jsonb;v_current public.pub_cash_price_versions%ROWTYPE;
BEGIN
 PERFORM public.pub_cash_assert_admin(p_actor);v_input:=public.pub_cash_pricing_input(p_input);
 SELECT v.* INTO v_current FROM public.pub_cash_price_versions v JOIN public.pub_cash_price_head h ON h.revision=v.revision WHERE h.singleton;
 IF v_current.revision IS DISTINCT FROM (v_input->>'expectedRevision')::integer THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT';END IF;
 RETURN jsonb_build_object('schemaReady',true,'current',public.pub_cash_price_dto(v_current),'proposed',v_input,'previewHash',public.pub_cash_hash(jsonb_build_object('actor',p_actor,'input',v_input,'currentId',v_current.id)));
END $$;
CREATE FUNCTION public.read_publish_cash_pricing_receipt(p_actor text,p_request_key text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_receipt jsonb;
BEGIN
 PERFORM public.pub_cash_assert_admin(p_actor);
 SELECT jsonb_build_object('requestKey',r.request_key,'requestHash',r.request_hash,'version',public.pub_cash_price_dto(v)) INTO v_receipt FROM public.pub_cash_price_requests r JOIN public.pub_cash_price_versions v ON v.id=r.version_id WHERE r.actor_id=p_actor AND r.request_key=p_request_key;
 RETURN jsonb_build_object('schemaReady',true,'receipt',v_receipt);
END $$;
CREATE FUNCTION public.save_publish_cash_pricing_atomic(p_actor text,p_request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_input jsonb;v_prior public.pub_cash_price_requests%ROWTYPE;v_preview jsonb;v_version public.pub_cash_price_versions%ROWTYPE;
BEGIN
 PERFORM 1 FROM public.users WHERE id=p_actor FOR UPDATE;PERFORM public.pub_cash_assert_admin(p_actor);
 PERFORM public.pub2_assert_json_keys(p_request,ARRAY['action','requestKey','input','previewHash'],ARRAY['action','requestKey','input','previewHash']);
 IF p_request->>'action'<>'save' OR coalesce(p_request->>'requestKey','') !~ '^[A-Za-z0-9_.:-]{8,160}$' THEN RAISE EXCEPTION 'PUBLISH_CASH_INPUT_INVALID';END IF;
 v_input:=public.pub_cash_pricing_input(p_request->'input');p_request:=jsonb_set(p_request,'{input}',v_input);
 SELECT * INTO v_prior FROM public.pub_cash_price_requests WHERE actor_id=p_actor AND request_key=p_request->>'requestKey';
 IF FOUND THEN
  IF v_prior.request_payload IS DISTINCT FROM p_request THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;
  RETURN public.read_publish_cash_pricing_receipt(p_actor,v_prior.request_key)->'receipt';
 END IF;
 PERFORM 1 FROM public.pub_cash_price_head WHERE singleton FOR UPDATE;
 v_preview:=public.preview_publish_cash_pricing(p_actor,v_input);
 IF p_request->>'previewHash' IS DISTINCT FROM v_preview->>'previewHash' THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT';END IF;
 INSERT INTO public.pub_cash_price_versions(revision,default_charge_cents,overrides,created_by,decision_source) VALUES((v_input->>'expectedRevision')::integer+1,(v_input->>'defaultChargeCents')::integer,v_input->'overrides',p_actor,'admin-confirmed') RETURNING * INTO v_version;
 UPDATE public.pub_cash_price_head SET revision=v_version.revision WHERE singleton;
 INSERT INTO public.pub_cash_price_requests(actor_id,request_key,request_payload,request_hash,version_id) VALUES(p_actor,p_request->>'requestKey',p_request,public.pub_cash_hash(p_request),v_version.id);
 RETURN public.read_publish_cash_pricing_receipt(p_actor,p_request->>'requestKey')->'receipt';
END $$;
CREATE FUNCTION public.read_publish_cash_available(p_actor text) RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_balance numeric;v_held numeric;
BEGIN
 PERFORM public.pub_cash_assert_reader(p_actor);
 SELECT round(coalesce(cash_balance,0),2) INTO v_balance FROM public.users WHERE id=p_actor;
 SELECT coalesce(sum(round(coalesce(task.billing_reserved_yuan,task.billing_price_yuan)::numeric,2)),0) INTO v_held FROM public.video_tasks task
 WHERE task.user_id::text=p_actor AND task.status NOT IN ('completed','failed','cancelled','expired')
 AND coalesce(task.billing_exempt,false) IS NOT TRUE AND coalesce(task.explicitly_free,false) IS NOT TRUE
 AND round(coalesce(task.billing_reserved_yuan,task.billing_price_yuan,0)::numeric,2)>0
 AND (task.billing_unit='token' OR coalesce(task.billing_state,'reserved') NOT IN ('submission_failed','settled_pending_commit','settled','legacy_h3_settled','not_required'))
 AND NOT EXISTS(SELECT 1 FROM public.wallet_operations wo WHERE wo.user_id=task.user_id::text AND wo.wallet='cash' AND wo.operation_kind='cash_charge' AND wo.status='completed' AND wo.idempotency_key=task.billing_idempotency_key AND round(wo.amount,2)=round(task.billing_price_yuan,2) AND round(wo.delta,2)=-round(task.billing_price_yuan,2));
 RETURN greatest(0,round((v_balance-v_held)*100))::bigint;
END $$;
CREATE FUNCTION public.pub_cash_binding(p_actor text,p_kind text,p_id uuid,p_revision integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_row jsonb;v_meta jsonb;
BEGIN
 IF p_kind='browser' THEN SELECT jsonb_build_object('id',a.id,'platform',a.platform,'revision',1,'uid',a.platform_account_id,'connection',a.updated_at,'transport','browser_plugin') INTO v_row FROM public.pub_accounts a WHERE a.id=p_id AND a.user_id=p_actor;
 ELSIF p_kind='official' THEN SELECT jsonb_build_object('id',a.id,'platform','douyin','revision',a.revision,'uid',a.platform_uid,'connection',a.connection_id,'transport','official_api') INTO v_row FROM public.pub3_account_bindings a WHERE a.id=p_id AND a.owner_id=p_actor AND a.status='active';
 ELSIF p_kind='generic' THEN SELECT jsonb_build_object('id',a.id,'platform',a.platform,'revision',a.revision,'uid',a.platform_uid,'connection',a.connection_id,'transport','official_api') INTO v_row FROM public.pub4_account_bindings a WHERE a.id=p_id AND a.owner_id=p_actor AND a.status='active';
 ELSE RAISE EXCEPTION 'PUBLISH_CASH_INPUT_INVALID';END IF;
 IF v_row IS NULL OR (v_row->>'revision')::integer IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'PUBLISH_CASH_ACCOUNT_CHANGED';END IF;
 IF p_kind IN ('browser','official') THEN
  SELECT to_jsonb(m) INTO v_meta FROM public.pub_native_account_meta m WHERE owner_id=p_actor AND account_kind=p_kind AND account_id=p_id;
  IF coalesce((v_meta->>'disconnected')::boolean,false) THEN RAISE EXCEPTION 'PUBLISH_CASH_ACCOUNT_CHANGED';END IF;
  v_row:=v_row||jsonb_build_object('metadataRevision',coalesce((v_meta->>'revision')::integer,0));
 END IF;
 RETURN v_row;
END $$;
CREATE FUNCTION public.pub_cash_quote_at(p_actor text,p_input jsonb,p_window bigint) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_price public.pub_cash_price_versions%ROWTYPE;v_target jsonb;v_binding jsonb;v_targets jsonb:='[]';v_hash_targets jsonb:='[]';v_cents integer;v_total bigint:=0;v_available bigint;v_enabled boolean;v_hash text;
BEGIN
 PERFORM public.pub_cash_assert_reader(p_actor);
 PERFORM public.pub2_assert_json_keys(p_input,ARRAY['schemaVersion','reviewHash','targets'],ARRAY['schemaVersion','reviewHash','targets']);
 IF p_input->'schemaVersion'<>'1' OR coalesce(p_input->>'reviewHash','') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_input->'targets')<>'array' OR jsonb_array_length(p_input->'targets') NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'targets') q GROUP BY q->>'accountKind',q->>'accountId' HAVING count(*)>1) THEN RAISE EXCEPTION 'PUBLISH_CASH_INPUT_INVALID';END IF;
 SELECT v.* INTO v_price FROM public.pub_cash_price_versions v JOIN public.pub_cash_price_head h ON h.revision=v.revision WHERE h.singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_CASH_PRICE_UNAVAILABLE';END IF;
 FOR v_target IN SELECT value FROM jsonb_array_elements(p_input->'targets') LOOP
  PERFORM public.pub2_assert_json_keys(v_target,ARRAY['accountId','accountKind','accountRevision','contentDigest'],ARRAY['accountId','accountKind','accountRevision','contentDigest']);
  IF coalesce(v_target->>'contentDigest','') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PUBLISH_CASH_INPUT_INVALID';END IF;
  v_binding:=public.pub_cash_binding(p_actor,v_target->>'accountKind',(v_target->>'accountId')::uuid,(v_target->>'accountRevision')::integer);
  SELECT (q->>'chargeCents')::integer INTO v_cents FROM jsonb_array_elements(v_price.overrides) q WHERE q->>'platform'=v_binding->>'platform' AND q->>'transport'=v_binding->>'transport';
  v_cents:=coalesce(v_cents,v_price.default_charge_cents);v_total:=v_total+v_cents;
  v_targets:=v_targets||jsonb_build_array(v_target||jsonb_build_object('platform',v_binding->>'platform','transport',v_binding->>'transport','priceVersionId',v_price.id,'chargeCents',v_cents));
  v_hash_targets:=v_hash_targets||jsonb_build_array(jsonb_build_object('input',v_target,'binding',v_binding,'priceVersionId',v_price.id,'chargeCents',v_cents));
 END LOOP;
 v_available:=public.read_publish_cash_available(p_actor);
 SELECT execution_enabled AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_targets) q WHERE NOT(enabled_platforms ? (q->>'platform'))) INTO v_enabled FROM public.pub_config_versions ORDER BY version DESC LIMIT 1;
 v_hash:=public.pub_cash_hash(jsonb_build_object('schemaVersion',1,'owner',p_actor,'reviewHash',p_input->>'reviewHash','targets',v_hash_targets,'pricingRevision',v_price.revision,'windowStart',p_window));
 RETURN jsonb_build_object('schemaVersion',1,'currency','CNY','pricingRevision',v_price.revision,'quoteHash',v_hash,'windowStart',p_window,'expiresAt',to_timestamp(p_window+300),'reviewHash',p_input->>'reviewHash','availableBalanceCents',v_available,'estimatedChargeCents',v_total,'canExecute',coalesce(v_enabled,false) AND v_available>=v_total,'reasonCode',CASE WHEN NOT coalesce(v_enabled,false) THEN 'execution_disabled' WHEN v_available<v_total THEN 'insufficient_balance' ELSE 'ready' END,'targets',v_targets);
END $$;
CREATE FUNCTION public.quote_publish_cash(p_actor text,p_input jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('schemaReady',true,'quote',q,'reasonCode',q->>'reasonCode') FROM (SELECT public.pub_cash_quote_at(p_actor,p_input,floor(extract(epoch FROM now())/300)::bigint*300) q) s
$$;

CREATE FUNCTION public.pub_cash_content(p_draft jsonb,p_target jsonb,p_kind text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE v_ids jsonb;v_media jsonb;v_cover jsonb:='null';v_title jsonb;v_body jsonb;v_topics jsonb;v_at jsonb;v_platform text;v_options jsonb;v_cover_id text;
BEGIN
 IF p_kind='generic' THEN
  v_title:=p_target->'title';v_body:=p_target->'body';v_topics:=p_target->'topics';v_at:=p_target->'publishAt';v_platform:=p_target->>'platform';
 ELSE
  v_title:=coalesce(p_target->'titleOverride',p_draft->'title');v_body:=coalesce(p_target->'bodyOverride',p_draft->'body');v_topics:=coalesce(p_target->'topicsOverride',p_draft->'topics');
  v_at:=CASE WHEN p_kind='browser' THEN p_target->'scheduledAt' ELSE p_target->'publishAt' END;v_platform:=CASE WHEN p_kind='official' THEN 'douyin' ELSE p_target->>'platform' END;
 END IF;
 v_ids:=p_target->'mediaIds';
 v_cover_id:=p_target->>'coverMediaId';
 IF p_kind='browser' AND v_cover_id IS NULL AND NOT(p_target ? 'mediaIds') THEN
  SELECT m->>'id' INTO v_cover_id FROM jsonb_array_elements(p_draft->'media') WITH ORDINALITY q(m,ord) WHERE m->>'role'='cover' ORDER BY ord LIMIT 1;
 END IF;
 IF v_ids IS NULL THEN SELECT coalesce(jsonb_agg(m->'id' ORDER BY ord),'[]') INTO v_ids FROM jsonb_array_elements(p_draft->'media') WITH ORDINALITY q(m,ord) WHERE m->>'role'<>'cover';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('sha256',m->>'hash','size',m->'size','mime',m->>'type','role',m->>'role') ORDER BY i.ord),'[]') INTO v_media
 FROM jsonb_array_elements_text(v_ids) WITH ORDINALITY i(mid,ord) JOIN jsonb_array_elements(p_draft->'media') m ON m->>'id'=i.mid
 WHERE p_kind<>'browser' OR i.mid IS DISTINCT FROM v_cover_id;
 IF v_cover_id IS NOT NULL THEN
  SELECT jsonb_build_object('sha256',m->>'hash','size',m->'size','mime',m->>'type','role','cover') INTO v_cover FROM jsonb_array_elements(p_draft->'media') m WHERE m->>'id'=v_cover_id;
  IF v_cover IS NULL THEN RAISE EXCEPTION 'PUBLISH_CASH_CONTENT_MISMATCH';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_media||CASE WHEN v_cover='null' THEN '[]'::jsonb ELSE jsonb_build_array(v_cover) END) q WHERE coalesce(q->>'sha256','') !~ '^[a-f0-9]{64}$' OR coalesce((q->>'size')::numeric,0)<=0) THEN RAISE EXCEPTION 'PUBLISH_CASH_CONTENT_MISMATCH';END IF;
 IF jsonb_array_length(v_ids)<>(SELECT count(DISTINCT value) FROM jsonb_array_elements_text(v_ids)) OR jsonb_array_length(v_media)<>(SELECT count(*) FROM jsonb_array_elements_text(v_ids) q WHERE p_kind<>'browser' OR q.value IS DISTINCT FROM v_cover_id) THEN RAISE EXCEPTION 'PUBLISH_CASH_CONTENT_MISMATCH';END IF;
 v_options:=p_target->'options';
 IF p_kind='browser' AND v_platform='wxSph' THEN v_options:='{"postFlag":0}'::jsonb||v_options;
 ELSIF p_kind='browser' AND v_platform='douyin' THEN v_options:='{"privacyLevel":"public"}'::jsonb||v_options;
 ELSIF p_kind='official' THEN v_options:='{"short_title":"","cover_tsp":0,"download_type":1,"private_status":0}'::jsonb||v_options;END IF;
 RETURN jsonb_build_object('schemaVersion',1,'contentType',p_draft->>'contentType','platform',v_platform,'title',v_title,'body',v_body,'topics',v_topics,'options',v_options,'publishAt',coalesce(v_at,'null'),'media',v_media,'cover',v_cover);
END $$;
CREATE FUNCTION public.pub_cash_admission_dto(p_row public.pub_cash_admissions) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',p_row.id,'state',p_row.state,'currency','CNY','chargeCents',p_row.charge_cents,'quoteHash',p_row.quote_hash,'priceVersionId',p_row.price_version_id,'chargedAt',p_row.charged_at,'refundedAt',p_row.refunded_at)
$$;
CREATE FUNCTION public.claim_publish_cash_target_atomic(p_actor text,p_request jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_kind text:=p_request->>'executionKind';v_operation uuid:=(p_request->>'operationId')::uuid;v_target_id uuid:=(p_request->>'targetId')::uuid;
 v_existing public.pub_cash_admissions%ROWTYPE;v_proof jsonb:=p_request->'funding'->'proof';v_quote jsonb;v_target jsonb;v_draft jsonb;v_account uuid;v_account_kind text;
 v_expected jsonb;v_content text:=p_request->>'contentCanonical';v_digest text;v_quote_target jsonb;v_wallet public.wallet_operations%ROWTYPE;v_id uuid:=gen_random_uuid();
BEGIN
 PERFORM public.pub_assert_actor(p_actor);PERFORM 1 FROM public.pub_cash_price_head WHERE singleton FOR SHARE;
 PERFORM public.pub2_assert_json_keys(p_request,ARRAY['executionKind','operationId','targetId','subjectId','funding','contentCanonical','snapshotHash','scheduleId'],ARRAY['executionKind','operationId','targetId','funding','contentCanonical','snapshotHash']);
 IF v_kind NOT IN ('v2','v3','v5') OR coalesce(p_request->>'snapshotHash','') !~ '^[a-f0-9]{64}$' OR p_request->'funding'->>'kind' IS DISTINCT FROM 'cash' THEN RAISE EXCEPTION 'PUBLISH_CASH_INPUT_INVALID';END IF;
 IF v_kind='v2' THEN
  SELECT dv.payload INTO v_draft FROM public.pub2_batches b JOIN public.pub2_draft_versions dv ON dv.user_id=b.user_id AND dv.draft_id=b.draft_id AND dv.version=b.draft_version WHERE b.id=v_operation AND b.user_id=p_actor AND b.target_ids ? v_target_id::text;
  SELECT value INTO v_target FROM jsonb_array_elements(v_draft->'targets') WHERE value->>'id'=v_target_id::text;
  IF p_request->>'scheduleId' IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM public.pub2_schedules s JOIN public.pub2_batches b ON b.user_id=s.user_id AND b.draft_id=s.draft_id AND b.draft_version=s.draft_version WHERE s.user_id=p_actor AND s.id=(p_request->>'scheduleId')::uuid AND s.target_id=v_target_id AND b.id=v_operation AND s.state='planned' AND s.scheduled_at<=now()) THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_LOCKED';END IF;
   v_target:=v_target||'{"scheduledAt":null}'::jsonb;
  END IF;
  v_account:=(v_target->>'accountId')::uuid;v_account_kind:='browser';
 ELSIF v_kind='v3' THEN
  IF v_target_id IS DISTINCT FROM v_operation THEN RAISE EXCEPTION 'PUBLISH_CASH_INPUT_INVALID';END IF;
  SELECT i.payload,dv.payload INTO v_target,v_draft FROM public.pub3_intents i JOIN public.pub2_draft_versions dv ON dv.user_id=i.owner_id AND dv.draft_id=(i.payload->>'draftId')::uuid AND dv.version=(i.payload->>'draftVersion')::integer WHERE i.id=(p_request->>'subjectId')::uuid AND i.owner_id=p_actor AND NOT i.archived;
  v_account:=(v_target->>'bindingId')::uuid;v_account_kind:='official';
 ELSE
  SELECT t.payload->'profile',o.snapshot->'draftPayload' INTO v_target,v_draft FROM public.pub5_targets t JOIN public.pub5_operations o ON o.id=t.operation_id AND o.owner_id=t.owner_id WHERE t.owner_id=p_actor AND t.id=v_target_id AND o.id=v_operation AND o.kind='publish' AND o.snapshot_hash=p_request->>'snapshotHash';
  v_account:=(v_target->>'accountId')::uuid;v_account_kind:='generic';
 END IF;
 IF v_target IS NULL OR v_draft IS NULL OR v_account IS NULL THEN RAISE EXCEPTION 'PUBLISH_CASH_CONTENT_MISMATCH';END IF;
 v_expected:=public.pub_cash_content(v_draft,v_target,v_account_kind);
 IF v_content IS NULL OR length(v_content)>1048576 OR v_content::jsonb IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'PUBLISH_CASH_CONTENT_MISMATCH';END IF;
 v_digest:=encode(sha256(convert_to(v_content,'UTF8')),'hex');
 SELECT * INTO v_existing FROM public.pub_cash_admissions WHERE owner_id=p_actor AND execution_kind=v_kind AND operation_id=v_operation AND target_id=v_target_id FOR UPDATE;
 IF FOUND THEN
  IF v_existing.account_id IS DISTINCT FROM v_account OR v_existing.content_digest IS DISTINCT FROM v_digest OR v_existing.snapshot_hash IS DISTINCT FROM p_request->>'snapshotHash' OR v_existing.quote_proof IS DISTINCT FROM v_proof THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;
  IF v_existing.state<>'charged' THEN RAISE EXCEPTION 'PUBLISH_CASH_REFUNDED';END IF;
  RETURN v_existing.id;
 END IF;
 PERFORM public.pub2_assert_json_keys(p_request->'funding',ARRAY['kind','proof'],ARRAY['kind','proof']);
 PERFORM public.pub2_assert_json_keys(v_proof,ARRAY['input','pricingRevision','windowStart','quoteHash'],ARRAY['input','pricingRevision','windowStart','quoteHash']);
 IF (v_proof->>'windowStart')::bigint IS DISTINCT FROM floor(extract(epoch FROM clock_timestamp())/300)::bigint*300 THEN RAISE EXCEPTION 'PUBLISH_CASH_QUOTE_EXPIRED';END IF;
 v_quote:=public.pub_cash_quote_at(p_actor,v_proof->'input',(v_proof->>'windowStart')::bigint);
 IF v_quote->>'quoteHash' IS DISTINCT FROM v_proof->>'quoteHash' OR v_quote->'pricingRevision' IS DISTINCT FROM v_proof->'pricingRevision' THEN RAISE EXCEPTION 'PUBLISH_CASH_QUOTE_CHANGED';END IF;
 SELECT value INTO v_quote_target FROM jsonb_array_elements(v_quote->'targets') WHERE value->>'accountId'=v_account::text AND value->>'accountKind'=v_account_kind;
 IF v_quote_target IS NULL OR v_quote_target->>'contentDigest' IS DISTINCT FROM v_digest THEN RAISE EXCEPTION 'PUBLISH_CASH_CONTENT_MISMATCH';END IF;
 -- Available balance includes all active video holds. The wallet trigger remains authoritative.
 IF public.read_publish_cash_available(p_actor)<(v_quote_target->>'chargeCents')::bigint THEN RAISE EXCEPTION 'PUBLISH_CASH_INSUFFICIENT';END IF;
 PERFORM public.apply_wallet_operation_atomic(p_actor,'cash_charge','publishing-cash:'||v_id::text,(v_quote_target->>'chargeCents')::numeric/100,'多平台发布：每目标账号一次执行',jsonb_build_object('publishingCashAdmissionId',v_id,'executionKind',v_kind,'operationId',v_operation,'targetId',v_target_id,'priceVersionId',v_quote_target->>'priceVersionId','quoteHash',v_proof->>'quoteHash'));
 SELECT * INTO v_wallet FROM public.wallet_operations WHERE user_id=p_actor AND operation_kind='cash_charge' AND idempotency_key='publishing-cash:'||v_id::text AND status='completed' AND wallet='cash' AND amount=(v_quote_target->>'chargeCents')::numeric/100 AND delta=-(v_quote_target->>'chargeCents')::numeric/100;
 IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_CASH_CHARGE_UNCONFIRMED';END IF;
 INSERT INTO public.pub_cash_admissions(id,owner_id,execution_kind,operation_id,target_id,account_id,account_kind,content_digest,snapshot_hash,quote_hash,quote_proof,price_version_id,charge_cents,charge_wallet_operation_id)
 VALUES(v_id,p_actor,v_kind,v_operation,v_target_id,v_account,v_account_kind,v_digest,p_request->>'snapshotHash',v_proof->>'quoteHash',v_proof,(v_quote_target->>'priceVersionId')::uuid,(v_quote_target->>'chargeCents')::integer,v_wallet.id);
 RETURN v_id;
END $$;

ALTER TABLE public.pub2_attempts ALTER COLUMN entitlement_id DROP NOT NULL;
ALTER TABLE public.pub2_attempts ADD COLUMN cash_admission_id uuid;
ALTER TABLE public.pub2_attempts ADD CONSTRAINT pub2_cash_owner_fk FOREIGN KEY(user_id,cash_admission_id) REFERENCES public.pub_cash_admissions(owner_id,id);
ALTER TABLE public.pub2_attempts ADD CONSTRAINT pub2_funding_xor CHECK((entitlement_id IS NOT NULL)<>(cash_admission_id IS NOT NULL));
ALTER TABLE public.pub3_operations ADD COLUMN cash_admission_id uuid;
ALTER TABLE public.pub3_operations ADD CONSTRAINT pub3_cash_owner_fk FOREIGN KEY(owner_id,cash_admission_id) REFERENCES public.pub_cash_admissions(owner_id,id);
ALTER TABLE public.pub3_operations ADD CONSTRAINT pub3_funding_xor CHECK((kind='publish' AND ((entitlement_id IS NOT NULL)<>(cash_admission_id IS NOT NULL))) OR (kind<>'publish' AND cash_admission_id IS NULL));
ALTER TABLE public.pub5_targets ADD COLUMN cash_admission_id uuid;
ALTER TABLE public.pub5_targets ADD CONSTRAINT pub5_cash_owner_fk FOREIGN KEY(owner_id,cash_admission_id) REFERENCES public.pub_cash_admissions(owner_id,id);
DO $$DECLARE v_name text;v_count integer:=0;BEGIN
 FOR v_name IN SELECT conname FROM pg_constraint WHERE conrelid='public.pub5_targets'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%NOT admitted%entitlement_id IS NOT NULL%' LOOP
  EXECUTE format('ALTER TABLE public.pub5_targets DROP CONSTRAINT %I',v_name);v_count:=v_count+1;
 END LOOP;
 IF v_count<>1 THEN RAISE EXCEPTION 'PUBLISH_CASH_FORWARD_DRIFT';END IF;
END $$;
ALTER TABLE public.pub5_targets ADD CONSTRAINT pub5_funding_xor CHECK((NOT admitted AND entitlement_id IS NULL AND cash_admission_id IS NULL) OR (admitted AND ((entitlement_id IS NOT NULL)<>(cash_admission_id IS NOT NULL))));

CREATE FUNCTION public.refund_publish_cash_unissued_atomic(p_actor text,p_admission uuid,p_expected_revision integer,p_evidence jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_cash public.pub_cash_admissions%ROWTYPE;v_wallet public.wallet_operations%ROWTYPE;v_allowed boolean:=false;
BEGIN
 PERFORM public.pub_assert_actor(p_actor);
 -- Lock the original operation before its immutable admission, matching claim/consume.
 SELECT * INTO v_cash FROM public.pub_cash_admissions WHERE owner_id=p_actor AND id=p_admission;
 IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_CASH_ADMISSION_NOT_FOUND';END IF;
 IF v_cash.execution_kind='v3' THEN PERFORM 1 FROM public.pub3_operations WHERE owner_id=p_actor AND id=v_cash.operation_id FOR UPDATE;
 ELSIF v_cash.execution_kind='v5' THEN PERFORM 1 FROM public.pub5_operations WHERE owner_id=p_actor AND id=v_cash.operation_id FOR UPDATE;PERFORM 1 FROM public.pub5_targets WHERE owner_id=p_actor AND id=v_cash.target_id FOR UPDATE;
 ELSE RAISE EXCEPTION 'PUBLISH_CASH_NOT_UNISSUED';END IF;
 SELECT * INTO v_cash FROM public.pub_cash_admissions WHERE owner_id=p_actor AND id=p_admission FOR UPDATE;
 IF v_cash.state='refunded' THEN RETURN public.pub_cash_admission_dto(v_cash);END IF;
 IF v_cash.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT';END IF;
 IF v_cash.execution_kind='v3' THEN
  SELECT NOT o.grant_used AND o.dispatch_state='blocked' AND o.outcome='pending' AND o.error_code IN ('NATIVE_ACCOUNT_DISCONNECTED','PUBLISH_CASH_NOT_DISPATCHED') AND o.provider_record_id IS NULL AND o.provider_task_id IS NULL AND o.work_id IS NULL AND o.work_link IS NULL AND NOT EXISTS(SELECT 1 FROM public.pub3_events e WHERE e.operation_id=o.id AND e.kind='provider_attempt') INTO v_allowed FROM public.pub3_operations o WHERE o.id=v_cash.operation_id AND o.owner_id=p_actor AND o.cash_admission_id=v_cash.id FOR UPDATE;
 ELSIF v_cash.execution_kind='v5' THEN
  SELECT NOT o.grant_used AND o.state IN ('prepared','dispatching') AND NOT EXISTS(SELECT 1 FROM public.pub5_events e WHERE e.operation_id=o.id AND e.kind IN ('provider_attempt','provider_result','unknown')) INTO v_allowed FROM public.pub5_operations o JOIN public.pub5_targets t ON t.operation_id=o.id AND t.owner_id=o.owner_id WHERE o.id=v_cash.operation_id AND o.owner_id=p_actor AND t.id=v_cash.target_id AND t.cash_admission_id=v_cash.id AND t.admitted AND NOT t.released FOR UPDATE OF o,t;
 END IF;
 IF v_allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'PUBLISH_CASH_NOT_UNISSUED';END IF;
 SELECT * INTO v_wallet FROM public.wallet_operations WHERE id=v_cash.charge_wallet_operation_id AND user_id=p_actor AND wallet='cash' AND operation_kind='cash_charge' AND status='completed' AND amount=v_cash.charge_cents::numeric/100 AND delta=-v_cash.charge_cents::numeric/100 AND idempotency_key='publishing-cash:'||v_cash.id::text;
 IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_CASH_CHARGE_UNCONFIRMED';END IF;
 PERFORM public.apply_wallet_operation_atomic(p_actor,'cash_refund','publishing-cash-refund:'||v_cash.id::text,v_cash.charge_cents::numeric/100,'发布尚未向平台派发，原款退回',jsonb_build_object('publishingCashAdmissionId',v_cash.id,'originalChargeOperationId',v_wallet.id));
 SELECT * INTO v_wallet FROM public.wallet_operations WHERE user_id=p_actor AND wallet='cash' AND operation_kind='cash_refund' AND status='completed' AND idempotency_key='publishing-cash-refund:'||v_cash.id::text AND amount=v_cash.charge_cents::numeric/100 AND delta=v_cash.charge_cents::numeric/100;
 IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_CASH_REFUND_UNCONFIRMED';END IF;
 UPDATE public.pub_cash_admissions SET state='refunded',refund_wallet_operation_id=v_wallet.id,refunded_at=now(),revision=revision+1 WHERE id=v_cash.id RETURNING * INTO v_cash;
 RETURN public.pub_cash_admission_dto(v_cash);
END $$;

CREATE TABLE public.pub_cash_forward_backups(signature text PRIMARY KEY,definition text NOT NULL,definition_hash text NOT NULL);
CREATE TEMP TABLE pub_cash_patch_stage(signature text PRIMARY KEY,definition text NOT NULL) ON COMMIT DROP;
CREATE FUNCTION pg_temp.pub_cash_patch(p_signature text,p_old text,p_new text,p_count integer DEFAULT 1) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_definition text;v_matches integer;
BEGIN
 SELECT definition INTO v_definition FROM pg_temp.pub_cash_patch_stage WHERE signature=p_signature;
 IF NOT FOUND THEN SELECT pg_get_functiondef(p_signature::regprocedure) INTO v_definition;END IF;
 INSERT INTO public.pub_cash_forward_backups VALUES(p_signature,v_definition,encode(sha256(convert_to(v_definition,'UTF8')),'hex')) ON CONFLICT DO NOTHING;
 v_matches:=(length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old);
 IF v_matches<>p_count THEN RAISE EXCEPTION 'PUBLISH_CASH_FORWARD_DRIFT: % expected % found %',p_signature,p_count,v_matches;END IF;
 INSERT INTO pg_temp.pub_cash_patch_stage(signature,definition) VALUES(p_signature,replace(v_definition,p_old,p_new)) ON CONFLICT(signature) DO UPDATE SET definition=EXCLUDED.definition;
END $$;

SELECT pg_temp.pub_cash_patch('public.pub2_assert_input_shape(jsonb)',
 $old$WHEN 'claim' THEN required:=ARRAY['action','batchId','targetId','entitlementId','idempotencyKey'];$old$,
 $new$WHEN 'claim' THEN required:=ARRAY['action','batchId','targetId','idempotencyKey']||CASE WHEN p_input ? 'funding' THEN ARRAY['funding','cashContentCanonical'] ELSE ARRAY['entitlementId'] END;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_publish_v2_atomic(text,jsonb)',$old$v_cover jsonb;$old$,$new$v_cover jsonb; v_cash uuid;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_publish_v2_atomic(text,jsonb)',$old$PERFORM public.pub_assert_actor(p_user_id);$old$,$new$PERFORM public.pub_assert_actor(p_user_id); IF p_input ? 'funding' THEN PERFORM 1 FROM public.pub_cash_price_head WHERE singleton FOR SHARE; END IF;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_publish_v2_atomic(text,jsonb)',
 $old$SELECT * INTO v_ent FROM public.pub_entitlements WHERE id=(p_input->>'entitlementId')::uuid AND user_id=p_user_id FOR UPDATE;$old$,
 $new$IF NOT (p_input ? 'funding') THEN SELECT * INTO v_ent FROM public.pub_entitlements WHERE id=(p_input->>'entitlementId')::uuid AND user_id=p_user_id FOR UPDATE;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_publish_v2_atomic(text,jsonb)',
 $old$IF NOT (v_ent.platforms ? (v_target->>'platform')) THEN RAISE EXCEPTION 'PUBLISH_PLATFORM_NOT_ALLOWED'; END IF;$old$,
 $new$IF NOT (v_ent.platforms ? (v_target->>'platform')) THEN RAISE EXCEPTION 'PUBLISH_PLATFORM_NOT_ALLOWED'; END IF; END IF;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_publish_v2_atomic(text,jsonb)',
 $old$UPDATE public.pub_entitlements SET used=used+1 WHERE id=v_ent.id;$old$,
 $new$IF p_input ? 'funding' THEN v_cash:=public.claim_publish_cash_target_atomic(p_user_id,jsonb_build_object('executionKind','v2','operationId',v_batch.id,'targetId',p_input->>'targetId','funding',p_input->'funding','contentCanonical',p_input->>'cashContentCanonical','snapshotHash',encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex'),'scheduleId',p_input->'scheduleId')); ELSE UPDATE public.pub_entitlements SET used=used+1 WHERE id=v_ent.id; END IF;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_publish_v2_atomic(text,jsonb)',
 $old$INSERT INTO public.pub2_attempts(user_id,batch_id,target_id,entitlement_id,platform,snapshot,snapshot_hash,request_key,fingerprint) VALUES(p_user_id,v_batch.id,(p_input->>'targetId')::uuid,v_ent.id,$old$,
 $new$INSERT INTO public.pub2_attempts(user_id,batch_id,target_id,entitlement_id,cash_admission_id,platform,snapshot,snapshot_hash,request_key,fingerprint) VALUES(p_user_id,v_batch.id,(p_input->>'targetId')::uuid,v_ent.id,v_cash,$new$);

SELECT pg_temp.pub_cash_patch('public.pub3_assert_input(jsonb)',
 $old$WHEN 'submit' THEN r:=ARRAY['action','connectionId','operationId','intentId','intentRevision','entitlementId','flowId','requestKey','requestHash','snapshot','providerRequestHash'];$old$,
 $new$WHEN 'submit' THEN r:=ARRAY['action','connectionId','operationId','intentId','intentRevision','flowId','requestKey','requestHash','snapshot','providerRequestHash']||CASE WHEN p ? 'funding' THEN ARRAY['funding','cashContentCanonical'] ELSE ARRAY['entitlementId'] END;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_publish_v3_media_v1_atomic(text,jsonb)',$old$inserted boolean;$old$,$new$inserted boolean; v_cash uuid;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_publish_v3_media_v1_atomic(text,jsonb)',$old$PERFORM public.pub_assert_actor(p_user_id);$old$,$new$PERFORM public.pub_assert_actor(p_user_id); IF p_input ? 'funding' THEN PERFORM 1 FROM public.pub_cash_price_head WHERE singleton FOR SHARE; END IF;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_publish_v3_media_v1_atomic(text,jsonb)',
 $old$SELECT * INTO ent FROM public.pub_entitlements WHERE id=(p_input->>'entitlementId')::uuid AND user_id=p_user_id FOR UPDATE;$old$,
 $new$IF p_input ? 'funding' THEN v_cash:=public.claim_publish_cash_target_atomic(p_user_id,jsonb_build_object('executionKind','v3','operationId',p_input->>'operationId','targetId',p_input->>'operationId','subjectId',intent.id,'funding',p_input->'funding','contentCanonical',p_input->>'cashContentCanonical','snapshotHash',encode(sha256(convert_to(input_snapshot::text,'UTF8')),'hex'))); ELSE SELECT * INTO ent FROM public.pub_entitlements WHERE id=(p_input->>'entitlementId')::uuid AND user_id=p_user_id FOR UPDATE;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_publish_v3_media_v1_atomic(text,jsonb)',
 $old$UPDATE public.pub_entitlements SET used=used+1 WHERE id=ent.id;$old$,
 $new$UPDATE public.pub_entitlements SET used=used+1 WHERE id=ent.id; END IF;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_publish_v3_media_v1_atomic(text,jsonb)',
 $old$flow_id,entitlement_id,intent_revision) VALUES($old$,$new$flow_id,entitlement_id,cash_admission_id,intent_revision) VALUES($new$);
SELECT pg_temp.pub_cash_patch('public.mutate_publish_v3_media_v1_atomic(text,jsonb)',
 $old$CASE WHEN v_kind='publish' THEN ent.id ELSE NULL END,CASE WHEN v_kind='publish' THEN intent.revision ELSE NULL END)$old$,
 $new$CASE WHEN v_kind='publish' THEN ent.id ELSE NULL END,v_cash,CASE WHEN v_kind='publish' THEN intent.revision ELSE NULL END)$new$);

SELECT pg_temp.pub_cash_patch('public.mutate_native_official_atomic(text,jsonb)',$old$v_change text;BEGIN$old$,$new$v_change text;v_cash uuid;BEGIN$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_native_official_atomic(text,jsonb)',$old$PERFORM public.pub_assert_actor(p_user_id);$old$,$new$PERFORM public.pub_assert_actor(p_user_id); IF p_input ? 'funding' THEN PERFORM 1 FROM public.pub_cash_price_head WHERE singleton FOR SHARE; END IF;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_native_official_atomic(text,jsonb)',
 $old$PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','namespace','operationId','expectedRevision','snapshotHash','dispatchId'],ARRAY['action','namespace','operationId','expectedRevision','snapshotHash','dispatchId']);$old$,
 $new$PERFORM public.pub2_assert_json_keys(p_input,ARRAY['action','namespace','operationId','expectedRevision','snapshotHash','dispatchId','funding','cashContents'],ARRAY['action','namespace','operationId','expectedRevision','snapshotHash','dispatchId']); IF (p_input ? 'funding') IS DISTINCT FROM (p_input ? 'cashContents') THEN RAISE EXCEPTION 'PUBLISH_CASH_INPUT_INVALID';END IF;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_native_official_atomic(text,jsonb)',
 $old$SELECT * INTO e FROM public.pub_entitlements WHERE user_id=p_user_id AND expires_at>now() AND platforms ? t.platform AND used<quota ORDER BY expires_at,id LIMIT 1 FOR UPDATE;$old$,
 $new$IF p_input ? 'funding' THEN
     v_cash:=public.claim_publish_cash_target_atomic(p_user_id,jsonb_build_object('executionKind','v5','operationId',o.id,'targetId',t.id,'funding',p_input->'funding','contentCanonical',p_input->'cashContents'->>t.id::text,'snapshotHash',o.snapshot_hash));
     UPDATE public.pub5_targets SET admitted=true,cash_admission_id=v_cash,revision=revision+1,updated_at=now() WHERE id=t.id;
    ELSE SELECT * INTO e FROM public.pub_entitlements WHERE user_id=p_user_id AND expires_at>now() AND platforms ? t.platform AND used<quota ORDER BY expires_at,id LIMIT 1 FOR UPDATE;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_native_official_atomic(text,jsonb)',
 $old$UPDATE public.pub5_targets SET admitted=true,entitlement_id=e.id,revision=revision+1,updated_at=now() WHERE id=t.id;$old$,
 $new$UPDATE public.pub5_targets SET admitted=true,entitlement_id=e.id,revision=revision+1,updated_at=now() WHERE id=t.id; END IF;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_native_official_atomic(text,jsonb)',
 $old$SELECT * INTO e FROM public.pub_entitlements WHERE id=t.entitlement_id AND user_id=p_user_id FOR UPDATE;$old$,
 $new$IF t.cash_admission_id IS NOT NULL THEN
     PERFORM public.refund_publish_cash_unissued_atomic(p_user_id,t.cash_admission_id,(SELECT revision FROM public.pub_cash_admissions WHERE id=t.cash_admission_id),'{}');
    ELSE SELECT * INTO e FROM public.pub_entitlements WHERE id=t.entitlement_id AND user_id=p_user_id FOR UPDATE;$new$);
SELECT pg_temp.pub_cash_patch('public.mutate_native_official_atomic(text,jsonb)',
 $old$UPDATE public.pub_entitlements SET used=used-1 WHERE id=e.id;$old$,
 $new$UPDATE public.pub_entitlements SET used=used-1 WHERE id=e.id; END IF;$new$);
SELECT pg_temp.pub_cash_patch('public.pub5_history_guard()',
 $old$ARRAY['state','revision','entitlement_id','admitted','released','publish_at','provider_record_id','provider_task_id','work_id','work_link','error_code','updated_at']$old$,
 $new$ARRAY['state','revision','entitlement_id','cash_admission_id','admitted','released','publish_at','provider_record_id','provider_task_id','work_id','work_link','error_code','updated_at']$new$,2);
SELECT pg_temp.pub_cash_patch('public.native_release_unissued_quota_on_blocked()',
 $old$PERFORM public.release_native_unissued_quota_atomic(NEW.owner_id,NEW.operation_id,v_revision);$old$,
 $new$IF EXISTS(SELECT 1 FROM public.pub3_operations WHERE id=NEW.operation_id AND owner_id=NEW.owner_id AND cash_admission_id IS NOT NULL) THEN
   PERFORM public.refund_publish_cash_unissued_atomic(NEW.owner_id,a.id,a.revision,'{}') FROM public.pub_cash_admissions a JOIN public.pub3_operations o ON o.cash_admission_id=a.id AND o.owner_id=a.owner_id WHERE o.id=NEW.operation_id AND o.owner_id=NEW.owner_id;
  ELSE PERFORM public.release_native_unissued_quota_atomic(NEW.owner_id,NEW.operation_id,v_revision); END IF;$new$);

-- Compile each complete function once; paired IF/END IF edits are never executed halfway.
DO $$DECLARE item record;BEGIN
 FOR item IN SELECT signature,definition FROM pg_temp.pub_cash_patch_stage ORDER BY signature LOOP EXECUTE item.definition;END LOOP;
END $$;

CREATE FUNCTION public.pub_cash_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$BEGIN
 IF TG_OP='DELETE' OR TG_TABLE_NAME IN ('pub_cash_price_versions','pub_cash_price_requests','pub_cash_forward_backups') THEN RAISE EXCEPTION 'PUBLISH_CASH_HISTORY_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='pub_cash_admissions' THEN
  IF (to_jsonb(NEW)-ARRAY['state','revision','refund_wallet_operation_id','refunded_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','refund_wallet_operation_id','refunded_at']) OR OLD.state<>'charged' OR NEW.state<>'refunded' OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'PUBLISH_CASH_HISTORY_IMMUTABLE';END IF;
 ELSIF TG_TABLE_NAME='pub3_operations' THEN
  IF NEW.cash_admission_id IS DISTINCT FROM OLD.cash_admission_id THEN RAISE EXCEPTION 'PUBLISH_CASH_HISTORY_IMMUTABLE';END IF;
  IF OLD.cash_admission_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.pub_cash_admissions WHERE id=OLD.cash_admission_id AND state='refunded') AND (NEW.grant_used OR NEW.dispatch_state<>'blocked' OR NEW.provider_record_id IS NOT NULL OR NEW.provider_task_id IS NOT NULL) THEN RAISE EXCEPTION 'PUBLISH_CASH_REFUNDED';END IF;
 ELSIF TG_TABLE_NAME='pub5_targets' THEN
  IF NEW.cash_admission_id IS DISTINCT FROM OLD.cash_admission_id AND (OLD.admitted OR OLD.cash_admission_id IS NOT NULL OR NOT NEW.admitted OR NEW.cash_admission_id IS NULL) THEN RAISE EXCEPTION 'PUBLISH_CASH_HISTORY_IMMUTABLE';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.pub_cash_reference_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_cash public.pub_cash_admissions%ROWTYPE;v_ok boolean;
BEGIN
 IF TG_TABLE_NAME='pub_cash_admissions' THEN v_cash:=NEW;ELSE SELECT * INTO v_cash FROM public.pub_cash_admissions WHERE id=NEW.cash_admission_id;IF NOT FOUND THEN RETURN NEW;END IF;END IF;
 IF v_cash.execution_kind='v2' THEN SELECT EXISTS(SELECT 1 FROM public.pub2_attempts a WHERE a.user_id=v_cash.owner_id AND a.batch_id=v_cash.operation_id AND a.target_id=v_cash.target_id AND a.cash_admission_id=v_cash.id AND a.entitlement_id IS NULL AND a.snapshot_hash=v_cash.snapshot_hash) INTO v_ok;
 ELSIF v_cash.execution_kind='v3' THEN SELECT EXISTS(SELECT 1 FROM public.pub3_operations o WHERE o.owner_id=v_cash.owner_id AND o.id=v_cash.operation_id AND o.kind='publish' AND o.id=v_cash.target_id AND o.cash_admission_id=v_cash.id AND o.entitlement_id IS NULL AND o.snapshot_hash=v_cash.snapshot_hash) INTO v_ok;
 ELSE SELECT EXISTS(SELECT 1 FROM public.pub5_targets t JOIN public.pub5_operations o ON o.id=t.operation_id AND o.owner_id=t.owner_id WHERE t.owner_id=v_cash.owner_id AND t.operation_id=v_cash.operation_id AND t.id=v_cash.target_id AND t.cash_admission_id=v_cash.id AND t.entitlement_id IS NULL AND t.admitted AND o.snapshot_hash=v_cash.snapshot_hash) INTO v_ok;END IF;
 IF v_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'PUBLISH_CASH_REFERENCE_MISMATCH';END IF;
 RETURN NEW;
END $$;
DO $$DECLARE v_table text;BEGIN
 FOREACH v_table IN ARRAY ARRAY['pub_cash_price_versions','pub_cash_price_requests','pub_cash_forward_backups','pub_cash_admissions','pub3_operations','pub5_targets'] LOOP
  EXECUTE format('CREATE TRIGGER pub_cash_history BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.pub_cash_history_guard()',v_table);
 END LOOP;
 FOREACH v_table IN ARRAY ARRAY['pub_cash_admissions','pub2_attempts','pub3_operations','pub5_targets'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER pub_cash_reference AFTER INSERT OR UPDATE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pub_cash_reference_guard()',v_table);
 END LOOP;
END $$;

CREATE FUNCTION public.resume_native_schedule_cash_atomic(p_owner text,p_schedule uuid,p_expected_revision integer,p_request_key text,p_funding jsonb,p_content_canonical text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.pub2_schedules%ROWTYPE;a public.pub2_attempts%ROWTYPE;c public.pub_cash_admissions%ROWTYPE;b jsonb;BEGIN
 PERFORM public.pub_assert_actor(p_owner);PERFORM 1 FROM public.pub_cash_price_head WHERE singleton FOR SHARE;
 SELECT * INTO s FROM public.pub2_schedules WHERE id=p_schedule AND user_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_NOT_FOUND';END IF;
 SELECT * INTO a FROM public.pub2_attempts WHERE user_id=p_owner AND request_key=p_request_key;
 IF FOUND THEN
  SELECT * INTO c FROM public.pub_cash_admissions WHERE id=a.cash_admission_id AND owner_id=p_owner;
  IF a.snapshot->'localSchedule'->>'id' IS DISTINCT FROM p_schedule::text OR c.id IS NULL OR c.quote_proof IS DISTINCT FROM p_funding->'proof' OR c.content_digest IS DISTINCT FROM encode(sha256(convert_to(p_content_canonical,'UTF8')),'hex') THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT';END IF;
  RETURN jsonb_build_object('kind','attempt','row',to_jsonb(a),'shouldExecute',false,'alreadyFulfilled',true);
 END IF;
 IF s.state<>'planned' OR s.revision IS DISTINCT FROM p_expected_revision OR s.scheduled_at>now() THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_LOCKED';END IF;
 b:=public.mutate_publish_v2_atomic(p_owner,jsonb_build_object('action','create-batch','draftId',s.draft_id,'draftVersion',s.draft_version,'targetIds',jsonb_build_array(s.target_id),'idempotencyKey','studio-resume-batch:'||s.id::text));
 RETURN public.mutate_publish_v2_atomic(p_owner,jsonb_build_object('action','claim','batchId',b->'row'->>'id','targetId',s.target_id,'funding',p_funding,'cashContentCanonical',p_content_canonical,'scheduleId',s.id,'idempotencyKey',p_request_key));
END $$;

CREATE FUNCTION public.block_publish_cash_unissued_atomic(p_actor text,p_operation uuid,p_expected_revision integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.pub3_operations%ROWTYPE;c public.pub_cash_admissions%ROWTYPE;BEGIN
 PERFORM public.pub_assert_actor(p_actor);
 SELECT * INTO o FROM public.pub3_operations WHERE id=p_operation AND owner_id=p_actor FOR UPDATE;
 IF NOT FOUND OR o.kind<>'publish' OR o.cash_admission_id IS NULL THEN RAISE EXCEPTION 'PUBLISH_CASH_ADMISSION_NOT_FOUND';END IF;
 IF o.dispatch_state='blocked' AND NOT o.grant_used THEN RETURN to_jsonb(o);END IF;
 IF o.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT';END IF;
 IF o.grant_used OR o.dispatch_state NOT IN ('ready','dispatching','unknown') OR o.outcome NOT IN ('pending','unknown') OR o.provider_record_id IS NOT NULL OR o.provider_task_id IS NOT NULL OR o.work_id IS NOT NULL OR o.work_link IS NOT NULL OR EXISTS(SELECT 1 FROM public.pub3_events WHERE operation_id=o.id AND kind='provider_attempt') THEN RAISE EXCEPTION 'PUBLISH_CASH_NOT_UNISSUED';END IF;
 UPDATE public.pub3_operations SET dispatch_state='blocked',outcome='pending',error_code='PUBLISH_CASH_NOT_DISPATCHED',revision=revision+1,updated_at=now() WHERE id=o.id RETURNING * INTO o;
 SELECT * INTO c FROM public.pub_cash_admissions WHERE id=o.cash_admission_id AND owner_id=p_actor;
 PERFORM public.refund_publish_cash_unissued_atomic(p_actor,c.id,c.revision,'{}');
 INSERT INTO public.pub3_events(owner_id,operation_id,kind,source,safe_payload) VALUES(p_actor,o.id,'blocked','system',jsonb_build_object('status','blocked','errorCode','PUBLISH_CASH_NOT_DISPATCHED'));
 RETURN to_jsonb(o);
END $$;

CREATE FUNCTION public.pub_cash_consume_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT OLD.grant_used AND NEW.grant_used AND NEW.kind='publish' THEN
  IF TG_TABLE_NAME='pub3_operations' THEN
   IF NEW.cash_admission_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.pub_cash_admissions c WHERE c.id=NEW.cash_admission_id AND c.owner_id=NEW.owner_id AND c.execution_kind='v3' AND c.operation_id=NEW.id AND c.target_id=NEW.id AND c.snapshot_hash=NEW.snapshot_hash AND c.state='charged') THEN RAISE EXCEPTION 'PUBLISH_CASH_REFUNDED';END IF;
  ELSE
   IF EXISTS(SELECT 1 FROM public.pub5_targets t LEFT JOIN public.pub_cash_admissions c ON c.id=t.cash_admission_id AND c.owner_id=t.owner_id WHERE t.operation_id=NEW.id AND t.owner_id=NEW.owner_id AND (NOT t.admitted OR t.released OR t.cash_admission_id IS NOT NULL AND (c.id IS NULL OR c.state<>'charged' OR c.execution_kind<>'v5' OR c.operation_id<>NEW.id OR c.target_id<>t.id OR c.snapshot_hash<>NEW.snapshot_hash))) THEN RAISE EXCEPTION 'PUBLISH_CASH_REFUNDED';END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pub_cash_consume BEFORE UPDATE ON public.pub3_operations FOR EACH ROW EXECUTE FUNCTION public.pub_cash_consume_guard();
CREATE TRIGGER pub_cash_consume BEFORE UPDATE ON public.pub5_operations FOR EACH ROW EXECUTE FUNCTION public.pub_cash_consume_guard();

DO $$DECLARE item record;BEGIN
 FOR item IN SELECT c.oid::regclass AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('pub_cash_price_versions','pub_cash_price_head','pub_cash_price_requests','pub_cash_admissions','pub_cash_forward_backups') LOOP
  EXECUTE format('ALTER TABLE %s OWNER TO zimeiti_owner',item.name);
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',item.name);
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC,anon,authenticated,service_role',item.name);
 END LOOP;
 FOR item IN SELECT p.oid::regprocedure AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'pub_cash_%' OR p.proname IN ('read_publish_cash_pricing','preview_publish_cash_pricing','read_publish_cash_pricing_receipt','save_publish_cash_pricing_atomic','read_publish_cash_available','quote_publish_cash','claim_publish_cash_target_atomic','refund_publish_cash_unissued_atomic','resume_native_schedule_cash_atomic','block_publish_cash_unissued_atomic')) LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO zimeiti_owner',item.name);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',item.name);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.read_publish_cash_pricing(),public.preview_publish_cash_pricing(text,jsonb),public.read_publish_cash_pricing_receipt(text,text),public.save_publish_cash_pricing_atomic(text,jsonb),public.read_publish_cash_available(text),public.quote_publish_cash(text,jsonb),public.resume_native_schedule_cash_atomic(text,uuid,integer,text,jsonb,text),public.block_publish_cash_unissued_atomic(text,uuid,integer) TO service_role;
COMMIT;
