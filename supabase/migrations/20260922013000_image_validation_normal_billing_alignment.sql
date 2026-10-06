-- Align image-model validation publication with the normal administrator billing policy.
BEGIN;

CREATE OR REPLACE FUNCTION public.publish_image_model_validation(
  p_validation_id text,p_user_id text,p_configuration_hash text,p_model_snapshot_hash text,
  p_expected_active boolean,p_expected_hidden boolean,p_asset_id text,p_verified_key text,
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
  IF NOT FOUND OR v_request.user_id<>p_user_id OR v_request.client_idempotency_key<>v_row.client_idempotency_key
     OR v_request.client_trace_id<>v_row.client_trace_id OR v_request.payload_fingerprint<>v_row.payload_fingerprint
     OR v_request.state<>'completed' OR v_request.delivery_state<>'delivered'
     OR v_request.delivery_asset_id IS DISTINCT FROM p_asset_id
     OR coalesce(v_request.response->>'selectedModelId','')<>v_model.id THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_RESULT_INCOMPLETE' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_asset FROM public.user_files WHERE id::text=p_asset_id FOR UPDATE;
  IF NOT FOUND OR v_asset.user_id::text<>p_user_id OR v_asset.storage_provider<>'tencent_cos'
     OR v_asset.storage_key IS DISTINCT FROM p_verified_key OR v_asset.file_size IS DISTINCT FROM p_verified_size
     OR v_asset.content_type IS DISTINCT FROM p_verified_type OR p_verified_size IS NULL OR p_verified_size<=0
     OR p_verified_type NOT IN ('image/png','image/jpeg','image/webp')
     OR coalesce(v_request.response->>'storageKey','')<>v_asset.storage_key
     OR coalesce(v_request.response->>'storageProvider','')<>v_asset.storage_provider
     OR coalesce(v_request.response->>'fileSize','')<>v_asset.file_size::text
     OR coalesce(v_request.response->>'contentType','')<>v_asset.content_type
     OR coalesce(v_asset.meta->>'traceId','')<>v_row.client_trace_id OR coalesce(v_asset.meta->>'modelId','')<>v_model.id THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_ASSET_MISMATCH' USING ERRCODE='22023';
  END IF;
  v_billing_key := 'image:h3_' || substr(encode(sha256(convert_to(p_user_id || ':' || v_row.client_idempotency_key,'UTF8')),'hex'),1,48);
  IF v_model.selling_price IS DISTINCT FROM v_row.quoted_price_yuan OR v_model.cost_price IS DISTINCT FROM v_row.cost_price_yuan
     OR (v_request.response->>'selectedCostPrice')::numeric IS DISTINCT FROM v_row.cost_price_yuan
     OR (v_asset.meta->>'quotedPriceYuan')::numeric IS DISTINCT FROM v_row.quoted_price_yuan
     OR (v_asset.meta->>'actualCostPriceYuan')::numeric IS DISTINCT FROM v_row.cost_price_yuan
     OR coalesce(v_asset.meta->>'billingReferenceId','')<>v_billing_key THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_BILLING_INCOMPLETE' USING ERRCODE='22023';
  END IF;

  SELECT count(*)::integer INTO v_count FROM public.revenue_records
    WHERE user_id=p_user_id AND task_id=v_billing_key AND record_type='image';
  IF v_count<>1 THEN RAISE EXCEPTION 'IMAGE_VALIDATION_REVENUE_INCOMPLETE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_revenue FROM public.revenue_records
    WHERE user_id=p_user_id AND task_id=v_billing_key AND record_type='image' FOR UPDATE;
  IF v_revenue.model_id IS DISTINCT FROM v_model.id OR v_revenue.cost_price IS DISTINCT FROM v_row.cost_price_yuan
     OR v_revenue.selling_price IS DISTINCT FROM v_row.quoted_price_yuan
     OR v_revenue.cash_charged IS DISTINCT FROM v_row.quoted_price_yuan
     OR v_revenue.billing_exempt IS DISTINCT FROM (v_row.quoted_price_yuan=0) THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_REVENUE_INCOMPLETE' USING ERRCODE='22023';
  END IF;

  IF v_row.quoted_price_yuan=0 THEN
    IF coalesce(v_asset.meta->>'billingExempt','')<>'true'
       OR coalesce(v_asset.meta->>'billingExemptionReason','')<>'zero_price'
       OR coalesce(v_asset.meta->>'billingOperationId','')<>'' THEN
      RAISE EXCEPTION 'IMAGE_VALIDATION_BILLING_INCOMPLETE' USING ERRCODE='22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.wallet_operations WHERE user_id=p_user_id AND idempotency_key=v_billing_key)
       OR EXISTS (SELECT 1 FROM public.wallet_ledger_entries WHERE user_id=p_user_id AND idempotency_key=v_billing_key)
       OR EXISTS (SELECT 1 FROM public.cash_transactions WHERE user_id=p_user_id AND reference_id=v_billing_key) THEN
      RAISE EXCEPTION 'IMAGE_VALIDATION_UNEXPECTED_CHARGE' USING ERRCODE='22023';
    END IF;
  ELSE
    IF coalesce(v_asset.meta->>'billingExempt','')<>'false'
       OR coalesce(v_asset.meta->>'billingExemptionReason','')<>'none'
       OR coalesce(v_asset.meta->>'billingOperationId','')='' THEN
      RAISE EXCEPTION 'IMAGE_VALIDATION_BILLING_INCOMPLETE' USING ERRCODE='22023';
    END IF;
    SELECT count(*)::integer INTO v_count FROM public.wallet_operations
      WHERE user_id=p_user_id AND idempotency_key=v_billing_key;
    IF v_count<>1 THEN RAISE EXCEPTION 'IMAGE_VALIDATION_WALLET_INCOMPLETE' USING ERRCODE='22023'; END IF;
    SELECT * INTO v_operation FROM public.wallet_operations
      WHERE user_id=p_user_id AND idempotency_key=v_billing_key FOR UPDATE;
    SELECT count(*)::integer INTO v_count FROM public.wallet_ledger_entries
      WHERE user_id=p_user_id AND idempotency_key=v_billing_key;
    IF v_count<>1 THEN RAISE EXCEPTION 'IMAGE_VALIDATION_LEDGER_INCOMPLETE' USING ERRCODE='22023'; END IF;
    SELECT * INTO v_ledger FROM public.wallet_ledger_entries
      WHERE user_id=p_user_id AND idempotency_key=v_billing_key FOR UPDATE;
    SELECT count(*)::integer INTO v_count FROM public.cash_transactions
      WHERE user_id=p_user_id AND reference_id=v_billing_key;
    IF v_count<>1 THEN RAISE EXCEPTION 'IMAGE_VALIDATION_CASH_INCOMPLETE' USING ERRCODE='22023'; END IF;
    SELECT * INTO v_cash FROM public.cash_transactions
      WHERE user_id=p_user_id AND reference_id=v_billing_key FOR UPDATE;
    IF v_operation.wallet IS DISTINCT FROM 'cash' OR v_operation.operation_kind IS DISTINCT FROM 'cash_charge'
       OR v_operation.status IS DISTINCT FROM 'completed' OR v_operation.amount IS DISTINCT FROM v_row.quoted_price_yuan
       OR v_operation.delta IS DISTINCT FROM -v_row.quoted_price_yuan
       OR v_operation.id::text IS DISTINCT FROM coalesce(v_asset.meta->>'billingOperationId','')
       OR v_ledger.operation_id IS DISTINCT FROM v_operation.id OR v_ledger.wallet IS DISTINCT FROM 'cash'
       OR v_ledger.operation_kind IS DISTINCT FROM 'cash_charge' OR v_ledger.delta IS DISTINCT FROM -v_row.quoted_price_yuan
       OR v_cash.type IS DISTINCT FROM 'consume' OR v_cash.amount IS DISTINCT FROM v_row.quoted_price_yuan THEN
      RAISE EXCEPTION 'IMAGE_VALIDATION_BILLING_INCOMPLETE' USING ERRCODE='22023';
    END IF;
  END IF;

  IF p_evidence IS NULL OR p_evidence->>'schema' IS DISTINCT FROM 'image_decoded_asset.v1'
     OR coalesce(p_evidence->>'sha256','') !~ '^[a-f0-9]{64}$'
     OR (p_evidence->>'width')::integer IS DISTINCT FROM (v_request.response->>'width')::integer
     OR (p_evidence->>'height')::integer IS DISTINCT FROM (v_request.response->>'height')::integer
     OR coalesce((p_evidence->>'width')::integer,0)<=0 OR coalesce((p_evidence->>'height')::integer,0)<=0
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_evidence) AS key WHERE key NOT IN ('schema','sha256','width','height')) THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_DECODE_EVIDENCE_INVALID' USING ERRCODE='22023';
  END IF;
  IF NOT v_replayed THEN
    UPDATE public.cover_models SET is_active=true,is_hidden=false,updated_at=now() WHERE id=v_model.id;
    UPDATE public.image_model_validations SET state='published',asset_id=p_asset_id,evidence=p_evidence,published_at=now(),updated_at=now()
      WHERE validation_id=p_validation_id;
  ELSIF v_row.asset_id IS DISTINCT FROM p_asset_id OR v_row.evidence IS DISTINCT FROM p_evidence THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_PUBLICATION_RECEIPT_CHANGED' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('success',true,'alreadyPublished',v_replayed,'modelId',v_model.id,'validationId',v_row.validation_id,'imageRecordId',v_row.image_record_id,'assetId',p_asset_id);
END;
$$;

COMMIT;
