-- Configuration and activation evidence can exceed a gateway URL limit.
-- Keep optimistic concurrency in a service-role-only POST RPC.
BEGIN;
CREATE OR REPLACE FUNCTION public.update_video_model_configuration_atomic(
  p_model_id text, p_expected jsonb, p_updates jsonb
) RETURNS SETOF public.video_models
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  current_model public.video_models%ROWTYPE;
  allowed_keys constant text[] := ARRAY[
    'name','provider','api_endpoint','api_key','protocol_type',
    'request_template','response_mapping','price_per_use','currency',
    'duration_seconds','max_duration','supports_image_input','is_active',
    'sort_order','admin_notes','model_name','cost_price','is_hidden',
    'billing_mode','token_billing_enabled','input_cost_per_million',
    'output_cost_per_million','profit_margin','token_rounding_unit',
    'cost_per_use','api_protocol_config','requires_image'
  ];
  assignments text;
BEGIN
  IF p_model_id IS NULL OR p_expected IS NULL OR p_updates IS NULL
     OR jsonb_typeof(p_expected) <> 'object' OR jsonb_typeof(p_updates) <> 'object'
     OR NOT (p_expected ? 'api_protocol_config') OR p_updates = '{}'::jsonb THEN
    RAISE EXCEPTION 'VIDEO_MODEL_UPDATE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_updates) k WHERE NOT (k = ANY(allowed_keys)))
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_expected) k WHERE NOT (k = ANY(allowed_keys))) THEN
    RAISE EXCEPTION 'VIDEO_MODEL_UPDATE_FIELD_FORBIDDEN' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO current_model FROM public.video_models WHERE id = p_model_id FOR UPDATE;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM jsonb_each(p_expected) e
    WHERE (to_jsonb(current_model) -> e.key) IS DISTINCT FROM e.value
  ) THEN
    RETURN;
  END IF;
  SELECT string_agg(format('%I = (jsonb_populate_record(NULL::public.video_models, $2)).%I', k, k), ', ' ORDER BY k)
    INTO assignments FROM jsonb_object_keys(p_updates) k;
  RETURN QUERY EXECUTE format('UPDATE public.video_models SET %s WHERE id = $1 RETURNING *', assignments)
    USING p_model_id, to_jsonb(current_model) || p_updates;
END;
$$;
REVOKE ALL ON FUNCTION public.update_video_model_configuration_atomic(text,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_video_model_configuration_atomic(text,jsonb,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
