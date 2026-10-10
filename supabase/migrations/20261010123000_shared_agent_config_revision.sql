BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- A reviewed replay must not let the previously installed trigger increment
-- revisions while the migration reconciles historical rows.
DROP TRIGGER IF EXISTS agents_prompt_version_after_write ON public.agents;
DROP TRIGGER IF EXISTS agents_config_revision_before_write ON public.agents;
DROP TRIGGER IF EXISTS prompt_versions_prepare_legacy_insert ON public.prompt_versions;

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS config_revision bigint;

UPDATE public.agents
SET config_revision = 1
WHERE config_revision IS NULL OR config_revision < 1;

ALTER TABLE public.agents
  ALTER COLUMN config_revision SET DEFAULT 1,
  ALTER COLUMN config_revision SET NOT NULL;

ALTER TABLE public.agents
  DROP CONSTRAINT IF EXISTS agents_config_revision_positive;
ALTER TABLE public.agents
  ADD CONSTRAINT agents_config_revision_positive CHECK (config_revision >= 1);

ALTER TABLE public.prompt_versions
  ADD COLUMN IF NOT EXISTS agent_revision bigint,
  ADD COLUMN IF NOT EXISTS prompt_hash text;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY agent_id
           ORDER BY created_at ASC NULLS FIRST, id ASC
         )::bigint AS revision
  FROM public.prompt_versions
)
UPDATE public.prompt_versions AS versions
SET agent_revision = ranked.revision
FROM ranked
WHERE versions.id = ranked.id
  AND versions.agent_revision IS NULL;

UPDATE public.prompt_versions
SET prompt_hash = encode(
  pg_catalog.sha256(convert_to(prompt, 'UTF8')),
  'hex'
)
WHERE prompt_hash IS NULL;

WITH latest_history AS (
  SELECT DISTINCT ON (agent_id)
         agent_id,
         agent_revision AS latest_revision,
         prompt_hash AS latest_prompt_hash
  FROM public.prompt_versions
  ORDER BY agent_id, agent_revision DESC
)
UPDATE public.agents AS agents
SET config_revision = greatest(
  agents.config_revision,
  latest_history.latest_revision + CASE
    WHEN nullif(btrim(agents.system_prompt), '') IS NULL THEN 0
    WHEN latest_history.latest_prompt_hash = encode(
      pg_catalog.sha256(convert_to(agents.system_prompt, 'UTF8')),
      'hex'
    ) THEN 0
    ELSE 1
  END
)
FROM latest_history
WHERE latest_history.agent_id = agents.id;

INSERT INTO public.prompt_versions (agent_id, prompt, agent_revision, prompt_hash)
SELECT agents.id,
       agents.system_prompt,
       agents.config_revision,
       encode(pg_catalog.sha256(convert_to(agents.system_prompt, 'UTF8')), 'hex')
FROM public.agents AS agents
WHERE nullif(btrim(agents.system_prompt), '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.prompt_versions AS versions
    WHERE versions.agent_id = agents.id
      AND versions.agent_revision = agents.config_revision
  );

ALTER TABLE public.prompt_versions
  ALTER COLUMN agent_revision SET NOT NULL,
  ALTER COLUMN prompt_hash SET NOT NULL;

ALTER TABLE public.prompt_versions
  DROP CONSTRAINT IF EXISTS prompt_versions_agent_revision_positive,
  DROP CONSTRAINT IF EXISTS prompt_versions_prompt_hash_format;
