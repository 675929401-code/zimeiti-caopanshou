-- Draft: forward migration, local review only. Does not seed acceptance or touch balances.
-- Dependencies: cover_models/users, image exactly-once, user_files, atomic wallet tables.
BEGIN;

CREATE TABLE public.image_model_validations (
  validation_id text PRIMARY KEY CHECK (validation_id ~ '^ivc_[a-f0-9]{64}$'),
  model_id text NOT NULL REFERENCES public.cover_models(id) ON DELETE RESTRICT,
  configuration_hash text NOT NULL CHECK (configuration_hash ~ '^[a-f0-9]{64}$'),
  model_snapshot_hash text NOT NULL CHECK (model_snapshot_hash ~ '^[a-f0-9]{64}$'),
  epoch integer NOT NULL CHECK (epoch >= 0),
  user_id text NOT NULL,
  client_idempotency_key text NOT NULL CHECK (client_idempotency_key ~ '^iav_[a-f0-9]{64}$'),
  client_trace_id text NOT NULL,
  image_record_id text NOT NULL CHECK (image_record_id ~ '^[a-f0-9]{64}$'),
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','unknown','rejected','completed','published')),
  quoted_price_yuan numeric NOT NULL CHECK (quoted_price_yuan >= 0 AND quoted_price_yuan::text NOT IN ('NaN','Infinity','-Infinity')),
  cost_price_yuan numeric NOT NULL CHECK (cost_price_yuan >= 0 AND cost_price_yuan::text NOT IN ('NaN','Infinity','-Infinity')),
  retest_reason text NOT NULL DEFAULT '',
  rejection_code text,
  rejection_http_status integer,
  asset_id text,
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT image_validation_config_epoch_unique UNIQUE(model_id,configuration_hash,epoch),
  CONSTRAINT image_validation_request_unique UNIQUE(image_record_id),
  CONSTRAINT image_validation_trace_matches CHECK (client_trace_id = client_idempotency_key)
);
CREATE UNIQUE INDEX image_validation_one_unresolved_model ON public.image_model_validations(model_id)
  WHERE state IN ('claimed','unknown');
ALTER TABLE public.image_model_validations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.image_model_validations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.image_model_validations TO service_role;
CREATE POLICY image_model_validations_service_read ON public.image_model_validations FOR SELECT TO service_role USING (true);

-- Populated separately by the local owner for the two explicitly reviewed pre-governance
-- public configurations only. No service-role insertion RPC exists and this is not acceptance.
CREATE TABLE public.image_model_legacy_baselines (
  model_id text PRIMARY KEY REFERENCES public.cover_models(id) ON DELETE RESTRICT,
  model_snapshot_hash text NOT NULL CHECK (model_snapshot_hash ~ '^[a-f0-9]{64}$'),
  configuration_hash text NOT NULL CHECK (configuration_hash ~ '^[a-f0-9]{64}$'),
  evidence_ref text NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 8 AND 500),
  established_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.image_model_legacy_baselines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.image_model_legacy_baselines FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.image_model_legacy_baselines TO service_role;
CREATE POLICY image_model_legacy_baselines_service_read ON public.image_model_legacy_baselines FOR SELECT TO service_role USING (true);

-- Hash the actual stored composite, including name-derived capabilities and every price/key field.
-- Only timestamps, sort order and publication flags are omitted. No secret enters a filter URL.
CREATE FUNCTION public.image_model_validation_snapshot(p_model public.cover_models) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT encode(sha256(convert_to((to_jsonb(p_model) - ARRAY['created_at','updated_at','sort_order','is_active','is_hidden'])::text,'UTF8')),'hex');
$$;

CREATE FUNCTION public.assert_image_validation_admin(p_user_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_user FROM public.users WHERE id::text = p_user_id;
  IF NOT FOUND OR v_user.role IS DISTINCT FROM 'admin' OR v_user.is_active IS DISTINCT FROM true
     OR (v_user.status IS NOT NULL AND v_user.status <> 'active') THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_ADMIN_REQUIRED' USING ERRCODE='42501';
  END IF;
END;
$$;

-- Server-only source for BOTH the public directory and ordinary generation admission.
-- Raw configuration must never be serialized from this RPC into a public response.
CREATE FUNCTION public.read_image_model_publication_state(p_model_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'model',to_jsonb(m),'modelSnapshotHash',public.image_model_validation_snapshot(m),
    'published',coalesce((SELECT jsonb_agg(jsonb_build_object('configurationHash',v.configuration_hash,
      'modelSnapshotHash',v.model_snapshot_hash)) FROM public.image_model_validations v
      WHERE v.model_id=m.id AND v.state='published'),'[]'::jsonb),
    'legacyBaseline',(SELECT jsonb_build_object('configurationHash',b.configuration_hash,
      'modelSnapshotHash',b.model_snapshot_hash,'evidenceRef',b.evidence_ref)
      FROM public.image_model_legacy_baselines b WHERE b.model_id=m.id)
  ) ORDER BY m.sort_order,m.id),'[]'::jsonb)
  FROM public.cover_models m WHERE (p_model_id IS NULL AND m.is_active=true AND m.is_hidden=false) OR m.id=p_model_id;
