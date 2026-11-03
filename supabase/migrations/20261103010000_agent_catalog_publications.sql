BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Function-only migration. Existing configuration, prompt history and governance audit are the authoritative records.
CREATE FUNCTION public.agent_catalog_projection_v1(p_agent public.agents)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
  SELECT jsonb_object_agg(k,to_jsonb(p_agent)->k)
  FROM unnest(ARRAY['name','description','avatar','category','source','model','model_id','system_prompt','cost_per_message','sort_order','is_active','preset_fields','base_fee','output_style','enable_think_tags','deep_thinking_type','deduct_deep_think','max_context_rounds','max_context_tokens','max_reply_tokens','timeout','enable_web_search','temperature','response_format','token_billing_enabled','input_cost_per_million','output_cost_per_million','cached_cost_per_million','profit_margin','token_rounding_unit','user_access','frequency_limit','image_parsing','file_parsing','guide_message','enable_knowledge_base','enable_memory','cover_url']) k;
$$;

CREATE FUNCTION public.read_agent_catalog_publication_v1(p_agent_id text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('id',a.id,'revision',a.config_revision,'deleted',a.deleted_at IS NOT NULL,'fields',f.value,
    'rowDigest',encode(sha256(convert_to(f.value::text,'UTF8')),'hex'),
    'numericText',(SELECT jsonb_object_agg(k,f.value->>k) FROM unnest(ARRAY['base_fee','deduct_deep_think','temperature','input_cost_per_million','output_cost_per_million','cached_cost_per_million','profit_margin']) k)
      || jsonb_build_object('nestedNumbers',(SELECT coalesce(jsonb_agg(n::text),'[]'::jsonb) FROM jsonb_path_query(jsonb_build_array(f.value->'output_style',f.value->'preset_fields'),'strict $.** ? (@.type() == "number")') n)),
    'portability',array_remove(ARRAY[
      CASE WHEN a.source IS DISTINCT FROM 'llm' OR nullif(a.bot_id,'') IS NOT NULL THEN 'NON_LLM_SOURCE' END,
      CASE WHEN nullif(btrim(a.coze_coding_api_token),'') IS NOT NULL OR nullif(btrim(a.coze_coding_api_url),'') IS NOT NULL OR nullif(btrim(a.coze_coding_project_id),'') IS NOT NULL THEN 'PRIVATE_AGENT_CREDENTIAL_OR_CHANNEL' END,
      CASE WHEN nullif(btrim(a.proxy_url),'') IS NOT NULL THEN 'PRIVATE_AGENT_PROXY' END,
      CASE WHEN a.enable_knowledge_base IS TRUE OR nullif(btrim(a.knowledge_base_id),'') IS NOT NULL THEN 'KNOWLEDGE_REFERENCE' END,
      CASE WHEN EXISTS(SELECT 1 FROM public.agent_skill_installations i WHERE i.agent_id=a.id) OR EXISTS(SELECT 1 FROM public.agent_skills i WHERE i.agent_id=a.id) THEN 'SKILL_REFERENCE' END
    ],NULL))
    FROM public.agents a CROSS JOIN LATERAL (SELECT public.agent_catalog_projection_v1(a) AS value) f WHERE a.id=p_agent_id;
$$;

CREATE FUNCTION public.read_agent_catalog_model_guard_v1(p_model_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('rowVersion',m.xmin::text,'poolCount',(SELECT count(*) FROM public.model_pool_config_releases p
      CROSS JOIN LATERAL jsonb_array_elements(p.snapshot->'models') x WHERE p.is_current AND p.status='published'
      AND x->>'kind'='agent' AND x->>'id'='llm:'||m.id::text AND x->>'modelName'=m.model_name))
    FROM public.llm_models m WHERE m.id=p_model_id;
$$;

-- SELECT ... FOR SHARE needs UPDATE privilege. Keep the original governance ACL intact:
-- this fixed helper has the same owner as the native step-up reader; the publication writer remains SECURITY INVOKER.
CREATE FUNCTION public.lock_agent_catalog_publication_owner_v1(p_actor text,p_step_hash text,p_self_use boolean DEFAULT false)
RETURNS timestamptz LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor jsonb; step jsonb; cap text; expires timestamptz;
  caps constant text[]:=ARRAY['agents.manage','prompts.view','prompts.edit','models.manage','internal_tools.manage','backups.manage'];
BEGIN
  IF p_actor IS NULL OR coalesce(p_step_hash,'') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'CATALOG_STEP_UP_REQUIRED'; END IF;
  step:=public.read_admin_step_up_session(p_actor,p_step_hash,'backups.manage');
  IF step->>'status' IS DISTINCT FROM 'ready' THEN RAISE EXCEPTION 'CATALOG_STEP_UP_REQUIRED'; END IF;
  PERFORM 1 FROM public.users WHERE id=p_actor AND role='admin' AND is_active IS TRUE AND coalesce(status,'active')='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_OWNER_REQUIRED'; END IF;
  PERFORM 1 FROM public.admin_access_profiles WHERE user_id=p_actor FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_OWNER_REQUIRED'; END IF;
  PERFORM 1 FROM public.admin_step_up_maintenance_lock WHERE singleton AND NOT is_enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_OWNER_REQUIRED'; END IF;
  PERFORM 1 FROM public.admin_permission_catalog WHERE permission_key=ANY(caps) ORDER BY permission_key FOR SHARE;
  SELECT expires_at INTO expires FROM public.admin_step_up_sessions WHERE actor_id=p_actor AND token_hash=p_step_hash
    AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_STEP_UP_REQUIRED'; END IF;
  actor:=public.read_admin_access_snapshot(p_actor);
  IF (actor->>'authority_status'='ready' AND actor->>'admin_level'='super_admin' AND (actor->>'integrity_valid')::boolean AND (actor->>'profile_active')::boolean) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CATALOG_OWNER_REQUIRED'; END IF;
  FOREACH cap IN ARRAY caps LOOP
    step:=public.read_admin_step_up_session(p_actor,p_step_hash,cap);
    IF (actor->'permission_keys' ? cap AND step->>'status'='ready' AND step->>'auth_method' IN ('login_password','management_password')) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CATALOG_STEP_UP_REQUIRED'; END IF;
  END LOOP;
  IF p_self_use THEN
    PERFORM 1 FROM public.member_permission_assignments WHERE user_id=p_actor FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_OWNER_SELF_USE_GRANT_REQUIRED'; END IF;
    actor:=public.read_member_permission_snapshot(p_actor);
    IF (actor->>'authority_status'='ready' AND (actor->>'integrity_valid')::boolean AND (actor->>'revision')::bigint>0 AND actor->'agent_navigation_keys' ? '自用') IS DISTINCT FROM true THEN RAISE EXCEPTION 'CATALOG_OWNER_SELF_USE_GRANT_REQUIRED'; END IF;
  END IF;
  IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'CATALOG_STEP_UP_REQUIRED'; END IF;
  RETURN expires;
END;
$$;
DO $install$
DECLARE native_owner text;
BEGIN
  SELECT pg_get_userbyid(proowner) INTO STRICT native_owner FROM pg_proc WHERE oid='public.read_admin_step_up_session(text,text,text)'::regprocedure;
  IF native_owner IN('service_role','authenticated','anon') THEN RAISE EXCEPTION 'CATALOG_GOVERNANCE_OWNER_INVALID'; END IF;
  EXECUTE format('ALTER FUNCTION public.lock_agent_catalog_publication_owner_v1(text,text,boolean) OWNER TO %I',native_owner);
END;
$install$;
REVOKE ALL ON FUNCTION public.lock_agent_catalog_publication_owner_v1(text,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.lock_agent_catalog_publication_owner_v1(text,text,boolean) TO service_role;

CREATE FUNCTION public.apply_agent_catalog_publication_v1(p_actor text,p_step_hash text,p_plan jsonb,p_fields jsonb,p_expected_row_hash text,p_model_proof jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  v_step_expires timestamptz; v_id text:=p_plan->>'id'; v_key text:=p_plan->>'requestKey';
  v_audit_key text; v_action text:=p_plan->>'operation'; v_snap jsonb; v_row public.agents%ROWTYPE;
  v_lifecycle text:=coalesce(p_plan->>'lifecycle','executable');
  v_model public.llm_models%ROWTYPE; v_guard jsonb; v_receipt jsonb; v_audit uuid; v_old jsonb;
  v_expected bigint; v_rev bigint; v_model_changed boolean; v_prompt_changed boolean; v_fields text[]; v_columns text; v_values text; v_count int; v_asset text; v_field text;
  v_previous_visibility text; v_target_visibility text; v_target_category_active boolean; v_self_use boolean; v_canonical text;
BEGIN
  IF p_plan->>'schema' IS DISTINCT FROM 'agent-catalog-publication.v1' OR v_id IS NULL OR v_id !~ '^agent-[a-zA-Z0-9][a-zA-Z0-9_-]{1,115}$'
     OR v_key IS NULL OR v_key !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
     OR coalesce(p_plan->>'planHash','') !~ '^[a-f0-9]{64}$' OR coalesce(p_plan->>'sourceHash','') !~ '^[a-f0-9]{64}$'
     OR coalesce(p_plan->>'targetHash','') !~ '^[a-f0-9]{64}$' OR v_action IS NULL OR v_action NOT IN ('create','update','noop')
     OR coalesce(p_plan->>'sourceRevision','') !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'CATALOG_INVALID_OPERATION'; END IF;
  v_self_use:=coalesce(v_lifecycle='executable' AND p_plan->>'audience'='owner-only' AND p_fields->>'category'='自用' AND p_fields->>'user_access'='hidden' AND p_plan->'categoryPolicy'->>'target'='view_only',false);
  v_step_expires:=public.lock_agent_catalog_publication_owner_v1(p_actor,p_step_hash,v_self_use);
  v_canonical:=public.agent_catalog_canonical_json_v1(p_fields);
  IF v_canonical::jsonb IS DISTINCT FROM p_fields THEN RAISE EXCEPTION 'CATALOG_DECIMAL_PRECISION_NOT_PORTABLE'; END IF;
  IF encode(sha256(convert_to(v_canonical,'UTF8')),'hex') IS DISTINCT FROM p_plan->>'targetHash' THEN RAISE EXCEPTION 'CATALOG_REVIEWED_TARGET_HASH_MISMATCH'; END IF;
  v_audit_key:='agent-catalog-publication:'||v_key;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_audit_key||':'||p_actor,0));
  SELECT metadata INTO v_old FROM public.admin_governance_audit WHERE actor_id=p_actor AND request_key=v_audit_key AND action='agent_catalog_publication';
  IF FOUND THEN
    IF v_old->>'planHash' IS DISTINCT FROM p_plan->>'planHash' OR v_old->>'id' IS DISTINCT FROM v_id OR v_old->>'targetHash' IS DISTINCT FROM p_plan->>'targetHash' OR v_old->>'sourceHash' IS DISTINCT FROM p_plan->>'sourceHash' OR v_old->>'sourceRevision' IS DISTINCT FROM p_plan->>'sourceRevision' THEN RAISE EXCEPTION 'CATALOG_REQUEST_KEY_REUSED'; END IF;
    IF v_step_expires<=clock_timestamp() THEN RAISE EXCEPTION 'CATALOG_STEP_UP_REQUIRED'; END IF;
    RETURN jsonb_build_object('receipt',v_old,'replayed',true);
  END IF;

  SELECT array_agg(key ORDER BY key) INTO v_fields FROM jsonb_object_keys(public.agent_catalog_projection_v1(jsonb_populate_record(NULL::public.agents,'{}'::jsonb))) AS key;
  IF jsonb_typeof(p_fields) IS DISTINCT FROM 'object' OR NOT (p_fields ?& v_fields) OR (SELECT count(*) FROM jsonb_object_keys(p_fields))<>cardinality(v_fields)
    OR p_fields->>'source' IS DISTINCT FROM 'llm' OR nullif(btrim(p_fields->>'system_prompt'),'') IS NULL OR v_lifecycle NOT IN('executable','catalog-only')
    OR (v_lifecycle='executable' AND nullif(btrim(p_fields->>'model_id'),'') IS NULL)
    OR nullif(btrim(p_fields->>'name'),'') IS NULL OR nullif(btrim(p_fields->>'category'),'') IS NULL OR p_fields->>'enable_knowledge_base'='true'
    OR p_fields->>'user_access' IS NULL OR p_fields->>'user_access' NOT IN ('available','hidden','view_only')
    OR p_plan->>'audience' IS NULL OR p_plan->>'audience' NOT IN ('source','owner-only')
    OR p_plan->>'sourceAccess' IS NULL OR p_plan->>'sourceAccess' NOT IN('available','hidden','view_only')
    OR (p_plan->>'sourceAccess'='hidden' AND p_fields->>'user_access'<>'hidden')
    OR (coalesce(p_plan->'stripPortability','[]'::jsonb)<>'[]'::jsonb AND NOT (v_lifecycle='catalog-only' AND p_plan->'stripPortability'='["PRIVATE_AGENT_PROXY"]'::jsonb))
    OR (p_plan->>'audience'='owner-only' AND p_fields->>'user_access'<>'hidden') THEN RAISE EXCEPTION 'CATALOG_INVALID_FIELDS'; END IF;
  -- Category names have no unique constraint. Cover concurrent inserts of a second name as well as changes to an existing category.
  LOCK TABLE public.categories IN SHARE MODE;
  PERFORM pg_advisory_xact_lock(hashtextextended('agent-catalog:'||v_id,0));
  -- Ordinary admin creates do not take our advisory lock. Serialize inserts/renames while checking for another stable ID with the same name.
  IF v_action='create' OR EXISTS(SELECT 1 FROM public.agents WHERE id=v_id AND name IS DISTINCT FROM p_fields->>'name') THEN
    LOCK TABLE public.agents IN SHARE ROW EXCLUSIVE MODE;
    IF EXISTS(SELECT 1 FROM public.agents WHERE id<>v_id AND name=p_fields->>'name') THEN RAISE EXCEPTION 'CATALOG_NAME_ALREADY_IN_USE'; END IF;
  END IF;
  SELECT * INTO v_row FROM public.agents WHERE id=v_id FOR UPDATE;
  v_expected:=(p_plan->>'currentRevision')::bigint;
  IF v_action='create' THEN
    IF FOUND OR v_expected IS NOT NULL OR p_expected_row_hash IS NOT NULL OR p_plan->'baseline' IS DISTINCT FROM 'null'::jsonb
       OR EXISTS(SELECT 1 FROM public.prompt_versions WHERE agent_id=v_id)
       OR EXISTS(SELECT 1 FROM public.agent_skills WHERE agent_id=v_id) OR EXISTS(SELECT 1 FROM public.agent_skill_installations WHERE agent_id=v_id)
       THEN RAISE EXCEPTION 'CATALOG_PRODUCTION_BASELINE_CONFLICT'; END IF;
  ELSE
    IF NOT FOUND OR v_row.deleted_at IS NOT NULL OR v_row.config_revision IS DISTINCT FROM v_expected OR v_expected IS NULL OR (p_plan->'baseline'->>'revision')::bigint IS DISTINCT FROM v_expected
      OR (p_plan->'baseline'->>'hash') IS DISTINCT FROM p_plan->>'currentHash'
      OR public.agent_catalog_canonical_json_v1(public.agent_catalog_projection_v1(v_row))::jsonb IS DISTINCT FROM public.agent_catalog_projection_v1(v_row)
      OR encode(sha256(convert_to(public.agent_catalog_canonical_json_v1(public.agent_catalog_projection_v1(v_row)),'UTF8')),'hex') IS DISTINCT FROM p_plan->>'currentHash'
      OR encode(sha256(convert_to(public.agent_catalog_projection_v1(v_row)::text,'UTF8')),'hex') IS DISTINCT FROM p_expected_row_hash THEN RAISE EXCEPTION 'CATALOG_PRODUCTION_BASELINE_CONFLICT'; END IF;
  END IF;
  SELECT count(*),min(visibility),bool_and(is_active IS TRUE) INTO v_count,v_target_visibility,v_target_category_active FROM public.categories WHERE name=p_fields->>'category';
  IF v_count<>1 OR v_target_category_active IS DISTINCT FROM true OR v_target_visibility IS NULL OR v_target_visibility NOT IN('normal','private','view_only') THEN RAISE EXCEPTION 'CATALOG_TARGET_CATEGORY_MISSING'; END IF;
  IF v_action<>'create' THEN
    SELECT count(*),min(visibility) INTO v_count,v_previous_visibility FROM public.categories WHERE name=v_row.category;
    IF v_count<>1 OR v_previous_visibility IS NULL OR v_previous_visibility NOT IN('normal','private','view_only') THEN RAISE EXCEPTION 'CATALOG_PREVIOUS_CATEGORY_UNVERIFIED'; END IF;
    IF (v_row.user_access='hidden' OR btrim(v_row.category)='自用' OR v_previous_visibility='private')
      AND p_fields->>'user_access'<>'hidden' AND btrim(p_fields->>'category')<>'自用' AND v_target_visibility<>'private' THEN RAISE EXCEPTION 'CATALOG_AUDIENCE_BROADENING_REQUIRES_NATIVE_REVIEW'; END IF;
    IF v_lifecycle='executable' AND (v_row.user_access='view_only' OR (v_previous_visibility='view_only' AND v_row.category<>'自用'))
      AND p_fields->>'user_access'<>'view_only' AND (v_target_visibility<>'view_only' OR v_self_use)
      AND (v_row.source='llm' AND v_row.is_active IS FALSE AND v_row.model_id IS NULL AND nullif(btrim(v_row.model),'') IS NULL) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CATALOG_VIEW_ONLY_PROMOTION_REQUIRES_NATIVE_REVIEW'; END IF;
  END IF;
  IF v_previous_visibility IS DISTINCT FROM p_plan->'categoryPolicy'->>'previous' OR v_target_visibility IS DISTINCT FROM p_plan->'categoryPolicy'->>'target' THEN RAISE EXCEPTION 'CATALOG_CATEGORY_POLICY_CHANGED'; END IF;
  IF v_lifecycle='executable' AND (p_plan->>'sourceAccess'='view_only' OR p_fields->>'user_access'='view_only' OR (v_target_visibility='view_only' AND NOT v_self_use)) THEN RAISE EXCEPTION 'CATALOG_VIEW_ONLY_NOT_EXECUTABLE'; END IF;
  v_model_changed:=v_action='create' OR v_row.model_id::text IS DISTINCT FROM p_fields->>'model_id' OR v_row.model IS DISTINCT FROM p_fields->>'model'
     OR (v_row.is_active IS NOT TRUE AND p_fields->>'is_active'='true') OR (v_row.user_access IS DISTINCT FROM 'available' AND p_fields->>'user_access'='available');
  IF v_lifecycle='catalog-only' THEN
    IF p_fields->'model_id' IS DISTINCT FROM 'null'::jsonb OR p_fields->>'model' IS DISTINCT FROM '' OR p_fields->>'is_active' IS DISTINCT FROM 'false'
      OR p_fields->>'user_access' NOT IN('view_only','hidden') OR (v_action<>'create' AND (v_row.source IS DISTINCT FROM 'llm' OR v_row.model_id IS NOT NULL OR nullif(btrim(v_row.model),'') IS NOT NULL))
      OR p_plan->'proposedModel'->>'id' IS NULL OR p_plan->'proposedModel'->>'id' IS DISTINCT FROM p_model_proof->>'proposedModelId'
      OR p_plan->'proposedModel'->>'name' IS DISTINCT FROM p_model_proof->>'proposedModelName' THEN RAISE EXCEPTION 'CATALOG_ONLY_MUST_BE_UNBOUND'; END IF;
    PERFORM 1 FROM public.llm_models m WHERE m.id=(p_model_proof->>'proposedModelId')::uuid AND m.model_name=p_model_proof->>'proposedModelName'
      AND m.user_access='pending_model_activation' AND m.xmin::text=p_model_proof->>'rowVersion' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_ONLY_REQUIRES_REGISTERED_PENDING_MODEL'; END IF;
  ELSIF v_model_changed THEN
    IF nullif(btrim(v_row.proxy_url),'') IS NOT NULL OR nullif(btrim(v_row.coze_coding_api_token),'') IS NOT NULL OR (v_action<>'create' AND v_row.source IS DISTINCT FROM 'llm') THEN RAISE EXCEPTION 'CATALOG_PRIVATE_CHANNEL_REQUIRES_REVIEW'; END IF;
    PERFORM 1 FROM public.llm_models WHERE id=(p_fields->>'model_id')::uuid FOR SHARE;
    SELECT * INTO v_model FROM public.llm_models WHERE id=(p_fields->>'model_id')::uuid;
    PERFORM 1 FROM public.model_pool_config_releases WHERE is_current AND status='published' FOR SHARE;
    v_guard:=public.read_agent_catalog_model_guard_v1((p_fields->>'model_id')::uuid);
    IF v_model.id IS NULL OR v_model.is_active IS DISTINCT FROM true OR v_model.is_hidden IS TRUE OR v_model.user_access IS DISTINCT FROM 'available'
      OR nullif(btrim(v_model.api_key),'') IS NULL OR v_model.model_name IS DISTINCT FROM p_fields->>'model' OR v_guard IS NULL
      OR v_guard->>'rowVersion' IS DISTINCT FROM p_model_proof->>'rowVersion' OR (v_guard->>'poolCount')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_REQUIRED'; END IF;
    PERFORM 1 FROM public.llm_model_validation_evidence WHERE model_id=v_model.id AND configuration_hash=p_model_proof->>'configurationHash' AND checked_at=(p_model_proof->>'checkedAt')::timestamptz AND checked_at BETWEEN now()-interval '7 days' AND now()+interval '1 minute' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED'; END IF;
  END IF;
  FOREACH v_field IN ARRAY ARRAY['avatar','cover_url'] LOOP
    v_asset:=p_fields->>v_field;
    IF v_asset LIKE 'agent-images/%' AND (v_action='create' OR (to_jsonb(v_row)->>v_field) IS DISTINCT FROM v_asset) THEN
      PERFORM 1 FROM public.user_files f WHERE f.user_id=p_actor AND f.storage_key=v_asset AND f.file_category='image'
        AND f.meta->>'purpose'=CASE WHEN v_field='avatar' THEN 'avatar' ELSE 'cover' END AND f.meta->>'sha256' ~ '^[a-f0-9]{64}$' FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_TARGET_ASSET_REQUIRED'; END IF;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgenabled IN('O','A') AND tgname IN('agents_config_revision_before_write','agents_prompt_version_after_write'))<>2 THEN RAISE EXCEPTION 'CATALOG_NATIVE_VERSION_TRIGGERS_REQUIRED'; END IF;
  v_prompt_changed:=v_action='create' OR v_row.system_prompt IS DISTINCT FROM p_fields->>'system_prompt';
  -- v_fields comes only from the private SQL projection above, never from a user key.
  SELECT string_agg(quote_ident(k),',' ORDER BY k),string_agg('r.'||quote_ident(k),',' ORDER BY k) INTO v_columns,v_values FROM unnest(v_fields) k;
  IF v_action='create' THEN
    EXECUTE format('INSERT INTO public.agents(id,%s) SELECT $1,%s FROM jsonb_populate_record(NULL::public.agents,$2) r',v_columns,v_values) USING v_id,p_fields;
  ELSIF v_action='update' THEN
    EXECUTE format('UPDATE public.agents a SET (%s)=(SELECT %s FROM jsonb_populate_record(NULL::public.agents,$2) r) WHERE a.id=$1 AND a.config_revision=$3 AND a.deleted_at IS NULL',v_columns,v_values) USING v_id,p_fields,v_expected;
    GET DIAGNOSTICS v_count=ROW_COUNT; IF v_count<>1 THEN RAISE EXCEPTION 'CATALOG_PRODUCTION_BASELINE_CONFLICT'; END IF;
  ELSIF public.agent_catalog_projection_v1(v_row) IS DISTINCT FROM p_fields THEN RAISE EXCEPTION 'CATALOG_INVALID_NOOP'; END IF;
  SELECT config_revision,public.agent_catalog_projection_v1(a) INTO v_rev,v_snap FROM public.agents a WHERE a.id=v_id;
  IF v_snap IS DISTINCT FROM p_fields OR v_rev IS DISTINCT FROM (CASE WHEN v_action='create' THEN 1 WHEN v_action='update' THEN v_expected+1 ELSE v_expected END)
    OR (v_prompt_changed AND NOT EXISTS(SELECT 1 FROM public.prompt_versions WHERE agent_id=v_id AND agent_revision=v_rev AND prompt_hash=encode(sha256(convert_to(p_fields->>'system_prompt','UTF8')),'hex'))) THEN RAISE EXCEPTION 'CATALOG_ATOMIC_READBACK_FAILED'; END IF;
  v_receipt:=jsonb_build_object('id',v_id,'requestKey',v_key,'planHash',p_plan->>'planHash','sourceRevision',p_plan->'sourceRevision','sourceHash',p_plan->>'sourceHash','targetHash',p_plan->>'targetHash',
    'revision',v_rev,'previousRevision',v_expected,'previousHash',p_plan->>'currentHash','operation',v_action,'audience',p_plan->>'audience',
    'baseline',p_plan->'baseline','changedFields',p_plan->'changedFields','lifecycle',v_lifecycle,'stripPortability',coalesce(p_plan->'stripPortability','[]'::jsonb),
    'proposedModel',CASE WHEN v_lifecycle='catalog-only' THEN jsonb_build_object('id',p_model_proof->>'proposedModelId','name',p_model_proof->>'proposedModelName') ELSE NULL END,
    'billingEvidence','configuration-only','providerCalls',0);
  v_audit:=public.append_admin_governance_audit(p_actor,'super_admin','','agents.manage','agent_catalog_publication','success','STABLE_ID_CONFIGURATION_PUBLICATION',v_id,'/api/admin/agent-catalog-publications','POST',v_audit_key,'','',v_receipt);
  IF v_audit IS NULL THEN RAISE EXCEPTION 'CATALOG_ATOMIC_AUDIT_FAILED'; END IF;
  IF v_step_expires<=clock_timestamp() THEN RAISE EXCEPTION 'CATALOG_STEP_UP_REQUIRED'; END IF;
  RETURN jsonb_build_object('receipt',v_receipt,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.agent_catalog_projection_v1(public.agents),public.read_agent_catalog_publication_v1(text),public.read_agent_catalog_model_guard_v1(uuid),public.apply_agent_catalog_publication_v1(text,text,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.agent_catalog_projection_v1(public.agents),public.read_agent_catalog_publication_v1(text),public.read_agent_catalog_model_guard_v1(uuid),public.apply_agent_catalog_publication_v1(text,text,jsonb,jsonb,text,jsonb) TO service_role;
-- Canonical JS property ordering uses UTF-16 code units, with integer index keys first.
CREATE FUNCTION public.agent_catalog_utf16_v1(p_text text) RETURNS integer[] LANGUAGE sql IMMUTABLE STRICT
SET search_path=pg_catalog,public AS $$
  SELECT coalesce(array_agg(unit ORDER BY ordinal,part),'{}'::integer[])
    FROM unnest(string_to_array(p_text,NULL)) WITH ORDINALITY chars(c,ordinal)
    CROSS JOIN LATERAL (SELECT ascii(c) AS n) cp
    CROSS JOIN LATERAL unnest(CASE WHEN cp.n<65536 THEN ARRAY[cp.n] ELSE ARRAY[55296+(cp.n-65536)/1024,56320+(cp.n-65536)%1024] END) WITH ORDINALITY units(unit,part);
$$;

CREATE FUNCTION public.agent_catalog_number_v1(p_number numeric) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path=pg_catalog,public SET extra_float_digits=3 AS $$
DECLARE magnitude double precision; bits bytea; binary_exp integer; exponent_bits integer; mantissa bigint; pos integer;
  step_size numeric; exact_value numeric; lower_bound numeric; upper_bound numeric; inclusive boolean; decimal_exp integer;
  digits integer; scale integer; unit numeric; nearest numeric; selected numeric; txt text; d text; e integer;
BEGIN
  -- PostgreSQL's shortest text can exclude midpoint spellings that ECMAScript permits (e.g. 1e23).
  -- Use the binary64 rounding interval and ties-to-even before applying JSON.stringify's exponent thresholds.
  IF p_number::text IN('NaN','Infinity','-Infinity') THEN RETURN 'null'; END IF;
  BEGIN magnitude:=abs(p_number)::double precision;
  EXCEPTION WHEN numeric_value_out_of_range THEN RETURN CASE WHEN abs(p_number)<1 THEN '0' ELSE 'null' END; END;
  IF magnitude=0 THEN RETURN '0'; END IF;
  bits:=float8send(magnitude);
  exponent_bits:=(get_byte(bits,0)%128)*16+get_byte(bits,1)/16;
  IF exponent_bits=2047 THEN RETURN 'null'; END IF;
  mantissa:=get_byte(bits,1)%16;
  FOR pos IN 2..7 LOOP mantissa:=mantissa*256+get_byte(bits,pos); END LOOP;
  IF exponent_bits=0 THEN binary_exp:=-1074;
  ELSE mantissa:=mantissa+4503599627370496;binary_exp:=exponent_bits-1075; END IF;
  IF binary_exp>=0 THEN step_size:=power(2::numeric,binary_exp);
  ELSE step_size:=power(5::numeric,-binary_exp)*('1e'||binary_exp)::numeric; END IF;
  exact_value:=mantissa::numeric*step_size;inclusive:=(mantissa%2=0);
  lower_bound:=exact_value-step_size*CASE WHEN exponent_bits>1 AND mantissa=4503599627370496 THEN 0.25 ELSE 0.5 END;
  upper_bound:=exact_value+step_size*0.5;
  txt:=trim_scale(exact_value)::text;
  IF exact_value>=1 THEN decimal_exp:=length(split_part(txt,'.',1))-1;
  ELSE decimal_exp:=1-(length(txt)-length(ltrim(replace(txt,'.',''),'0'))); END IF;
  FOR digits IN 1..17 LOOP
    scale:=digits-1-decimal_exp;unit:=('1e'||(-scale))::numeric;nearest:=round(exact_value,scale);
    SELECT n INTO selected FROM unnest(ARRAY[nearest-unit,nearest,nearest+unit]) n
      WHERE n>0 AND (n>lower_bound OR (inclusive AND n=lower_bound)) AND (n<upper_bound OR (inclusive AND n=upper_bound))
      ORDER BY abs(n-exact_value),mod(trunc(n/unit),2),n LIMIT 1;
    EXIT WHEN FOUND;
  END LOOP;
  IF selected IS NULL THEN RAISE EXCEPTION 'CATALOG_NUMBER_CANONICALIZATION_FAILED'; END IF;
  txt:=trim_scale(selected)::text;
  IF selected>=0.000001 AND selected<1000000000000000000000 THEN RETURN CASE WHEN p_number<0 THEN '-' ELSE '' END||txt; END IF;
  IF selected>=1 THEN e:=length(split_part(txt,'.',1))-1;
  ELSE e:=1-(length(txt)-length(ltrim(replace(txt,'.',''),'0'))); END IF;
  d:=rtrim(ltrim(replace(txt,'.',''),'0'),'0');
  RETURN CASE WHEN p_number<0 THEN '-' ELSE '' END||left(d,1)||CASE WHEN length(d)>1 THEN '.'||substr(d,2) ELSE '' END||'e'||CASE WHEN e>=0 THEN '+' ELSE '' END||e::text;
END;
$$;

CREATE FUNCTION public.agent_catalog_canonical_json_v1(p_value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path=pg_catalog,public AS $$
DECLARE output text;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.agent_catalog_canonical_json_v1(value),',' ORDER BY
        CASE WHEN key ~ '^(0|[1-9][0-9]{0,9})$' THEN CASE WHEN key::bigint<4294967295 THEN key::bigint END END NULLS LAST,
        public.agent_catalog_utf16_v1(key)),'')||'}' INTO output FROM jsonb_each(p_value);
    WHEN 'array' THEN
      SELECT '['||coalesce(string_agg(public.agent_catalog_canonical_json_v1(v),',' ORDER BY n),'')||']' INTO output FROM jsonb_array_elements(p_value) WITH ORDINALITY a(v,n);
    WHEN 'number' THEN output:=public.agent_catalog_number_v1((p_value::text)::numeric);
    ELSE output:=p_value::text;
  END CASE;
  RETURN output;
END;
$$;

CREATE FUNCTION public.read_agent_catalog_publication_index_v1(p_actor text,p_step_hash text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public AS $$
DECLARE actor jsonb; step jsonb; cap text; index_doc jsonb;
BEGIN
  actor:=public.read_admin_access_snapshot(p_actor);
  IF (actor->>'authority_status'='ready' AND actor->>'admin_level'='super_admin' AND (actor->>'integrity_valid')::boolean AND (actor->>'profile_active')::boolean) IS DISTINCT FROM true
    OR NOT EXISTS(SELECT 1 FROM public.admin_step_up_maintenance_lock WHERE singleton AND NOT is_enabled)
    OR coalesce(p_step_hash,'') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'CATALOG_OWNER_REQUIRED'; END IF;
  FOREACH cap IN ARRAY ARRAY['agents.view','prompts.view','models.manage','internal_tools.manage','backups.manage'] LOOP
    step:=public.read_admin_step_up_session(p_actor,p_step_hash,cap);
    IF (actor->'permission_keys' ? cap AND step->>'status'='ready' AND step->>'auth_method' IN ('login_password','management_password')) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CATALOG_STEP_UP_REQUIRED'; END IF;
  END LOOP;
  -- One stable statement/snapshot. Return hashes, never the source JSON, even to the application server.
  WITH inventory AS MATERIALIZED (
    SELECT a.id,a.is_active,a.user_access,a.category,a.deleted_at IS NOT NULL AS deleted,a.config_revision,
      encode(sha256(convert_to(coalesce(a.system_prompt,''),'UTF8')),'hex') AS prompt_hash,public.read_agent_catalog_publication_v1(a.id) AS s
    FROM public.agents a
  ), measured AS MATERIALIZED (
    SELECT i.*,public.agent_catalog_canonical_json_v1(s->'fields') AS canonical,
      NOT EXISTS(SELECT 1 FROM jsonb_each_text(s->'numericText') n WHERE n.key<>'nestedNumbers' AND n.value IN ('NaN','Infinity','-Infinity')) AS finite FROM inventory i
  ), summarized AS (
    SELECT id,deleted,is_active,user_access,jsonb_build_object('id',id,'revision',config_revision,'sourceHash',
      CASE WHEN finite AND canonical::jsonb=s->'fields' THEN encode(sha256(convert_to(canonical,'UTF8')),'hex') END,
      'promptHash',prompt_hash,'deleted',deleted,'isActive',is_active IS TRUE,'userAccess',user_access,'category',category,
      'portability',s->'portability'||CASE WHEN finite AND canonical::jsonb=s->'fields' THEN '[]'::jsonb ELSE '["DECIMAL_NOT_EXACT_IN_JSON"]'::jsonb END) AS entry
    FROM measured
  )
  SELECT jsonb_build_object('schema','agent-catalog-production-index.v1','complete',true,'observedAt',statement_timestamp(),
    'database',jsonb_build_object('database',current_database(),'oid',(SELECT oid::text FROM pg_database WHERE datname=current_database())),
    'totalCount',count(*),'counts',jsonb_build_object('active',count(*) FILTER (WHERE NOT deleted AND is_active IS TRUE),
      'hidden',count(*) FILTER (WHERE NOT deleted AND user_access='hidden'),'tombstones',count(*) FILTER (WHERE deleted)),
    'entries',coalesce(jsonb_agg(entry ORDER BY public.agent_catalog_utf16_v1(id)),'[]'::jsonb)) INTO index_doc FROM summarized;
  RETURN index_doc;
END;
$$;
REVOKE ALL ON FUNCTION public.agent_catalog_utf16_v1(text),public.agent_catalog_number_v1(numeric),public.agent_catalog_canonical_json_v1(jsonb),public.read_agent_catalog_publication_index_v1(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.agent_catalog_utf16_v1(text),public.agent_catalog_number_v1(numeric),public.agent_catalog_canonical_json_v1(jsonb),public.read_agent_catalog_publication_index_v1(text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
