BEGIN;

-- Ordinary model-resource records are always enabled and visible. Explicit
-- retirement remains the only supported way to remove a record from public
-- catalogs, and uses provider='retired_configuration' as its tombstone.
CREATE OR REPLACE FUNCTION public.enforce_model_resource_visibility_invariant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM 'retired_configuration' THEN
    NEW.is_active := true;
    NEW.is_hidden := false;
  END IF;
  RETURN NEW;
END;
$$;

UPDATE public.cover_models
SET is_active = true,
    is_hidden = false,
    api_protocol_config = coalesce(api_protocol_config, '{}'::jsonb)
      - 'catalog_visibility'
      - 'public_availability_code'
      - 'public_unavailable_reason',
    updated_at = now()
WHERE provider IS DISTINCT FROM 'retired_configuration';

UPDATE public.llm_models
SET is_active = true,
    is_hidden = false,
    updated_at = now()
WHERE provider IS DISTINCT FROM 'retired_configuration';

UPDATE public.video_models
SET is_active = true,
    is_hidden = false,
    updated_at = now()
WHERE provider IS DISTINCT FROM 'retired_configuration';

DROP TRIGGER IF EXISTS cover_models_visibility_invariant ON public.cover_models;
CREATE TRIGGER cover_models_visibility_invariant
BEFORE INSERT OR UPDATE ON public.cover_models
FOR EACH ROW EXECUTE FUNCTION public.enforce_model_resource_visibility_invariant();

DROP TRIGGER IF EXISTS llm_models_visibility_invariant ON public.llm_models;
CREATE TRIGGER llm_models_visibility_invariant
BEFORE INSERT OR UPDATE ON public.llm_models
FOR EACH ROW EXECUTE FUNCTION public.enforce_model_resource_visibility_invariant();

DROP TRIGGER IF EXISTS video_models_visibility_invariant ON public.video_models;
CREATE TRIGGER video_models_visibility_invariant
BEFORE INSERT OR UPDATE ON public.video_models
FOR EACH ROW EXECUTE FUNCTION public.enforce_model_resource_visibility_invariant();

-- Legacy chat_models has no provider/tombstone column. DELETE is its only
-- retirement path, so every retained row stays enabled.
CREATE OR REPLACE FUNCTION public.enforce_chat_model_active_invariant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.is_active := true;
  RETURN NEW;
END;
$$;

UPDATE public.chat_models
SET is_active = true,
    updated_at = now();

DROP TRIGGER IF EXISTS chat_models_active_invariant ON public.chat_models;
CREATE TRIGGER chat_models_active_invariant
BEFORE INSERT OR UPDATE ON public.chat_models
FOR EACH ROW EXECUTE FUNCTION public.enforce_chat_model_active_invariant();

COMMIT;
