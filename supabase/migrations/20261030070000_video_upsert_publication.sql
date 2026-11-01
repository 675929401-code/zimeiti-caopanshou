-- Migration 192: video upserts publish only their frozen video targets.
-- Preserve 189 guards and all global projector/delta/ordinary publish semantics.
BEGIN;
DO $precondition$ DECLARE v_proc pg_proc%ROWTYPE; BEGIN
  SELECT * INTO STRICT v_proc FROM pg_proc WHERE oid='public.publish_platform_configuration_release_atomic(text,uuid,uuid,text,uuid,text)'::regprocedure;
  IF pg_get_userbyid(v_proc.proowner) IS DISTINCT FROM 'zimeiti_owner'
    OR v_proc.proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}'
    OR v_proc.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
    OR v_proc.prosecdef IS DISTINCT FROM true OR v_proc.provolatile IS DISTINCT FROM 'v'
    OR v_proc.proparallel IS DISTINCT FROM 'u' OR v_proc.proisstrict IS DISTINCT FROM false OR v_proc.proleakproof IS DISTINCT FROM false
    OR v_proc.prokind IS DISTINCT FROM 'f' OR v_proc.prorettype IS DISTINCT FROM 'jsonb'::regtype
    OR (SELECT lanname FROM pg_language WHERE oid=v_proc.prolang) IS DISTINCT FROM 'plpgsql'
    OR encode(sha256(convert_to(v_proc.prosrc,'UTF8')),'hex') IS DISTINCT FROM 'e20c16d0af33624896dd0138ce5227c2c208021112242bf1c52a1704e52d9a74' THEN
    RAISE EXCEPTION 'VIDEO_UPSERT_PUBLISH_PRECONDITION_FAILED';
  END IF;
END $precondition$;
DO $column$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='video_models' AND column_name='icon_url' AND data_type<>'text') THEN
    RAISE EXCEPTION 'VIDEO_UPSERT_ICON_COLUMN_TYPE_INVALID';
  END IF;