ALTER TABLE public.prompt_versions
  ADD CONSTRAINT prompt_versions_agent_revision_positive CHECK (agent_revision >= 1),
  ADD CONSTRAINT prompt_versions_prompt_hash_format CHECK (prompt_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_agent_revision_unique
  ON public.prompt_versions (agent_id, agent_revision);
CREATE INDEX IF NOT EXISTS prompt_versions_agent_prompt_hash_idx
  ON public.prompt_versions (agent_id, prompt_hash);

CREATE OR REPLACE FUNCTION public.maintain_shared_agent_config_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.config_revision := greatest(coalesce(NEW.config_revision, 1), 1);
  ELSE
    IF OLD.config_revision >= 9223372036854775807 THEN
      RAISE EXCEPTION 'AGENT_CONFIG_REVISION_EXHAUSTED' USING ERRCODE = '54000';
    END IF;
    -- Callers may supply an expected revision as a WHERE predicate, but may
    -- never choose the next revision value themselves.
    NEW.config_revision := OLD.config_revision + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_shared_agent_prompt_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF nullif(btrim(NEW.system_prompt), '') IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.system_prompt IS NOT DISTINCT FROM OLD.system_prompt THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO public.prompt_versions (
    agent_id,
    prompt,
    agent_revision,
    prompt_hash
  ) VALUES (
    NEW.id,
    NEW.system_prompt,
    NEW.config_revision,
    encode(pg_catalog.sha256(convert_to(NEW.system_prompt, 'UTF8')), 'hex')
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_shared_agent_prompt_version_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_revision bigint;
  v_existing_hash text;
  v_computed_hash text;
BEGIN
  SELECT config_revision
  INTO v_current_revision
  FROM public.agents
  WHERE id = NEW.agent_id;

  IF v_current_revision IS NULL THEN
    RAISE EXCEPTION 'AGENT_PROMPT_VERSION_AGENT_NOT_FOUND' USING ERRCODE = '23503';
  END IF;

  v_computed_hash := encode(
    pg_catalog.sha256(convert_to(NEW.prompt, 'UTF8')),
    'hex'
  );
  IF NEW.prompt_hash IS NOT NULL AND NEW.prompt_hash <> v_computed_hash THEN
    RAISE EXCEPTION 'AGENT_PROMPT_VERSION_HASH_MISMATCH' USING ERRCODE = '22000';
  END IF;

  NEW.prompt_hash := v_computed_hash;
  NEW.agent_revision := coalesce(NEW.agent_revision, v_current_revision);
  IF NEW.agent_revision <> v_current_revision THEN
    RAISE EXCEPTION 'AGENT_PROMPT_VERSION_REVISION_MISMATCH' USING ERRCODE = '23514';
  END IF;

  SELECT prompt_hash
  INTO v_existing_hash
  FROM public.prompt_versions
  WHERE agent_id = NEW.agent_id
    AND agent_revision = NEW.agent_revision;

  IF v_existing_hash IS NOT NULL THEN
    IF v_existing_hash = NEW.prompt_hash THEN
      -- Old application instances write the same prompt after updating the
      -- agent. The agent trigger already recorded it atomically, so acknowledge
      -- that legacy insert as an idempotent no-op.
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'AGENT_PROMPT_VERSION_REVISION_CONFLICT' USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agents_config_revision_before_write ON public.agents;
CREATE TRIGGER agents_config_revision_before_write
BEFORE INSERT OR UPDATE ON public.agents
FOR EACH ROW
EXECUTE FUNCTION public.maintain_shared_agent_config_revision();

CREATE TRIGGER prompt_versions_prepare_legacy_insert
BEFORE INSERT ON public.prompt_versions
FOR EACH ROW
EXECUTE FUNCTION public.prepare_shared_agent_prompt_version_insert();

DROP TRIGGER IF EXISTS agents_prompt_version_after_write ON public.agents;
CREATE TRIGGER agents_prompt_version_after_write
AFTER INSERT OR UPDATE ON public.agents
FOR EACH ROW
EXECUTE FUNCTION public.record_shared_agent_prompt_version();

REVOKE ALL ON FUNCTION public.maintain_shared_agent_config_revision()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_shared_agent_prompt_version()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_shared_agent_prompt_version_insert()
  FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN public.agents.config_revision IS
  'Monotonic revision used for compare-and-swap updates of shared agent configuration.';
COMMENT ON COLUMN public.prompt_versions.agent_revision IS
  'The agents.config_revision that atomically produced this prompt snapshot.';
COMMENT ON COLUMN public.prompt_versions.prompt_hash IS
  'Lowercase SHA-256 of the exact prompt text; no prompt content is logged by the API.';

NOTIFY pgrst, 'reload schema';
COMMIT;
