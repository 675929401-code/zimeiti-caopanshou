BEGIN;
SET LOCAL lock_timeout = '10s';

-- Forward-compatible rollback: keep the additive revision columns, unique
-- history and triggers. Older application instances remain compatible because
-- prompt_versions_prepare_legacy_insert fills the new fields and treats the
-- post-update duplicate insert as an idempotent no-op. Dropping these objects
-- while a newer application is still live would silently disable CAS safety.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agents'
      AND column_name = 'config_revision'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'prompt_versions'
      AND column_name = 'agent_revision'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'prompt_versions'
      AND column_name = 'prompt_hash'
  ) THEN
    RAISE EXCEPTION 'SHARED_AGENT_CONFIG_REVISION_NOT_APPLIED' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.agents'::regclass
      AND tgname = 'agents_config_revision_before_write'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.agents'::regclass
      AND tgname = 'agents_prompt_version_after_write'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.prompt_versions'::regclass
      AND tgname = 'prompt_versions_prepare_legacy_insert'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'SHARED_AGENT_CONFIG_REVISION_TRIGGER_MISSING' USING ERRCODE = '55000';
  END IF;
END
$$;

-- Intentionally no DROP/ALTER: application rollback is safe while this
-- forward-compatible database contract remains installed. A rolled-back old
-- application still lacks expected_revision CAS, so drain it to a single
-- writer; do not run old and new writers concurrently in shared mode.
COMMIT;
