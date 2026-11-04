BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE FUNCTION public.lock_reviewed_text_activation_owner_v1(p_actor text, p_step_hash text)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $owner_lock$
DECLARE actor jsonb; step jsonb; expires timestamptz;
BEGIN
  IF p_actor IS NULL OR coalesce(p_step_hash,'') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'CATALOG_STEP_UP_REQUIRED'; END IF;
  PERFORM 1 FROM public.users WHERE id=p_actor AND role='admin' AND is_active IS TRUE AND coalesce(status,'active')='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_OWNER_REQUIRED'; END IF;
  PERFORM 1 FROM public.admin_access_profiles WHERE user_id=p_actor AND is_active AND admin_level='super_admin' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_OWNER_REQUIRED'; END IF;
  PERFORM 1 FROM public.admin_step_up_maintenance_lock WHERE singleton AND NOT is_enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_OWNER_REQUIRED'; END IF;
  PERFORM 1 FROM public.admin_permission_catalog WHERE permission_key='models.manage' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_STEP_UP_REQUIRED'; END IF;
  SELECT expires_at INTO expires FROM public.admin_step_up_sessions
    WHERE actor_id=p_actor AND token_hash=p_step_hash AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_STEP_UP_REQUIRED'; END IF;
  actor:=public.read_admin_access_snapshot(p_actor);
  step:=public.read_admin_step_up_session(p_actor,p_step_hash,'models.manage');
  IF (actor->>'authority_status'='ready' AND actor->>'admin_level'='super_admin' AND (actor->>'integrity_valid')::boolean
    AND (actor->>'profile_active')::boolean AND actor->'permission_keys' ? 'models.manage') IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'CATALOG_OWNER_REQUIRED'; END IF;
  IF (step->>'status'='ready' AND step->>'auth_method'='login_password') IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'CATALOG_STEP_UP_REQUIRED'; END IF;
  RETURN expires;
END;
$owner_lock$;

