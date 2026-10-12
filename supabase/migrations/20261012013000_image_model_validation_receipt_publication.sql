-- Explicit administrator publication evidence. Original generation receipt is immutable.
-- Forward repair only after activation; do not drop task, billing, or publication receipts.
BEGIN;
SET LOCAL lock_timeout='10s';

CREATE OR REPLACE FUNCTION public.publish_image_model_validation_receipt(
  p_validation_id text,p_user_id text,p_configuration_hash text,p_model_snapshot_hash text,
  p_expected_active boolean,p_expected_hidden boolean,p_verified_key text,
  p_verified_size bigint,p_verified_type text,p_evidence jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_model public.cover_models%ROWTYPE; v_row public.image_model_validations%ROWTYPE;
  v_request public.image_generation_requests%ROWTYPE; v_asset public.user_files%ROWTYPE;
  v_user public.users%ROWTYPE; v_operation public.wallet_operations%ROWTYPE;
  v_ledger public.wallet_ledger_entries%ROWTYPE; v_cash public.cash_transactions%ROWTYPE;
  v_revenue public.revenue_records%ROWTYPE;
  v_model_id text; v_billing_key text; v_replayed boolean; v_count integer;
  v_asset_user_id public.user_files.user_id%TYPE; v_operation_id text; v_meta jsonb; v_asset_id text; v_mode text; v_expected_key text;
BEGIN
  PERFORM public.assert_image_validation_admin(p_user_id);
  SELECT * INTO v_user FROM public.users WHERE id::text=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_user.role IS DISTINCT FROM 'admin' OR v_user.is_active IS DISTINCT FROM true
     OR (v_user.status IS NOT NULL AND v_user.status <> 'active') THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_ADMIN_REQUIRED' USING ERRCODE='42501';
  END IF;
  SELECT model_id INTO v_model_id FROM public.image_model_validations WHERE validation_id=p_validation_id;
  SELECT * INTO v_model FROM public.cover_models WHERE id=v_model_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IMAGE_VALIDATION_MODEL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_row FROM public.image_model_validations WHERE validation_id=p_validation_id FOR UPDATE;
  IF v_row.user_id IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'IMAGE_VALIDATION_OWNER_MISMATCH' USING ERRCODE='42501'; END IF;
  IF v_row.configuration_hash IS DISTINCT FROM p_configuration_hash OR v_row.model_snapshot_hash IS DISTINCT FROM p_model_snapshot_hash
     OR public.image_model_validation_snapshot(v_model) IS DISTINCT FROM p_model_snapshot_hash
     OR v_model.is_active IS DISTINCT FROM p_expected_active OR v_model.is_hidden IS DISTINCT FROM p_expected_hidden THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_CONFIGURATION_CHANGED' USING ERRCODE='40001';
  END IF;
  v_replayed := v_row.state='published';
  IF v_row.state NOT IN ('claimed','unknown','completed','published') OR (v_replayed AND (v_model.is_active IS DISTINCT FROM true OR v_model.is_hidden IS DISTINCT FROM false)) THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_PUBLICATION_STATE_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_request FROM public.image_generation_requests WHERE record_id=v_row.image_record_id FOR UPDATE;
  IF NOT FOUND OR v_request.user_id IS DISTINCT FROM p_user_id OR v_request.client_idempotency_key IS DISTINCT FROM v_row.client_idempotency_key
     OR v_request.client_trace_id IS DISTINCT FROM v_row.client_trace_id OR v_request.payload_fingerprint IS DISTINCT FROM v_row.payload_fingerprint
     OR v_request.state IS DISTINCT FROM 'completed' OR v_request.delivery_state IS DISTINCT FROM 'delivered'
     OR v_request.delivery_asset_id IS NOT NULL
     OR v_request.record_id IS DISTINCT FROM encode(sha256(convert_to(p_user_id,'UTF8') || decode('00','hex') || convert_to(v_row.client_idempotency_key,'UTF8')),'hex')
     OR v_row.client_trace_id IS DISTINCT FROM v_row.client_idempotency_key
     OR coalesce(v_request.response->>'selectedModelId','')<>v_model.id THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_RESULT_INCOMPLETE' USING ERRCODE='22023';
  END IF;
  v_mode := v_request.response->>'deliveryMode';
  IF coalesce(v_mode,'') NOT IN ('provider_url','inline_ephemeral')
    OR v_request.provider_dispatch_receipt->>'schema' IS DISTINCT FROM 'image_provider_dispatch_receipt.v1'
    OR coalesce(v_request.provider_dispatch_receipt->>'receiptSha256','') !~ '^[a-f0-9]{64}$'
    OR v_request.provider_submission_receipt->>'schema' IS DISTINCT FROM 'image_provider_submission_receipt.v1'
    OR coalesce(v_request.provider_submission_receipt->>'receiptSha256','') !~ '^[a-f0-9]{64}$'
    OR v_request.provider_submission_receipt->>'dispatchReceiptSha256' IS DISTINCT FROM v_request.provider_dispatch_receipt->>'receiptSha256'
    OR v_request.provider_submission_receipt->>'transportState' IS DISTINCT FROM 'response_received'
    OR coalesce((v_request.provider_submission_receipt->>'responseStatus')::integer,0) NOT BETWEEN 200 AND 299 THEN
    RAISE EXCEPTION 'IMAGE_PUBLICATION_PROVIDER_RECEIPT_INVALID' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' OR octet_length(p_evidence::text)>4096 OR p_evidence->>'schema' IS DISTINCT FROM 'image_publication_receipt.v1'
    OR p_evidence->>'sourceMode' IS DISTINCT FROM v_mode
    OR coalesce(p_evidence->>'sha256','') !~ '^[a-f0-9]{64}$'
    OR p_verified_size IS NULL OR p_verified_size NOT BETWEEN 1 AND 31457280
    OR coalesce(p_verified_type,'') NOT IN ('image/png','image/jpeg','image/webp')
    OR jsonb_typeof(p_evidence->'width') IS DISTINCT FROM 'number' OR jsonb_typeof(p_evidence->'height') IS DISTINCT FROM 'number'
    OR coalesce(p_evidence->>'width','') !~ '^[0-9]+$' OR coalesce(p_evidence->>'height','') !~ '^[0-9]+$'
    OR (p_evidence->>'width')::bigint NOT BETWEEN 1 AND 32768 OR (p_evidence->>'height')::bigint NOT BETWEEN 1 AND 32768
    OR (p_evidence->>'width')::bigint*(p_evidence->>'height')::bigint>40000000
    OR p_evidence->>'dispatchReceiptSha256' IS DISTINCT FROM v_request.provider_dispatch_receipt->>'receiptSha256'
    OR p_evidence->>'submissionReceiptSha256' IS DISTINCT FROM v_request.provider_submission_receipt->>'receiptSha256'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_evidence) k WHERE k NOT IN ('schema','sourceMode','sha256','width','height','dispatchReceiptSha256','submissionReceiptSha256','providerUrlSha256')) THEN
    RAISE EXCEPTION 'IMAGE_PUBLICATION_EVIDENCE_INVALID' USING ERRCODE='22023';
  END IF;
  IF v_mode='inline_ephemeral' THEN
    IF p_evidence->>'sha256' IS DISTINCT FROM v_request.response->>'sha256'
      OR p_verified_size IS DISTINCT FROM (v_request.response->>'byteLength')::bigint
      OR p_verified_type IS DISTINCT FROM v_request.response->>'contentType'
      OR p_evidence->>'width' IS DISTINCT FROM v_request.response->>'width'
      OR p_evidence->>'height' IS DISTINCT FROM v_request.response->>'height' OR p_evidence ? 'providerUrlSha256' THEN
      RAISE EXCEPTION 'IMAGE_PUBLICATION_INLINE_BYTES_MISMATCH' USING ERRCODE='22023';
    END IF;
  ELSIF nullif(v_request.response->>'providerUrl','') IS NULL OR (NOT v_replayed AND v_request.response ? 'sourceExpiredAt')
    OR p_evidence->>'providerUrlSha256' IS DISTINCT FROM encode(sha256(convert_to(v_request.response->>'providerUrl','UTF8')),'hex')
    OR p_evidence->>'width' IS DISTINCT FROM v_request.response->>'width' OR p_evidence->>'height' IS DISTINCT FROM v_request.response->>'height' THEN
    RAISE EXCEPTION 'IMAGE_PUBLICATION_PROVIDER_SOURCE_MISMATCH' USING ERRCODE='22023';
  END IF;
  v_expected_key := 'admin-image-publication/' || encode(sha256(convert_to(p_user_id,'UTF8')),'hex') || '/' || p_validation_id || '/' || v_request.record_id || '/' || (p_evidence->>'sha256');
  IF p_verified_key IS DISTINCT FROM v_expected_key THEN RAISE EXCEPTION 'IMAGE_PUBLICATION_KEY_INVALID' USING ERRCODE='22023'; END IF;
  v_billing_key := 'image:h3_' || substr(encode(sha256(convert_to(p_user_id || ':' || v_row.client_idempotency_key,'UTF8')),'hex'),1,48);
  IF v_row.quoted_price_yuan IS NULL OR v_row.quoted_price_yuan<0 OR v_row.cost_price_yuan IS NULL OR v_row.cost_price_yuan<0
     OR v_model.selling_price IS DISTINCT FROM v_row.quoted_price_yuan OR v_model.cost_price IS DISTINCT FROM v_row.cost_price_yuan
     OR (v_request.response->>'selectedCostPrice')::numeric IS DISTINCT FROM v_row.cost_price_yuan
     OR (v_request.request_snapshot->>'quotedPriceYuan')::numeric IS DISTINCT FROM v_row.quoted_price_yuan
     OR (v_mode='inline_ephemeral' AND ((v_request.response->>'cashCharged')::numeric IS DISTINCT FROM v_row.quoted_price_yuan OR v_request.response->>'billingReferenceId' IS DISTINCT FROM v_billing_key)) THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_BILLING_INCOMPLETE' USING ERRCODE='22023';
  END IF;

  SELECT count(*)::integer INTO v_count FROM public.revenue_records
    WHERE user_id::text=p_user_id AND task_id=v_billing_key AND record_type='image';
  IF v_count<>1 THEN RAISE EXCEPTION 'IMAGE_VALIDATION_REVENUE_INCOMPLETE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_revenue FROM public.revenue_records
    WHERE user_id::text=p_user_id AND task_id=v_billing_key AND record_type='image' FOR UPDATE;
  IF v_revenue.model_id IS DISTINCT FROM v_model.id OR v_revenue.cost_price IS DISTINCT FROM v_row.cost_price_yuan
     OR v_revenue.selling_price IS DISTINCT FROM v_row.quoted_price_yuan
     OR v_revenue.cash_charged IS DISTINCT FROM v_row.quoted_price_yuan
     OR v_revenue.billing_exempt IS DISTINCT FROM (v_row.quoted_price_yuan=0) THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_REVENUE_INCOMPLETE' USING ERRCODE='22023';
  END IF;

  IF v_row.quoted_price_yuan=0 THEN
    IF coalesce((v_request.request_snapshot->>'billingExempt')::boolean,false) IS NOT TRUE OR (v_mode='inline_ephemeral' AND nullif(v_request.response->>'billingOperationId','') IS NOT NULL) THEN
      RAISE EXCEPTION 'IMAGE_VALIDATION_BILLING_INCOMPLETE' USING ERRCODE='22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.wallet_operations WHERE user_id::text=p_user_id AND idempotency_key=v_billing_key)
       OR EXISTS (SELECT 1 FROM public.wallet_ledger_entries WHERE user_id::text=p_user_id AND idempotency_key=v_billing_key)
       OR EXISTS (SELECT 1 FROM public.cash_transactions WHERE user_id::text=p_user_id AND reference_id=v_billing_key) THEN
      RAISE EXCEPTION 'IMAGE_VALIDATION_UNEXPECTED_CHARGE' USING ERRCODE='22023';
    END IF;
  ELSE
    SELECT count(*)::integer INTO v_count FROM public.wallet_operations
      WHERE user_id::text=p_user_id AND idempotency_key=v_billing_key;
    IF v_count<>1 THEN RAISE EXCEPTION 'IMAGE_VALIDATION_WALLET_INCOMPLETE' USING ERRCODE='22023'; END IF;
    SELECT * INTO v_operation FROM public.wallet_operations
      WHERE user_id::text=p_user_id AND idempotency_key=v_billing_key FOR UPDATE;
    SELECT count(*)::integer INTO v_count FROM public.wallet_ledger_entries
      WHERE user_id::text=p_user_id AND idempotency_key=v_billing_key;
    IF v_count<>1 THEN RAISE EXCEPTION 'IMAGE_VALIDATION_LEDGER_INCOMPLETE' USING ERRCODE='22023'; END IF;
    SELECT * INTO v_ledger FROM public.wallet_ledger_entries
      WHERE user_id::text=p_user_id AND idempotency_key=v_billing_key FOR UPDATE;
    SELECT count(*)::integer INTO v_count FROM public.cash_transactions
      WHERE user_id::text=p_user_id AND reference_id=v_billing_key;
    IF v_count<>1 THEN RAISE EXCEPTION 'IMAGE_VALIDATION_CASH_INCOMPLETE' USING ERRCODE='22023'; END IF;
    SELECT * INTO v_cash FROM public.cash_transactions
      WHERE user_id::text=p_user_id AND reference_id=v_billing_key FOR UPDATE;
    IF v_operation.wallet IS DISTINCT FROM 'cash' OR v_operation.operation_kind IS DISTINCT FROM 'cash_charge'
       OR v_operation.status IS DISTINCT FROM 'completed' OR v_operation.amount IS DISTINCT FROM v_row.quoted_price_yuan
       OR v_operation.delta IS DISTINCT FROM -v_row.quoted_price_yuan
       OR (v_mode='inline_ephemeral' AND v_operation.id::text IS DISTINCT FROM coalesce(v_request.response->>'billingOperationId',''))
       OR v_ledger.operation_id IS DISTINCT FROM v_operation.id OR v_ledger.wallet IS DISTINCT FROM 'cash'
       OR v_ledger.operation_kind IS DISTINCT FROM 'cash_charge' OR v_ledger.delta IS DISTINCT FROM -v_row.quoted_price_yuan
       OR v_cash.type IS DISTINCT FROM 'consume' OR v_cash.amount IS DISTINCT FROM v_row.quoted_price_yuan THEN
      RAISE EXCEPTION 'IMAGE_VALIDATION_BILLING_INCOMPLETE' USING ERRCODE='22023';
    END IF;
  END IF;

  IF EXISTS(SELECT 1 FROM public.wallet_operations WHERE user_id::text=p_user_id AND (idempotency_key IN(v_billing_key,v_billing_key||':release')) AND operation_kind='cash_refund') THEN
    RAISE EXCEPTION 'IMAGE_PUBLICATION_BILLING_RELEASED' USING ERRCODE='22023';
  END IF;
  v_operation_id:=CASE WHEN v_row.quoted_price_yuan>0 THEN v_operation.id::text ELSE NULL END;
  v_meta := jsonb_build_object('purpose','admin_image_publication','validationId',p_validation_id,'imageRecordId',v_request.record_id,
    'configurationHash',p_configuration_hash,'modelSnapshotHash',p_model_snapshot_hash,'payloadFingerprint',v_request.payload_fingerprint,
    'sourceMode',v_mode,'sha256',p_evidence->>'sha256','size',p_verified_size,'contentType',p_verified_type,
    'width',(p_evidence->>'width')::integer,'height',(p_evidence->>'height')::integer,
    'billingReferenceId',v_billing_key,'billingOperationId',v_operation_id);
  SELECT count(*) INTO v_count FROM public.user_files WHERE storage_provider='tencent_cos' AND storage_key=p_verified_key;
  IF v_count>1 THEN RAISE EXCEPTION 'IMAGE_PUBLICATION_ASSET_COLLISION' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_asset FROM public.user_files WHERE storage_provider='tencent_cos' AND storage_key=p_verified_key FOR UPDATE;
  IF FOUND THEN
    IF v_asset.user_id::text IS DISTINCT FROM p_user_id OR v_asset.source IS DISTINCT FROM 'admin_image_publication'
      OR v_asset.file_size IS DISTINCT FROM p_verified_size OR v_asset.content_type IS DISTINCT FROM p_verified_type
      OR v_asset.file_category IS DISTINCT FROM 'image' OR v_asset.meta IS DISTINCT FROM v_meta OR v_asset.is_public IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'IMAGE_PUBLICATION_ASSET_COLLISION' USING ERRCODE='22023';
    END IF;
    v_asset_id := v_asset.id::text;
  ELSIF v_replayed THEN RAISE EXCEPTION 'IMAGE_PUBLICATION_ASSET_MISSING' USING ERRCODE='22023';
  ELSE
    v_asset_user_id:=p_user_id;
    INSERT INTO public.user_files(user_id,storage_key,storage_provider,file_name,file_category,file_size,content_type,source,meta,is_public)
    VALUES(v_asset_user_id,p_verified_key,'tencent_cos','validation-evidence','image',p_verified_size,p_verified_type,'admin_image_publication',v_meta,false)
    RETURNING id::text INTO v_asset_id;
  END IF;
  IF NOT v_replayed THEN
    UPDATE public.cover_models SET is_active=true,is_hidden=false,updated_at=now() WHERE id=v_model.id;
    UPDATE public.image_model_validations SET state='published',asset_id=v_asset_id,evidence=p_evidence,published_at=now(),updated_at=now()
      WHERE validation_id=p_validation_id;
  ELSIF v_row.asset_id IS DISTINCT FROM v_asset_id OR v_row.evidence IS DISTINCT FROM p_evidence THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_PUBLICATION_RECEIPT_CHANGED' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('success',true,'alreadyPublished',v_replayed,'modelId',v_model.id,'validationId',v_row.validation_id,'imageRecordId',v_row.image_record_id,'assetId',v_asset_id);
