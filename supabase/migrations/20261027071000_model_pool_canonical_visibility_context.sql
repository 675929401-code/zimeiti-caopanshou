BEGIN;

-- The canonical projector owns this narrow retirement capability. A session
-- GUC, caller-owned temp relation, or a permit for another row is insufficient.


DO $install$
DECLARE
  v_original pg_proc%ROWTYPE;
  v_owner text;
  v_grantee record;
  v_acl record;
BEGIN
  SELECT * INTO STRICT v_original FROM pg_proc
   WHERE oid = 'public.project_model_pool_configuration_atomic(jsonb)'::regprocedure;
  IF NOT v_original.prosecdef OR v_original.provolatile <> 'v'
     OR to_regprocedure('public.project_model_pool_before_visibility(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'MODEL_POOL_VISIBILITY_PROJECTOR_IDENTITY_INVALID';
  END IF;
  v_owner := pg_get_userbyid(v_original.proowner);
  EXECUTE replace($trigger_ddl$
CREATE OR REPLACE FUNCTION public.enforce_model_resource_visibility_invariant()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $visibility$
DECLARE
  v_owner oid;
  v_removed boolean;
  v_relation oid;
  v_allowed boolean := false;
BEGIN
  IF NEW.provider IS NOT DISTINCT FROM 'retired_configuration' THEN
    RETURN NEW;
  END IF;
  v_relation := to_regclass('pg_temp.model_pool_canonical_visibility_permit');
  IF v_relation IS NOT NULL THEN
    SELECT oid INTO v_owner FROM pg_roles WHERE rolname = __EXPECTED_OWNER_LITERAL__;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class relation
       WHERE relation.oid = v_relation AND relation.relowner = v_owner
         AND relation.relpersistence = 't' AND relation.relkind = 'r'
         AND relation.relnamespace = pg_my_temp_schema()
         AND (SELECT count(*) FROM pg_attribute attribute WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped) = 7
         AND (SELECT array_agg(attribute.attname::text || ':' || attribute.atttypid::regtype::text ORDER BY attribute.attnum) FROM pg_attribute attribute WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped AND attribute.attnotnull) = ARRAY['legacy_table:text','legacy_id:text','transaction_id:bigint','backend_pid:integer','expected_present:boolean','removed:boolean','original_hash:text']
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'MODEL_POOL_VISIBILITY_CONTEXT_UNTRUSTED';
    END IF;
    IF TG_TABLE_SCHEMA = 'public'
       AND TG_TABLE_NAME IN ('cover_models', 'video_models', 'llm_models')
       AND current_user = pg_get_userbyid(v_owner)
       AND NEW.is_active IS FALSE AND NEW.is_hidden IS TRUE THEN
      SELECT permit.removed INTO v_removed
        FROM pg_temp.model_pool_canonical_visibility_permit permit
         WHERE permit.legacy_table = TG_TABLE_NAME AND permit.legacy_id = NEW.id::text
           AND permit.transaction_id = txid_current() AND permit.backend_pid = pg_backend_pid()
      ;
      IF FOUND AND v_removed AND (TG_OP <> 'UPDATE' OR
          (to_jsonb(NEW) - ARRAY['is_active','is_hidden','updated_at']) IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['is_active','is_hidden','updated_at'])) THEN
        RAISE EXCEPTION 'MODEL_POOL_REMOVAL_CONTENT_CHANGED';
      END IF;
      IF FOUND AND ((TG_OP = 'UPDATE' AND (NOT v_removed OR (to_jsonb(NEW) - ARRAY['is_active','is_hidden','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['is_active','is_hidden','updated_at']))) OR (TG_OP = 'INSERT' AND NOT v_removed)) THEN
        v_allowed := true;
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_active IS FALSE AND OLD.is_hidden IS TRUE
     AND NEW.is_active IS FALSE AND NEW.is_hidden IS TRUE THEN
    RETURN NEW;
  END IF;
  IF NOT v_allowed THEN
    NEW.is_active := true;
    NEW.is_hidden := false;
  END IF;
  RETURN NEW;
END;
$visibility$;
$trigger_ddl$, '__EXPECTED_OWNER_LITERAL__', quote_literal(v_owner));
  ALTER FUNCTION public.project_model_pool_configuration_atomic(jsonb)
    RENAME TO project_model_pool_before_visibility;
  EXECUTE replace($wrapper_ddl$
CREATE FUNCTION public.project_model_pool_configuration_atomic(p_snapshot jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $wrapper$
DECLARE
  v_delta jsonb;
  v_target record;
  v_relation oid;
  v_owner oid;
  v_grantee record;
  v_present boolean;
  v_retired boolean;
  v_hash text;
BEGIN
  SELECT oid INTO v_owner FROM pg_roles WHERE rolname = __EXPECTED_OWNER_LITERAL__;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.project_model_pool_configuration_atomic(jsonb)'::regprocedure AND proowner = v_owner) OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.project_model_pool_before_visibility(jsonb)'::regprocedure AND proowner = v_owner) THEN
    RAISE EXCEPTION 'MODEL_POOL_VISIBILITY_PROJECTOR_OWNER_DRIFT';
  END IF;
  IF current_user <> pg_get_userbyid(v_owner) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'MODEL_POOL_VISIBILITY_CONTEXT_OWNER_REQUIRED';
  END IF;
  v_relation := to_regclass('pg_temp.model_pool_canonical_visibility_permit');
  IF v_relation IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_class relation WHERE relation.oid = v_relation
       AND relation.relowner = v_owner AND relation.relpersistence = 't'
       AND relation.relkind = 'r' AND relation.relnamespace = pg_my_temp_schema()) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'MODEL_POOL_VISIBILITY_CONTEXT_UNTRUSTED';
    END IF;
    RAISE EXCEPTION 'MODEL_POOL_VISIBILITY_CONTEXT_REENTRY';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(delta)), '[]'::jsonb) INTO v_delta
    FROM public.model_pool_projection_delta(p_snapshot) delta;
  CREATE TEMP TABLE pg_temp.model_pool_canonical_visibility_permit (
    legacy_table text NOT NULL,
    legacy_id text NOT NULL,
    transaction_id bigint NOT NULL,
    backend_pid integer NOT NULL,
    expected_present boolean NOT NULL,
    removed boolean NOT NULL,
    original_hash text NOT NULL,
    PRIMARY KEY (legacy_table, legacy_id)
  ) ON COMMIT DROP;
  -- Remove all default grants as well as the named API roles. Only the
  -- SECURITY DEFINER owner may populate or alter this per-backend capability.
  FOR v_grantee IN SELECT DISTINCT acl.grantee
    FROM pg_class relation,
      LATERAL aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
   WHERE relation.oid = 'pg_temp.model_pool_canonical_visibility_permit'::regclass
     AND acl.grantee <> v_owner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE pg_temp.model_pool_canonical_visibility_permit FROM %s',
      CASE WHEN v_grantee.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_grantee.grantee)) END);
  END LOOP;
  REVOKE ALL ON TABLE pg_temp.model_pool_canonical_visibility_permit FROM PUBLIC, anon, authenticated, service_role;
  FOR v_target IN
    SELECT delta.legacy_table, delta.legacy_id, delta.removed
      FROM jsonb_to_recordset(v_delta) delta(legacy_table text, legacy_id text, removed boolean)
     WHERE delta.legacy_table IN ('cover_models', 'video_models', 'llm_models')
       AND (delta.removed OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_snapshot->'models') model
          WHERE model #>> '{configuration,legacyTable}' = delta.legacy_table
            AND model #>> '{configuration,legacyId}' = delta.legacy_id
            AND model->>'catalogState' = 'retired'
       ))
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id::text = $1)', v_target.legacy_table)
      INTO v_present USING v_target.legacy_id;
    EXECUTE format('SELECT coalesce((SELECT encode(sha256(convert_to((to_jsonb(target) - ARRAY[''is_active'',''is_hidden'',''updated_at''])::text, ''UTF8'')), ''hex'') FROM public.%I target WHERE id::text = $1), '''')', v_target.legacy_table)
      INTO v_hash USING v_target.legacy_id;
    INSERT INTO pg_temp.model_pool_canonical_visibility_permit
      VALUES(v_target.legacy_table, v_target.legacy_id, txid_current(), pg_backend_pid(), v_present, v_target.removed, v_hash);
  END LOOP;
  PERFORM public.project_model_pool_before_visibility(p_snapshot);
  FOR v_target IN SELECT * FROM pg_temp.model_pool_canonical_visibility_permit
  LOOP
    IF v_target.expected_present OR NOT v_target.removed THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id::text = $1 AND is_active IS FALSE AND is_hidden IS TRUE)', v_target.legacy_table)
        INTO v_retired USING v_target.legacy_id;
      IF NOT v_retired THEN
        RAISE EXCEPTION 'MODEL_POOL_CANONICAL_RETIREMENT_NOT_APPLIED: %/%', v_target.legacy_table, v_target.legacy_id;
      END IF;
      IF v_target.removed THEN
        EXECUTE format('SELECT coalesce((SELECT encode(sha256(convert_to((to_jsonb(target) - ARRAY[''is_active'',''is_hidden'',''updated_at''])::text, ''UTF8'')), ''hex'') FROM public.%I target WHERE id::text = $1), '''')', v_target.legacy_table)
          INTO v_hash USING v_target.legacy_id;
        IF v_hash IS DISTINCT FROM v_target.original_hash THEN
          RAISE EXCEPTION 'MODEL_POOL_REMOVAL_CONTENT_CHANGED';
        END IF;
      END IF;
    ELSE
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id::text = $1)', v_target.legacy_table) INTO v_present USING v_target.legacy_id;
      IF v_present THEN RAISE EXCEPTION 'MODEL_POOL_REMOVED_ABSENT_ROW_REINSERTED'; END IF;
    END IF;
  END LOOP;
  DROP TABLE pg_temp.model_pool_canonical_visibility_permit;
