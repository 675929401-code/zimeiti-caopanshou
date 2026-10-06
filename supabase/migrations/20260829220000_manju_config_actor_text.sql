BEGIN;

-- Forward compatibility migration for environments that applied the original
-- UUID-actor Manju control plane. Historical migrations stay immutable; this
-- migration converts actor columns and recreates RPC signatures for the main
-- site's bounded text user identifiers.

DROP FUNCTION IF EXISTS public.save_manju_config_draft(
  text, text, jsonb, text, text, uuid, timestamptz, uuid
);
DROP FUNCTION IF EXISTS public.save_manju_config_draft(
  text, text, jsonb, text, text, uuid, timestamptz, text
);
DROP FUNCTION IF EXISTS public.publish_manju_config_revision(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.publish_manju_config_revision(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.rollback_manju_config_release(text, text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.rollback_manju_config_release(text, text, uuid, uuid, text);

ALTER TABLE public.manju_config_revisions
  DROP CONSTRAINT IF EXISTS manju_config_revisions_created_by_check;
ALTER TABLE public.manju_config_releases
  DROP CONSTRAINT IF EXISTS manju_config_releases_released_by_check;
ALTER TABLE public.manju_config_active
  DROP CONSTRAINT IF EXISTS manju_config_active_updated_by_check;
ALTER TABLE public.manju_config_audit
  DROP CONSTRAINT IF EXISTS manju_config_audit_actor_id_check;

ALTER TABLE public.manju_config_revisions
  ALTER COLUMN created_by TYPE text USING created_by::text;
ALTER TABLE public.manju_config_releases
  ALTER COLUMN released_by TYPE text USING released_by::text;
ALTER TABLE public.manju_config_active
  ALTER COLUMN updated_by TYPE text USING updated_by::text;
ALTER TABLE public.manju_config_audit
  ALTER COLUMN actor_id TYPE text USING actor_id::text;

ALTER TABLE public.manju_config_revisions
  ADD CONSTRAINT manju_config_revisions_created_by_check CHECK (
    created_by IS NULL
    OR (char_length(created_by) BETWEEN 1 AND 128 AND created_by = btrim(created_by))
  );
ALTER TABLE public.manju_config_releases
  ADD CONSTRAINT manju_config_releases_released_by_check CHECK (
    released_by IS NULL
    OR (char_length(released_by) BETWEEN 1 AND 128 AND released_by = btrim(released_by))
  );
ALTER TABLE public.manju_config_active
  ADD CONSTRAINT manju_config_active_updated_by_check CHECK (
    updated_by IS NULL
    OR (char_length(updated_by) BETWEEN 1 AND 128 AND updated_by = btrim(updated_by))
  );
ALTER TABLE public.manju_config_audit
  ADD CONSTRAINT manju_config_audit_actor_id_check CHECK (
    actor_id IS NULL
    OR (char_length(actor_id) BETWEEN 1 AND 128 AND actor_id = btrim(actor_id))
  );

CREATE FUNCTION public.save_manju_config_draft(
  p_environment text,
  p_domain text,
  p_payload jsonb,
  p_payload_hash text,
  p_schema_version text DEFAULT '1.0.0',
  p_revision_id uuid DEFAULT NULL,
  p_expected_updated_at timestamptz DEFAULT NULL,
  p_actor_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_environment text := lower(trim(coalesce(p_environment, '')));
  v_domain text := lower(trim(coalesce(p_domain, '')));
  v_payload_hash text := lower(trim(coalesce(p_payload_hash, '')));
  v_schema_version text := trim(coalesce(p_schema_version, ''));
  v_revision public.manju_config_revisions%ROWTYPE;
  v_previous_updated_at timestamptz;
  v_previous_payload_hash text;
  v_parent_revision_id uuid;
  v_next_version bigint;
  v_action text;
BEGIN
  IF v_environment NOT IN ('production', 'staging', 'development') THEN
    RAISE EXCEPTION 'MANJU_CONFIG_ENVIRONMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_domain NOT IN (
    'prompt', 'skill', 'agent', 'workflow', 'content', 'media',
    'feature_flags', 'model_policy', 'ui'
  ) THEN
    RAISE EXCEPTION 'MANJU_CONFIG_DOMAIN_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'MANJU_CONFIG_PAYLOAD_OBJECT_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_payload_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'MANJU_CONFIG_PAYLOAD_HASH_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_schema_version !~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$' THEN
    RAISE EXCEPTION 'MANJU_CONFIG_SCHEMA_VERSION_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Use the same scope lock as publish/rollback.  This prevents version races
  -- for new drafts and establishes one lock order for every control-plane RPC.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('manju-config:' || v_environment || ':' || v_domain, 0)
  );

  IF p_revision_id IS NULL THEN
    IF p_expected_updated_at IS NOT NULL THEN
      RAISE EXCEPTION 'MANJU_CONFIG_NEW_DRAFT_EXPECTATION_FORBIDDEN'
        USING ERRCODE = '22023';
    END IF;

    SELECT coalesce(max(version), 0) + 1
      INTO v_next_version
      FROM public.manju_config_revisions
     WHERE environment = v_environment
       AND domain = v_domain;

    SELECT active_revision_id
      INTO v_parent_revision_id
      FROM public.manju_config_active
     WHERE environment = v_environment
       AND domain = v_domain;

    INSERT INTO public.manju_config_revisions (
      environment,
      domain,
      version,
      status,
      payload,
      payload_hash,
      schema_version,
      parent_revision_id,
      created_by
    ) VALUES (
      v_environment,
      v_domain,
      v_next_version,
      'draft',
      p_payload,
      v_payload_hash,
      v_schema_version,
      v_parent_revision_id,
      p_actor_id
    ) RETURNING * INTO v_revision;
    v_action := 'create_draft';

    INSERT INTO public.manju_config_audit (
      action, environment, domain, revision_id, actor_id, detail
    ) VALUES (
      v_action,
      v_environment,
      v_domain,
      v_revision.id,
      p_actor_id,
      jsonb_build_object(
        'version', v_revision.version,
        'schema_version', v_revision.schema_version,
        'payload_hash', v_revision.payload_hash,
        'parent_revision_id', v_revision.parent_revision_id
      )
    );
  ELSE
    IF p_expected_updated_at IS NULL THEN
      RAISE EXCEPTION 'MANJU_CONFIG_EXPECTED_UPDATED_AT_REQUIRED'
        USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_revision
      FROM public.manju_config_revisions
     WHERE id = p_revision_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MANJU_CONFIG_REVISION_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF v_revision.environment <> v_environment OR v_revision.domain <> v_domain THEN
      RAISE EXCEPTION 'MANJU_CONFIG_REVISION_SCOPE_MISMATCH' USING ERRCODE = '22023';
    END IF;
    IF v_revision.status <> 'draft' THEN
      RAISE EXCEPTION 'MANJU_CONFIG_REVISION_NOT_DRAFT' USING ERRCODE = '55000';
    END IF;
    IF v_revision.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'MANJU_CONFIG_DRAFT_CONFLICT expected=% actual=%',
        p_expected_updated_at, v_revision.updated_at
        USING ERRCODE = '40001';
    END IF;

    v_previous_updated_at := v_revision.updated_at;
    v_previous_payload_hash := v_revision.payload_hash;

    UPDATE public.manju_config_revisions
       SET payload = p_payload,
           payload_hash = v_payload_hash,
           schema_version = v_schema_version
     WHERE id = v_revision.id
     RETURNING * INTO v_revision;
    v_action := 'update_draft';

    INSERT INTO public.manju_config_audit (
      action, environment, domain, revision_id, actor_id, detail
    ) VALUES (
      v_action,
      v_environment,
      v_domain,
      v_revision.id,
      p_actor_id,
      jsonb_build_object(
        'version', v_revision.version,
        'schema_version', v_revision.schema_version,
        'previous_payload_hash', v_previous_payload_hash,
        'payload_hash', v_revision.payload_hash,
        'expected_updated_at', p_expected_updated_at,
        'previous_updated_at', v_previous_updated_at,
        'updated_at', v_revision.updated_at
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action,
    'revision_id', v_revision.id,
    'environment', v_revision.environment,
    'domain', v_revision.domain,
    'version', v_revision.version,
    'status', v_revision.status,
    'payload_hash', v_revision.payload_hash,
    'schema_version', v_revision.schema_version,
    'parent_revision_id', v_revision.parent_revision_id,
    'updated_at', v_revision.updated_at
  );
END;
$$;

CREATE FUNCTION public.publish_manju_config_revision(
  p_revision_id uuid,
  p_expected_active_release_id uuid DEFAULT NULL,
  p_actor_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_revision public.manju_config_revisions%ROWTYPE;
  v_active public.manju_config_active%ROWTYPE;
  v_release public.manju_config_releases%ROWTYPE;
  v_has_active boolean := false;
  v_release_number bigint;
  v_etag text;
BEGIN
  IF p_revision_id IS NULL THEN
    RAISE EXCEPTION 'MANJU_CONFIG_REVISION_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- Read the immutable scope first, acquire the shared domain lock, then lock
  -- and re-read the revision.  This avoids a revision/advisory lock inversion
  -- with save_manju_config_draft.
  SELECT * INTO v_revision
    FROM public.manju_config_revisions
   WHERE id = p_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_REVISION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('manju-config:' || v_revision.environment || ':' || v_revision.domain, 0)
  );

  SELECT * INTO v_revision
    FROM public.manju_config_revisions
   WHERE id = p_revision_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_REVISION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_revision.status <> 'draft' THEN
    RAISE EXCEPTION 'MANJU_CONFIG_REVISION_NOT_DRAFT' USING ERRCODE = '55000';
  END IF;
  IF v_revision.domain IN ('prompt', 'content', 'media', 'feature_flags')
     AND v_revision.schema_version IS DISTINCT FROM '1.1.0' THEN
    RAISE EXCEPTION
      'MANJU_CONFIG_ACTIVATION_SCHEMA_VERSION_UNSUPPORTED domain=% expected=1.1.0 actual=%',
      v_revision.domain,
      coalesce(v_revision.schema_version, '<null>')
      USING ERRCODE = '55000',
            HINT = 'Create and validate a new schema_version=1.1.0 draft; historical revisions remain readable but cannot be activated directly.';
  END IF;

  SELECT * INTO v_active
    FROM public.manju_config_active
   WHERE environment = v_revision.environment
     AND domain = v_revision.domain
   FOR UPDATE;
  v_has_active := FOUND;

  IF (v_has_active AND p_expected_active_release_id IS NULL)
     OR (NOT v_has_active AND p_expected_active_release_id IS NOT NULL)
     OR (v_has_active AND v_active.active_release_id <> p_expected_active_release_id) THEN
    RAISE EXCEPTION 'MANJU_CONFIG_ACTIVE_CONFLICT expected=% actual=%',
      coalesce(p_expected_active_release_id::text, '<none>'),
      CASE WHEN v_has_active THEN v_active.active_release_id::text ELSE '<none>' END
      USING ERRCODE = '40001';
  END IF;

  SELECT coalesce(max(release_number), 0) + 1
    INTO v_release_number
    FROM public.manju_config_releases
   WHERE environment = v_revision.environment
     AND domain = v_revision.domain;
  v_etag := v_revision.payload_hash || ':' || v_release_number::text;

  IF v_has_active AND v_active.active_revision_id <> v_revision.id THEN
    UPDATE public.manju_config_revisions
       SET status = 'superseded'
     WHERE id = v_active.active_revision_id;
  END IF;

  UPDATE public.manju_config_revisions
     SET status = 'published',
         published_at = coalesce(published_at, now())
   WHERE id = v_revision.id
   RETURNING * INTO v_revision;

  INSERT INTO public.manju_config_releases (
    environment,
    domain,
    release_number,
    revision_id,
    previous_release_id,
    release_kind,
    rollback_of_release_id,
    etag,
    released_by
  ) VALUES (
    v_revision.environment,
    v_revision.domain,
    v_release_number,
    v_revision.id,
    CASE WHEN v_has_active THEN v_active.active_release_id ELSE NULL END,
    'publish',
    NULL,
    v_etag,
    p_actor_id
  ) RETURNING * INTO v_release;

  INSERT INTO public.manju_config_active (
    environment, domain, active_release_id, active_revision_id, etag, updated_by
  ) VALUES (
    v_revision.environment, v_revision.domain, v_release.id, v_revision.id, v_etag, p_actor_id
  )
  ON CONFLICT (environment, domain) DO UPDATE SET
    active_release_id = EXCLUDED.active_release_id,
    active_revision_id = EXCLUDED.active_revision_id,
    etag = EXCLUDED.etag,
    updated_by = EXCLUDED.updated_by,
    updated_at = now();

  INSERT INTO public.manju_config_audit (
    action, environment, domain, revision_id, release_id,
    previous_release_id, actor_id, detail
  ) VALUES (
    'publish', v_revision.environment, v_revision.domain, v_revision.id,
    v_release.id,
    CASE WHEN v_has_active THEN v_active.active_release_id ELSE NULL END,
    p_actor_id,
    jsonb_build_object(
      'version', v_revision.version,
      'schema_version', v_revision.schema_version,
      'payload_hash', v_revision.payload_hash,
      'expected_active_release_id', p_expected_active_release_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'publish',
    'environment', v_revision.environment,
    'domain', v_revision.domain,
    'revision_id', v_revision.id,
    'release_id', v_release.id,
    'release_number', v_release.release_number,
    'etag', v_release.etag
  );
END;
$$;

CREATE FUNCTION public.rollback_manju_config_release(
  p_environment text,
  p_domain text,
  p_target_release_id uuid,
  p_expected_active_release_id uuid DEFAULT NULL,
  p_actor_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_environment text := lower(trim(coalesce(p_environment, '')));
  v_domain text := lower(trim(coalesce(p_domain, '')));
  v_active public.manju_config_active%ROWTYPE;
  v_target_release public.manju_config_releases%ROWTYPE;
  v_target_revision public.manju_config_revisions%ROWTYPE;
  v_release public.manju_config_releases%ROWTYPE;
  v_release_number bigint;
  v_etag text;
BEGIN
  IF v_environment NOT IN ('production', 'staging', 'development') THEN
    RAISE EXCEPTION 'MANJU_CONFIG_ENVIRONMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_domain NOT IN (
    'prompt', 'skill', 'agent', 'workflow', 'content', 'media',
    'feature_flags', 'model_policy', 'ui'
  ) THEN
    RAISE EXCEPTION 'MANJU_CONFIG_DOMAIN_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_target_release_id IS NULL OR p_expected_active_release_id IS NULL THEN
    RAISE EXCEPTION 'MANJU_CONFIG_ROLLBACK_POINTERS_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('manju-config:' || v_environment || ':' || v_domain, 0)
  );

  SELECT * INTO v_active
    FROM public.manju_config_active
   WHERE environment = v_environment
     AND domain = v_domain
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_ACTIVE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_active.active_release_id <> p_expected_active_release_id THEN
    RAISE EXCEPTION 'MANJU_CONFIG_ACTIVE_CONFLICT expected=% actual=%',
      p_expected_active_release_id, v_active.active_release_id
      USING ERRCODE = '40001';
  END IF;
  IF v_active.active_release_id = p_target_release_id THEN
    RAISE EXCEPTION 'MANJU_CONFIG_ROLLBACK_TARGET_ALREADY_ACTIVE'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_target_release
    FROM public.manju_config_releases
   WHERE id = p_target_release_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_target_release.environment <> v_environment
     OR v_target_release.domain <> v_domain THEN
    RAISE EXCEPTION 'MANJU_CONFIG_ROLLBACK_TARGET_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_target_revision
    FROM public.manju_config_revisions
   WHERE id = v_target_release.revision_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_ROLLBACK_REVISION_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_target_revision.environment IS DISTINCT FROM v_environment
     OR v_target_revision.domain IS DISTINCT FROM v_domain THEN
    RAISE EXCEPTION 'MANJU_CONFIG_ROLLBACK_REVISION_SCOPE_MISMATCH'
      USING ERRCODE = '40001';
  END IF;
  IF v_target_revision.domain IN ('prompt', 'content', 'media', 'feature_flags')
     AND v_target_revision.schema_version IS DISTINCT FROM '1.1.0' THEN
    RAISE EXCEPTION
      'MANJU_CONFIG_ACTIVATION_SCHEMA_VERSION_UNSUPPORTED domain=% expected=1.1.0 actual=%',
      v_target_revision.domain,
      coalesce(v_target_revision.schema_version, '<null>')
      USING ERRCODE = '55000',
            HINT = 'Use an upgrade-rollback: copy the historical payload into a new schema_version=1.1.0 draft, validate it, and publish a new release.';
  END IF;
  IF v_target_revision.id = v_active.active_revision_id THEN
    RAISE EXCEPTION 'MANJU_CONFIG_ROLLBACK_WOULD_NOT_CHANGE_REVISION'
      USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(max(release_number), 0) + 1
    INTO v_release_number
    FROM public.manju_config_releases
   WHERE environment = v_environment
     AND domain = v_domain;
  v_etag := v_target_revision.payload_hash || ':' || v_release_number::text;

  UPDATE public.manju_config_revisions
     SET status = 'superseded'
   WHERE id = v_active.active_revision_id;
  UPDATE public.manju_config_revisions
     SET status = 'published'
   WHERE id = v_target_revision.id
   RETURNING * INTO v_target_revision;

  INSERT INTO public.manju_config_releases (
    environment,
    domain,
    release_number,
    revision_id,
    previous_release_id,
    release_kind,
    rollback_of_release_id,
    etag,
    released_by
  ) VALUES (
    v_environment,
    v_domain,
    v_release_number,
    v_target_revision.id,
    v_active.active_release_id,
    'rollback',
    v_target_release.id,
    v_etag,
    p_actor_id
  ) RETURNING * INTO v_release;

  UPDATE public.manju_config_active
     SET active_release_id = v_release.id,
         active_revision_id = v_target_revision.id,
         etag = v_etag,
         updated_by = p_actor_id,
         updated_at = now()
   WHERE environment = v_environment
     AND domain = v_domain;

  INSERT INTO public.manju_config_audit (
    action, environment, domain, revision_id, release_id,
    previous_release_id, actor_id, detail
  ) VALUES (
    'rollback', v_environment, v_domain, v_target_revision.id,
    v_release.id, v_active.active_release_id, p_actor_id,
    jsonb_build_object(
      'target_release_id', v_target_release.id,
      'target_release_number', v_target_release.release_number,
      'target_revision_version', v_target_revision.version,
      'payload_hash', v_target_revision.payload_hash,
      'expected_active_release_id', p_expected_active_release_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'rollback',
    'environment', v_environment,
    'domain', v_domain,
    'revision_id', v_target_revision.id,
    'release_id', v_release.id,
    'release_number', v_release.release_number,
    'rollback_of_release_id', v_target_release.id,
    'etag', v_release.etag
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_manju_config_draft(
  text, text, jsonb, text, text, uuid, timestamptz, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_manju_config_revision(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rollback_manju_config_release(text, text, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_manju_config_draft(
  text, text, jsonb, text, text, uuid, timestamptz, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_manju_config_revision(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.rollback_manju_config_release(text, text, uuid, uuid, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
