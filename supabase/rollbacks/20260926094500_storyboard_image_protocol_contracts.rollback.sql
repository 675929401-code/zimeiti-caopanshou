BEGIN;

UPDATE public.cover_models
SET api_protocol_config = coalesce(api_protocol_config, '{}'::jsonb) - ARRAY[
  'protocol',
  'reference_transport',
  'adapter_contract',
  'resolution_options',
  'default_resolution',
  'resolution_cost_prices',
  'resolution_prices',
  'fixed_resolution_sku',
  'result_delivery_hosts'
],
updated_at = now()
WHERE id IN (
  'pending-cover-model-1789087539302-c79bd2865ca4',
  'pending-cover-model-1789087566193-f4a5f4f1190f',
  'gemini-3-1-flash-image-chA',
  'gemini-3-0-pro-image-chA',
  'cover-model-seedream-5-pro'
);

COMMIT;