END $column$;
ALTER TABLE public.video_models ADD COLUMN IF NOT EXISTS icon_url text;
CREATE OR REPLACE FUNCTION public.publish_platform_configuration_release_atomic(p_kind text, p_release_id uuid, p_actor_id uuid, p_expected_candidate_sha256 text, p_expected_current_id uuid, p_expected_current_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_candidate record; v_current record; v_has_current boolean; v_pending record; v_active record; v_exists boolean; v_result jsonb;
  v_video_upsert boolean := false; v_targets text[] := ARRAY[]::text[];
  v_pair record; v_model jsonb; v_old jsonb; v_physical public.video_models%ROWTYPE;
  v_protocol jsonb; v_gate jsonb; v_key text; v_is_new boolean; v_binding_changed boolean; v_field record; v_requested_protocol jsonb; v_old_protocol jsonb; v_requested_model jsonb;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('model-pool','workspace-models') OR p_actor_id IS NULL OR p_release_id IS NULL OR p_expected_candidate_sha256 IS NULL OR p_expected_candidate_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_PUBLISH_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-configuration-publish:model-pool',0));
  IF p_kind='workspace-models' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('platform-configuration-publish:workspace-models',0));
    RETURN public.publish_platform_configuration_release_before_pending_credentials(p_kind,p_release_id,p_actor_id,p_expected_candidate_sha256,p_expected_current_id,p_expected_current_sha256);
  END IF;
  SELECT * INTO v_current FROM public.model_pool_config_releases WHERE is_current FOR UPDATE; v_has_current:=FOUND;
  SELECT * INTO v_candidate FROM public.model_pool_config_releases WHERE id=p_release_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_RELEASE_NOT_FOUND'; END IF;
  IF v_candidate.snapshot_sha256 IS DISTINCT FROM p_expected_candidate_sha256 THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CANDIDATE_CHANGED'; END IF;
  IF v_candidate.is_current AND v_candidate.status='published' THEN RETURN to_jsonb(v_candidate); END IF;
  IF v_candidate.status='superseded' THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_ALREADY_PUBLISHED_NOT_CURRENT'; END IF;
  IF v_candidate.status<>'validated' OR v_candidate.is_current THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_RELEASE_NOT_VALIDATED'; END IF;
  IF (NOT v_has_current AND (p_expected_current_id IS NOT NULL OR p_expected_current_sha256 IS NOT NULL))
    OR (v_has_current AND (v_current.id IS DISTINCT FROM p_expected_current_id OR v_current.snapshot_sha256 IS DISTINCT FROM p_expected_current_sha256)) THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CURRENT_CHANGED';
  END IF;
  -- A pending credential is bound to the model-pool identity on which it was staged.
  -- Re-previewing a later current does not rebase that immutable candidate.
  IF EXISTS (SELECT 1 FROM public.platform_model_pending_credentials WHERE release_id=p_release_id AND state='pending')
    AND v_candidate.parent_release_id IS DISTINCT FROM (CASE WHEN v_has_current THEN v_current.id ELSE NULL END) THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_CANDIDATE_BASE_CHANGED';
  END IF;
  -- A strict unchanged subset projects only removals, not surviving credentials.
  -- Reject this own-candidate combination before any active binding promotion.
  IF v_has_current
    AND EXISTS (SELECT 1 FROM public.platform_model_pending_credentials WHERE release_id=p_release_id AND state='pending')
    AND jsonb_typeof(v_current.snapshot->'models') = 'array'
    AND jsonb_typeof(v_candidate.snapshot->'models') = 'array'
    AND jsonb_array_length(v_candidate.snapshot->'models') < jsonb_array_length(v_current.snapshot->'models')
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_candidate.snapshot->'models') next(model)
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_current.snapshot->'models') old(model)
        WHERE old.model = next.model
      )
    ) THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_REMOVAL_COMBINATION_REJECTED';
  END IF;
  -- Verify every expected revision first, before changing any active binding.
  FOR v_pending IN SELECT * FROM public.platform_model_pending_credentials WHERE release_id=p_release_id ORDER BY model_key FOR UPDATE LOOP
    IF v_pending.state<>'pending' THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_PENDING_CREDENTIAL_STATE_INVALID'; END IF;
    SELECT * INTO v_active FROM public.platform_model_credential_bindings WHERE model_key=v_pending.model_key FOR UPDATE; v_exists:=FOUND;
    IF v_exists IS DISTINCT FROM v_pending.expected_exists OR (v_exists AND (v_active.revision IS DISTINCT FROM v_pending.expected_revision OR v_active.credential_ref IS DISTINCT FROM v_pending.credential_ref)) THEN
      RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT';
    END IF;
  END LOOP;
  IF jsonb_typeof(v_candidate.snapshot) IS DISTINCT FROM 'object' OR jsonb_typeof(v_candidate.snapshot->'models') IS DISTINCT FROM 'array'
    OR (v_has_current AND (jsonb_typeof(v_current.snapshot) IS DISTINCT FROM 'object' OR jsonb_typeof(v_current.snapshot->'models') IS DISTINCT FROM 'array')) THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_MODEL_POOL_SCHEMA_INVALID';
  END IF;
  -- Stable IDs, not array position, define a video upsert. Video operations
  -- must never fall through to a projector that can repair unrelated LLM rows.
  v_video_upsert := v_candidate.validation_result->>'operation'='video-upsert-only'
    OR EXISTS (SELECT 1 FROM public.platform_model_pending_credentials WHERE release_id=p_release_id AND model_key LIKE 'video_models:%')
    OR (v_has_current AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_candidate.snapshot->'models') n
      LEFT JOIN jsonb_array_elements(v_current.snapshot->'models') o ON o->>'id'=n->>'id'
      WHERE (n->>'kind'='video' OR n #>> '{configuration,legacyTable}'='video_models') AND n IS DISTINCT FROM o));
  IF v_video_upsert THEN
    IF NOT v_has_current OR v_candidate.parent_release_id IS DISTINCT FROM v_current.id
      OR (v_current.snapshot-'models') IS DISTINCT FROM (v_candidate.snapshot-'models') THEN
      RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_UPSERT_BASE_INVALID';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_current.snapshot->'models') m WHERE jsonb_typeof(m) IS DISTINCT FROM 'object' OR coalesce(m->>'id','')='' OR coalesce(m #>> '{configuration,legacyTable}','')='' OR coalesce(m #>> '{configuration,legacyId}','')='')
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_candidate.snapshot->'models') m WHERE jsonb_typeof(m) IS DISTINCT FROM 'object' OR coalesce(m->>'id','')='' OR coalesce(m #>> '{configuration,legacyTable}','')='' OR coalesce(m #>> '{configuration,legacyId}','')='')
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_current.snapshot->'models') m GROUP BY m #>> '{configuration,legacyTable}',m #>> '{configuration,legacyId}' HAVING count(*)<>1)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_candidate.snapshot->'models') m GROUP BY m #>> '{configuration,legacyTable}',m #>> '{configuration,legacyId}' HAVING count(*)<>1)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_current.snapshot->'models') m GROUP BY m->>'id' HAVING count(*)<>1)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_candidate.snapshot->'models') m GROUP BY m->>'id' HAVING count(*)<>1) THEN
      RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_UPSERT_IDENTITY_INVALID';
    END IF;
    FOR v_pair IN SELECT o AS old_model,n AS next_model
      FROM jsonb_array_elements(v_current.snapshot->'models') o
      FULL JOIN jsonb_array_elements(v_candidate.snapshot->'models') n ON o->>'id'=n->>'id'
    LOOP
      IF v_pair.next_model IS NULL THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_UPSERT_REMOVAL_REJECTED'; END IF;
      IF v_pair.old_model IS NOT DISTINCT FROM v_pair.next_model THEN CONTINUE; END IF;
      v_model:=v_pair.next_model;
      IF v_model->>'kind' IS DISTINCT FROM 'video' OR v_model #>> '{configuration,legacyTable}' IS DISTINCT FROM 'video_models'
        OR coalesce(v_model->>'id','') !~ '^[A-Za-z0-9._-]{1,160}$'
        OR v_model->>'id' IS DISTINCT FROM v_model #>> '{configuration,legacyId}'
        OR (v_pair.old_model IS NOT NULL AND (v_pair.old_model->>'kind' IS DISTINCT FROM 'video'
          OR v_pair.old_model #>> '{configuration,legacyTable}' IS DISTINCT FROM 'video_models'
          OR v_pair.old_model #>> '{configuration,legacyId}' IS DISTINCT FROM v_model->>'id')) THEN
        RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_UPSERT_SCOPE_INVALID';
      END IF;
      v_targets:=array_append(v_targets,v_model->>'id');
    END LOOP;
    FOR v_pending IN SELECT * FROM public.platform_model_pending_credentials WHERE release_id=p_release_id ORDER BY model_key LOOP
      IF v_pending.model_key !~ '^video_models:[A-Za-z0-9._-]{1,160}$'
        OR v_pending.credential_ref IS DISTINCT FROM 'secret://platform-model/video_models/'||substr(v_pending.model_key,14)
        OR (SELECT count(*) FROM jsonb_array_elements(v_candidate.snapshot->'models') m
          WHERE m->>'id'=substr(v_pending.model_key,14) AND m->>'kind'='video'
          AND m #>> '{configuration,legacyTable}'='video_models' AND m #>> '{configuration,legacyId}'=m->>'id'
          AND m->>'credentialRef'=v_pending.credential_ref)<>1 THEN
        RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_UPSERT_CREDENTIAL_INVALID';
      END IF;
      IF NOT substr(v_pending.model_key,14)=ANY(v_targets) THEN v_targets:=array_append(v_targets,substr(v_pending.model_key,14)); END IF;
    END LOOP;
    -- Lock existing targets in fixed order; absence and collision are errors,
    -- never permission to repair a missing existing model or overwrite a new one.
    PERFORM 1 FROM public.video_models WHERE id=ANY(v_targets) ORDER BY id FOR UPDATE;
    FOREACH v_key IN ARRAY v_targets LOOP
      SELECT m INTO v_model FROM jsonb_array_elements(v_candidate.snapshot->'models') m WHERE m->>'id'=v_key;
      SELECT m INTO v_old FROM jsonb_array_elements(v_current.snapshot->'models') m WHERE m->>'id'=v_key;
      v_is_new:=v_old IS NULL;
      SELECT * INTO v_physical FROM public.video_models WHERE id=v_key;
      IF v_is_new AND FOUND THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_UPSERT_NEW_COLLISION'; END IF;
      IF NOT v_is_new AND NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_UPSERT_EXISTING_MISSING'; END IF;
      IF v_model->>'catalogState' IS DISTINCT FROM 'enabled' THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_UPSERT_RETIREMENT_REJECTED'; END IF;
      IF v_is_new AND NOT EXISTS (SELECT 1 FROM public.platform_model_pending_credentials WHERE release_id=p_release_id AND model_key='video_models:'||v_key) THEN
        RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_UPSERT_NEW_CREDENTIAL_REQUIRED';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.platform_model_pending_credentials WHERE release_id=p_release_id AND model_key='video_models:'||v_key)
        AND v_model->'credentialRef' IS DISTINCT FROM v_old->'credentialRef' THEN
        RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_UPSERT_CREDENTIAL_INVALID';
      END IF;
      IF jsonb_typeof(v_model #> '{configuration,protocolConfig}') IS DISTINCT FROM 'object'
        OR (v_model #> '{configuration,protocolConfig}') IS DISTINCT FROM (v_model #> '{capabilities,protocol}') THEN
        RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_UPSERT_PROTOCOL_INVALID';
      END IF;
      v_gate:=v_model #> '{configuration,protocolConfig,__model_activation_gate}';
      IF v_gate IS NOT NULL AND (v_gate->>'schema' IS DISTINCT FROM 'media_model_activation_gate.v1' OR (v_gate->>'state' IS DISTINCT FROM 'pending' AND (v_gate IS DISTINCT FROM v_old #> '{configuration,protocolConfig,__model_activation_gate}' OR v_gate IS DISTINCT FROM v_physical.api_protocol_config->'__model_activation_gate'))) THEN
        RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_UPSERT_GATE_INVALID';
      END IF;
      IF v_is_new AND v_gate IS NULL THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_UPSERT_NEW_GATE_REQUIRED'; END IF;
      IF jsonb_typeof(v_model #> '{pricing,cost}') IS DISTINCT FROM 'number'
        OR jsonb_typeof(v_model #> '{pricing,selling}') IS DISTINCT FROM 'number'
        OR (v_model #>> '{pricing,cost}')::numeric<0 OR (v_model #>> '{pricing,selling}')::numeric<0 THEN
        RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_PRICING_VALUE_INVALID';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_each(coalesce(v_model #> '{configuration,protocolConfig,resolution_cost_prices}','{}'::jsonb)) a
          FULL JOIN jsonb_each(coalesce(v_model #> '{configuration,protocolConfig,resolution_prices}','{}'::jsonb)) b USING(key)
          WHERE a.key IS NULL OR b.key IS NULL OR jsonb_typeof(a.value) IS DISTINCT FROM 'number' OR jsonb_typeof(b.value) IS DISTINCT FROM 'number') THEN
        RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_PRICING_VALUE_INVALID';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_each(coalesce(v_model #> '{configuration,protocolConfig,resolution_cost_prices}','{}'::jsonb)) a WHERE a.value::text::numeric<0)
        OR EXISTS (SELECT 1 FROM jsonb_each(coalesce(v_model #> '{configuration,protocolConfig,resolution_prices}','{}'::jsonb)) a WHERE a.value::text::numeric<0) THEN
        RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_PRICING_VALUE_INVALID';
      END IF;
    END LOOP;
  END IF;
  FOR v_pending IN SELECT * FROM public.platform_model_pending_credentials WHERE release_id=p_release_id ORDER BY model_key LOOP
    IF v_pending.expected_exists THEN
      UPDATE public.platform_model_credential_bindings SET secret_value=v_pending.secret_value,updated_by=p_actor_id,updated_at=now()
      WHERE model_key=v_pending.model_key AND credential_ref=v_pending.credential_ref AND revision=v_pending.expected_revision
      RETURNING * INTO v_active;
    ELSE
      INSERT INTO public.platform_model_credential_bindings(credential_ref,model_key,secret_value,updated_by,updated_at)
        VALUES(v_pending.credential_ref,v_pending.model_key,v_pending.secret_value,p_actor_id,now())
      ON CONFLICT DO NOTHING RETURNING * INTO v_active;
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT'; END IF;
  END LOOP;
  -- The original projector and pointer switch run in the SAME transaction.
  -- A projector or pointer failure rolls back bindings and pending transitions.
  IF v_video_upsert THEN
    FOREACH v_key IN ARRAY v_targets LOOP
      SELECT m INTO v_model FROM jsonb_array_elements(v_candidate.snapshot->'models') m WHERE m->>'id'=v_key;
      SELECT m INTO v_old FROM jsonb_array_elements(v_current.snapshot->'models') m WHERE m->>'id'=v_key;
      v_is_new:=v_old IS NULL;
      SELECT * INTO v_physical FROM public.video_models WHERE id=v_key;
      SELECT secret_value INTO v_key FROM public.platform_model_pending_credentials
        WHERE release_id=p_release_id AND model_key='video_models:'||(v_model->>'id');
      v_key:=coalesce(v_key,v_physical.api_key,'');
      v_requested_model:=v_model;
      v_protocol:=v_model #> '{configuration,protocolConfig}';
      IF NOT v_is_new THEN
        -- Apply only old -> candidate changes. The live target may itself have
        -- newer metadata; a credential/price edit does not authorize reverting it.
        FOR v_field IN SELECT * FROM (VALUES
          (ARRAY['name'],to_jsonb(v_physical.name)),(ARRAY['modelName'],to_jsonb(v_physical.model_name)),
          (ARRAY['provider'],to_jsonb(v_physical.provider)),(ARRAY['protocol'],to_jsonb(v_physical.protocol_type)),
          (ARRAY['endpoint'],to_jsonb(v_physical.api_endpoint)),(ARRAY['sortOrder'],to_jsonb(v_physical.sort_order)),
          (ARRAY['pricing','cost'],to_jsonb(v_physical.cost_price)),(ARRAY['pricing','selling'],to_jsonb(v_physical.price_per_use)),
          (ARRAY['pricing','currency'],to_jsonb(v_physical.currency)),(ARRAY['pricing','costPerUse'],to_jsonb(v_physical.cost_per_use)),
          (ARRAY['pricing','inputCostPerMillion'],to_jsonb(v_physical.input_cost_per_million)),(ARRAY['pricing','outputCostPerMillion'],to_jsonb(v_physical.output_cost_per_million)),
          (ARRAY['capabilities','durationSeconds'],to_jsonb(v_physical.duration_seconds)),(ARRAY['capabilities','maxDuration'],to_jsonb(v_physical.max_duration)),
          (ARRAY['capabilities','supportsImageInput'],to_jsonb(v_physical.supports_image_input)),(ARRAY['capabilities','requiresImage'],to_jsonb(v_physical.requires_image)),
          (ARRAY['configuration','adminNotes'],to_jsonb(v_physical.admin_notes)),(ARRAY['configuration','iconUrl'],to_jsonb(v_physical.icon_url)),
          (ARRAY['configuration','billingMode'],to_jsonb(v_physical.billing_mode)),(ARRAY['configuration','tokenBillingEnabled'],to_jsonb(v_physical.token_billing_enabled)),
          (ARRAY['configuration','profitMargin'],to_jsonb(v_physical.profit_margin)),(ARRAY['configuration','tokenRoundingUnit'],to_jsonb(v_physical.token_rounding_unit)),
          (ARRAY['configuration','requestTemplate'],to_jsonb(v_physical.request_template)),(ARRAY['configuration','responseMapping'],to_jsonb(v_physical.response_mapping))
        ) field(path,value) LOOP
          IF v_model #> v_field.path IS NOT DISTINCT FROM v_old #> v_field.path THEN
            v_model:=jsonb_set(v_model,v_field.path,coalesce(v_field.value,'null'::jsonb),true);
          ELSIF v_model #> v_field.path IS NULL THEN
            v_model:=jsonb_set(v_model,v_field.path,'null'::jsonb,true);
          END IF;
        END LOOP;
        v_requested_protocol:=v_protocol; v_old_protocol:=coalesce(v_old #> '{configuration,protocolConfig}','{}'::jsonb);
        v_protocol:=coalesce(v_physical.api_protocol_config,'{}'::jsonb)-'__model_activation_gate';
        FOR v_field IN SELECT key FROM jsonb_object_keys(v_old_protocol||v_requested_protocol) key WHERE key<>'__model_activation_gate' LOOP
          IF v_old_protocol->v_field.key IS DISTINCT FROM v_requested_protocol->v_field.key THEN
            IF v_requested_protocol ? v_field.key THEN v_protocol:=jsonb_set(v_protocol,ARRAY[v_field.key],v_requested_protocol->v_field.key,true);
            ELSE v_protocol:=v_protocol-v_field.key; END IF;
          END IF;
        END LOOP;
        IF v_requested_protocol ? '__model_activation_gate' THEN v_protocol:=v_protocol||jsonb_build_object('__model_activation_gate',v_requested_protocol->'__model_activation_gate'); END IF;
      END IF;
      -- Pricing and placement are administrative metadata. All other provider
      -- config plus identity/endpoint/key changes invalidate execution evidence.
      v_binding_changed:=v_is_new OR v_physical.model_name IS DISTINCT FROM v_model->>'modelName'
        OR v_physical.provider IS DISTINCT FROM v_model->>'provider' OR v_physical.protocol_type IS DISTINCT FROM v_model->>'protocol'
        OR v_physical.api_endpoint IS DISTINCT FROM v_model->>'endpoint' OR v_physical.api_key IS DISTINCT FROM v_key
        OR (v_model #> '{configuration,requestTemplate}' IS NOT NULL AND coalesce(to_jsonb(v_physical.request_template),'null'::jsonb) IS DISTINCT FROM v_model #> '{configuration,requestTemplate}')
        OR (v_model #> '{configuration,responseMapping}' IS NOT NULL AND coalesce(to_jsonb(v_physical.response_mapping),'null'::jsonb) IS DISTINCT FROM v_model #> '{configuration,responseMapping}')
        OR (coalesce(v_physical.api_protocol_config,'{}'::jsonb)-ARRAY['__model_activation_gate','resolution_cost_prices','resolution_prices','workspace_surfaces'])
          IS DISTINCT FROM (v_protocol-ARRAY['__model_activation_gate','resolution_cost_prices','resolution_prices','workspace_surfaces']);
      v_gate:=v_protocol->'__model_activation_gate';
      IF v_gate->>'state' IS DISTINCT FROM 'pending' THEN v_gate:=NULL; END IF;
      IF v_binding_changed THEN
        v_gate:=coalesce(v_gate,jsonb_build_object('schema','media_model_activation_gate.v1','state','pending','created_at',now()));
      ELSIF v_physical.api_protocol_config #>> '{__model_activation_gate,state}'='pending' OR v_gate IS NULL THEN
        v_gate:=v_physical.api_protocol_config->'__model_activation_gate';
      END IF;
      v_protocol:=v_protocol-'__model_activation_gate';
      IF v_gate IS NOT NULL THEN v_protocol:=v_protocol||jsonb_build_object('__model_activation_gate',v_gate); END IF;
      IF v_is_new THEN
        INSERT INTO public.video_models(id,name,model_name,provider,api_endpoint,api_key,protocol_type,price_per_use,cost_price,currency,
          duration_seconds,max_duration,supports_image_input,requires_image,is_active,is_hidden,sort_order,api_protocol_config,admin_notes,icon_url,billing_mode,token_billing_enabled,profit_margin,token_rounding_unit,cost_per_use,input_cost_per_million,output_cost_per_million,request_template,response_mapping)
        VALUES(v_model->>'id',v_model->>'name',v_model->>'modelName',v_model->>'provider',v_model->>'endpoint',v_key,v_model->>'protocol',
          (v_model #>> '{pricing,selling}')::numeric,(v_model #>> '{pricing,cost}')::numeric,coalesce(v_model #>> '{pricing,currency}','CNY'),
          coalesce((v_model #>> '{capabilities,durationSeconds}')::integer,10),coalesce((v_model #>> '{capabilities,maxDuration}')::integer,10),
          coalesce((v_model #>> '{capabilities,supportsImageInput}')::boolean,false),coalesce((v_model #>> '{capabilities,requiresImage}')::boolean,false),
          true,false,(v_model->>'sortOrder')::integer,v_protocol,
          coalesce(v_model #>> '{configuration,adminNotes}',''),coalesce(v_model #>> '{configuration,iconUrl}',''),v_model #>> '{configuration,billingMode}',coalesce((v_model #>> '{configuration,tokenBillingEnabled}')::boolean,false),
          (v_model #>> '{configuration,profitMargin}')::numeric,(v_model #>> '{configuration,tokenRoundingUnit}')::integer,
          (v_model #>> '{pricing,costPerUse}')::numeric,(v_model #>> '{pricing,inputCostPerMillion}')::numeric,(v_model #>> '{pricing,outputCostPerMillion}')::numeric,
          v_model #> '{configuration,requestTemplate}',v_model #> '{configuration,responseMapping}');
      ELSE
        UPDATE public.video_models SET name=v_model->>'name',model_name=v_model->>'modelName',provider=v_model->>'provider',
          api_endpoint=v_model->>'endpoint',api_key=v_key,protocol_type=v_model->>'protocol',
          price_per_use=(v_model #>> '{pricing,selling}')::numeric,cost_price=(v_model #>> '{pricing,cost}')::numeric,
          currency=v_model #>> '{pricing,currency}',duration_seconds=(v_model #>> '{capabilities,durationSeconds}')::integer,
          max_duration=(v_model #>> '{capabilities,maxDuration}')::integer,supports_image_input=(v_model #>> '{capabilities,supportsImageInput}')::boolean,
          requires_image=(v_model #>> '{capabilities,requiresImage}')::boolean,
          is_active=CASE WHEN v_old->>'catalogState'='retired' THEN true ELSE is_active END,
          is_hidden=CASE WHEN v_old->>'catalogState'='retired' THEN false ELSE is_hidden END,sort_order=(v_model->>'sortOrder')::integer,api_protocol_config=v_protocol,
          admin_notes=v_model #>> '{configuration,adminNotes}',icon_url=v_model #>> '{configuration,iconUrl}',
          billing_mode=v_model #>> '{configuration,billingMode}',token_billing_enabled=(v_model #>> '{configuration,tokenBillingEnabled}')::boolean,
          profit_margin=(v_model #>> '{configuration,profitMargin}')::numeric,token_rounding_unit=(v_model #>> '{configuration,tokenRoundingUnit}')::integer,
          cost_per_use=(v_model #>> '{pricing,costPerUse}')::numeric,input_cost_per_million=(v_model #>> '{pricing,inputCostPerMillion}')::numeric,
          output_cost_per_million=(v_model #>> '{pricing,outputCostPerMillion}')::numeric,
          request_template=CASE WHEN v_requested_model #> '{configuration,requestTemplate}' IS NOT DISTINCT FROM v_old #> '{configuration,requestTemplate}' THEN v_physical.request_template ELSE v_requested_model #> '{configuration,requestTemplate}' END,
          response_mapping=CASE WHEN v_requested_model #> '{configuration,responseMapping}' IS NOT DISTINCT FROM v_old #> '{configuration,responseMapping}' THEN v_physical.response_mapping ELSE v_requested_model #> '{configuration,responseMapping}' END
          WHERE id=v_model->>'id';
        IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_VIDEO_UPSERT_EXISTING_MISSING'; END IF;
      END IF;
    END LOOP;
    -- Exact original model-pool pointer finalization, without global projection.
    UPDATE public.model_pool_config_releases SET status='superseded',is_current=false WHERE id=v_current.id;
    UPDATE public.model_pool_config_releases SET status='published',is_current=true,published_by=p_actor_id,published_at=now()
      WHERE id=p_release_id RETURNING * INTO v_candidate;
    v_result:=to_jsonb(v_candidate);
  ELSE
  v_result:=public.publish_platform_configuration_release_before_pending_credentials(p_kind,p_release_id,p_actor_id,p_expected_candidate_sha256,p_expected_current_id,p_expected_current_sha256);
  END IF;

  UPDATE public.platform_model_pending_credentials SET state='applied',secret_value=NULL,applied_at=now() WHERE release_id=p_release_id;
  UPDATE public.platform_model_mutation_receipts SET state='applied',applied_at=now() WHERE candidate_id=p_release_id;
  RETURN v_result;
END $function$;

DO $precondition$ DECLARE v_proc pg_proc%ROWTYPE; BEGIN
  SELECT * INTO STRICT v_proc FROM pg_proc WHERE oid='public.stage_model_pool_candidate_with_credentials_atomic(uuid,uuid,jsonb,jsonb,text,jsonb,text,text,uuid,jsonb)'::regprocedure;
  IF pg_get_userbyid(v_proc.proowner) IS DISTINCT FROM 'zimeiti_owner'
    OR v_proc.proacl::text IS DISTINCT FROM '{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}'
    OR v_proc.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
    OR v_proc.prosecdef IS DISTINCT FROM true OR v_proc.provolatile IS DISTINCT FROM 'v'
    OR v_proc.proparallel IS DISTINCT FROM 'u' OR v_proc.proisstrict IS DISTINCT FROM false OR v_proc.proleakproof IS DISTINCT FROM false
    OR v_proc.prokind IS DISTINCT FROM 'f' OR v_proc.prorettype IS DISTINCT FROM 'jsonb'::regtype
    OR (SELECT lanname FROM pg_language WHERE oid=v_proc.prolang) IS DISTINCT FROM 'plpgsql'
    OR encode(sha256(convert_to(v_proc.prosrc,'UTF8')),'hex') IS DISTINCT FROM 'b51ab600921f399b2ce2d7a0c61547273f80bb65ab2ca027a6e2d0e1a478225d' THEN
    RAISE EXCEPTION 'VIDEO_UPSERT_STAGE_PRECONDITION_FAILED';
  END IF;
END $precondition$;

CREATE OR REPLACE FUNCTION public.stage_model_pool_candidate_with_credentials_atomic(
  p_actor_id uuid,p_request_id uuid,p_request_payload jsonb,p_snapshot jsonb,p_snapshot_sha256 text,
  p_validation_result jsonb,p_status text,p_change_note text,p_parent_release_id uuid,p_credential_changes jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE
  v_receipt public.platform_model_mutation_receipts%ROWTYPE;
  v_binding public.platform_model_credential_bindings%ROWTYPE;
  v_candidate jsonb;
  v_change jsonb;
  v_salt uuid := gen_random_uuid();
  v_exists boolean;
  v_table text;
  v_id text;
  v_base public.model_pool_config_releases%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL OR p_request_id IS NULL OR p_actor_id::text !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' OR p_request_id::text !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' OR jsonb_typeof(p_request_payload) IS DISTINCT FROM 'object'
    OR octet_length(p_request_payload::text)>1048576 THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_REQUEST_ID_REQUIRED'; END IF;
  -- Publication first everywhere; request lock never precedes this dependency lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-configuration-publish:model-pool',0));
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-model-request:'||p_actor_id::text||':'||p_request_id::text,0));
  SELECT * INTO v_receipt FROM public.platform_model_mutation_receipts WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF FOUND THEN
    IF v_receipt.request_fingerprint IS DISTINCT FROM encode(sha256(convert_to(v_receipt.request_salt::text||p_request_payload::text,'UTF8')),'hex') THEN
      RAISE EXCEPTION 'PLATFORM_CONFIGURATION_REQUEST_ID_CONFLICT';
    END IF;
    SELECT to_jsonb(r) INTO v_candidate FROM public.model_pool_config_releases r WHERE id=v_receipt.candidate_id;
    RETURN v_candidate;
  END IF;
  -- A resumed receipt is authoritative; fresh video candidates must carry
  -- the same immutable base used to construct their snapshot into this lock.
  IF p_validation_result->>'operation'='video-upsert-only' THEN
    SELECT * INTO v_base FROM public.model_pool_config_releases WHERE is_current AND status='published' FOR UPDATE;
    IF NOT FOUND OR v_base.id IS DISTINCT FROM p_parent_release_id
      OR v_base.snapshot_sha256 IS DISTINCT FROM p_validation_result->>'baseSnapshotSha256' THEN
      RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CURRENT_CHANGED';
    END IF;
  END IF;
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'  OR p_snapshot->>'schema' IS DISTINCT FROM 'model-pool-config/v1'
    OR jsonb_typeof(p_snapshot->'models') IS DISTINCT FROM 'array' OR jsonb_typeof(p_credential_changes) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_credential_changes)>200 OR p_snapshot_sha256 IS NULL OR p_status IS NULL OR p_status NOT IN ('draft','validated') OR jsonb_typeof(p_validation_result) IS DISTINCT FROM 'object' OR p_snapshot_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_INPUT_INVALID';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_credential_changes) c WHERE jsonb_typeof(c) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(c))<>3
    OR jsonb_typeof(c->'model_key') IS DISTINCT FROM 'string' OR jsonb_typeof(c->'credential_ref') IS DISTINCT FROM 'string'
    OR jsonb_typeof(c->'secret_value') IS DISTINCT FROM 'string' OR length(btrim(c->>'secret_value')) NOT BETWEEN 1 AND 32768
    OR c->>'secret_value' ~* '^(\*+|sk-\*+|configured|unchanged)$'
    OR length(c->>'model_key') NOT BETWEEN 1 AND 220 OR length(c->>'credential_ref') NOT BETWEEN 1 AND 240)
    OR (SELECT count(*) FROM jsonb_array_elements(p_credential_changes))<>(SELECT count(DISTINCT c->>'model_key') FROM jsonb_array_elements(p_credential_changes) c) THEN
    RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_INPUT_INVALID';
  END IF;
  FOR v_change IN SELECT value FROM jsonb_array_elements(p_credential_changes) ORDER BY value->>'model_key' LOOP
    v_table := split_part(v_change->>'model_key',':',1); v_id := substr(v_change->>'model_key',length(v_table)+2);
    IF v_table NOT IN ('cover_models','video_models','llm_models','chat_models') OR v_id !~ '^[A-Za-z0-9._-]{1,160}$'
      OR v_change->>'credential_ref' IS DISTINCT FROM 'secret://platform-model/'||v_table||'/'||v_id
      OR (SELECT count(*) FROM jsonb_array_elements(p_snapshot->'models') m
        WHERE m #>> '{configuration,legacyTable}'=v_table AND m #>> '{configuration,legacyId}'=v_id
        AND m->>'credentialRef'=v_change->>'credential_ref'
        AND m->>'id'=CASE WHEN v_table='llm_models' THEN 'llm:'||v_id WHEN v_table='chat_models' THEN 'chat:'||v_id ELSE v_id END)<>1 THEN
      RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_MODEL_MISMATCH';
    END IF;
  END LOOP;
  -- Existing function owns version-counter serialization and candidate validation.
  v_candidate := public.create_platform_configuration_candidate_atomic('model-pool',p_actor_id,p_snapshot,p_snapshot_sha256,p_validation_result,p_status,p_change_note,p_parent_release_id,NULL);
  FOR v_change IN SELECT value FROM jsonb_array_elements(p_credential_changes) ORDER BY value->>'model_key' LOOP
    SELECT * INTO v_binding FROM public.platform_model_credential_bindings WHERE model_key=v_change->>'model_key' FOR UPDATE;
    v_exists := FOUND;
    IF v_exists AND v_binding.credential_ref IS DISTINCT FROM v_change->>'credential_ref' THEN RAISE EXCEPTION 'PLATFORM_CONFIGURATION_CREDENTIAL_MODEL_MISMATCH'; END IF;
    INSERT INTO public.platform_model_pending_credentials(release_id,model_key,credential_ref,expected_exists,expected_revision,secret_value)
    VALUES((v_candidate->>'id')::uuid,v_change->>'model_key',v_change->>'credential_ref',v_exists,CASE WHEN v_exists THEN v_binding.revision ELSE NULL END,v_change->>'secret_value');
  END LOOP;
  INSERT INTO public.platform_model_mutation_receipts(actor_id,request_id,candidate_id,request_salt,request_fingerprint,payload_fingerprint)
  VALUES(p_actor_id,p_request_id,(v_candidate->>'id')::uuid,v_salt,
    encode(sha256(convert_to(v_salt::text||p_request_payload::text,'UTF8')),'hex'),
    encode(sha256(convert_to(v_salt::text||jsonb_build_object('snapshot',p_snapshot,'credentialChanges',p_credential_changes)::text,'UTF8')),'hex'));
  RETURN v_candidate;
END $$;

-- CREATE OR REPLACE preserves the existing owner and ACL.
COMMIT;
