-- Match the frozen, model-specific resolution rates used by the video billing contract.
BEGIN;
CREATE OR REPLACE FUNCTION public.reserve_video_token_task_v1_atomic(
  p_task jsonb, p_routing_snapshot jsonb, p_request_snapshot jsonb, p_token_quote jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_result jsonb;
  v_max numeric;
  v_sale numeric;
  v_cost numeric;
  v_price_key text;
  v_id text := trim(coalesce(p_task->>'p_task_id', ''));
  v_user text := trim(coalesce(p_task->>'p_user_id', ''));
  v_client text := trim(coalesce(p_task->>'p_client_request_id', ''));
BEGIN
  IF session_user <> 'service_role' AND current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_SERVICE_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_task) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_token_quote) IS DISTINCT FROM 'object'
     OR p_token_quote->>'schema' IS DISTINCT FROM 'video_token_quote.v1'
     OR coalesce(p_token_quote->>'resolution', '') NOT IN ('480p','720p','1080p','4k')
     OR coalesce(p_token_quote->>'pricingClass', '') NOT IN ('no_reference_video', 'reference_video')
     OR jsonb_typeof(p_token_quote->'saleYuanPerMillionTokens') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_token_quote->'costYuanPerMillionTokens') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_token_quote->'maxChargeYuan') IS DISTINCT FROM 'number'
     OR coalesce(p_token_quote->>'priceVersion', '') NOT LIKE 'video_token_sale.v1:%'
     OR pg_column_size(p_token_quote) > 16384 THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_QUOTE_INVALID' USING ERRCODE = '22023';
  END IF;
  v_max := (p_token_quote->>'maxChargeYuan')::numeric;
  v_sale := (p_token_quote->>'saleYuanPerMillionTokens')::numeric;
  v_cost := (p_token_quote->>'costYuanPerMillionTokens')::numeric;
  IF v_max <= 0 OR v_max >= 10000000000 OR v_max <> round(v_max, 2)
     OR v_sale <= 0 OR v_sale > 9007199254740991 OR v_cost <= 0 OR v_cost > 9007199254740991
     OR (p_task->>'p_billing_price_yuan')::numeric IS DISTINCT FROM v_max
     OR coalesce((p_task->>'p_explicitly_free')::boolean, false)
     OR coalesce((p_task->>'p_billing_exempt')::boolean, false)
     OR p_request_snapshot->>'resolution' IS DISTINCT FROM p_token_quote->>'resolution' THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_QUOTE_INVALID' USING ERRCODE = '22023';
  END IF;
  v_price_key := (p_token_quote->>'resolution') || ':' || (p_token_quote->>'pricingClass');
  IF (p_routing_snapshot->'apiProtocolConfig'->'token_sale_prices_per_million'->>v_price_key)::numeric IS DISTINCT FROM v_sale
     OR (p_routing_snapshot->'apiProtocolConfig'->'token_cost_prices_per_million'->>v_price_key)::numeric IS DISTINCT FROM v_cost
     OR p_routing_snapshot->'apiProtocolConfig'->>'provider_billing_unit' IS DISTINCT FROM 'token'
     OR (p_token_quote->>'pricingClass' = 'reference_video') IS DISTINCT FROM EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_request_snapshot->'referenceAssets') asset
        WHERE asset->>'role' = 'source_video'
     ) THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_QUOTE_ROUTING_MISMATCH' USING ERRCODE = '23514';
  END IF;

  -- Same identity lock as the underlying reservation. Replays must not call
  -- its fixed-price comparison after an actual token amount has been recorded.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user || ':' || v_client, 0));
  SELECT * INTO v_task FROM public.video_tasks
   WHERE user_id::text = v_user AND client_request_id = v_client FOR UPDATE;
  IF FOUND THEN
    IF v_task.id::text IS DISTINCT FROM v_id
       OR v_task.model_id::text IS DISTINCT FROM p_task->>'p_model_id'
       OR v_task.request_fingerprint IS DISTINCT FROM lower(trim(coalesce(p_task->>'p_request_fingerprint', '')))
       OR v_task.billing_unit IS DISTINCT FROM 'token'
       OR v_task.billing_token_quote IS DISTINCT FROM p_token_quote
       OR v_task.billing_reserved_yuan IS DISTINCT FROM v_max
       OR v_task.routing_snapshot IS DISTINCT FROM p_routing_snapshot
       OR v_task.request_snapshot IS DISTINCT FROM p_request_snapshot
       OR v_task.request_snapshot_hash IS DISTINCT FROM lower(trim(coalesce(p_task->>'p_request_snapshot_hash', '')))
       OR (nullif(p_task->>'p_provider_task_id', '') IS NOT NULL
           AND v_task.task_id_external IS DISTINCT FROM p_task->>'p_provider_task_id') THEN
      RAISE EXCEPTION 'VIDEO_TOKEN_RESERVATION_IMMUTABLE_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('created', false, 'task_id', v_task.id, 'status', v_task.status,
      'billing_state', v_task.billing_state, 'provider_task_id', coalesce(v_task.task_id_external, ''),
      'billing_reserved_yuan', v_task.billing_reserved_yuan, 'billing_token_quote', v_task.billing_token_quote);
  END IF;
  v_result := public.reserve_video_generation_task_request_snapshot_v1_atomic(
    p_task_id => v_id, p_user_id => v_user, p_model_id => p_task->>'p_model_id',
    p_client_request_id => v_client, p_request_fingerprint => p_task->>'p_request_fingerprint',
    p_billing_price_yuan => v_max, p_billing_cost_price_yuan => coalesce((p_task->>'p_billing_cost_price_yuan')::numeric, 0),
    p_billing_unit => 'per_use', p_billing_quantity => 1,
    p_explicitly_free => false, p_billing_exempt => false,
    p_routing_snapshot => p_routing_snapshot, p_request_snapshot => p_request_snapshot,
    p_request_snapshot_hash => p_task->>'p_request_snapshot_hash',
    p_provider_task_id => nullif(p_task->>'p_provider_task_id', ''),
    p_task_label => p_task->>'p_task_label', p_batch_id => p_task->>'p_batch_id',
    p_batch_topic => p_task->>'p_batch_topic', p_card_index => (p_task->>'p_card_index')::integer,
    p_prompt => coalesce(p_task->>'p_prompt', ''), p_first_frame_url => p_task->>'p_first_frame_url',
    p_last_frame_url => p_task->>'p_last_frame_url', p_reference_image_url => p_task->>'p_reference_image_url',
    p_aspect_ratio => coalesce(p_task->>'p_aspect_ratio', '16:9'), p_resolution => p_task->>'p_resolution',
    p_duration_seconds => (p_task->>'p_duration_seconds')::numeric, p_content_url => p_task->>'p_content_url'
  );
  IF coalesce((v_result->>'created')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'VIDEO_TOKEN_RESERVATION_IMMUTABLE_CONFLICT' USING ERRCODE = '23505';
  END IF;
  UPDATE public.video_tasks SET billing_unit = 'token', billing_token_quote = p_token_quote,
    billing_reserved_yuan = v_max WHERE id::text = v_id AND user_id::text = v_user;
  RETURN v_result || jsonb_build_object('billing_reserved_yuan', v_max, 'billing_token_quote', p_token_quote);
END $$;

CREATE OR REPLACE FUNCTION public.native_ai_no_credentials(p jsonb,depth integer DEFAULT 0) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$DECLARE e record;v jsonb;BEGIN
 IF p IS NULL OR depth>20 OR octet_length(p::text)>2097152 THEN RETURN false;END IF;
 IF jsonb_typeof(p)='object' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p))>200 THEN RETURN false;END IF;
  FOR e IN SELECT * FROM jsonb_each(p) LOOP
   IF e.key='tokenBilling' THEN
    IF jsonb_typeof(e.value) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(e.value))<>2 OR NOT(e.value?'maxChargeYuan') OR NOT(e.value?'priceVersion') OR jsonb_typeof(e.value->'maxChargeYuan') IS DISTINCT FROM 'number' OR jsonb_typeof(e.value->'priceVersion') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
    IF (e.value->>'maxChargeYuan')::numeric<=0 OR scale((e.value->>'maxChargeYuan')::numeric)>2 OR (e.value->>'maxChargeYuan')::numeric*100>9007199254740991 OR length(e.value->>'priceVersion')>1024 OR left(e.value->>'priceVersion',length('video_token_sale.v1:'))<>'video_token_sale.v1:' THEN RETURN false;END IF;
    BEGIN v:=substring(e.value->>'priceVersion' FROM length('video_token_sale.v1:')+1)::jsonb;EXCEPTION WHEN OTHERS THEN RETURN false;END;
    IF jsonb_typeof(v) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
    IF NOT (v ? '720p:no_reference_video' AND v ? '720p:reference_video') OR EXISTS (
      SELECT 1 FROM jsonb_each(v) price WHERE
        price.key !~ '^(480p|720p|1080p|4k):(no_reference_video|reference_video)$'
        OR NOT (v ? (split_part(price.key, ':', 1) || ':no_reference_video') AND v ? (split_part(price.key, ':', 1) || ':reference_video'))
        OR CASE WHEN jsonb_typeof(price.value) = 'number'
           THEN (price.value::text)::numeric <= 0 OR (price.value::text)::numeric > 9007199254740991
           ELSE true END
    ) THEN RETURN false; END IF;
    CONTINUE;
   END IF;
   IF e.key IN ('__proto__','constructor','prototype') OR e.key~*'(cookie|token|secret|password|authorization|credential|api.?key|upload.?url|continuation|headers)' AND NOT(e.key IN ('maxReplyTokens','maxContextTokens','max_reply_tokens','max_context_tokens') AND jsonb_typeof(e.value)='number') OR NOT public.native_ai_no_credentials(e.value,depth+1) THEN RETURN false;END IF;
  END LOOP;
 ELSIF jsonb_typeof(p)='array' THEN
  IF jsonb_array_length(p)>200 THEN RETURN false;END IF;
  FOR v IN SELECT * FROM jsonb_array_elements(p) LOOP IF NOT public.native_ai_no_credentials(v,depth+1) THEN RETURN false;END IF;END LOOP;
 END IF;RETURN true;
END$$;
COMMIT;
