BEGIN;

-- Manju Workbench configuration control plane.
--
-- This migration deliberately stores configuration as versioned JSON rather
-- than coupling mutable prompts, skills, workflows and presentation content to
-- the application bundle.  A release is an immutable event for exactly one
-- (environment, domain) pair.  The active table is the sole mutable pointer.

CREATE TABLE public.manju_config_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL,
  domain text NOT NULL,
  version bigint NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_hash text NOT NULL,
  schema_version text NOT NULL DEFAULT '1.0.0',
  parent_revision_id uuid REFERENCES public.manju_config_revisions(id) ON DELETE RESTRICT,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT manju_config_revisions_environment_check CHECK (
    environment IN ('production', 'staging', 'development')
  ),
  CONSTRAINT manju_config_revisions_domain_check CHECK (
    domain IN (
      'prompt', 'skill', 'agent', 'workflow', 'content', 'media',
      'feature_flags', 'model_policy', 'ui'
    )
  ),
  CONSTRAINT manju_config_revisions_version_check CHECK (version >= 1),
  CONSTRAINT manju_config_revisions_status_check CHECK (
    status IN ('draft', 'published', 'superseded')
  ),
  CONSTRAINT manju_config_revisions_payload_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT manju_config_revisions_payload_hash_check CHECK (
    payload_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT manju_config_revisions_schema_version_check CHECK (
    schema_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$'
  ),
  CONSTRAINT manju_config_revisions_publish_time_check CHECK (
    (status = 'draft' AND published_at IS NULL)
    OR
    (status IN ('published', 'superseded') AND published_at IS NOT NULL)
  ),
  CONSTRAINT manju_config_revisions_environment_domain_version_unique
    UNIQUE (environment, domain, version),
  CONSTRAINT manju_config_revisions_composite_identity_unique
    UNIQUE (id, environment, domain)
);

CREATE TABLE public.manju_config_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL,
  domain text NOT NULL,
  release_number bigint NOT NULL,
  revision_id uuid NOT NULL,
  previous_release_id uuid,
  release_kind text NOT NULL,
  rollback_of_release_id uuid,
  etag text NOT NULL,
  released_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manju_config_releases_environment_check CHECK (
    environment IN ('production', 'staging', 'development')
  ),
  CONSTRAINT manju_config_releases_domain_check CHECK (
    domain IN (
      'prompt', 'skill', 'agent', 'workflow', 'content', 'media',
      'feature_flags', 'model_policy', 'ui'
    )
  ),
  CONSTRAINT manju_config_releases_number_check CHECK (release_number >= 1),
  CONSTRAINT manju_config_releases_kind_check CHECK (
    release_kind IN ('publish', 'rollback')
  ),
  CONSTRAINT manju_config_releases_kind_target_check CHECK (
    (release_kind = 'publish' AND rollback_of_release_id IS NULL)
    OR
    (release_kind = 'rollback' AND rollback_of_release_id IS NOT NULL)
  ),
  CONSTRAINT manju_config_releases_etag_check CHECK (
    etag ~ '^[0-9a-f]{64}:[1-9][0-9]*$'
  ),
  CONSTRAINT manju_config_releases_environment_domain_number_unique
    UNIQUE (environment, domain, release_number),
  CONSTRAINT manju_config_releases_composite_identity_unique
    UNIQUE (id, environment, domain),
  CONSTRAINT manju_config_releases_revision_fk
    FOREIGN KEY (revision_id, environment, domain)
    REFERENCES public.manju_config_revisions(id, environment, domain)
    ON DELETE RESTRICT,
  CONSTRAINT manju_config_releases_previous_fk
    FOREIGN KEY (previous_release_id, environment, domain)
    REFERENCES public.manju_config_releases(id, environment, domain)
    ON DELETE RESTRICT,
  CONSTRAINT manju_config_releases_rollback_target_fk
    FOREIGN KEY (rollback_of_release_id, environment, domain)
    REFERENCES public.manju_config_releases(id, environment, domain)
    ON DELETE RESTRICT
);

CREATE TABLE public.manju_config_active (
  environment text NOT NULL,
  domain text NOT NULL,
  active_release_id uuid NOT NULL,
  active_revision_id uuid NOT NULL,
  etag text NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, domain),
  CONSTRAINT manju_config_active_environment_check CHECK (
    environment IN ('production', 'staging', 'development')
  ),
  CONSTRAINT manju_config_active_domain_check CHECK (
    domain IN (
      'prompt', 'skill', 'agent', 'workflow', 'content', 'media',
      'feature_flags', 'model_policy', 'ui'
    )
  ),
  CONSTRAINT manju_config_active_etag_check CHECK (
    etag ~ '^[0-9a-f]{64}:[1-9][0-9]*$'
  ),
  CONSTRAINT manju_config_active_release_fk
    FOREIGN KEY (active_release_id, environment, domain)
    REFERENCES public.manju_config_releases(id, environment, domain)
    ON DELETE RESTRICT,
  CONSTRAINT manju_config_active_revision_fk
    FOREIGN KEY (active_revision_id, environment, domain)
    REFERENCES public.manju_config_revisions(id, environment, domain)
    ON DELETE RESTRICT
);

