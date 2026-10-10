BEGIN;
SET LOCAL lock_timeout = '10s';

-- Forward-compatible rollback: retain ownership alignment with the agents
-- table. Restoring a bootstrap role such as postgres would make the already
-- published 20261010123000 migration impossible for the runtime table owner
-- to replay and would reintroduce environment-specific ownership drift.
DO $block$
DECLARE
  v_agents_owner oid;
BEGIN
  SELECT relation.relowner
  INTO v_agents_owner
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname = 'agents'
    AND relation.relkind IN ('r', 'p');

  IF v_agents_owner IS NULL THEN
    RAISE EXCEPTION 'SHARED_AGENT_AGENTS_TABLE_OWNER_NOT_FOUND'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'maintain_shared_agent_config_revision',
      'record_shared_agent_prompt_version',
      'prepare_shared_agent_prompt_version_insert'
    ]) AS required(function_name)
    LEFT JOIN pg_catalog.pg_proc AS procedure
      ON procedure.proname = required.function_name
     AND procedure.pronargs = 0
     AND procedure.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
     AND procedure.pronamespace = 'public'::pg_catalog.regnamespace
    WHERE procedure.oid IS NULL
       OR procedure.proowner <> v_agents_owner
       OR NOT procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'SHARED_AGENT_FUNCTION_OWNER_RECONCILIATION_REQUIRED'
      USING ERRCODE = '55000';
  END IF;
END
$block$;

-- Intentionally no ALTER OWNER: the ownership correction is an additive
-- compatibility repair and remains valid when the application is rolled back.
COMMIT;
