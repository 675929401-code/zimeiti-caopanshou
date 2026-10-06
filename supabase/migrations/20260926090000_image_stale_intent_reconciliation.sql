BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.reconcile_stale_image_generation_request_atomic(
  p_record_id text,
  p_user_id text,
  p_stale_after_seconds integer DEFAULT 600
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.image_generation_requests%ROWTYPE;
  v_price numeric(20, 6);
  v_billing_key text;
  v_charge public.wallet_operations%ROWTYPE;
  v_refund jsonb;
BEGIN
  IF trim(coalesce(p_record_id, '')) = ''
     OR trim(coalesce(p_user_id, '')) = ''
     OR p_stale_after_seconds IS NULL
     OR p_stale_after_seconds < 600
     OR p_stale_after_seconds > 86400 THEN
    RAISE EXCEPTION 'IMAGE_STALE_RECONCILIATION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_request
    FROM public.image_generation_requests
   WHERE record_id = trim(p_record_id)
     AND user_id = trim(p_user_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'not_found');
  END IF;

  IF v_request.state NOT IN ('intent', 'failed_unknown')
     OR v_request.response IS NOT NULL
     OR v_request.delivery_state <> 'held'
     OR v_request.delivery_asset_id IS NOT NULL THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'already_resolved', 'record', to_jsonb(v_request));
  END IF;
  IF v_request.updated_at > clock_timestamp() - make_interval(secs => p_stale_after_seconds) THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'not_stale', 'record', to_jsonb(v_request));
  END IF;
  IF v_request.request_snapshot IS NULL
     OR v_request.request_snapshot->>'schema' IS DISTINCT FROM 'image_generation_request_snapshot.v1'
     OR jsonb_typeof(v_request.request_snapshot->'quotedPriceYuan') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_request.request_snapshot->'billingExempt') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'IMAGE_STALE_RECONCILIATION_SNAPSHOT_INVALID';
  END IF;

  v_price := round((v_request.request_snapshot->>'quotedPriceYuan')::numeric, 2);
  IF v_price < 0 OR v_price > 1000000 THEN
    RAISE EXCEPTION 'IMAGE_STALE_RECONCILIATION_PRICE_INVALID';
  END IF;
  v_billing_key := 'image:h3_' || substr(encode(sha256(convert_to(
    trim(p_user_id) || ':' || v_request.client_idempotency_key, 'UTF8'
  )), 'hex'), 1, 48);

  SELECT * INTO v_charge
    FROM public.wallet_operations
   WHERE user_id = trim(p_user_id)
     AND operation_kind = 'cash_charge'
     AND idempotency_key = v_billing_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_charge.status <> 'completed' OR v_charge.amount <> v_price OR v_price <= 0 THEN
      RAISE EXCEPTION 'IMAGE_STALE_RECONCILIATION_BILLING_CONFLICT';
    END IF;
    v_refund := public.apply_wallet_operation_atomic(
      trim(p_user_id),
      'cash_refund',
      v_billing_key || ':release',
      v_charge.amount,
      '图片任务中断且未取得可交付结果，自动退回原请求费用',
      jsonb_build_object(
        'source', 'image.stale-intent-reconciliation',
        'record_id', v_request.record_id,
        'charge_operation_id', v_charge.id,
        'charge_idempotency_key', v_billing_key
      )
    );
    IF coalesce((v_refund->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'IMAGE_STALE_RECONCILIATION_REFUND_FAILED';
    END IF;
  ELSIF v_price > 0 THEN
    -- The request can be interrupted before budget reservation. In that case
    -- there is no charge to release, but it must still become retryable.
    v_refund := NULL;
  END IF;

  UPDATE public.image_generation_requests
     SET state = 'failed_unknown',
         response = jsonb_build_object(
           'schema', 'image_request_rejection.v1',
           'payloadFingerprint', v_request.payload_fingerprint,
           'source', 'platform',
           'code', 'IMAGE_PLATFORM_REQUEST_INTERRUPTED',
           'interruptedAt', clock_timestamp()
         ),
         updated_at = clock_timestamp()
   WHERE record_id = v_request.record_id
   RETURNING * INTO v_request;

  RETURN jsonb_build_object(
    'reconciled', true,
    'reason', 'stale_interrupted',
    'refunded', v_refund IS NOT NULL,
    'refund', v_refund,
    'record', to_jsonb(v_request)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_stale_image_generation_request_atomic(text,text,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_image_generation_request_atomic(text,text,integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
