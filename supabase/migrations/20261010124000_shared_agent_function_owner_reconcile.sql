BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- The shared-agent revision migration may be installed by a bootstrap role
-- and replayed later by the runtime table owner. PostgreSQL only permits
-- CREATE OR REPLACE FUNCTION to the current function owner, so keep these
-- SECURITY DEFINER trigger helpers aligned with the authoritative agents
-- table owner instead of naming an environment-specific role here.
DO $block$
DECLARE
  v_agents_owner name;
  v_function_name text;
  v_function_owner name;
  v_security_definer boolean;
BEGIN
  SELECT owner_role.rolname
  INTO v_agents_owner
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_roles AS owner_role
    ON owner_role.oid = relation.relowner
  WHERE namespace.nspname = 'public'
    AND relation.relname = 'agents'
    AND relation.relkind IN ('r', 'p');

  IF v_agents_owner IS NULL THEN
    RAISE EXCEPTION 'SHARED_AGENT_AGENTS_TABLE_OWNER_NOT_FOUND'
      USING ERRCODE = '55000';
  END IF;

  FOREACH v_function_name IN ARRAY ARRAY[
    'maintain_shared_agent_config_revision',
    'record_shared_agent_prompt_version',
    'prepare_shared_agent_prompt_version_insert'
  ]
  LOOP
    SELECT owner_role.rolname, procedure.prosecdef
    INTO v_function_owner, v_security_definer
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = procedure.proowner
    WHERE namespace.nspname = 'public'
      AND procedure.proname = v_function_name
      AND procedure.pronargs = 0
      AND procedure.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype;

    IF v_function_owner IS NULL THEN
      RAISE EXCEPTION 'SHARED_AGENT_TRIGGER_FUNCTION_NOT_FOUND: %', v_function_name
        USING ERRCODE = '55000';
    END IF;
    IF NOT v_security_definer THEN
      RAISE EXCEPTION 'SHARED_AGENT_TRIGGER_FUNCTION_MUST_BE_SECURITY_DEFINER: %', v_function_name
        USING ERRCODE = '55000';
    END IF;

    IF v_function_owner <> v_agents_owner THEN
      EXECUTE format(
        'ALTER FUNCTION public.%I() OWNER TO %I',
        v_function_name,
        v_agents_owner
      );
    END IF;

    -- Ownership changes must not make trigger helpers callable as public RPCs.
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated',
      v_function_name
    );
  END LOOP;
END
$block$;

COMMIT;
