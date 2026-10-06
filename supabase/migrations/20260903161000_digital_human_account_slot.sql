BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE OR REPLACE FUNCTION public.reserve_video_generation_task_atomic(p_task_id text, p_user_id text, p_model_id text, p_client_request_id text, p_request_fingerprint text, p_billing_price_yuan numeric, p_billing_cost_price_yuan numeric, p_billing_unit text, p_billing_quantity numeric, p_explicitly_free boolean, p_billing_exempt boolean, p_provider_task_id text DEFAULT NULL::text, p_task_label text DEFAULT NULL::text, p_batch_id text DEFAULT NULL::text, p_batch_topic text DEFAULT NULL::text, p_card_index integer DEFAULT NULL::integer, p_prompt text DEFAULT ''::text, p_first_frame_url text DEFAULT NULL::text, p_last_frame_url text DEFAULT NULL::text, p_reference_image_url text DEFAULT NULL::text, p_aspect_ratio text DEFAULT '16:9'::text, p_resolution text DEFAULT NULL::text, p_duration_seconds numeric DEFAULT 5, p_content_url text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_task_user_id public.video_tasks.user_id%TYPE;
  v_created boolean := false;
  v_price numeric(14,4);
  v_cost numeric(14,4);
  v_quantity numeric(14,4);
  v_client_request_id text := trim(coalesce(p_client_request_id, ''));
  v_fingerprint text := lower(trim(coalesce(p_request_fingerprint, '')));
  v_provider_task_id text := nullif(trim(coalesce(p_provider_task_id, '')), '');
BEGIN
  IF p_duration_seconds IS NOT NULL AND (p_duration_seconds::text IN ('NaN', 'Infinity', '-Infinity') OR p_duration_seconds <= 0) THEN
    RAISE EXCEPTION 'VIDEO_TASK_DURATION_INVALID' USING ERRCODE = '22023';
  END IF;
  IF trim(coalesce(p_task_id, '')) = ''
     OR trim(coalesce(p_user_id, '')) = ''
     OR trim(coalesce(p_model_id, '')) = ''
     OR v_client_request_id !~ '^[A-Za-z0-9._:-]{8,128}$'
     OR v_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'VIDEO_TASK_RESERVATION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- Existing video_tasks.user_id is UUID; assign through its column type.
  v_task_user_id := trim(p_user_id);
  IF p_billing_price_yuan IS NULL
     OR p_billing_cost_price_yuan IS NULL
     OR p_billing_quantity IS NULL
     OR p_billing_price_yuan::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_billing_cost_price_yuan::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_billing_quantity::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'VIDEO_TASK_PRICE_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_price := round(p_billing_price_yuan, 4);
  v_cost := round(p_billing_cost_price_yuan, 4);
  v_quantity := round(p_billing_quantity, 4);
  IF v_price < 0 OR v_cost < 0 OR v_quantity <= 0
     OR trim(coalesce(p_billing_unit, '')) NOT IN ('per_use', 'output_second')
     OR (coalesce(p_explicitly_free, false) IS NOT TRUE
         AND coalesce(p_billing_exempt, false) IS NOT TRUE
         AND round(v_price, 2) <= 0) THEN
    RAISE EXCEPTION 'VIDEO_TASK_PRICE_SNAPSHOT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- A per-account slot prevents duplicate browser tabs from submitting separate paid
  -- digital-human jobs. Different accounts have independent locks and run concurrently.
  IF coalesce(p_task_label, '') LIKE 'digital-human:%' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('digital-human-account:' || trim(p_user_id), 0));
  END IF;

  -- Serialize first submit and all concurrent replays for the same account key.
  PERFORM pg_advisory_xact_lock(hashtextextended(trim(p_user_id) || ':' || v_client_request_id, 0));

  SELECT * INTO v_task
    FROM public.video_tasks
   WHERE user_id::text = trim(p_user_id)
     AND client_request_id = v_client_request_id
   FOR UPDATE;

  IF FOUND THEN
    IF v_task.id::text IS DISTINCT FROM trim(p_task_id)
       OR v_task.model_id::text IS DISTINCT FROM trim(p_model_id)
       OR v_task.request_fingerprint IS DISTINCT FROM v_fingerprint
       OR v_task.billing_price_yuan IS DISTINCT FROM v_price
       OR v_task.billing_cost_price_yuan IS DISTINCT FROM v_cost
       OR v_task.billing_unit IS DISTINCT FROM trim(p_billing_unit)
       OR v_task.billing_quantity IS DISTINCT FROM v_quantity
       OR coalesce(v_task.explicitly_free, false) IS DISTINCT FROM coalesce(p_explicitly_free, false)
       OR coalesce(v_task.billing_exempt, false) IS DISTINCT FROM coalesce(p_billing_exempt, false)
       OR (v_provider_task_id IS NOT NULL
           AND v_task.task_id_external IS NOT NULL
           AND v_task.task_id_external IS DISTINCT FROM v_provider_task_id) THEN
      RAISE EXCEPTION 'VIDEO_REQUEST_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'created', false,
      'task_id', v_task.id,
      'status', v_task.status,
      'billing_state', v_task.billing_state,
      'provider_task_id', coalesce(v_task.task_id_external, '')
    );
  END IF;

  IF coalesce(p_task_label, '') LIKE 'digital-human:%' AND EXISTS (
    SELECT 1 FROM public.video_tasks
    WHERE user_id::text = trim(p_user_id)
      AND task_label LIKE 'digital-human:%'
      AND status NOT IN ('completed', 'failed', 'cancelled', 'expired')
  ) THEN
    RAISE EXCEPTION 'DIGITAL_HUMAN_ACCOUNT_BUSY' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.video_tasks (
    id, user_id, model_id, task_label, batch_id, batch_topic, card_index,
    prompt, first_frame_url, last_frame_url, reference_image_url,
    aspect_ratio, resolution, duration_seconds, status, task_id_external,
    content_url, error_message, price_charged, completed_at,
    client_request_id, request_fingerprint, billing_price_yuan,
    billing_cost_price_yuan, billing_unit, billing_quantity, billing_state,
    billing_idempotency_key, explicitly_free, billing_exempt
  ) VALUES (
    trim(p_task_id), v_task_user_id, trim(p_model_id), p_task_label,
    p_batch_id, p_batch_topic, p_card_index, coalesce(p_prompt, ''),
    p_first_frame_url, p_last_frame_url, p_reference_image_url,
    coalesce(nullif(trim(p_aspect_ratio), ''), '16:9'), p_resolution,
    greatest(coalesce(p_duration_seconds, 5), 1), 'pending',
    v_provider_task_id, p_content_url,
    CASE WHEN v_provider_task_id IS NULL
      THEN '任务已安全登记，等待供应商接收'
      ELSE '任务已安全登记，等待供应商处理'
    END,
    0, NULL, v_client_request_id, v_fingerprint, v_price, v_cost,
    trim(p_billing_unit), v_quantity,
    CASE WHEN v_provider_task_id IS NULL THEN 'reserved' ELSE 'provider_submitted' END,
    'video-terminal:' || trim(p_task_id),
    coalesce(p_explicitly_free, false), coalesce(p_billing_exempt, false)
  ) RETURNING * INTO v_task;
  v_created := true;

  RETURN jsonb_build_object(
    'created', v_created,
    'task_id', v_task.id,
    'status', v_task.status,
    'billing_state', v_task.billing_state,
    'provider_task_id', coalesce(v_task.task_id_external, '')
  );
END
$function$
;
NOTIFY pgrst, 'reload schema';
COMMIT;