END;
$wrapper$;
$wrapper_ddl$, '__EXPECTED_OWNER_LITERAL__', quote_literal(v_owner));
  EXECUTE format('ALTER FUNCTION public.project_model_pool_configuration_atomic(jsonb) OWNER TO %I', v_owner);
  -- Remove CREATE FUNCTION defaults, then restore the original API ACL exactly
  -- by grantee/privilege/grant option. The renamed implementation is owner-only.
  FOR v_grantee IN
    SELECT DISTINCT acl.grantee FROM pg_proc routine,
      LATERAL aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) acl
     WHERE routine.oid IN (
       'public.project_model_pool_configuration_atomic(jsonb)'::regprocedure,
       'public.project_model_pool_before_visibility(jsonb)'::regprocedure)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.project_model_pool_configuration_atomic(jsonb) FROM %s',
      CASE WHEN v_grantee.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_grantee.grantee)) END);
    EXECUTE format('REVOKE ALL ON FUNCTION public.project_model_pool_before_visibility(jsonb) FROM %s',
      CASE WHEN v_grantee.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_grantee.grantee)) END);
  END LOOP;
  REVOKE ALL ON FUNCTION public.project_model_pool_before_visibility(jsonb) FROM PUBLIC, anon, authenticated, service_role;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.project_model_pool_before_visibility(jsonb) TO %I', v_owner);
  FOR v_acl IN SELECT * FROM aclexplode(coalesce(v_original.proacl, acldefault('f', v_original.proowner)))
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.project_model_pool_configuration_atomic(jsonb) TO %s%s',
      CASE WHEN v_acl.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_acl.grantee)) END,
      CASE WHEN v_acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END;
$install$;

COMMIT;
