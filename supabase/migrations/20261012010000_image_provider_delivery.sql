-- Reviewed forward migration. Source only; apply requires the authoritative deployment gates.
-- Uses existing image_generation_requests and wallet_operations; no new columns.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE OR REPLACE FUNCTION public.finalize_image_provider_delivery(
  p_record_id text, p_user_id text, p_provider_url text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_row public.image_generation_requests%ROWTYPE;
  v_price numeric;
  v_key text;
BEGIN
  SELECT * INTO v_row FROM public.image_generation_requests
    WHERE record_id=p_record_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_row.state <> 'completed'
    OR v_row.response->>'deliveryMode' IS DISTINCT FROM 'provider_url'
    OR v_row.response->>'providerUrl' IS DISTINCT FROM p_provider_url
    OR p_provider_url IS NULL OR btrim(p_provider_url)=''
    OR NOT coalesce(p_provider_url ~ '^https?://[^[:space:]]+$',false)
    OR v_row.response->>'sourceExpiredAt' IS NOT NULL THEN
    RAISE EXCEPTION 'IMAGE_PROVIDER_DELIVERY_INVALID';
  END IF;
  v_price := (v_row.request_snapshot->>'quotedPriceYuan')::numeric;
  IF v_price IS NULL OR v_price < 0 THEN RAISE EXCEPTION 'IMAGE_DELIVERY_PRICE_INVALID'; END IF;
  v_key := 'image:h3_' || substr(encode(sha256(convert_to(p_user_id || ':' || v_row.client_idempotency_key,'UTF8')),'hex'),1,48);
  -- Privileged legacy callers may omit a client key; route derives admin_<trace hash>.
  IF v_row.client_idempotency_key = 'admin_' || substr(encode(sha256(convert_to(v_row.client_trace_id,'UTF8')),'hex'),1,48) THEN
    v_key := 'image:' || v_row.client_trace_id;
  END IF;
  IF v_price > 0 THEN
    PERFORM 1 FROM public.wallet_operations WHERE user_id=p_user_id
      AND operation_kind='cash_charge' AND idempotency_key=v_key
      AND status='completed' AND amount=v_price FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IMAGE_DELIVERY_BILLING_NOT_CONFIRMED'; END IF;
    PERFORM 1 FROM public.wallet_operations WHERE user_id=p_user_id
      AND operation_kind='cash_refund' AND idempotency_key IN (v_key,v_key || ':release') FOR UPDATE;
    IF FOUND THEN RAISE EXCEPTION 'IMAGE_DELIVERY_BILLING_RELEASED'; END IF;
  ELSIF coalesce((v_row.request_snapshot->>'billingExempt')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'IMAGE_DELIVERY_ZERO_PRICE_NOT_CONFIRMED';
  END IF;
  -- No user_files insert, media bytes or ledger mutation. Same row lock fences replays.
  UPDATE public.image_generation_requests SET delivery_state='delivered', updated_at=now()
    WHERE record_id=v_row.record_id AND delivery_state IS DISTINCT FROM 'delivered';
  RETURN jsonb_build_object('deliveryState','delivered','deliveryMode','provider_url');
END;
$$;
CREATE OR REPLACE FUNCTION public.mark_image_provider_source_expired(
  p_record_id text, p_user_id text, p_provider_url text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_row public.image_generation_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.image_generation_requests
    WHERE record_id=p_record_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_row.state <> 'completed' OR v_row.delivery_state <> 'delivered'
    OR v_row.response->>'deliveryMode' IS DISTINCT FROM 'provider_url'
    OR v_row.response->>'providerUrl' IS DISTINCT FROM p_provider_url
    OR p_provider_url IS NULL OR btrim(p_provider_url)=''
    OR NOT coalesce(p_provider_url ~ '^https?://[^[:space:]]+$',false) THEN
    RAISE EXCEPTION 'IMAGE_PROVIDER_EXPIRY_BINDING_INVALID';
  END IF;
  UPDATE public.image_generation_requests
    SET response=response || jsonb_build_object('sourceExpiredAt',coalesce(response->>'sourceExpiredAt',now()::text)), updated_at=now()
    WHERE record_id=v_row.record_id;
  -- Keep provider receipt, task and all financial evidence; only hide visible media.
  RETURN jsonb_build_object('sourceExpired',true);
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_image_provider_delivery(text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.mark_image_provider_source_expired(text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_image_provider_delivery(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_image_provider_source_expired(text,text,text) TO service_role;
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
  FOREACH v_signature IN ARRAY ARRAY['public.finalize_image_provider_delivery(text,text,text)',
    'public.mark_image_provider_source_expired(text,text,text)'] LOOP
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
