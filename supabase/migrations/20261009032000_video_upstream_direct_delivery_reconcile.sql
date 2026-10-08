-- Reconcile the historical direct-delivery migration without replaying its
-- non-idempotent unconditional function rename. Preserve the legacy function
-- once, then make the current provider-URL delivery implementation canonical.
BEGIN;

DO $reconcile$
BEGIN
  IF to_regprocedure('public.finalize_video_generation_task_persistent_v1(text,text,text,text,bigint,boolean)') IS NULL THEN
    IF to_regprocedure('public.finalize_video_generation_task_atomic(text,text,text,text,bigint,boolean)') IS NULL THEN
      RAISE EXCEPTION 'VIDEO_FINALIZER_PREREQUISITE_MISSING';
    END IF;
    ALTER FUNCTION public.finalize_video_generation_task_atomic(text, text, text, text, bigint, boolean)
      RENAME TO finalize_video_generation_task_persistent_v1;
  END IF;
END
$reconcile$;
CREATE OR REPLACE FUNCTION public.finalize_video_generation_task_atomic(
  p_task_id text,
  p_user_id text,
  p_provider_task_id text,
  p_stable_storage_url text,
  p_billing_operation_id bigint DEFAULT NULL,
  p_legacy_h3_settled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_operation public.wallet_operations%ROWTYPE;
  v_h3 public.autodl_h3_settlements%ROWTYPE;
  v_provider_task_id text := nullif(trim(coalesce(p_provider_task_id, '')), '');
  v_delivery_url text := trim(coalesce(p_stable_storage_url, ''));
  v_persistent boolean := v_delivery_url ~ '^object://tencent_cos/[^?#]+$';
  v_price numeric(14,4);
  v_paid boolean;
  v_charged numeric(14,4) := 0;
  v_billing_state text;
BEGIN
  IF NOT v_persistent AND v_delivery_url !~ '^https?://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'VIDEO_DELIVERY_SOURCE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_task
    FROM public.video_tasks
   WHERE id::text = trim(p_task_id)
     AND user_id::text = trim(p_user_id)
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VIDEO_TASK_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  IF v_persistent THEN
    IF v_task.storage_url IS DISTINCT FROM v_delivery_url THEN
      RAISE EXCEPTION 'VIDEO_STABLE_ASSET_MISMATCH' USING ERRCODE = '22023';
    END IF;
  ELSIF v_task.provider_result_url IS DISTINCT FROM v_delivery_url THEN
    RAISE EXCEPTION 'VIDEO_PROVIDER_RESULT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  IF v_provider_task_id IS NOT NULL
     AND v_task.task_id_external IS NOT NULL
     AND v_task.task_id_external IS DISTINCT FROM v_provider_task_id THEN
    RAISE EXCEPTION 'VIDEO_PROVIDER_TASK_CONFLICT' USING ERRCODE = '23505';
  END IF;
  IF v_task.billing_price_yuan IS NULL
     OR v_task.billing_cost_price_yuan IS NULL
     OR v_task.billing_price_yuan < 0
     OR v_task.billing_cost_price_yuan < 0 THEN
    RAISE EXCEPTION 'VIDEO_PRICE_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_price := round(v_task.billing_price_yuan, 4);
  v_paid := coalesce(v_task.billing_exempt, false) IS NOT TRUE
    AND coalesce(v_task.explicitly_free, false) IS NOT TRUE
    AND round(v_price, 2) > 0;
  IF coalesce(v_task.billing_exempt, false) IS NOT TRUE
     AND coalesce(v_task.explicitly_free, false) IS NOT TRUE
     AND round(v_price, 2) <= 0 THEN
    RAISE EXCEPTION 'VIDEO_PRICE_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF v_task.status = 'completed'
     AND v_task.video_url = v_delivery_url
     AND (
       (v_persistent AND v_task.storage_url = v_delivery_url)
       OR (NOT v_persistent AND v_task.storage_url IS NULL AND v_task.provider_result_url = v_delivery_url)
     )
     AND (
       (v_paid AND v_task.billing_state IN ('settled', 'legacy_h3_settled')
        AND round(coalesce(v_task.price_charged, 0), 2) = round(v_price, 2))
       OR (NOT v_paid AND v_task.billing_state = 'not_required'
           AND coalesce(v_task.price_charged, 0) = 0)
     ) THEN
    RETURN jsonb_build_object(
      'status', 'completed',
      'already_completed', true,
      'billing_state', v_task.billing_state,
      'price_charged', v_task.price_charged,
      'stable_storage_url', v_delivery_url
    );
  END IF;

  IF v_paid THEN
    IF coalesce(p_legacy_h3_settled, false) THEN
      IF NOT v_persistent THEN
        RAISE EXCEPTION 'VIDEO_LEGACY_H3_REQUIRES_PERSISTENT_ASSET' USING ERRCODE = '22023';
      END IF;
      SELECT * INTO v_h3
        FROM public.autodl_h3_settlements
       WHERE video_task_internal_id = v_task.id::text
         AND user_id::text = v_task.user_id::text
         AND model_id::text = v_task.model_id::text
         AND stable_asset_url = v_delivery_url
       FOR UPDATE;
      IF NOT FOUND
         OR round(v_h3.price_yuan, 4) <> v_price
         OR round(v_h3.charged_yuan, 4) <> v_price THEN
        RAISE EXCEPTION 'VIDEO_LEGACY_H3_SETTLEMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      v_charged := v_price;
      v_billing_state := 'legacy_h3_settled';
    ELSE
      IF p_billing_operation_id IS NULL OR trim(coalesce(v_task.billing_idempotency_key, '')) = '' THEN
        RAISE EXCEPTION 'VIDEO_BILLING_OPERATION_REQUIRED' USING ERRCODE = '22023';
      END IF;
      SELECT * INTO v_operation
        FROM public.wallet_operations
       WHERE id = p_billing_operation_id
         AND user_id = v_task.user_id::text
         AND wallet = 'cash'
         AND operation_kind = 'cash_charge'
         AND idempotency_key = v_task.billing_idempotency_key
       FOR UPDATE;
      IF NOT FOUND
         OR v_operation.status <> 'completed'
         OR round(v_operation.amount, 4) <> v_price
         OR round(v_operation.delta, 4) <> -v_price THEN
        RAISE EXCEPTION 'VIDEO_BILLING_OPERATION_INVALID' USING ERRCODE = '22023';
      END IF;
      v_charged := v_price;
      v_billing_state := 'settled';
    END IF;
  ELSE
    IF p_billing_operation_id IS NOT NULL OR coalesce(p_legacy_h3_settled, false) THEN
      RAISE EXCEPTION 'VIDEO_FREE_TASK_MUST_NOT_CHARGE' USING ERRCODE = '22023';
    END IF;
    v_charged := 0;
    v_billing_state := 'not_required';
  END IF;

  UPDATE public.video_tasks
     SET status = 'completed',
         task_id_external = coalesce(v_provider_task_id, task_id_external),
         video_url = v_delivery_url,
         storage_url = CASE WHEN v_persistent THEN v_delivery_url ELSE NULL END,
         provider_result_url = CASE WHEN v_persistent THEN provider_result_url ELSE v_delivery_url END,
         needs_proxy = NOT v_persistent,
         price_charged = v_charged,
         billing_state = v_billing_state,
         billing_operation_id = CASE WHEN v_paid AND NOT coalesce(p_legacy_h3_settled, false)
           THEN p_billing_operation_id ELSE billing_operation_id END,
         error_message = NULL,
         completed_at = now()
   WHERE id = v_task.id
   RETURNING * INTO v_task;

  RETURN jsonb_build_object(
    'status', v_task.status,
    'already_completed', false,
    'billing_state', v_task.billing_state,
    'price_charged', v_task.price_charged,
    'stable_storage_url', v_delivery_url,
    'billing_operation_id', v_task.billing_operation_id
  );
END
$$;

REVOKE ALL ON FUNCTION public.finalize_video_generation_task_atomic(text, text, text, text, bigint, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_video_generation_task_atomic(text, text, text, text, bigint, boolean)
  TO service_role;

COMMIT;
