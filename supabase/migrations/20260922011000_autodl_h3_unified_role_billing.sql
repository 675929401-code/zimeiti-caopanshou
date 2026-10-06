-- MiniMax H3 finalization uses one billing rule for every active account.
-- The account role is retained for revenue audit only and never grants a free
-- generation. Replacing the function in a new migration preserves history and
-- makes the database terminal boundary agree with the application routes.

CREATE OR REPLACE FUNCTION autodl_h3_finalize_video(
  p_job_id uuid,
  p_public_task_id text,
  p_video_task_internal_id text,
  p_user_id text,
  p_model_id text,
  p_upstream_task_id text,
  p_owner text,
  p_lease_token bigint,
  p_result_asset_url text,
  p_price_yuan numeric,
  p_cost_price numeric,
  p_response_ms bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_job autodl_h3_jobs%ROWTYPE;
  v_task video_tasks%ROWTYPE;
  v_model video_models%ROWTYPE;
  v_user users%ROWTYPE;
  v_existing autodl_h3_settlements%ROWTYPE;
  v_charged numeric(14,4) := 0;
  v_balance numeric;
  v_ledger_user_id uuid;
  v_reference text := 'autodl_h3:' || p_public_task_id;
BEGIN
  SELECT * INTO v_job FROM autodl_h3_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.public_task_id IS DISTINCT FROM p_public_task_id
     OR v_job.video_task_internal_id IS DISTINCT FROM p_video_task_internal_id
     OR v_job.user_id::text IS DISTINCT FROM p_user_id
     OR v_job.model_id IS DISTINCT FROM p_model_id
     OR v_job.upstream_task_id IS DISTINCT FROM p_upstream_task_id
     OR v_job.lease_owner IS DISTINCT FROM p_owner OR v_job.lease_token IS DISTINCT FROM p_lease_token
     OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= now() THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_existing FROM autodl_h3_settlements WHERE job_id = p_job_id FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('committed', true, 'already_committed', true,
      'stable_asset_url', v_existing.stable_asset_url, 'charged_yuan', v_existing.charged_yuan);
  END IF;

  IF v_job.state <> 'FINALIZING' THEN RAISE EXCEPTION 'AUTODL_H3_FINALIZE_STATE_INVALID'; END IF;
  IF p_result_asset_url !~ '^object://tencent_cos/[^?#]+$' THEN RAISE EXCEPTION 'AUTODL_H3_FINALIZE_ASSET_INVALID'; END IF;
  IF p_price_yuan IS NULL OR p_cost_price IS NULL OR p_response_ms IS NULL
     OR p_price_yuan < 0 OR p_cost_price < 0 OR p_response_ms < 0
     OR jsonb_typeof(v_job.request_payload->'billingPriceYuan') <> 'number'
     OR jsonb_typeof(v_job.request_payload->'billingCostPrice') <> 'number'
     OR COALESCE((v_job.request_payload->>'billingPriceYuan')::numeric <> p_price_yuan, true)
     OR COALESCE((v_job.request_payload->>'billingCostPrice')::numeric <> p_cost_price, true) THEN
    RAISE EXCEPTION 'AUTODL_H3_FINALIZE_BILLING_SNAPSHOT_MISMATCH';
  END IF;

  SELECT * INTO v_task FROM video_tasks WHERE id::text = p_video_task_internal_id FOR UPDATE;
  IF NOT FOUND OR v_task.user_id::text IS DISTINCT FROM p_user_id
     OR v_task.model_id::text IS DISTINCT FROM p_model_id
     OR v_task.task_id_external::text IS DISTINCT FROM p_public_task_id
     OR v_task.status NOT IN ('pending','queued','processing','finalizing') THEN
    RAISE EXCEPTION 'AUTODL_H3_FINALIZE_VIDEO_TASK_MISMATCH';
  END IF;

  SELECT * INTO v_model FROM video_models WHERE id::text = p_model_id;
  IF NOT FOUND OR v_model.provider IS DISTINCT FROM 'autodl_h3_selfhost'
     OR v_model.protocol_type IS DISTINCT FROM 'autodl_h3_selfhost'
     OR v_model.model_name IS DISTINCT FROM 'minimax-h3-turbo'
     OR v_model.api_endpoint IS DISTINCT FROM 'http://127.0.0.1:16011/v1/video/generations'
     OR v_model.api_key IS DISTINCT FROM 'secret://autodl-h3-selfhost'
     OR v_model.is_active IS NOT TRUE OR v_model.is_hidden IS TRUE THEN
    RAISE EXCEPTION 'AUTODL_H3_FINALIZE_MODEL_BINDING_INVALID';
  END IF;

  SELECT * INTO v_user FROM users WHERE id::text = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTODL_H3_FINALIZE_USER_MISSING'; END IF;
  IF p_user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'AUTODL_H3_FINALIZE_LEDGER_USER_ID_INVALID';
  END IF;
  v_ledger_user_id := p_user_id::uuid;

  IF p_price_yuan > 0 THEN
    v_balance := COALESCE(v_user.cash_balance, 0);
    IF v_balance < p_price_yuan THEN RAISE EXCEPTION 'AUTODL_H3_FINALIZE_INSUFFICIENT_CASH'; END IF;
    v_balance := v_balance - p_price_yuan;
    v_charged := p_price_yuan;
    UPDATE users SET cash_balance = v_balance,
      total_cash_consumed = COALESCE(total_cash_consumed, 0) + p_price_yuan,
      updated_at = now() WHERE id::text = p_user_id;
    INSERT INTO cash_transactions(user_id, amount, balance_after, type, description, reference_id, created_at)
    VALUES (v_ledger_user_id, p_price_yuan, v_balance, 'consume', '视频生成: ' || COALESCE(v_model.name, p_model_id), v_reference, now());
  END IF;

  UPDATE video_tasks SET status = 'completed', video_url = p_result_asset_url,
    storage_url = p_result_asset_url, needs_proxy = false, price_charged = v_charged,
    completed_at = now(), error_message = NULL
  WHERE id::text = p_video_task_internal_id;

  INSERT INTO revenue_records(user_id, model_id, task_id, cost_price, selling_price,
    is_admin, billing_exempt, record_type, credits_charged, cash_charged)
  VALUES (v_ledger_user_id, p_model_id, p_public_task_id, p_cost_price, p_price_yuan,
    COALESCE(v_user.role, 'student') = 'admin', false, 'video', 0, v_charged);

  UPDATE autodl_h3_jobs SET state = 'SUCCEEDED', progress = 100,
    result_asset_url = p_result_asset_url, completed_at = now(), updated_at = now(),
    error_code = NULL, error_message = NULL WHERE id = p_job_id;
  INSERT INTO autodl_h3_settlements(job_id, public_task_id, video_task_internal_id,
    user_id, model_id, upstream_task_id, stable_asset_url, price_yuan, cost_price,
    charged_yuan, response_ms)
  VALUES (p_job_id, p_public_task_id, p_video_task_internal_id, p_user_id, p_model_id,
    p_upstream_task_id, p_result_asset_url, p_price_yuan, p_cost_price, v_charged, p_response_ms);
  UPDATE autodl_h3_instance_state SET activity_epoch = activity_epoch + 1,
    last_activity_at = now(), idle_since = NULL, updated_at = now()
  WHERE instance_uuid = v_job.instance_uuid;
  RETURN jsonb_build_object('committed', true, 'already_committed', false,
    'stable_asset_url', p_result_asset_url, 'charged_yuan', v_charged);
END
$function$;

REVOKE ALL ON FUNCTION autodl_h3_finalize_video(uuid, text, text, text, text, text, text, bigint, text, numeric, numeric, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION autodl_h3_finalize_video(uuid, text, text, text, text, text, text, bigint, text, numeric, numeric, bigint) TO service_role;
