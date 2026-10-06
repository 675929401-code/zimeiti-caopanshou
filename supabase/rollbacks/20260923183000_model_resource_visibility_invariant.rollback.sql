BEGIN;

DROP TRIGGER IF EXISTS chat_models_active_invariant ON public.chat_models;
DROP TRIGGER IF EXISTS video_models_visibility_invariant ON public.video_models;
DROP TRIGGER IF EXISTS llm_models_visibility_invariant ON public.llm_models;
DROP TRIGGER IF EXISTS cover_models_visibility_invariant ON public.cover_models;

DROP FUNCTION IF EXISTS public.enforce_chat_model_active_invariant();
DROP FUNCTION IF EXISTS public.enforce_model_resource_visibility_invariant();

-- The rollback removes future-write guards only. It intentionally does not
-- guess which retained model rows an administrator might want disabled.

COMMIT;