$$;

-- Private server-only read. The application must project an allowlisted DTO, never this model row.
CREATE FUNCTION public.read_image_model_validation_model(p_model_id text,p_user_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_model public.cover_models%ROWTYPE;
BEGIN
  PERFORM public.assert_image_validation_admin(p_user_id);
  SELECT * INTO v_model FROM public.cover_models WHERE id = p_model_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'IMAGE_VALIDATION_MODEL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('model',to_jsonb(v_model),'modelSnapshotHash',public.image_model_validation_snapshot(v_model));
END;
$$;

CREATE FUNCTION public.claim_image_model_validation(
  p_validation_id text,p_model_id text,p_user_id text,p_configuration_hash text,p_model_snapshot_hash text,
  p_epoch integer,p_client_key text,p_payload_fingerprint text,p_retest_reason text DEFAULT ''
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_model public.cover_models%ROWTYPE;
  v_row public.image_model_validations%ROWTYPE;
  v_previous public.image_model_validations%ROWTYPE;
  v_expected_id text;
  v_record_id text;
  v_user public.users%ROWTYPE;
BEGIN
  PERFORM public.assert_image_validation_admin(p_user_id);
  SELECT * INTO v_user FROM public.users WHERE id::text=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_user.role IS DISTINCT FROM 'admin' OR v_user.is_active IS DISTINCT FROM true
     OR (v_user.status IS NOT NULL AND v_user.status <> 'active') THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_ADMIN_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF p_epoch IS NULL OR p_epoch < 0 OR p_configuration_hash !~ '^[a-f0-9]{64}$'
     OR p_model_snapshot_hash !~ '^[a-f0-9]{64}$' OR p_payload_fingerprint !~ '^[a-f0-9]{64}$'
     OR p_client_key !~ '^iav_[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  v_expected_id := 'ivc_' || encode(sha256(convert_to('image-validation-claim:v1:' || p_model_id || ':' || p_configuration_hash || ':' || p_epoch::text,'UTF8')),'hex');
  IF p_validation_id IS DISTINCT FROM v_expected_id THEN RAISE EXCEPTION 'IMAGE_VALIDATION_CLAIM_MISMATCH' USING ERRCODE='22023'; END IF;
  v_record_id := encode(sha256(convert_to(p_user_id,'UTF8') || decode('00','hex') || convert_to(p_client_key,'UTF8')),'hex');
  SELECT * INTO v_model FROM public.cover_models WHERE id = p_model_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IMAGE_VALIDATION_MODEL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF public.image_model_validation_snapshot(v_model) IS DISTINCT FROM p_model_snapshot_hash THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_CONFIGURATION_CHANGED' USING ERRCODE='40001';
  END IF;
  IF v_model.selling_price IS NULL OR v_model.selling_price < 0 OR v_model.cost_price IS NULL OR v_model.cost_price < 0
     OR v_model.selling_price::text IN ('NaN','Infinity','-Infinity') OR v_model.cost_price::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_PRICE_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_row FROM public.image_model_validations WHERE validation_id=p_validation_id FOR UPDATE;
  IF FOUND THEN
    IF v_row.user_id <> p_user_id THEN RETURN jsonb_build_object('created',false,'busy',true); END IF;
    IF v_row.model_id <> p_model_id OR v_row.configuration_hash <> p_configuration_hash OR v_row.model_snapshot_hash <> p_model_snapshot_hash
       OR v_row.epoch <> p_epoch OR v_row.client_idempotency_key <> p_client_key OR v_row.payload_fingerprint <> p_payload_fingerprint
       OR v_row.image_record_id <> v_record_id THEN
      RAISE EXCEPTION 'IMAGE_VALIDATION_CLAIM_CONFLICT' USING ERRCODE='22023';
    END IF;
    RETURN jsonb_build_object('created',false,'busy',false,'record',to_jsonb(v_row));
  END IF;
  -- A changed credential/configuration must not release an unresolved provider request either.
  IF EXISTS (SELECT 1 FROM public.image_model_validations WHERE model_id=p_model_id AND state IN ('claimed','unknown')) THEN
    RETURN jsonb_build_object('created',false,'busy',true);
  END IF;
  SELECT * INTO v_previous FROM public.image_model_validations
    WHERE model_id=p_model_id AND configuration_hash=p_configuration_hash ORDER BY epoch DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF v_previous.state <> 'rejected' OR p_epoch <> v_previous.epoch + 1 OR length(trim(coalesce(p_retest_reason,''))) NOT BETWEEN 8 AND 300 THEN
      RAISE EXCEPTION 'IMAGE_VALIDATION_RETEST_NOT_ALLOWED' USING ERRCODE='22023';
    END IF;
  ELSIF p_epoch <> 0 THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_EPOCH_INVALID' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.image_model_validations(validation_id,model_id,configuration_hash,model_snapshot_hash,epoch,user_id,
    client_idempotency_key,client_trace_id,image_record_id,payload_fingerprint,quoted_price_yuan,cost_price_yuan,retest_reason)
  VALUES(p_validation_id,p_model_id,p_configuration_hash,p_model_snapshot_hash,p_epoch,p_user_id,p_client_key,p_client_key,
    v_record_id,p_payload_fingerprint,v_model.selling_price,v_model.cost_price,trim(coalesce(p_retest_reason,''))) RETURNING * INTO v_row;
  RETURN jsonb_build_object('created',true,'busy',false,'record',to_jsonb(v_row));
END;
$$;

-- Called only by the existing generator's confirmed outcome path, never by browser-supplied status.
CREATE FUNCTION public.record_image_model_validation_outcome(
  p_validation_id text,p_user_id text,p_outcome text,p_rejection_code text DEFAULT NULL,p_http_status integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_row public.image_model_validations%ROWTYPE; v_request public.image_generation_requests%ROWTYPE; v_user public.users%ROWTYPE;
BEGIN
  PERFORM public.assert_image_validation_admin(p_user_id);
  SELECT * INTO v_user FROM public.users WHERE id::text=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_user.role IS DISTINCT FROM 'admin' OR v_user.is_active IS DISTINCT FROM true
     OR (v_user.status IS NOT NULL AND v_user.status <> 'active') THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_ADMIN_REQUIRED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_row FROM public.image_model_validations WHERE validation_id=p_validation_id FOR UPDATE;
  IF NOT FOUND OR v_row.user_id <> p_user_id THEN RAISE EXCEPTION 'IMAGE_VALIDATION_OWNER_MISMATCH' USING ERRCODE='42501'; END IF;
  IF p_outcome NOT IN ('unknown','rejected','completed') OR p_outcome IS NULL THEN RAISE EXCEPTION 'IMAGE_VALIDATION_OUTCOME_INVALID' USING ERRCODE='22023'; END IF;
  IF v_row.state IN ('rejected','completed','published') THEN
    IF v_row.state <> p_outcome AND NOT (v_row.state='published' AND p_outcome='completed') THEN
      RAISE EXCEPTION 'IMAGE_VALIDATION_TERMINAL_CONFLICT' USING ERRCODE='22023';
    END IF;
    RETURN jsonb_build_object('record',to_jsonb(v_row));
  END IF;
  SELECT * INTO v_request FROM public.image_generation_requests WHERE record_id=v_row.image_record_id FOR UPDATE;
  IF FOUND AND (v_request.user_id<>v_row.user_id OR v_request.client_idempotency_key<>v_row.client_idempotency_key
    OR v_request.client_trace_id<>v_row.client_trace_id OR v_request.payload_fingerprint<>v_row.payload_fingerprint) THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_REQUEST_MISMATCH' USING ERRCODE='22023';
  END IF;
  IF p_outcome='completed' AND (v_request.record_id IS NULL OR v_request.state<>'completed'
     OR coalesce(v_request.response->>'selectedModelId','')<>v_row.model_id) THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_RESULT_INCOMPLETE' USING ERRCODE='22023';
  END IF;
  IF p_outcome='rejected' THEN
    IF v_request.record_id IS NULL OR v_request.state<>'failed_unknown'
       OR v_request.response->>'schema' IS DISTINCT FROM 'image_request_rejection.v1'
       OR v_request.response->>'payloadFingerprint' IS DISTINCT FROM v_row.payload_fingerprint
       OR v_request.response->>'code' IS DISTINCT FROM p_rejection_code THEN
      RAISE EXCEPTION 'IMAGE_VALIDATION_REJECTION_UNPROVEN' USING ERRCODE='22023';
    END IF;
    IF v_request.response->>'source'='input' THEN
      IF p_rejection_code IS DISTINCT FROM 'IMAGE_REFERENCE_READ_FAILED' OR p_http_status IS NOT NULL
         OR v_request.response->>'upstreamStatus' IS NOT NULL THEN
        RAISE EXCEPTION 'IMAGE_VALIDATION_REJECTION_UNPROVEN' USING ERRCODE='22023';
      END IF;
    ELSIF v_request.response->>'source'='provider' THEN
      IF p_http_status IS NULL OR p_http_status NOT IN (400,401,403,404,422)
         OR v_request.response->>'upstreamStatus' IS DISTINCT FROM p_http_status::text
         OR p_rejection_code IS NULL OR p_rejection_code NOT IN ('IMAGE_REFERENCE_REJECTED','IMAGE_UPSTREAM_REQUEST_REJECTED')
         OR (p_rejection_code='IMAGE_REFERENCE_REJECTED' AND p_http_status<>400) THEN
        RAISE EXCEPTION 'IMAGE_VALIDATION_REJECTION_UNPROVEN' USING ERRCODE='22023';
      END IF;
    ELSE
      RAISE EXCEPTION 'IMAGE_VALIDATION_REJECTION_UNPROVEN' USING ERRCODE='22023';
    END IF;
  END IF;
  IF p_outcome='unknown' AND v_request.state='completed' THEN RAISE EXCEPTION 'IMAGE_VALIDATION_RESULT_ALREADY_COMPLETED' USING ERRCODE='22023'; END IF;
  UPDATE public.image_model_validations SET state=p_outcome,updated_at=now(),
    rejection_code=CASE WHEN p_outcome='rejected' THEN p_rejection_code END,
    rejection_http_status=CASE WHEN p_outcome='rejected' THEN p_http_status END
    WHERE validation_id=p_validation_id RETURNING * INTO v_row;
  RETURN jsonb_build_object('record',to_jsonb(v_row));
END;
$$;

CREATE FUNCTION public.publish_image_model_validation(
  p_validation_id text,p_user_id text,p_configuration_hash text,p_model_snapshot_hash text,
  p_expected_active boolean,p_expected_hidden boolean,p_asset_id text,p_verified_key text,
  p_verified_size bigint,p_verified_type text,p_evidence jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_model public.cover_models%ROWTYPE; v_row public.image_model_validations%ROWTYPE;
  v_request public.image_generation_requests%ROWTYPE; v_asset public.user_files%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_model_id text; v_billing_key text; v_replayed boolean;
BEGIN
  PERFORM public.assert_image_validation_admin(p_user_id);
  -- The wallet mutation contract locks this same user row. Hold it while proving zero charge,
  -- so an operation cannot be inserted between the absence check and publication commit.
  SELECT * INTO v_user FROM public.users WHERE id::text=p_user_id FOR UPDATE;
  -- The unlocked precheck may have observed an administrator while a demotion was
  -- uncommitted. Validate the row returned after the lock wait, before any publication.
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
     OR coalesce(v_asset.meta->>'billingReferenceId','')<>v_billing_key
     OR coalesce(v_asset.meta->>'billingExempt','')<>'true' OR coalesce(v_asset.meta->>'billingExemptionReason','')<>'admin'
     OR coalesce(v_asset.meta->>'billingOperationId','')<>'' THEN
    RAISE EXCEPTION 'IMAGE_VALIDATION_BILLING_INCOMPLETE' USING ERRCODE='22023';
  END IF;
  -- Validation is current-admin-only. A paid ordinary task cannot be substituted for its receipt.
  PERFORM 1 FROM public.wallet_operations WHERE user_id=p_user_id AND idempotency_key=v_billing_key FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'IMAGE_VALIDATION_UNEXPECTED_CHARGE' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.wallet_ledger_entries WHERE user_id=p_user_id AND idempotency_key=v_billing_key FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'IMAGE_VALIDATION_UNEXPECTED_CHARGE' USING ERRCODE='22023'; END IF;
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

REVOKE ALL ON FUNCTION public.image_model_validation_snapshot(public.cover_models), public.assert_image_validation_admin(text),
  public.read_image_model_publication_state(text),
  public.read_image_model_validation_model(text,text), public.claim_image_model_validation(text,text,text,text,text,integer,text,text,text),
  public.record_image_model_validation_outcome(text,text,text,text,integer),
  public.publish_image_model_validation(text,text,text,text,boolean,boolean,text,text,bigint,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_image_model_validation_model(text,text),
  public.read_image_model_publication_state(text),
  public.claim_image_model_validation(text,text,text,text,text,integer,text,text,text),
  public.record_image_model_validation_outcome(text,text,text,text,integer),
  public.publish_image_model_validation(text,text,text,text,boolean,boolean,text,text,bigint,text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
