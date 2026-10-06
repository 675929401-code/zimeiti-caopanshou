BEGIN;

-- Keep configured but administrator-paused image models discoverable in the
-- general workbenches. Generation admission continues to require is_active,
-- so these rows render disabled and cannot create paid tasks.
UPDATE public.cover_models
SET api_protocol_config = coalesce(api_protocol_config, '{}'::jsonb) || jsonb_build_object(
      'catalog_visibility', 'visible_disabled',
      'public_availability_code', 'administrator_paused',
      'public_unavailable_reason', '当前模型已暂停生成'
    ),
    updated_at = now()
WHERE id = ANY(ARRAY[
    'cover-model-seedream-5',
    'gemini-3-0-pro-image-chA'
  ]::text[])
  AND is_hidden = false
  AND is_active = false;

COMMIT;
