-- REVIEW ONLY until separately approved and applied by the migration owner.
-- Additive entry point. No existing function/trigger/table ACL is modified.
BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

DO $precondition$
DECLARE v_table text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='zimeiti_owner')
    OR NOT has_function_privilege('zimeiti_owner','public.read_admin_access_snapshot(text)','EXECUTE')
    OR NOT has_database_privilege('zimeiti_owner',current_database(),'TEMP')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='publish_image_model_addition_only_atomic') THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_MIGRATION_PRECONDITION_FAILED';
  END IF;
  FOREACH v_table IN ARRAY ARRAY['cover_models','video_models','llm_models','chat_models','model_pool_config_releases',
    'workspace_model_config_releases','platform_settings','platform_model_credential_bindings',
    'platform_model_pending_credentials','platform_model_mutation_receipts','users','wallet_operations',
    'wallet_ledger_entries','revenue_records','image_model_validations','image_model_legacy_baselines'] LOOP
    IF to_regclass('public.'||v_table) IS NULL OR NOT has_table_privilege('zimeiti_owner','public.'||v_table,'SELECT') THEN
      RAISE EXCEPTION 'IMAGE_ADDITION_MIGRATION_OWNER_PRIVILEGE_MISSING';
    END IF;
  END LOOP;
  IF NOT has_table_privilege('zimeiti_owner','public.cover_models','INSERT')
    OR NOT has_table_privilege('zimeiti_owner','public.model_pool_config_releases','UPDATE')
    OR NOT has_table_privilege('zimeiti_owner','public.platform_model_credential_bindings','INSERT')
    OR NOT has_table_privilege('zimeiti_owner','public.platform_model_pending_credentials','UPDATE')
    OR NOT has_table_privilege('zimeiti_owner','public.platform_model_mutation_receipts','UPDATE') THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_MIGRATION_OWNER_PRIVILEGE_MISSING';
  END IF;
END;
$precondition$;

