begin;

-- The configured secure-skill Gemini image channel returned a binary
-- foreground mask in two independent commercial canaries instead of the
-- requested finished image. Keep the configuration for an explicit admin
-- retest, but do not publish it to end users until a new validation succeeds.
update public.cover_models
set is_active = false,
    is_hidden = true,
    updated_at = now()
where id = 'gemini-3-0-pro-image-chA'
  and provider = 'secure_skill_chat'
  and model_name = 'gemini-3.0-pro-image';

select pg_notify('pgrst', 'reload schema');

commit;