END;
$$;

-- Align authority to the protected table; do not inherit deployment-role privileges.
DO $delivery_owner_acl$
DECLARE
  v_owner oid; v_owner_name name; v_service oid := to_regrole('service_role');
  v_signature text; v_grantee oid; v_grantee_name name; v_definer boolean;
BEGIN
  IF v_service IS NULL OR to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_REQUIRED_ROLES_MISSING' USING ERRCODE='55000';
  END IF;
  SELECT relowner, pg_get_userbyid(relowner) INTO v_owner, v_owner_name
    FROM pg_class WHERE oid='public.cover_models'::regclass;
  IF v_owner IS NULL OR v_owner_name IS NULL THEN RAISE EXCEPTION 'DELIVERY_TABLE_OWNER_MISSING'; END IF;
  FOREACH v_signature IN ARRAY ARRAY['public.publish_image_model_validation_receipt(text,text,text,text,boolean,boolean,text,bigint,text,jsonb)'] LOOP
    IF to_regprocedure(v_signature) IS NULL THEN RAISE EXCEPTION 'DELIVERY_FUNCTION_MISSING:%',v_signature; END IF;
    v_definer := true;
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I',v_signature,v_owner_name);
    EXECUTE format('ALTER FUNCTION %s SECURITY %s',v_signature,CASE WHEN v_definer THEN 'DEFINER' ELSE 'INVOKER' END);
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp',v_signature);
    FOR v_grantee,v_grantee_name IN
      SELECT DISTINCT acl.grantee,coalesce(pg_get_userbyid(acl.grantee),'PUBLIC')::name
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE p.oid=to_regprocedure(v_signature) AND acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner
    LOOP
      IF v_grantee=0 THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',v_signature);
      ELSE EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',v_signature,v_grantee_name); END IF;
    END LOOP;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',v_signature);
    IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(v_signature)
      AND (p.proowner<>v_owner OR p.prosecdef IS DISTINCT FROM v_definer
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR NOT has_function_privilege(v_service,p.oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM pg_roles r WHERE NOT r.rolsuper AND r.oid NOT IN(v_owner,v_service)
          AND has_function_privilege(r.oid,p.oid,'EXECUTE'))
        OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.privilege_type='EXECUTE' AND a.grantee NOT IN(v_owner,v_service)))) THEN
      RAISE EXCEPTION 'DELIVERY_OWNER_EFFECTIVE_ACL_INVALID:%',v_signature USING ERRCODE='55000';
    END IF;
  END LOOP;
END;
$delivery_owner_acl$;


COMMIT;