CREATE TABLE public.manju_config_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL,
  environment text NOT NULL,
  domain text NOT NULL,
  revision_id uuid,
  release_id uuid,
  previous_release_id uuid,
  actor_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manju_config_audit_action_check CHECK (
    action IN ('validate', 'create_draft', 'update_draft', 'publish', 'rollback')
  ),
  CONSTRAINT manju_config_audit_environment_check CHECK (
    environment IN ('production', 'staging', 'development')
  ),
  CONSTRAINT manju_config_audit_domain_check CHECK (
    domain IN (
      'prompt', 'skill', 'agent', 'workflow', 'content', 'media',
      'feature_flags', 'model_policy', 'ui'
    )
  ),
  CONSTRAINT manju_config_audit_detail_check CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT manju_config_audit_revision_fk
    FOREIGN KEY (revision_id) REFERENCES public.manju_config_revisions(id) ON DELETE RESTRICT,
  CONSTRAINT manju_config_audit_release_fk
    FOREIGN KEY (release_id) REFERENCES public.manju_config_releases(id) ON DELETE RESTRICT,
  CONSTRAINT manju_config_audit_previous_release_fk
    FOREIGN KEY (previous_release_id) REFERENCES public.manju_config_releases(id) ON DELETE RESTRICT
);

CREATE INDEX manju_config_revisions_lookup_idx
  ON public.manju_config_revisions (environment, domain, status, version DESC);
CREATE INDEX manju_config_revisions_parent_idx
  ON public.manju_config_revisions (parent_revision_id)
  WHERE parent_revision_id IS NOT NULL;
CREATE INDEX manju_config_revisions_hash_idx
  ON public.manju_config_revisions (environment, domain, payload_hash);
CREATE INDEX manju_config_releases_revision_idx
  ON public.manju_config_releases (revision_id, created_at DESC);
CREATE INDEX manju_config_releases_history_idx
  ON public.manju_config_releases (environment, domain, release_number DESC);
CREATE INDEX manju_config_audit_history_idx
  ON public.manju_config_audit (environment, domain, created_at DESC);
CREATE INDEX manju_config_audit_release_idx
  ON public.manju_config_audit (release_id)
  WHERE release_id IS NOT NULL;

CREATE FUNCTION public.manju_config_guard_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_parent_environment text;
  v_parent_domain text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'MANJU_CONFIG_REVISION_MUST_START_AS_DRAFT'
        USING ERRCODE = '22023';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft'
       OR EXISTS (
         SELECT 1 FROM public.manju_config_releases release
          WHERE release.revision_id = OLD.id
       ) THEN
      RAISE EXCEPTION 'MANJU_CONFIG_REVISION_IMMUTABLE'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.environment IS DISTINCT FROM OLD.environment
       OR NEW.domain IS DISTINCT FROM OLD.domain
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'MANJU_CONFIG_REVISION_IDENTITY_IMMUTABLE'
        USING ERRCODE = '55000';
    END IF;

    IF OLD.status <> 'draft'
       OR EXISTS (
         SELECT 1 FROM public.manju_config_releases release
          WHERE release.revision_id = OLD.id
       ) THEN
      IF NEW.payload IS DISTINCT FROM OLD.payload
         OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
         OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
         OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id THEN
        RAISE EXCEPTION 'MANJU_CONFIG_REVISION_PAYLOAD_IMMUTABLE'
          USING ERRCODE = '55000';
      END IF;
    END IF;

    IF NOT (
      (OLD.status = 'draft' AND NEW.status IN ('draft', 'published'))
      OR (OLD.status = 'published' AND NEW.status IN ('published', 'superseded'))
      OR (OLD.status = 'superseded' AND NEW.status IN ('superseded', 'published'))
    ) THEN
      RAISE EXCEPTION 'MANJU_CONFIG_REVISION_STATUS_TRANSITION_INVALID:%->%',
        OLD.status, NEW.status USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NEW.parent_revision_id IS NOT NULL THEN
    SELECT parent.environment, parent.domain
      INTO v_parent_environment, v_parent_domain
      FROM public.manju_config_revisions parent
     WHERE parent.id = NEW.parent_revision_id;
    IF NOT FOUND
       OR v_parent_environment <> NEW.environment
       OR v_parent_domain <> NEW.domain THEN
      RAISE EXCEPTION 'MANJU_CONFIG_PARENT_REVISION_SCOPE_MISMATCH'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.manju_config_touch_revision_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.manju_config_guard_release()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_revision public.manju_config_revisions%ROWTYPE;
  v_link public.manju_config_releases%ROWTYPE;
