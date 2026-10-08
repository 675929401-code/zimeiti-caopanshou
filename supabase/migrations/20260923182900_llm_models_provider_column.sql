-- Forward fix: llm_models lacked the provider column that the
-- 20260923183000 visibility invariant migration requires. Production lineage
-- never carried this column for llm_models (cover_models/video_models have it).
-- This migration sorts one second before 20260923183000 so the invariant
-- applies on a complete base. Idempotent and NULL-safe: existing rows keep
-- provider NULL, which satisfies IS DISTINCT FROM 'retired_configuration'.
BEGIN;

ALTER TABLE public.llm_models ADD COLUMN IF NOT EXISTS provider text;

-- video_models carries every invariant column except updated_at in the
-- production lineage; the 20260923183000 invariant sets it on every row.
ALTER TABLE public.video_models ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- platform_settings keys must be unique for the ON CONFLICT upserts used by
-- configuration writers; the OpenAPI-derived baseline cannot carry uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS platform_settings_setting_key_key
  ON public.platform_settings (setting_key);

COMMIT;
