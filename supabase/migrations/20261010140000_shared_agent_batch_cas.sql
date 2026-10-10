BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.apply_agent_reorder_cas_v1(p_entries jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_requested integer;
  v_locked integer;
  v_conflict record;
  v_result jsonb;
BEGIN
  IF jsonb_typeof(p_entries) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'AGENT_REORDER_ENTRIES_MUST_BE_ARRAY' USING ERRCODE = '22023';
  END IF;
  v_requested := jsonb_array_length(p_entries);
  IF v_requested < 1 OR v_requested > 500 THEN
    RAISE EXCEPTION 'AGENT_REORDER_ENTRY_COUNT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_entries) AS item(value)
    WHERE jsonb_typeof(value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(value -> 'id') IS DISTINCT FROM 'string'
       OR nullif(btrim(value ->> 'id'), '') IS NULL
       OR CASE
            WHEN jsonb_typeof(value -> 'expected_revision') = 'number'
             AND (value ->> 'expected_revision') ~ '^[1-9][0-9]*$'
            THEN (value ->> 'expected_revision')::numeric > 9223372036854775807::numeric
            ELSE true
          END
  ) THEN
    RAISE EXCEPTION 'AGENT_REORDER_ENTRY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_entries) AS item(value)
    GROUP BY value ->> 'id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'AGENT_REORDER_DUPLICATE_ID' USING ERRCODE = '22023';
  END IF;

  -- Reorder is category-wide. Lock the entire active ordering domain in a
  -- deterministic order so a filtered/search/favorites subset cannot race a
  -- category change or overwrite unseen rows.
  PERFORM agents.id
  FROM public.agents AS agents
  WHERE agents.deleted_at IS NULL
  ORDER BY agents.id
  FOR UPDATE OF agents;

  SELECT count(*)
  INTO v_locked
  FROM public.agents AS agents
  JOIN jsonb_array_elements(p_entries) AS item(value)
    ON agents.id = item.value ->> 'id'
  WHERE agents.deleted_at IS NULL;
  IF v_locked <> v_requested THEN
    RAISE EXCEPTION 'AGENT_REORDER_TARGET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    WITH input AS (
      SELECT item.value ->> 'id' AS id
      FROM jsonb_array_elements(p_entries) AS item(value)
    ), affected AS (
      SELECT DISTINCT coalesce(agents.category, '未分类') AS category
      FROM public.agents AS agents
      JOIN input ON input.id = agents.id
      WHERE agents.deleted_at IS NULL
    ), expected AS (
      SELECT coalesce(agents.category, '未分类') AS category, count(*) AS row_count
      FROM public.agents AS agents
      JOIN affected ON affected.category = coalesce(agents.category, '未分类')
      WHERE agents.deleted_at IS NULL
      GROUP BY coalesce(agents.category, '未分类')
    ), submitted AS (
      SELECT coalesce(agents.category, '未分类') AS category, count(*) AS row_count
      FROM public.agents AS agents
      JOIN input ON input.id = agents.id
      WHERE agents.deleted_at IS NULL
      GROUP BY coalesce(agents.category, '未分类')
    )
    SELECT 1
    FROM expected
    LEFT JOIN submitted USING (category)
    WHERE expected.row_count <> coalesce(submitted.row_count, 0)
  ) THEN
    RAISE EXCEPTION 'AGENT_REORDER_CATEGORY_INCOMPLETE' USING ERRCODE = '40001';
  END IF;

  SELECT agents.id,
         (item.value ->> 'expected_revision')::bigint AS expected_revision,
         agents.config_revision AS current_revision
  INTO v_conflict
  FROM public.agents AS agents
  JOIN jsonb_array_elements(p_entries) AS item(value)
    ON agents.id = item.value ->> 'id'
  WHERE agents.deleted_at IS NULL
    AND agents.config_revision <> (item.value ->> 'expected_revision')::bigint
  ORDER BY agents.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AGENT_CONFIG_REVISION_CONFLICT:%:%:%',
      v_conflict.id, v_conflict.expected_revision, v_conflict.current_revision
      USING ERRCODE = '40001';
  END IF;

  WITH input AS (
    SELECT item.value ->> 'id' AS id,
           item.ordinality
    FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS item(value, ordinality)
  ), desired AS (
    SELECT agents.id,
           (row_number() OVER (
             PARTITION BY coalesce(agents.category, '未分类')
             ORDER BY input.ordinality
           ) * 10)::integer AS sort_order
    FROM public.agents AS agents
    JOIN input ON input.id = agents.id
    WHERE agents.deleted_at IS NULL
  ), updated AS (
    UPDATE public.agents AS agents
    SET sort_order = desired.sort_order,
        updated_at = now()
    FROM desired
    WHERE agents.id = desired.id
    RETURNING agents.id, agents.config_revision, agents.sort_order
  )
  SELECT jsonb_build_object(
    'updated', count(*),
    'agents', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', updated.id,
          'config_revision', updated.config_revision,
          'sort_order', updated.sort_order
        ) ORDER BY updated.id
      ),
      '[]'::jsonb
    )
  )
  INTO v_result
  FROM updated;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_coze_agent_import_cas_v1(p_entries jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_requested integer;
  v_update_requested integer;
  v_locked integer;
  v_conflict record;
  v_bot_id text;
  v_imported integer := 0;
  v_updated integer := 0;
  v_result jsonb;
BEGIN
  IF jsonb_typeof(p_entries) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'COZE_IMPORT_ENTRIES_MUST_BE_ARRAY' USING ERRCODE = '22023';
  END IF;
  v_requested := jsonb_array_length(p_entries);
  IF v_requested < 1 OR v_requested > 100 THEN
    RAISE EXCEPTION 'COZE_IMPORT_ENTRY_COUNT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_entries) AS item(value)
    WHERE jsonb_typeof(value) IS DISTINCT FROM 'object'
       OR value ->> 'operation' IS NULL
       OR value ->> 'operation' NOT IN ('insert', 'update')
       OR jsonb_typeof(value -> 'id') IS DISTINCT FROM 'string'
       OR nullif(btrim(value ->> 'id'), '') IS NULL
       OR length(value ->> 'id') > 255
       OR jsonb_typeof(value -> 'bot_id') IS DISTINCT FROM 'string'
       OR nullif(btrim(value ->> 'bot_id'), '') IS NULL
       OR length(value ->> 'bot_id') > 128
       OR jsonb_typeof(value -> 'name') IS DISTINCT FROM 'string'
       OR nullif(btrim(value ->> 'name'), '') IS NULL
       OR length(value ->> 'name') > 255
       OR (
         value ->> 'operation' = 'update'
         AND (
           CASE
             WHEN jsonb_typeof(value -> 'expected_revision') = 'number'
              AND (value ->> 'expected_revision') ~ '^[1-9][0-9]*$'
             THEN (value ->> 'expected_revision')::numeric > 9223372036854775807::numeric
             ELSE true
           END
         )
       )
  ) THEN
    RAISE EXCEPTION 'COZE_IMPORT_ENTRY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_entries) AS item(value)
    GROUP BY value ->> 'id'
    HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_entries) AS item(value)
    GROUP BY value ->> 'bot_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'COZE_IMPORT_DUPLICATE_TARGET' USING ERRCODE = '22023';
  END IF;

  -- Serialize new bot ids even when no row exists yet, then lock every
  -- matching/update row by stable agent id. This closes concurrent upsert gaps.
  FOR v_bot_id IN
    SELECT DISTINCT item.value ->> 'bot_id' AS bot_id
    FROM jsonb_array_elements(p_entries) AS item(value)
    ORDER BY bot_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('coze-agent:' || v_bot_id, 0));
  END LOOP;

  PERFORM agents.id
  FROM public.agents AS agents
  JOIN jsonb_array_elements(p_entries) AS item(value)
    ON agents.id = item.value ->> 'id'
       OR (
         agents.deleted_at IS NULL
         AND agents.bot_id = item.value ->> 'bot_id'
       )
  ORDER BY agents.id
  FOR UPDATE OF agents;

  SELECT count(*)
  INTO v_update_requested
  FROM jsonb_array_elements(p_entries) AS item(value)
  WHERE item.value ->> 'operation' = 'update';

  SELECT count(*)
  INTO v_locked
  FROM public.agents AS agents
  JOIN jsonb_array_elements(p_entries) AS item(value)
    ON agents.id = item.value ->> 'id'
  WHERE item.value ->> 'operation' = 'update'
    AND agents.deleted_at IS NULL;
  IF v_locked <> v_update_requested THEN
    RAISE EXCEPTION 'COZE_IMPORT_UPDATE_TARGET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.agents AS agents
    JOIN jsonb_array_elements(p_entries) AS item(value)
      ON agents.id = item.value ->> 'id'
    WHERE item.value ->> 'operation' = 'update'
      AND agents.bot_id IS DISTINCT FROM item.value ->> 'bot_id'
  ) THEN
    RAISE EXCEPTION 'COZE_IMPORT_UPDATE_BOT_ID_MISMATCH' USING ERRCODE = '23514';
  END IF;

  SELECT agents.id,
         (item.value ->> 'expected_revision')::bigint AS expected_revision,
         agents.config_revision AS current_revision
  INTO v_conflict
  FROM public.agents AS agents
  JOIN jsonb_array_elements(p_entries) AS item(value)
    ON agents.id = item.value ->> 'id'
  WHERE item.value ->> 'operation' = 'update'
    AND agents.deleted_at IS NULL
    AND agents.config_revision <> (item.value ->> 'expected_revision')::bigint
  ORDER BY agents.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AGENT_CONFIG_REVISION_CONFLICT:%:%:%',
      v_conflict.id, v_conflict.expected_revision, v_conflict.current_revision
      USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_entries) AS item(value)
    JOIN public.agents AS agents
      ON agents.deleted_at IS NULL
     AND agents.bot_id = item.value ->> 'bot_id'
    WHERE item.value ->> 'operation' = 'insert'
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_entries) AS item(value)
    JOIN public.agents AS agents
      ON agents.id = item.value ->> 'id'
    WHERE item.value ->> 'operation' = 'insert'
  ) THEN
    RAISE EXCEPTION 'COZE_IMPORT_INSERT_TARGET_EXISTS' USING ERRCODE = '23505';
  END IF;

  WITH input AS (
    SELECT item.value, item.ordinality
    FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS item(value, ordinality)
    WHERE item.value ->> 'operation' = 'insert'
  ), inserted AS (
    INSERT INTO public.agents (
      id, name, description, avatar, category, source, bot_id, model,
      system_prompt, cost_per_message, sort_order, is_active
    )
    SELECT value ->> 'id',
           value ->> 'name',
           coalesce(value ->> 'description', ''),
           coalesce(value ->> 'avatar', ''),
           '通用',
           'coze',
           value ->> 'bot_id',
           '',
           coalesce(value ->> 'system_prompt', ''),
           10,
           coalesce((value ->> 'sort_order')::integer, ordinality::integer),
           true
    FROM input
    RETURNING id
  )
  SELECT count(*) INTO v_imported FROM inserted;

  WITH input AS (
    SELECT item.value
    FROM jsonb_array_elements(p_entries) AS item(value)
    WHERE item.value ->> 'operation' = 'update'
  ), updated AS (
    UPDATE public.agents AS agents
    SET name = input.value ->> 'name',
        description = coalesce(input.value ->> 'description', ''),
        avatar = coalesce(input.value ->> 'avatar', ''),
        system_prompt = coalesce(input.value ->> 'system_prompt', ''),
        updated_at = now()
    FROM input
    WHERE agents.id = input.value ->> 'id'
      AND agents.deleted_at IS NULL
      AND agents.config_revision = (input.value ->> 'expected_revision')::bigint
    RETURNING agents.id
  )
  SELECT count(*) INTO v_updated FROM updated;

  IF v_updated <> v_update_requested THEN
    RAISE EXCEPTION 'AGENT_CONFIG_REVISION_CONFLICT_AFTER_LOCK' USING ERRCODE = '40001';
  END IF;

  WITH input AS (
    SELECT item.value ->> 'id' AS id,
           item.value ->> 'operation' AS operation
    FROM jsonb_array_elements(p_entries) AS item(value)
  )
  SELECT jsonb_build_object(
    'imported', v_imported,
    'updated', v_updated,
    'agents', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', agents.id,
          'operation', input.operation,
          'config_revision', agents.config_revision
        ) ORDER BY agents.id
      ),
      '[]'::jsonb
    )
  )
  INTO v_result
  FROM input
  JOIN public.agents AS agents ON agents.id = input.id;

  RETURN v_result;