BEGIN
  SELECT * INTO v_revision
    FROM public.manju_config_revisions
   WHERE id = NEW.revision_id;
  IF NOT FOUND
     OR v_revision.environment <> NEW.environment
     OR v_revision.domain <> NEW.domain
     OR v_revision.status NOT IN ('published', 'superseded') THEN
    RAISE EXCEPTION 'MANJU_CONFIG_RELEASE_REVISION_INVALID'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.etag <> (v_revision.payload_hash || ':' || NEW.release_number::text) THEN
    RAISE EXCEPTION 'MANJU_CONFIG_RELEASE_ETAG_INVALID'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.previous_release_id IS NOT NULL THEN
    SELECT * INTO v_link
      FROM public.manju_config_releases
     WHERE id = NEW.previous_release_id;
    IF NOT FOUND
       OR v_link.environment <> NEW.environment
       OR v_link.domain <> NEW.domain THEN
      RAISE EXCEPTION 'MANJU_CONFIG_PREVIOUS_RELEASE_SCOPE_MISMATCH'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.release_kind = 'publish' AND NEW.rollback_of_release_id IS NOT NULL THEN
    RAISE EXCEPTION 'MANJU_CONFIG_PUBLISH_ROLLBACK_TARGET_FORBIDDEN'
      USING ERRCODE = '23514';
  ELSIF NEW.release_kind = 'rollback' THEN
    SELECT * INTO v_link
      FROM public.manju_config_releases
     WHERE id = NEW.rollback_of_release_id;
    IF NOT FOUND
       OR v_link.environment <> NEW.environment
       OR v_link.domain <> NEW.domain
       OR v_link.revision_id <> NEW.revision_id THEN
      RAISE EXCEPTION 'MANJU_CONFIG_ROLLBACK_TARGET_INVALID'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.manju_config_reject_release_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'MANJU_CONFIG_RELEASE_IMMUTABLE'
    USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION public.manju_config_guard_active_pointer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_release public.manju_config_releases%ROWTYPE;
BEGIN
  SELECT * INTO v_release
    FROM public.manju_config_releases
   WHERE id = NEW.active_release_id;
  IF NOT FOUND
     OR v_release.environment <> NEW.environment
     OR v_release.domain <> NEW.domain
     OR v_release.revision_id <> NEW.active_revision_id
     OR v_release.etag <> NEW.etag THEN
    RAISE EXCEPTION 'MANJU_CONFIG_ACTIVE_POINTER_INVALID'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.manju_config_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'MANJU_CONFIG_AUDIT_IMMUTABLE'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER manju_config_revision_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.manju_config_revisions
  FOR EACH ROW EXECUTE FUNCTION public.manju_config_guard_revision();
CREATE TRIGGER manju_config_revision_touch_updated_at
  BEFORE UPDATE ON public.manju_config_revisions
  FOR EACH ROW EXECUTE FUNCTION public.manju_config_touch_revision_updated_at();
CREATE TRIGGER manju_config_release_guard
  BEFORE INSERT ON public.manju_config_releases
  FOR EACH ROW EXECUTE FUNCTION public.manju_config_guard_release();
CREATE TRIGGER manju_config_release_immutable
  BEFORE UPDATE OR DELETE ON public.manju_config_releases
  FOR EACH ROW EXECUTE FUNCTION public.manju_config_reject_release_mutation();
CREATE TRIGGER manju_config_active_pointer_guard
  BEFORE INSERT OR UPDATE ON public.manju_config_active
  FOR EACH ROW EXECUTE FUNCTION public.manju_config_guard_active_pointer();
CREATE TRIGGER manju_config_audit_immutable
  BEFORE UPDATE OR DELETE ON public.manju_config_audit
  FOR EACH ROW EXECUTE FUNCTION public.manju_config_reject_audit_mutation();

CREATE FUNCTION public.save_manju_config_draft(
  p_environment text,
  p_domain text,
  p_payload jsonb,
  p_payload_hash text,
  p_schema_version text DEFAULT '1.0.0',
  p_revision_id uuid DEFAULT NULL,
  p_expected_updated_at timestamptz DEFAULT NULL,
  p_actor_id uuid DEFAULT NULL
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
  p_actor_id uuid DEFAULT NULL
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
  p_actor_id uuid DEFAULT NULL
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

ALTER TABLE public.manju_config_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manju_config_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manju_config_active ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manju_config_audit ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies are created.  Combined with RLS and these
-- grants, direct client access is fail-closed; the server-side service role is
-- the only data-plane principal.
REVOKE ALL ON TABLE public.manju_config_revisions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.manju_config_releases FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.manju_config_active FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.manju_config_audit FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.manju_config_audit_id_seq FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.manju_config_revisions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.manju_config_releases TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.manju_config_active TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.manju_config_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.manju_config_audit_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.manju_config_guard_revision() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.manju_config_touch_revision_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.manju_config_guard_release() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.manju_config_reject_release_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.manju_config_guard_active_pointer() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.manju_config_reject_audit_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_manju_config_draft(
  text, text, jsonb, text, text, uuid, timestamptz, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_manju_config_revision(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rollback_manju_config_release(text, text, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_manju_config_draft(
  text, text, jsonb, text, text, uuid, timestamptz, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_manju_config_revision(uuid, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.rollback_manju_config_release(text, text, uuid, uuid, uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
