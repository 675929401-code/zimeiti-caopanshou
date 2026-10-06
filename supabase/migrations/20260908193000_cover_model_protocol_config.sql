-- Image-model onboarding metadata and resolution-aware billing.
-- This stores protocol, channel and tier pricing beside the backend credential.
BEGIN;

ALTER TABLE public.cover_models
  ADD COLUMN IF NOT EXISTS api_protocol_config jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.cover_models
  DROP CONSTRAINT IF EXISTS cover_models_api_protocol_config_object;
ALTER TABLE public.cover_models
  ADD CONSTRAINT cover_models_api_protocol_config_object
  CHECK (jsonb_typeof(api_protocol_config) = 'object');

COMMENT ON COLUMN public.cover_models.api_protocol_config IS
  'Server-side image provider protocol, relay group, supported resolutions, tier costs and tier selling prices. Never contains raw credentials.';

COMMIT;