END;
$$;

DO $owner_alignment$
DECLARE
  v_agents_owner name;
  v_signature text;
  v_grantee_oid oid;
  v_grantee_name name;
BEGIN
  SELECT pg_get_userbyid(relation.relowner)
  INTO v_agents_owner
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'public.agents'::regclass;

  IF v_agents_owner IS NULL THEN
    RAISE EXCEPTION 'SHARED_AGENT_AGENTS_TABLE_OWNER_NOT_FOUND' USING ERRCODE = '55000';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.apply_agent_reorder_cas_v1(jsonb)',
    'public.apply_coze_agent_import_cas_v1(jsonb)'
  ] LOOP
    IF to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION 'SHARED_AGENT_BATCH_FUNCTION_NOT_FOUND:%', v_signature USING ERRCODE = '55000';
    END IF;
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', v_signature, v_agents_owner);
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', v_signature);
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', v_signature);

    FOR v_grantee_oid, v_grantee_name IN
      SELECT DISTINCT acl.grantee,
             coalesce(pg_get_userbyid(acl.grantee), 'PUBLIC')::name
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL aclexplode(
        coalesce(procedure.proacl, acldefault('f', procedure.proowner))
      ) AS acl
      WHERE procedure.oid = to_regprocedure(v_signature)
        AND acl.privilege_type = 'EXECUTE'
        AND acl.grantee <> procedure.proowner
        AND coalesce(pg_get_userbyid(acl.grantee), 'PUBLIC') <> 'service_role'
    LOOP
      IF v_grantee_oid = 0 THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_signature);
      ELSE
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_signature, v_grantee_name);
      END IF;
    END LOOP;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_signature);
  END LOOP;
END;
$owner_alignment$;

COMMENT ON FUNCTION public.apply_agent_reorder_cas_v1(jsonb) IS
  'Atomic shared-agent reorder. Locks all targets, validates every expected revision, then updates all rows or none.';
COMMENT ON FUNCTION public.apply_coze_agent_import_cas_v1(jsonb) IS
  'Atomic mixed Coze insert/overwrite. All target and revision checks complete before any write.';

NOTIFY pgrst, 'reload schema';
COMMIT;
