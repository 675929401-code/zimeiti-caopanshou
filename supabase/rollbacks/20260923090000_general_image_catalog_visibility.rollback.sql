BEGIN;

UPDATE public.cover_models
SET api_protocol_config = coalesce(api_protocol_config, '{}'::jsonb)
      - 'catalog_visibility'
      - 'public_availability_code'
      - 'public_unavailable_reason',
    updated_at = now()
WHERE id = ANY(ARRAY[
    'cover-model-seedream-5',
    'gemini-3-0-pro-image-chA'
  ]::text[])
  AND api_protocol_config->>'catalog_visibility' = 'visible_disabled'
  AND api_protocol_config->>'public_availability_code' = 'administrator_paused';

COMMIT;