-- Lock read-only governance/credential tables with their native owner without granting UPDATE to the API role.
-- The helper can examine only this one historical binding. A missing audit can be adopted only by the RPC below.
CREATE FUNCTION public.lock_reviewed_deepseek_history_v1(p_actor text,p_model_id uuid,p_agent_id text,p_configuration_hash text,p_row_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  m public.llm_models%ROWTYPE; a public.admin_governance_audit%ROWTYPE; current_pool jsonb; entry jsonb; credential text;
  endpoint text; payload jsonb; metadata jsonb; checked_at constant timestamptz:='2026-11-02T18:18:19.863Z';
BEGIN
  IF p_model_id IS DISTINCT FROM '97f7feee-08f8-4174-a918-770758ddf7d6'::uuid OR p_agent_id IS DISTINCT FROM 'agent-1793171231055-r9qzu6'
    OR p_configuration_hash IS DISTINCT FROM '8021c56dcd535c180a78b8060ba17a33eee5f75f53be6dc987a1b2cc559cdbac' THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED'; END IF;
  IF checked_at NOT BETWEEN clock_timestamp()-interval '7 days' AND clock_timestamp()+interval '1 minute' THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED'; END IF;
  SELECT * INTO m FROM public.llm_models WHERE id=p_model_id AND xmin::text=p_row_version FOR SHARE;
  IF NOT FOUND OR m.model_name IS DISTINCT FROM 'deepseek-flash' OR m.is_hidden IS DISTINCT FROM false THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_REQUIRED'; END IF;
  SELECT snapshot INTO STRICT current_pool FROM public.model_pool_config_releases WHERE is_current AND status='published' FOR SHARE;
  IF NOT FOUND OR (SELECT count(*) FROM jsonb_array_elements(current_pool->'models') e WHERE e->>'id'='llm:'||p_model_id)<>1 THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_REQUIRED'; END IF;
  SELECT e INTO entry FROM jsonb_array_elements(current_pool->'models') e WHERE e->>'id'='llm:'||p_model_id;
  IF entry->>'kind' IS DISTINCT FROM 'agent' OR entry->>'catalogState' IS DISTINCT FROM 'enabled' OR entry->>'modelName' IS DISTINCT FROM m.model_name
    OR entry->>'provider' IS DISTINCT FROM 'deepseek_official' OR entry->>'protocol' IS DISTINCT FROM 'openai_chat'
    OR rtrim(entry->>'endpoint','/') IS DISTINCT FROM 'https://api.deepseek.com' OR entry#>>'{configuration,legacyTable}' IS DISTINCT FROM 'llm_models'
    OR entry#>>'{configuration,legacyId}' IS DISTINCT FROM p_model_id::text OR entry#>'{configuration,protocolConfig}' IS DISTINCT FROM m.api_protocol_config
    OR entry->>'credentialRef' IS DISTINCT FROM 'secret://platform-model/llm_models/'||p_model_id THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_REQUIRED'; END IF;
  SELECT secret_value INTO credential FROM public.platform_model_credential_bindings
    WHERE model_key='llm_models:'||p_model_id AND credential_ref=entry->>'credentialRef' FOR SHARE;
  IF NOT FOUND OR credential IS DISTINCT FROM m.api_key OR nullif(btrim(credential),'') IS NULL OR credential~*'^(secret|env)://' THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_REQUIRED'; END IF;
  endpoint:=rtrim(coalesce(nullif(btrim(m.api_endpoint),''),btrim(m.proxy_url)),'/');
  IF endpoint IS DISTINCT FROM 'https://api.deepseek.com' THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_REQUIRED'; END IF;
  -- Same ordered pairs and JSON number serialization as llmModelValidationConfigurationHash. All input comes from locked rows.
  payload:=jsonb_build_array(
    jsonb_build_array('id',m.id),jsonb_build_array('modelName',m.model_name),jsonb_build_array('endpoint',endpoint),
    jsonb_build_array('secretSha256',encode(sha256(convert_to(credential,'UTF8')),'hex')),
    jsonb_build_array('billingMode',coalesce(btrim(m.billing_mode),'')),jsonb_build_array('tokenBillingEnabled',m.token_billing_enabled IS TRUE),
    jsonb_build_array('inputCostPerMillion',coalesce(m.input_cost_per_million,0)),jsonb_build_array('outputCostPerMillion',coalesce(m.output_cost_per_million,0)),
    jsonb_build_array('cachedCostPerMillion',coalesce(m.cached_cost_per_million,0)),jsonb_build_array('profitMargin',coalesce(m.profit_margin,0)),
    jsonb_build_array('maxContextRounds',coalesce(m.max_context_rounds,0)),jsonb_build_array('maxContextTokens',coalesce(m.max_context_tokens,0)),
    jsonb_build_array('maxReplyTokens',coalesce(m.max_reply_tokens,0)),jsonb_build_array('timeout',coalesce(m.timeout,0)),
    jsonb_build_array('deepThinkingType',coalesce(m.deep_thinking_type,0)),jsonb_build_array('webSearch',m.enable_web_search IS TRUE),
    jsonb_build_array('protocolConfig',coalesce(m.api_protocol_config,'{}'::jsonb)));
  IF encode(sha256(convert_to(public.agent_catalog_canonical_json_v1(payload),'UTF8')),'hex') IS DISTINCT FROM p_configuration_hash THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_REQUIRED'; END IF;
  metadata:=jsonb_build_object('source','reviewed_local_business_history','modelId',p_model_id,'agentId',p_agent_id,'configurationHash',p_configuration_hash,
    'evidenceSha256','f0a35e0fcc50921c5f1953371c00b96585141216a7f0787549fa01c8e19f27f8','checkedAt','2026-11-02T18:18:19.863Z','settledCount',3);
  PERFORM 1 FROM public.admin_governance_audit WHERE actor_id IS DISTINCT FROM p_actor AND request_key='reviewed-text-history:deepseek-flash:2026-11-03' FOR SHARE;
  IF FOUND THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED'; END IF;
  SELECT * INTO a FROM public.admin_governance_audit WHERE actor_id=p_actor AND request_key='reviewed-text-history:deepseek-flash:2026-11-03' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('metadata',metadata); END IF;
  IF a.actor_level IS DISTINCT FROM 'super_admin' OR a.permission_key IS DISTINCT FROM 'models.manage' OR a.action IS DISTINCT FROM 'accept_reviewed_text_history'
    OR a.result IS DISTINCT FROM 'success' OR a.reason_code IS DISTINCT FROM 'THREE_LOCAL_SETTLED_TEXT_REQUESTS' OR a.resource IS DISTINCT FROM p_model_id::text
    OR a.request_path IS DISTINCT FROM '/api/admin/models/activate' OR a.request_method IS DISTINCT FROM 'POST' OR a.metadata IS DISTINCT FROM metadata
    OR a.created_at NOT BETWEEN checked_at AND clock_timestamp()+interval '1 minute' THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED'; END IF;
  RETURN jsonb_build_object('id',a.id,'source','reviewed_local_business_history','checkedAt',metadata->>'checkedAt','auditCreatedAt',a.created_at);
END;
$$;
DO $owner$
DECLARE native_owner text;
BEGIN
  SELECT pg_get_userbyid(proowner) INTO STRICT native_owner FROM pg_proc WHERE oid='public.lock_agent_catalog_publication_owner_v1(text,text,boolean)'::regprocedure;
  IF native_owner IN ('anon','authenticated','service_role') THEN RAISE EXCEPTION 'REVIEWED_HISTORY_OWNER_INVALID'; END IF;
  EXECUTE format('ALTER FUNCTION public.lock_reviewed_deepseek_history_v1(text,uuid,text,text,text) OWNER TO %I',native_owner);
  EXECUTE format('ALTER FUNCTION public.lock_reviewed_text_activation_owner_v1(text,text) OWNER TO %I',native_owner);
END;
$owner$;
REVOKE ALL ON FUNCTION public.lock_reviewed_deepseek_history_v1(text,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lock_reviewed_deepseek_history_v1(text,uuid,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.lock_reviewed_text_activation_owner_v1(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lock_reviewed_text_activation_owner_v1(text,text) TO service_role;

CREATE FUNCTION public.activate_reviewed_deepseek_history_v1(p_actor text,p_step_hash text,p_model_id uuid,p_agent_id text,p_configuration_hash text,p_expected_row_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE expires timestamptz; m public.llm_models%ROWTYPE; admission jsonb; new_audit uuid; replayed boolean; actual_version text;
BEGIN
  expires:=public.lock_reviewed_text_activation_owner_v1(p_actor,p_step_hash);
  -- Lock the model for update from the start: concurrent owners never upgrade two competing share locks.
  IF p_model_id IS DISTINCT FROM '97f7feee-08f8-4174-a918-770758ddf7d6'::uuid THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_REQUIRED'; END IF;
  SELECT * INTO m FROM public.llm_models WHERE id=p_model_id FOR UPDATE;
  SELECT xmin::text INTO actual_version FROM public.llm_models WHERE id=p_model_id;
  IF actual_version IS DISTINCT FROM p_expected_row_version OR actual_version IS NULL THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_REQUIRED'; END IF;
  admission:=public.lock_reviewed_deepseek_history_v1(p_actor,p_model_id,p_agent_id,p_configuration_hash,actual_version);
  replayed:=admission ? 'id';
  IF replayed THEN
    IF m.is_active IS DISTINCT FROM true OR m.user_access IS DISTINCT FROM 'available' THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED'; END IF;
  ELSE
    IF m.user_access IS DISTINCT FROM 'pending_model_activation' THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_REQUIRED'; END IF;
    new_audit:=public.append_admin_governance_audit(p_actor,'super_admin','','models.manage','accept_reviewed_text_history','success',
      'THREE_LOCAL_SETTLED_TEXT_REQUESTS',p_model_id::text,'/api/admin/models/activate','POST','reviewed-text-history:deepseek-flash:2026-11-03','','',admission->'metadata');
    UPDATE public.llm_models SET is_active=true,user_access='available',updated_at=clock_timestamp()
      WHERE id=p_model_id AND xmin::text=actual_version AND user_access='pending_model_activation' AND is_hidden IS FALSE RETURNING * INTO m;
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_REQUIRED'; END IF;
    SELECT xmin::text INTO actual_version FROM public.llm_models WHERE id=p_model_id;
    admission:=public.lock_reviewed_deepseek_history_v1(p_actor,p_model_id,p_agent_id,p_configuration_hash,actual_version);
    IF new_audit IS NULL OR admission->>'id' IS DISTINCT FROM new_audit::text OR m.is_active IS DISTINCT FROM true OR m.user_access IS DISTINCT FROM 'available'
      THEN RAISE EXCEPTION 'CATALOG_ATOMIC_READBACK_FAILED'; END IF;
  END IF;
  IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'CATALOG_STEP_UP_REQUIRED'; END IF;
  RETURN jsonb_build_object('activated',true,'idempotent',replayed,'acceptance',admission,'model',jsonb_build_object('id',m.id,'name',m.name,
    'model_name',m.model_name,'is_active',m.is_active,'is_hidden',m.is_hidden,'user_access',m.user_access,'updated_at',m.updated_at));
END;
$$;
REVOKE ALL ON FUNCTION public.activate_reviewed_deepseek_history_v1(text,text,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.activate_reviewed_deepseek_history_v1(text,text,uuid,text,text,text) TO service_role;

-- Patch reviewed spans of the immutable R1632 source; keep the function OID, dependencies, owner, ACL and INVOKER status.
DO $patch$
DECLARE p pg_proc%ROWTYPE; after_proc pg_proc%ROWTYPE; body text; definition text; original_model text; new_model text; original_receipt text; new_receipt text; original_promotion text; new_promotion text; original_channel text; new_channel text;
BEGIN
  SELECT * INTO STRICT p FROM pg_proc WHERE oid='public.apply_agent_catalog_publication_v1(text,text,jsonb,jsonb,text,jsonb)'::regprocedure;
  body:=replace(p.prosrc,E'\r\n',E'\n');
  IF p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[] OR p.provolatile<>'v'
    OR encode(sha256(convert_to(body,'UTF8')),'hex')<>'a38d4fa83bf02ed4729a7f179b4c8a0b77bf3f5bf0bb9e9d97282b019daaf00b'
    OR has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE')
    OR NOT has_function_privilege('service_role',p.oid,'EXECUTE') THEN RAISE EXCEPTION 'REVIEWED_HISTORY_SOURCE_PRECONDITION'; END IF;
  -- The old, already-bound card is admissible only under this exact plan, after native row and hash CAS.
  original_promotion:=$old$      AND (v_row.source='llm' AND v_row.is_active IS FALSE AND v_row.model_id IS NULL AND nullif(btrim(v_row.model),'') IS NULL) IS DISTINCT FROM true THEN RAISE EXCEPTION 'CATALOG_VIEW_ONLY_PROMOTION_REQUIRES_NATIVE_REVIEW'; END IF;$old$;
  new_promotion:=$new$      AND (v_row.source='llm' AND v_row.is_active IS FALSE AND v_row.model_id IS NULL AND nullif(btrim(v_row.model),'') IS NULL) IS DISTINCT FROM true
      AND NOT v_reviewed_r2 THEN RAISE EXCEPTION 'CATALOG_VIEW_ONLY_PROMOTION_REQUIRES_NATIVE_REVIEW'; END IF;$new$;
  original_channel:=$old$    IF nullif(btrim(v_row.proxy_url),'') IS NOT NULL OR$old$;
  new_channel:=$new$    IF (nullif(btrim(v_row.proxy_url),'') IS NOT NULL AND NOT v_reviewed_r2) OR$new$;
  original_model:=$old$    PERFORM 1 FROM public.llm_model_validation_evidence WHERE model_id=v_model.id AND configuration_hash=p_model_proof->>'configurationHash' AND checked_at=(p_model_proof->>'checkedAt')::timestamptz AND checked_at BETWEEN now()-interval '7 days' AND now()+interval '1 minute' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED'; END IF;$old$;
  new_model:=$new$    IF p_model_proof ? 'reviewedModelAdmission' THEN
      IF v_action<>'update' OR v_lifecycle<>'executable' OR p_plan->>'audience'<>'source' OR v_row.is_active IS DISTINCT FROM false
        OR (NOT v_reviewed_r2 AND (v_row.model_id IS NOT NULL OR coalesce(v_row.model,'')<>''))
        OR v_row.user_access IS DISTINCT FROM 'view_only' OR p_fields->>'is_active' IS DISTINCT FROM 'true'
        OR p_fields->>'user_access' IS DISTINCT FROM 'available' OR (public.agent_catalog_projection_v1(v_row)-ARRAY['model','model_id','is_active','user_access'])
          IS DISTINCT FROM (p_fields-ARRAY['model','model_id','is_active','user_access']) THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED'; END IF;
      IF v_reviewed_r2 AND (v_model.api_endpoint IS NULL OR v_model.api_endpoint NOT IN ('https://api.deepseek.com','https://api.deepseek.com/')
        OR rtrim(v_row.proxy_url,'/') IS DISTINCT FROM rtrim(v_model.api_endpoint,'/')) THEN RAISE EXCEPTION 'CATALOG_PRIVATE_CHANNEL_REQUIRES_REVIEW'; END IF;
      v_guard:=public.lock_reviewed_deepseek_history_v1(p_actor,v_model.id,v_id,p_model_proof->>'configurationHash',p_model_proof->>'rowVersion');
      IF v_guard->>'id' IS NULL OR p_plan->'reviewedModelAdmission' IS DISTINCT FROM p_model_proof->'reviewedModelAdmission'
        OR jsonb_typeof(p_plan->'reviewedModelAdmission') IS DISTINCT FROM 'object'
        OR ((p_plan->'reviewedModelAdmission')-ARRAY['source','auditId','checkedAt','auditCreatedAt']) IS DISTINCT FROM '{}'::jsonb
        OR p_model_proof#>>'{reviewedModelAdmission,source}' IS DISTINCT FROM v_guard->>'source'
        OR p_model_proof#>>'{reviewedModelAdmission,auditId}' IS DISTINCT FROM v_guard->>'id'
        OR p_model_proof#>>'{reviewedModelAdmission,checkedAt}' IS DISTINCT FROM v_guard->>'checkedAt'
        OR p_model_proof->>'checkedAt' IS DISTINCT FROM v_guard->>'checkedAt'
        OR (p_model_proof#>>'{reviewedModelAdmission,auditCreatedAt}')::timestamptz IS DISTINCT FROM (v_guard->>'auditCreatedAt')::timestamptz
        THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED'; END IF;
    ELSE
$new$||original_model||E'\n    END IF;';
  original_receipt:=$old$    'billingEvidence','configuration-only','providerCalls',0);$old$;
  new_receipt:=original_receipt||$new$
  IF p_plan ? 'reviewedModelAdmission' OR coalesce(p_model_proof,'{}'::jsonb) ? 'reviewedModelAdmission' THEN
    IF v_model_changed IS DISTINCT FROM true OR v_action<>'update' OR v_lifecycle<>'executable' OR v_guard->>'source' IS DISTINCT FROM 'reviewed_local_business_history'
      THEN RAISE EXCEPTION 'CATALOG_CURRENT_MODEL_EVIDENCE_REQUIRED'; END IF;
    v_receipt:=v_receipt||jsonb_build_object('reviewedModelAdmission',p_plan->'reviewedModelAdmission');
  END IF;$new$;
  body:=replace(body,'  v_step_expires timestamptz;',E'  v_reviewed_r2 boolean:=false;\n  v_step_expires timestamptz;');
  body:=replace(body,'    IF (v_row.user_access=',$new$    v_reviewed_r2:=coalesce(
      v_id='agent-1793171231055-r9qzu6' AND v_action='update' AND v_lifecycle='executable' AND p_plan->>'audience'='source'
      AND v_row.config_revision=2 AND v_expected=2 AND p_plan->>'currentHash'='e4a1cb0a4f0c7360e597f9ce0b200c51bfc200b9bbd5730ef1933e7fa02d64e0'
      AND p_plan->>'targetHash'='ff7387aa0c1ab87aecd885f84c546ebd6499b49da2967f7ade0bb2c11f49c027'
      AND p_plan->>'sourceHash'=p_plan->>'targetHash' AND p_plan->>'sourceAccess'='available'
      AND p_plan ? 'reviewedModelAdmission' AND p_model_proof ? 'reviewedModelAdmission'
      AND v_row.is_active IS FALSE AND v_row.user_access='view_only' AND v_row.source='llm'
      AND v_row.model_id='705eab71-df2d-4e4d-ab1d-ab2de6cc8ddd'::uuid AND v_row.model='deepseek-v4-flash'
      AND p_fields->>'model_id'='97f7feee-08f8-4174-a918-770758ddf7d6' AND p_fields->>'model'='deepseek-flash'
      AND p_fields->>'is_active'='true' AND p_fields->>'user_access'='available'
      AND (public.agent_catalog_projection_v1(v_row)-ARRAY['model','model_id','is_active','user_access'])
        = (p_fields-ARRAY['model','model_id','is_active','user_access'])
      AND v_row.proxy_url IN ('https://api.deepseek.com','https://api.deepseek.com/')
      AND coalesce(v_row.bot_id,'')='' AND coalesce(v_row.coze_coding_api_token,'')=''
      AND coalesce(v_row.coze_coding_api_url,'')='' AND coalesce(v_row.coze_coding_project_id,'')=''
      AND coalesce(v_row.knowledge_base_id,'')='' AND v_row.enable_knowledge_base IS NOT TRUE,false);
    IF v_reviewed_r2 THEN
      -- Child inserts need not lock the parent. Exclude relation writers before checking for absent rows.
      IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
        RAISE EXCEPTION 'CATALOG_R2_FRESH_SKILL_SNAPSHOT_REQUIRED';
      END IF;
      BEGIN
        LOCK TABLE public.agent_skill_installations, public.agent_skills IN SHARE MODE NOWAIT;
      EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'CATALOG_SKILL_RELATION_BUSY' USING ERRCODE='55P03';
      END;
      IF EXISTS(SELECT 1 FROM public.agent_skill_installations WHERE agent_id=v_id)
        OR EXISTS(SELECT 1 FROM public.agent_skills WHERE agent_id=v_id) THEN
        v_reviewed_r2:=false;
      END IF;
    END IF;
    IF (v_row.user_access=$new$);
  body:=replace(replace(body,original_promotion,new_promotion),original_channel,new_channel);
  -- A driver can submit the Windows file bytes verbatim. Compare spans and hash the emitted body using LF.
  body:=replace(replace(body,replace(original_model,E'\r\n',E'\n'),new_model),original_receipt,new_receipt);
  body:=replace(body,E'\r\n',E'\n');
  IF encode(sha256(convert_to(body,'UTF8')),'hex')<>'adce1c197ddc88308fa6a90592788be9900d79af38224447af8ced2a72a76a70' THEN RAISE EXCEPTION 'REVIEWED_HISTORY_PATCH_MISMATCH'; END IF;
  definition:=pg_get_functiondef(p.oid); EXECUTE replace(definition,p.prosrc,body);
  SELECT * INTO STRICT after_proc FROM pg_proc WHERE oid=p.oid;
  IF after_proc.prosrc<>body OR after_proc.proowner<>p.proowner OR after_proc.proacl IS DISTINCT FROM p.proacl
    OR after_proc.proconfig IS DISTINCT FROM p.proconfig OR after_proc.prosecdef<>p.prosecdef THEN RAISE EXCEPTION 'REVIEWED_HISTORY_FUNCTION_IDENTITY_CHANGED'; END IF;
END;
$patch$;
COMMIT;
