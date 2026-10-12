-- Reviewed forward migration. Source only; apply requires the authoritative deployment gates.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE OR REPLACE FUNCTION public.complete_image_ephemeral_delivery(
  p_record_id text, p_user_id text, p_client_trace_id text, p_payload_fingerprint text,
  p_dispatch_receipt_sha256 text, p_submission_receipt_sha256 text,
  p_billing_reference_id text, p_metadata jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_row public.image_generation_requests%ROWTYPE;
  v_price numeric;
  v_key text;
  v_operation_id text;
  v_receipt jsonb;
BEGIN
  IF jsonb_typeof(p_metadata) IS DISTINCT FROM 'object'
    OR octet_length(p_metadata::text)>4096
    OR (p_metadata - ARRAY['schema','deliveryMode','recordId','contentType','sha256','byteLength','width','height','selectedModelId','selectedCostPrice','mediaAvailable','canRecover']::text[]) <> '{}'::jsonb
    OR p_metadata->>'schema' IS DISTINCT FROM 'image_ephemeral_receipt.v1'
    OR p_metadata->>'deliveryMode' IS DISTINCT FROM 'inline_ephemeral'
    OR p_metadata->>'recordId' IS DISTINCT FROM p_record_id
    OR coalesce(p_metadata->>'sha256','') !~ '^[a-f0-9]{64}$'
    OR coalesce(p_metadata->>'contentType','') NOT IN ('image/png','image/jpeg','image/webp')
    OR jsonb_typeof(p_metadata->'byteLength') IS DISTINCT FROM 'number'
    OR coalesce(p_metadata->>'byteLength','') !~ '^[0-9]+$'
    OR (p_metadata->>'byteLength')::bigint NOT BETWEEN 1 AND 31457280
    OR jsonb_typeof(p_metadata->'width') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_metadata->'height') IS DISTINCT FROM 'number'
    OR coalesce(p_metadata->>'width','') !~ '^[0-9]+$'
    OR coalesce(p_metadata->>'height','') !~ '^[0-9]+$'
    OR (p_metadata->>'width')::integer NOT BETWEEN 1 AND 32768
    OR (p_metadata->>'height')::integer NOT BETWEEN 1 AND 32768
    OR coalesce(p_metadata->>'selectedModelId','') !~ '^[A-Za-z0-9_.:/-]{1,200}$'
    OR jsonb_typeof(p_metadata->'selectedCostPrice') IS DISTINCT FROM 'number'
    OR (p_metadata->>'selectedCostPrice')::numeric < 0
    OR p_metadata->'mediaAvailable' IS DISTINCT FROM 'false'::jsonb
    OR p_metadata->'canRecover' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'IMAGE_EPHEMERAL_METADATA_INVALID';
  END IF;
  SELECT * INTO v_row FROM public.image_generation_requests
    WHERE record_id=p_record_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_row.client_trace_id IS DISTINCT FROM p_client_trace_id
    OR v_row.payload_fingerprint IS DISTINCT FROM p_payload_fingerprint
    OR coalesce(p_dispatch_receipt_sha256,'') !~ '^[a-f0-9]{64}$'
    OR coalesce(p_submission_receipt_sha256,'') !~ '^[a-f0-9]{64}$'
    OR v_row.provider_dispatch_receipt->>'receiptSha256' IS DISTINCT FROM p_dispatch_receipt_sha256
    OR v_row.provider_submission_receipt->>'receiptSha256' IS DISTINCT FROM p_submission_receipt_sha256
    OR v_row.provider_submission_receipt->>'dispatchReceiptSha256' IS DISTINCT FROM p_dispatch_receipt_sha256
    OR v_row.provider_submission_receipt->>'transportState' IS DISTINCT FROM 'response_received'
    OR coalesce((v_row.provider_submission_receipt->>'responseStatus')::integer,0) NOT BETWEEN 200 AND 299 THEN
    RAISE EXCEPTION 'IMAGE_EPHEMERAL_REQUEST_BINDING_INVALID';
  END IF;
  v_price := (v_row.request_snapshot->>'quotedPriceYuan')::numeric;
  IF v_price IS NULL OR v_price < 0 THEN RAISE EXCEPTION 'IMAGE_DELIVERY_PRICE_INVALID'; END IF;
  v_key := 'image:h3_' || substr(encode(sha256(convert_to(p_user_id || ':' || v_row.client_idempotency_key,'UTF8')),'hex'),1,48);
  IF v_row.client_idempotency_key = 'admin_' || substr(encode(sha256(convert_to(v_row.client_trace_id,'UTF8')),'hex'),1,48) THEN
    v_key := 'image:' || v_row.client_trace_id;
  END IF;
  IF p_billing_reference_id IS DISTINCT FROM v_key THEN RAISE EXCEPTION 'IMAGE_EPHEMERAL_BILLING_BINDING_INVALID'; END IF;
  IF v_price > 0 THEN
    SELECT id::text INTO v_operation_id FROM public.wallet_operations
      WHERE user_id=p_user_id AND operation_kind='cash_charge' AND idempotency_key=v_key
        AND status='completed' AND amount=v_price FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IMAGE_DELIVERY_BILLING_NOT_CONFIRMED'; END IF;
    PERFORM 1 FROM public.wallet_operations WHERE user_id=p_user_id
      AND operation_kind='cash_refund' AND idempotency_key IN (v_key,v_key || ':release') FOR UPDATE;
    IF FOUND THEN RAISE EXCEPTION 'IMAGE_DELIVERY_BILLING_RELEASED'; END IF;
  ELSIF coalesce((v_row.request_snapshot->>'billingExempt')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'IMAGE_DELIVERY_ZERO_PRICE_NOT_CONFIRMED';
  END IF;
  v_receipt := p_metadata || jsonb_build_object('billingReferenceId',v_key,'cashCharged',v_price,'billingOperationId',v_operation_id);
  IF v_row.state='completed' THEN
    IF v_row.response IS DISTINCT FROM v_receipt OR v_row.delivery_state IS DISTINCT FROM 'delivered'
      OR v_row.delivery_asset_id IS NOT NULL THEN RAISE EXCEPTION 'IMAGE_EPHEMERAL_RESULT_CONFLICT'; END IF;
    RETURN jsonb_build_object('record',to_jsonb(v_row));
  END IF;
  IF v_row.state IS DISTINCT FROM 'intent' OR v_row.response IS NOT NULL
    OR v_row.delivery_asset_id IS NOT NULL THEN RAISE EXCEPTION 'IMAGE_EPHEMERAL_STATE_CONFLICT'; END IF;
  -- One row lock, one metadata transition. Existing charge is only verified.
  UPDATE public.image_generation_requests SET state='completed', response=v_receipt,
    delivery_state='delivered', updated_at=now() WHERE record_id=v_row.record_id RETURNING * INTO v_row;
  RETURN jsonb_build_object('record',to_jsonb(v_row));
END;
$$;
REVOKE ALL ON FUNCTION public.complete_image_ephemeral_delivery(text,text,text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_image_ephemeral_delivery(text,text,text,text,text,text,text,jsonb) TO service_role;

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
    FROM pg_class WHERE oid='public.image_generation_requests'::regclass;
  IF v_owner IS NULL OR v_owner_name IS NULL THEN RAISE EXCEPTION 'DELIVERY_TABLE_OWNER_MISSING'; END IF;
  FOREACH v_signature IN ARRAY ARRAY['public.complete_image_ephemeral_delivery(text,text,text,text,text,text,text,jsonb)'] LOOP
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
