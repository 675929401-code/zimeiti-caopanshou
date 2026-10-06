BEGIN;

DO $$
DECLARE
  matched integer;
BEGIN
  SELECT count(*) INTO matched
  FROM public.cover_models
  WHERE (id, provider, model_name) IN (
    ('pending-cover-model-1789087539302-c79bd2865ca4', 'lconai', 'nano-banana-pro'),
    ('pending-cover-model-1789087566193-f4a5f4f1190f', 'lconai', 'gemini-3.1-flash-image-4k'),
    ('gemini-3-1-flash-image-chA', 'secure_skill_chat', 'gemini-3.1-flash-image'),
    ('gemini-3-0-pro-image-chA', 'secure_skill_chat', 'gemini-3.0-pro-image'),
    ('cover-model-seedream-5-pro', 'volcengine', 'doubao-seedream-5-0-pro-260628')
  );
  IF matched <> 5 THEN
    RAISE EXCEPTION 'storyboard image model binding drift: expected 5 rows, found %', matched;
  END IF;

  UPDATE public.cover_models
  SET api_protocol_config = coalesce(api_protocol_config, '{}'::jsonb) || CASE id
    WHEN 'pending-cover-model-1789087539302-c79bd2865ca4' THEN jsonb_build_object(
      'protocol', 'images_generations',
      'reference_transport', 'generations_url_array',
      'adapter_contract', 'openai_images_generations_v1',
      'resolution_options', jsonb_build_array('1K'),
      'default_resolution', '1K',
      'resolution_cost_prices', jsonb_build_object('1K', 0.24),
      'resolution_prices', jsonb_build_object('1K', 0.34)
    )
    WHEN 'pending-cover-model-1789087566193-f4a5f4f1190f' THEN jsonb_build_object(
      'protocol', 'images_generations',
      'reference_transport', 'generations_url_array',
      'adapter_contract', 'openai_images_generations_v1',
      'resolution_options', jsonb_build_array('4K'),
      'default_resolution', '4K',
      'resolution_cost_prices', jsonb_build_object('4K', 0.16),
      'resolution_prices', jsonb_build_object('4K', 0.26),
      'fixed_resolution_sku', true
    )
    WHEN 'gemini-3-1-flash-image-chA' THEN jsonb_build_object(
      'protocol', 'chat_completions',
      'reference_transport', 'chat_inline_data',
      'adapter_contract', 'secure_skill_chat_completions_v1',
      'resolution_options', jsonb_build_array('1K', '2K', '4K'),
      'default_resolution', '2K',
      'resolution_cost_prices', jsonb_build_object('1K', 0.04, '2K', 0.04, '4K', 0.04),
      'resolution_prices', jsonb_build_object('1K', 0.14, '2K', 0.14, '4K', 0.14)
    )
    WHEN 'gemini-3-0-pro-image-chA' THEN jsonb_build_object(
      'protocol', 'chat_completions',
      'reference_transport', 'chat_inline_data',
      'adapter_contract', 'secure_skill_chat_completions_v1',
      'resolution_options', jsonb_build_array('1K', '2K', '4K'),
      'default_resolution', '2K',
      'resolution_cost_prices', jsonb_build_object('1K', 0.05, '2K', 0.05, '4K', 0.05),
      'resolution_prices', jsonb_build_object('1K', 0.15, '2K', 0.15, '4K', 0.15)
    )
    WHEN 'cover-model-seedream-5-pro' THEN jsonb_build_object(
      'protocol', 'volcengine_images_v3',
      'reference_transport', 'none',
      'adapter_contract', 'volcengine_images_v3',
      'resolution_options', jsonb_build_array('2K'),
      'default_resolution', '2K',
      'resolution_cost_prices', jsonb_build_object('2K', 0.15),
      'resolution_prices', jsonb_build_object('2K', 0.35),
      'result_delivery_hosts', jsonb_build_array('ark-acg-cn-beijing.tos-cn-beijing.volces.com')
    )
    ELSE '{}'::jsonb
  END,
  updated_at = now()
  WHERE id IN (
    'pending-cover-model-1789087539302-c79bd2865ca4',
    'pending-cover-model-1789087566193-f4a5f4f1190f',
    'gemini-3-1-flash-image-chA',
    'gemini-3-0-pro-image-chA',
    'cover-model-seedream-5-pro'
  );
END $$;

COMMIT;