CREATE FUNCTION public.publish_image_model_addition_only_atomic(
  p_actor_id uuid,
  p_release_id uuid,
  p_expected_candidate_sha256 text,
  p_expected_current_id uuid,
  p_expected_current_sha256 text,
  p_target_model_id text,
  p_dry_run boolean,
  p_expected_current_snapshot jsonb,
  p_expected_candidate_snapshot jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_current public.model_pool_config_releases%ROWTYPE;
  v_candidate public.model_pool_config_releases%ROWTYPE;
  v_after_current public.model_pool_config_releases%ROWTYPE;
  v_after_candidate public.model_pool_config_releases%ROWTYPE;
  v_pending public.platform_model_pending_credentials%ROWTYPE;
  v_binding public.platform_model_credential_bindings%ROWTYPE;
  v_after_binding public.platform_model_credential_bindings%ROWTYPE;
  v_receipt public.platform_model_mutation_receipts%ROWTYPE;
  v_model jsonb; v_protocol jsonb; v_access jsonb; v_physical jsonb;
  v_binding_exists boolean; v_count integer; v_owner oid; v_grantee record;
  v_tables text[]; v_table text; v_where text; v_query text; v_queries jsonb := '{}'::jsonb;
  v_digest jsonb; v_before jsonb := '{}'::jsonb; v_after jsonb := '{}'::jsonb; v_restored jsonb := '{}'::jsonb;
  v_new_pending jsonb; v_new_receipt jsonb; v_replayed boolean := false;
  v_rolled_back boolean := false; v_evidence jsonb;
BEGIN
  IF current_user IS DISTINCT FROM 'zimeiti_owner' THEN RAISE EXCEPTION 'IMAGE_ADDITION_ROLE_UNAVAILABLE'; END IF;
  IF p_actor_id IS NULL OR p_release_id IS NULL OR p_expected_current_id IS NULL
    OR p_expected_candidate_sha256 IS NULL OR p_expected_candidate_sha256 !~ '^[a-f0-9]{64}$'
    OR p_expected_current_sha256 IS NULL OR p_expected_current_sha256 !~ '^[a-f0-9]{64}$'
    OR p_target_model_id IS NULL OR p_target_model_id !~ '^[A-Za-z0-9._-]{1,160}$'
    OR p_dry_run IS NULL OR jsonb_typeof(p_expected_current_snapshot) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_expected_candidate_snapshot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_INPUT_INVALID';
  END IF;
  PERFORM set_config('lock_timeout','8s',true);
  PERFORM set_config('statement_timeout','60s',true);
  PERFORM set_config('row_security','off',true);
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-configuration-publish:model-pool',0));
  -- The existing visibility trigger has its own historical search_path.
  -- Reject all pre-existing temp relations/types/functions before invoking it.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace=pg_catalog.pg_my_temp_schema())
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typnamespace=pg_catalog.pg_my_temp_schema())
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace=pg_catalog.pg_my_temp_schema()) THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_TEMP_CONTEXT_UNTRUSTED';
  END IF;

  -- Full sets, not only old row IDs: block concurrent inserts/deletes as well.
  SELECT array_agg(c.relname::text ORDER BY c.relname) INTO v_tables
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('r','p')
     AND (c.relname IN ('cover_models','video_models','llm_models','chat_models','model_pool_config_releases',
       'workspace_model_config_releases','platform_settings','platform_model_credential_bindings',
       'platform_model_pending_credentials','platform_model_mutation_receipts','users','revenue_records',
       'transactions','credit_transactions','cash_transactions','image_model_validations','image_model_legacy_baselines')
       OR c.relname ~ '^(wallet_|workspace_|admin_|user_auth_|llm_credit_|image_generation_|cover_generation_|cover_prepare_|cover_review_|cover_analysis_|cover_execution_)');
  IF v_tables IS NULL OR NOT v_tables @> ARRAY['cover_models','video_models','llm_models','chat_models',
    'model_pool_config_releases','workspace_model_config_releases','platform_settings','platform_model_credential_bindings',
    'platform_model_pending_credentials','platform_model_mutation_receipts','users','wallet_operations','wallet_ledger_entries',
    'revenue_records','image_model_validations','image_model_legacy_baselines']::text[] THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_SCHEMA_UNAVAILABLE';
  END IF;
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE',v_table);
  END LOOP;
  v_access := public.read_admin_access_snapshot(p_actor_id::text);
  IF v_access->>'authority_status' IS DISTINCT FROM 'ready'
    OR v_access->>'integrity_valid' IS DISTINCT FROM 'true'
    OR v_access->>'profile_active' IS DISTINCT FROM 'true'
    OR NOT coalesce(v_access->'permission_keys' ? 'models.manage',false) THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_ADMIN_REQUIRED';
  END IF;
  IF (SELECT count(*) FROM public.model_pool_config_releases WHERE is_current) <> 1 THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_BASE_CHANGED';
  END IF;
  SELECT * INTO v_current FROM public.model_pool_config_releases WHERE id=p_expected_current_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IMAGE_ADDITION_BASE_CHANGED'; END IF;
  SELECT * INTO v_candidate FROM public.model_pool_config_releases WHERE id=p_release_id FOR UPDATE;
  IF NOT FOUND OR v_candidate.snapshot_sha256 IS DISTINCT FROM p_expected_candidate_sha256
    OR v_current.snapshot_sha256 IS DISTINCT FROM p_expected_current_sha256
    OR v_candidate.parent_release_id IS DISTINCT FROM v_current.id OR v_candidate.rollback_target_id IS NOT NULL
    OR v_current.snapshot IS DISTINCT FROM p_expected_current_snapshot
    OR v_candidate.snapshot IS DISTINCT FROM p_expected_candidate_snapshot THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_BASE_CHANGED';
  END IF;
  v_replayed := v_candidate.is_current AND v_candidate.status='published';
  IF v_replayed THEN RAISE EXCEPTION 'IMAGE_ADDITION_ALREADY_PUBLISHED'; END IF;
  IF NOT v_replayed AND (NOT v_current.is_current OR v_current.status<>'published'
    OR v_candidate.is_current OR v_candidate.status<>'validated' OR v_candidate.validated_at IS NULL
    OR v_candidate.validation_result->>'ok' IS DISTINCT FROM 'true'
    OR v_candidate.validation_result->>'schema' IS DISTINCT FROM 'platform-configuration-validation/v1'
    OR v_candidate.validation_result->>'mode' IS DISTINCT FROM 'deterministic-contract'
    OR v_candidate.validation_result->>'checkedBy' IS DISTINCT FROM p_actor_id::text) THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_CANDIDATE_INVALID';
  END IF;
  IF v_current.snapshot->>'schema' IS DISTINCT FROM 'model-pool-config/v1'
    OR v_candidate.snapshot->>'schema' IS DISTINCT FROM 'model-pool-config/v1'
    OR jsonb_typeof(v_current.snapshot->'models') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_candidate.snapshot->'models') IS DISTINCT FROM 'array'
    OR (v_current.snapshot-'models') IS DISTINCT FROM (v_candidate.snapshot-'models')
    OR jsonb_array_length(v_candidate.snapshot->'models') <> jsonb_array_length(v_current.snapshot->'models')+1 THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_CANDIDATE_INVALID';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_candidate.snapshot->'models') m
      WHERE jsonb_typeof(m) IS DISTINCT FROM 'object' OR coalesce(m->>'id','')=''
        OR coalesce(m #>> '{configuration,legacyId}','')='' OR coalesce(m #>> '{configuration,legacyTable}','')='')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_candidate.snapshot->'models') m GROUP BY m->>'id' HAVING count(*)<>1)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_candidate.snapshot->'models') m
      GROUP BY m #>> '{configuration,legacyTable}',m #>> '{configuration,legacyId}' HAVING count(*)<>1) THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_CANDIDATE_INVALID';
  END IF;
  SELECT m INTO v_model FROM jsonb_array_elements(v_candidate.snapshot->'models') m WHERE m->>'id'=p_target_model_id;
  IF v_model IS NULL OR v_model->>'kind' IS DISTINCT FROM 'image'
    OR v_model #>> '{configuration,legacyTable}' IS DISTINCT FROM 'cover_models'
    OR v_model #>> '{configuration,legacyId}' IS DISTINCT FROM p_target_model_id
    OR v_model->>'catalogState' IS DISTINCT FROM 'enabled'
    OR v_model->>'credentialRef' IS DISTINCT FROM 'secret://platform-model/cover_models/'||p_target_model_id
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_current.snapshot->'models') m
      WHERE m->>'id'=p_target_model_id OR m->'credentialRef'=v_model->'credentialRef')
    OR (SELECT coalesce(jsonb_agg(m ORDER BY ord),'[]'::jsonb)
      FROM jsonb_array_elements(v_candidate.snapshot->'models') WITH ORDINALITY t(m,ord)
      WHERE m->>'id'<>p_target_model_id) IS DISTINCT FROM v_current.snapshot->'models' THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_TARGET_INVALID';
  END IF;
  v_protocol := v_model #> '{configuration,protocolConfig}';
  IF jsonb_typeof(v_protocol) IS DISTINCT FROM 'object' OR v_protocol IS DISTINCT FROM v_model #> '{capabilities,protocol}'
    OR v_protocol->>'protocol' IS DISTINCT FROM v_model->>'protocol'
    OR coalesce(v_protocol->>'protocol','') NOT IN ('chat_completions','google_generate_content','images_generations','images_generations_async','images_edits')
    OR jsonb_typeof(v_model #> '{pricing,cost}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(v_model #> '{pricing,selling}') IS DISTINCT FROM 'number'
    OR (v_model #>> '{pricing,cost}')::numeric<0 OR (v_model #>> '{pricing,selling}')::numeric<0
    OR v_model #>> '{pricing,currency}' IS DISTINCT FROM 'CNY'
    OR v_protocol->>'canary_verified'='true' OR v_protocol->>'canaryVerified'='true'
    OR v_protocol #>> '{__model_activation_gate,state}'='evidence_ready' THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_TARGET_INVALID';
  END IF;

  -- Existing pending credential/receipt are the only write authorization.
  SELECT count(*) INTO v_count FROM public.platform_model_pending_credentials WHERE release_id=p_release_id;
  IF v_count<>1 THEN RAISE EXCEPTION 'IMAGE_ADDITION_CREDENTIAL_CONFLICT'; END IF;
  SELECT * INTO v_pending FROM public.platform_model_pending_credentials
    WHERE release_id=p_release_id AND model_key='cover_models:'||p_target_model_id FOR UPDATE;
  IF NOT FOUND OR v_pending.credential_ref IS DISTINCT FROM v_model->>'credentialRef'
    OR (NOT v_replayed AND (v_pending.state<>'pending' OR coalesce(v_pending.secret_value,'')='')) THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_CREDENTIAL_CONFLICT';
  END IF;
  SELECT count(*) INTO v_count FROM public.platform_model_mutation_receipts WHERE candidate_id=p_release_id;
  IF v_count<>1 THEN RAISE EXCEPTION 'IMAGE_ADDITION_CREDENTIAL_CONFLICT'; END IF;
  SELECT * INTO v_receipt FROM public.platform_model_mutation_receipts
    WHERE candidate_id=p_release_id AND actor_id=p_actor_id FOR UPDATE;
  IF NOT FOUND OR (NOT v_replayed AND v_receipt.state<>'staged') THEN RAISE EXCEPTION 'IMAGE_ADDITION_CREDENTIAL_CONFLICT'; END IF;
  SELECT * INTO v_binding FROM public.platform_model_credential_bindings
    WHERE model_key=v_pending.model_key FOR UPDATE; v_binding_exists:=FOUND;
  IF NOT v_replayed AND (v_binding_exists OR v_pending.expected_exists IS DISTINCT FROM false
    OR v_pending.expected_revision IS NOT NULL) THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_CREDENTIAL_CONFLICT';
  END IF;

  -- Hash every full non-target row, including its key. Sorting hashes also
  -- detects additions/deletions without returning any credential/user content.
  FOREACH v_table IN ARRAY v_tables LOOP
    v_where := CASE v_table
      WHEN 'cover_models' THEN format(' WHERE t.id::text<>%L',p_target_model_id)
      WHEN 'platform_model_credential_bindings' THEN format(' WHERE t.model_key<>%L',v_pending.model_key)
      WHEN 'platform_model_pending_credentials' THEN format(' WHERE NOT(t.release_id=%L::uuid AND t.model_key=%L)',p_release_id,v_pending.model_key)
      WHEN 'platform_model_mutation_receipts' THEN format(' WHERE NOT(t.actor_id=%L::uuid AND t.request_id=%L::uuid)',v_receipt.actor_id,v_receipt.request_id)
      WHEN 'model_pool_config_releases' THEN format(' WHERE t.id NOT IN (%L::uuid,%L::uuid)',v_current.id,v_candidate.id)
      ELSE '' END;
    v_query := format($hash$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(
      coalesce(string_agg(h.digest,'' ORDER BY h.digest),''),'UTF8')),'hex')) FROM
      (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest FROM public.%I t%s) h$hash$,v_table,v_where);
    v_queries:=v_queries||jsonb_build_object(v_table,v_query);
    EXECUTE v_query INTO v_digest; v_before:=v_before||jsonb_build_object(v_table,v_digest);
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.cover_models WHERE id=p_target_model_id)
    OR EXISTS (SELECT 1 FROM public.image_model_validations WHERE model_id=p_target_model_id)
    OR EXISTS (SELECT 1 FROM public.image_model_legacy_baselines WHERE model_id=p_target_model_id) THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_TARGET_EXISTS';
  END IF;
  IF to_regclass('pg_temp.model_pool_canonical_visibility_permit') IS NOT NULL THEN
    RAISE EXCEPTION 'IMAGE_ADDITION_VISIBILITY_CONTEXT_REENTRY';
  END IF;
  SELECT oid INTO v_owner FROM pg_catalog.pg_roles WHERE rolname=current_user;
  IF current_user IS DISTINCT FROM 'zimeiti_owner' THEN RAISE EXCEPTION 'IMAGE_ADDITION_ROLE_UNAVAILABLE'; END IF;
  CREATE TEMP TABLE pg_temp.model_pool_canonical_visibility_permit (
    legacy_table text NOT NULL,legacy_id text NOT NULL,transaction_id bigint NOT NULL,
    backend_pid integer NOT NULL,expected_present boolean NOT NULL,removed boolean NOT NULL,
    original_hash text NOT NULL,PRIMARY KEY(legacy_table,legacy_id)
  ) ON COMMIT DROP;
  FOR v_grantee IN SELECT DISTINCT acl.grantee FROM pg_catalog.pg_class c,
      LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    WHERE c.oid='pg_temp.model_pool_canonical_visibility_permit'::regclass AND acl.grantee<>v_owner LOOP
    EXECUTE format('REVOKE ALL ON TABLE pg_temp.model_pool_canonical_visibility_permit FROM %s',
      CASE WHEN v_grantee.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_grantee.grantee)) END);
  END LOOP;
  REVOKE ALL ON TABLE pg_temp.model_pool_canonical_visibility_permit FROM PUBLIC,anon,authenticated,service_role;
  INSERT INTO pg_temp.model_pool_canonical_visibility_permit VALUES('cover_models',p_target_model_id,txid_current(),pg_backend_pid(),false,false,'');

  -- Sentinel is caught ONLY after every real assertion succeeds. All target
  -- business DML belongs to this subtransaction; dry-run rolls it all back.
  BEGIN
    INSERT INTO public.platform_model_credential_bindings(credential_ref,model_key,secret_value,updated_by,updated_at)
      VALUES(v_pending.credential_ref,v_pending.model_key,v_pending.secret_value,p_actor_id,now())
      ON CONFLICT DO NOTHING RETURNING * INTO v_after_binding;
    IF NOT FOUND THEN RAISE EXCEPTION 'IMAGE_ADDITION_CREDENTIAL_CONFLICT'; END IF;
    INSERT INTO public.cover_models(id,name,model_name,provider,api_endpoint,api_key,cost_price,selling_price,
      is_active,is_hidden,supports_image_input,sort_order,api_protocol_config,updated_at)
      VALUES(p_target_model_id,v_model->>'name',v_model->>'modelName',v_model->>'provider',v_model->>'endpoint',
        v_after_binding.secret_value,(v_model #>> '{pricing,cost}')::numeric,(v_model #>> '{pricing,selling}')::numeric,
        false,true,coalesce((v_model #>> '{capabilities,supportsImageInput}')::boolean,false),
        (v_model->>'sortOrder')::integer,v_protocol,now());
    UPDATE public.platform_model_pending_credentials SET state='applied',secret_value=NULL,applied_at=now()
      WHERE release_id=p_release_id AND model_key=v_pending.model_key AND state='pending' AND pending_revision=v_pending.pending_revision;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count<>1 THEN RAISE EXCEPTION 'IMAGE_ADDITION_CREDENTIAL_CONFLICT'; END IF;
    UPDATE public.platform_model_mutation_receipts SET state='applied',applied_at=now()
      WHERE actor_id=v_receipt.actor_id AND request_id=v_receipt.request_id AND candidate_id=p_release_id AND state='staged';
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count<>1 THEN RAISE EXCEPTION 'IMAGE_ADDITION_CREDENTIAL_CONFLICT'; END IF;
    UPDATE public.model_pool_config_releases SET status='superseded',is_current=false
      WHERE id=v_current.id AND is_current AND status='published' AND snapshot_sha256=p_expected_current_sha256
      AND snapshot=p_expected_current_snapshot;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count<>1 THEN RAISE EXCEPTION 'IMAGE_ADDITION_BASE_CHANGED'; END IF;
    UPDATE public.model_pool_config_releases SET status='published',is_current=true,published_by=p_actor_id,published_at=now()
      WHERE id=p_release_id AND status='validated' AND NOT is_current AND snapshot_sha256=p_expected_candidate_sha256
      AND snapshot=p_expected_candidate_snapshot RETURNING * INTO v_after_candidate;
    IF NOT FOUND THEN RAISE EXCEPTION 'IMAGE_ADDITION_BASE_CHANGED'; END IF;
    SELECT * INTO v_after_current FROM public.model_pool_config_releases WHERE id=v_current.id;
    IF (to_jsonb(v_after_current)-ARRAY['status','is_current']) IS DISTINCT FROM (to_jsonb(v_current)-ARRAY['status','is_current'])
      OR (to_jsonb(v_after_candidate)-ARRAY['status','is_current','published_by','published_at'])
        IS DISTINCT FROM (to_jsonb(v_candidate)-ARRAY['status','is_current','published_by','published_at']) THEN
      RAISE EXCEPTION 'IMAGE_ADDITION_PROTECTED_ROWS_CHANGED';
    END IF;
    SELECT to_jsonb(m)-'api_key' INTO v_physical FROM public.cover_models m
      WHERE m.id=p_target_model_id AND m.api_key=v_pending.secret_value;
    IF v_physical IS NULL OR v_physical->>'is_active' IS DISTINCT FROM 'false'
      OR v_physical->>'is_hidden' IS DISTINCT FROM 'true' OR v_physical->>'name' IS DISTINCT FROM v_model->>'name'
      OR v_physical->>'model_name' IS DISTINCT FROM v_model->>'modelName'
      OR v_physical->>'provider' IS DISTINCT FROM v_model->>'provider'
      OR v_physical->>'api_endpoint' IS DISTINCT FROM v_model->>'endpoint'
      OR (v_physical->>'cost_price')::numeric IS DISTINCT FROM (v_model #>> '{pricing,cost}')::numeric
      OR (v_physical->>'selling_price')::numeric IS DISTINCT FROM (v_model #>> '{pricing,selling}')::numeric
      OR (v_physical->>'supports_image_input')::boolean IS DISTINCT FROM coalesce((v_model #>> '{capabilities,supportsImageInput}')::boolean,false)
      OR (v_physical->>'sort_order')::integer IS DISTINCT FROM (v_model->>'sortOrder')::integer
      OR v_physical->'api_protocol_config' IS DISTINCT FROM v_protocol THEN
      RAISE EXCEPTION 'IMAGE_ADDITION_ISOLATION_POSTCONDITION_FAILED';
    END IF;
    SELECT to_jsonb(p) INTO v_new_pending FROM public.platform_model_pending_credentials p
      WHERE release_id=p_release_id AND model_key=v_pending.model_key;
    SELECT to_jsonb(r) INTO v_new_receipt FROM public.platform_model_mutation_receipts r
      WHERE actor_id=v_receipt.actor_id AND request_id=v_receipt.request_id;
    IF (v_new_pending-ARRAY['state','secret_value','applied_at']) IS DISTINCT FROM (to_jsonb(v_pending)-ARRAY['state','secret_value','applied_at'])
      OR v_new_pending->>'state' IS DISTINCT FROM 'applied' OR v_new_pending->'secret_value' IS DISTINCT FROM 'null'::jsonb
      OR v_new_pending->>'applied_at' IS NULL
      OR (v_new_receipt-ARRAY['state','applied_at']) IS DISTINCT FROM (to_jsonb(v_receipt)-ARRAY['state','applied_at'])
      OR v_new_receipt->>'state' IS DISTINCT FROM 'applied' OR v_new_receipt->>'applied_at' IS NULL
      OR NOT EXISTS (SELECT 1 FROM public.platform_model_credential_bindings b WHERE b.model_key=v_pending.model_key
        AND b.credential_ref=v_pending.credential_ref AND b.secret_value=v_pending.secret_value AND b.updated_by=p_actor_id
        AND b.revision IS NOT NULL AND b.updated_at IS NOT NULL) THEN
      RAISE EXCEPTION 'IMAGE_ADDITION_CREDENTIAL_POSTCONDITION_FAILED';
    END IF;
    FOREACH v_table IN ARRAY v_tables LOOP
      EXECUTE v_queries->>v_table INTO v_digest; v_after:=v_after||jsonb_build_object(v_table,v_digest);
    END LOOP;
    IF v_after IS DISTINCT FROM v_before THEN RAISE EXCEPTION 'IMAGE_ADDITION_PROTECTED_ROWS_CHANGED'; END IF;
    IF (SELECT count(*) FROM pg_temp.model_pool_canonical_visibility_permit)<>1
      OR NOT EXISTS (SELECT 1 FROM pg_temp.model_pool_canonical_visibility_permit WHERE legacy_table='cover_models'
        AND legacy_id=p_target_model_id AND transaction_id=txid_current() AND backend_pid=pg_backend_pid()
        AND NOT expected_present AND NOT removed AND original_hash='') THEN
      RAISE EXCEPTION 'IMAGE_ADDITION_VISIBILITY_POSTCONDITION_FAILED';
    END IF;
    v_evidence:=jsonb_build_object('targetModelId',p_target_model_id,'verificationState','pending',
      'protectedUnchanged',true,'rollbackVerified',false,'before',v_before,'after',v_after);
    IF p_dry_run THEN RAISE EXCEPTION USING ERRCODE='P0I01',MESSAGE='IMAGE_ADDITION_DRY_RUN_SENTINEL'; END IF;
  EXCEPTION WHEN SQLSTATE 'P0I01' THEN
    IF NOT p_dry_run OR v_evidence IS NULL THEN RAISE EXCEPTION 'IMAGE_ADDITION_DRY_RUN_INVALID'; END IF;
    v_rolled_back:=true;
  END;

  IF p_dry_run THEN
    IF NOT v_rolled_back THEN RAISE EXCEPTION 'IMAGE_ADDITION_DRY_RUN_INVALID'; END IF;
    FOREACH v_table IN ARRAY v_tables LOOP
      EXECUTE v_queries->>v_table INTO v_digest; v_restored:=v_restored||jsonb_build_object(v_table,v_digest);
    END LOOP;
    IF v_restored IS DISTINCT FROM v_before
      OR EXISTS (SELECT 1 FROM public.cover_models WHERE id=p_target_model_id)
      OR (SELECT to_jsonb(r) FROM public.model_pool_config_releases r WHERE id=v_current.id) IS DISTINCT FROM to_jsonb(v_current)
      OR (SELECT to_jsonb(r) FROM public.model_pool_config_releases r WHERE id=v_candidate.id) IS DISTINCT FROM to_jsonb(v_candidate)
      OR (SELECT to_jsonb(p) FROM public.platform_model_pending_credentials p WHERE release_id=p_release_id AND model_key=v_pending.model_key) IS DISTINCT FROM to_jsonb(v_pending)
      OR (SELECT to_jsonb(r) FROM public.platform_model_mutation_receipts r WHERE actor_id=v_receipt.actor_id AND request_id=v_receipt.request_id) IS DISTINCT FROM to_jsonb(v_receipt)
      OR EXISTS (SELECT 1 FROM public.platform_model_credential_bindings WHERE model_key=v_pending.model_key) THEN
      RAISE EXCEPTION 'IMAGE_ADDITION_DRY_RUN_RESTORE_FAILED';
    END IF;
    DROP TABLE pg_temp.model_pool_canonical_visibility_permit;
    RETURN jsonb_build_object('release',to_jsonb(v_candidate),'dryRun',true,'outcome','rolled_back',
      'evidence',v_evidence||jsonb_build_object('rollbackVerified',true));
  END IF;
  DROP TABLE pg_temp.model_pool_canonical_visibility_permit;
  RETURN jsonb_build_object('release',to_jsonb(v_after_candidate),'dryRun',false,'outcome','committed','evidence',v_evidence);
EXCEPTION WHEN OTHERS THEN
  -- Never expose PostgreSQL DETAIL/failed-row values containing credentials.
  IF SQLERRM ~ '^IMAGE_ADDITION_[A-Z_]+$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE=SQLERRM; END IF;
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='IMAGE_ADDITION_DATABASE_REJECTED';
END;
$function$;

ALTER FUNCTION public.publish_image_model_addition_only_atomic(uuid,uuid,text,uuid,text,text,boolean,jsonb,jsonb) OWNER TO zimeiti_owner;
REVOKE ALL ON FUNCTION public.publish_image_model_addition_only_atomic(uuid,uuid,text,uuid,text,text,boolean,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_image_model_addition_only_atomic(uuid,uuid,text,uuid,text,text,boolean,jsonb,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
