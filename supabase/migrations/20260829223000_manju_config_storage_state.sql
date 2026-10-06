BEGIN;

-- Authoritative storage selection and atomic compat/native bridge for the
-- Manju configuration control plane. This is intentionally a new forward
-- migration: previously applied migrations are immutable and must not be
-- edited to smuggle new objects into an existing environment.

-- A scope that already has native revisions but no active pointer is not an
-- empty compat scope.  Refuse to install the storage marker until an operator
-- has explicitly repaired or archived that orphaned native state.  Without
-- this preflight the seed below would silently label a draft-only native scope
-- as compat and make the existing revisions invisible to the runtime.
-- Hold both native fact tables against concurrent writes until the state table
-- and its seed are committed; otherwise a draft could be inserted between the
-- preflight and seed and recreate the exact ambiguity this migration rejects.
LOCK TABLE public.manju_config_revisions, public.manju_config_active
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  v_orphaned_scope record;
BEGIN
  SELECT revisions.environment,
         revisions.domain,
         count(*)::bigint AS revision_count
    INTO v_orphaned_scope
    FROM public.manju_config_revisions AS revisions
   WHERE NOT EXISTS (
     SELECT 1
       FROM public.manju_config_active AS active
      WHERE active.environment = revisions.environment
        AND active.domain = revisions.domain
   )
   GROUP BY revisions.environment, revisions.domain
   ORDER BY revisions.environment, revisions.domain
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'MANJU_CONFIG_STORAGE_NATIVE_SCOPE_WITHOUT_ACTIVE_REQUIRES_RECONCILIATION environment=% domain=% revisions=%',
      v_orphaned_scope.environment,
      v_orphaned_scope.domain,
      v_orphaned_scope.revision_count
      USING ERRCODE = '55000',
            HINT = 'Export and review the orphaned native revisions, then establish an explicit active pointer or remove them through an approved recovery before retrying this migration.';
  END IF;
END;
$$;

ALTER TABLE public.manju_config_audit
  DROP CONSTRAINT manju_config_audit_action_check;
ALTER TABLE public.manju_config_audit
  ADD CONSTRAINT manju_config_audit_action_check CHECK (
    action IN (
      'validate', 'create_draft', 'update_draft', 'publish', 'rollback',
      'storage_reconcile', 'cutover'
    )
  );

-- Authoritative native/compat cutover state. Merely creating or partially
-- filling the native tables must never switch a scope. The final cutover RPC
-- updates this row only after both stores and their active payload hashes have
-- been reconciled under the same advisory lock used by all config mutations.
CREATE TABLE public.manju_config_storage_state (
  environment text NOT NULL,
  domain text NOT NULL,
  state text NOT NULL DEFAULT 'compat',
  generation bigint NOT NULL DEFAULT 1,
  compat_setting_key text NOT NULL,
  compat_storage_revision timestamptz,
  compat_active_release_id uuid,
  compat_active_revision_id uuid,
  compat_payload_hash text,
  native_active_release_id uuid,
  native_active_revision_id uuid,
  native_payload_hash text,
  cutover_at timestamptz,
  cutover_by text,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, domain),
  CONSTRAINT manju_config_storage_state_environment_check CHECK (
    environment IN ('production', 'staging', 'development')
  ),
  CONSTRAINT manju_config_storage_state_domain_check CHECK (
    domain IN (
      'prompt', 'skill', 'agent', 'workflow', 'content', 'media',
      'feature_flags', 'model_policy', 'ui'
    )
  ),
  CONSTRAINT manju_config_storage_state_state_check CHECK (
    state IN ('compat', 'migrating', 'native')
  ),
  CONSTRAINT manju_config_storage_state_generation_check CHECK (generation >= 1),
  CONSTRAINT manju_config_storage_state_compat_key_check CHECK (
    compat_setting_key = 'manju.config.v1.' || environment || '.' || domain
  ),
  CONSTRAINT manju_config_storage_state_hashes_check CHECK (
    (compat_payload_hash IS NULL OR compat_payload_hash ~ '^[0-9a-f]{64}$')
    AND (native_payload_hash IS NULL OR native_payload_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT manju_config_storage_state_cutover_by_check CHECK (
    cutover_by IS NULL
    OR (char_length(cutover_by) BETWEEN 1 AND 128 AND cutover_by = btrim(cutover_by))
  ),
  CONSTRAINT manju_config_storage_state_native_evidence_check CHECK (
    state <> 'native'
    OR (
      native_active_release_id IS NOT NULL
      AND native_active_revision_id IS NOT NULL
      AND native_payload_hash IS NOT NULL
      AND cutover_at IS NOT NULL
      AND cutover_by IS NOT NULL
      AND last_verified_at IS NOT NULL
      AND (
        (
          compat_storage_revision IS NULL
          AND compat_active_release_id IS NULL
          AND compat_active_revision_id IS NULL
          AND compat_payload_hash IS NULL
        )
        OR (
          compat_storage_revision IS NOT NULL
          AND compat_active_release_id IS NOT NULL
          AND compat_active_revision_id IS NOT NULL
          AND compat_payload_hash IS NOT NULL
          AND compat_payload_hash = native_payload_hash
        )
      )
    )
  ),
  CONSTRAINT manju_config_storage_state_native_release_fk
    FOREIGN KEY (native_active_release_id, environment, domain)
    REFERENCES public.manju_config_releases(id, environment, domain)
    ON DELETE RESTRICT,
  CONSTRAINT manju_config_storage_state_native_revision_fk
    FOREIGN KEY (native_active_revision_id, environment, domain)
    REFERENCES public.manju_config_revisions(id, environment, domain)
    ON DELETE RESTRICT
);

INSERT INTO public.manju_config_storage_state (
  environment,
  domain,
  state,
  generation,
  compat_setting_key
)
SELECT environments.environment, domains.domain,
       CASE WHEN EXISTS (
         SELECT 1
           FROM public.manju_config_active AS active
          WHERE active.environment = environments.environment
            AND active.domain = domains.domain
       ) THEN 'migrating' ELSE 'compat' END,
       1,
       'manju.config.v1.' || environments.environment || '.' || domains.domain
  FROM unnest(ARRAY['production', 'staging', 'development']) AS environments(environment)
 CROSS JOIN unnest(ARRAY[
   'prompt', 'skill', 'agent', 'workflow', 'content', 'media',
   'feature_flags', 'model_policy', 'ui'
 ]) AS domains(domain);

CREATE FUNCTION public.manju_config_guard_storage_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_STATE_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.domain IS DISTINCT FROM OLD.domain
     OR NEW.compat_setting_key IS DISTINCT FROM OLD.compat_setting_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_STATE_IDENTITY_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'native' AND NEW.state <> 'native' THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_STATE_DOWNGRADE_FORBIDDEN'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.generation <> OLD.generation + 1 THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_GENERATION_INVALID'
      USING ERRCODE = '40001';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER manju_config_storage_state_guard
  BEFORE UPDATE OR DELETE ON public.manju_config_storage_state
  FOR EACH ROW EXECUTE FUNCTION public.manju_config_guard_storage_state();

-- Serialize compat-envelope mutations with native cutover.  The application
-- computes and validates the next envelope, while this function owns the
-- authoritative storage-generation check, advisory lock and row-level CAS.
CREATE FUNCTION public.commit_manju_config_compat_envelope(
  p_environment text,
  p_domain text,
  p_expected_generation bigint,
  p_expected_storage_revision timestamptz,
  p_envelope jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_environment text := lower(trim(coalesce(p_environment, '')));
  v_domain text := lower(trim(coalesce(p_domain, '')));
  v_setting_key text;
  v_state public.manju_config_storage_state%ROWTYPE;
  v_current_storage_revision timestamptz;
  v_row_exists boolean := false;
  v_now timestamptz := now();
  v_envelope jsonb;
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
  IF p_expected_generation IS NULL OR p_expected_generation < 1 THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_GENERATION_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_envelope) IS DISTINCT FROM 'object'
     OR p_envelope->>'format' IS DISTINCT FROM 'manju-platform-settings-v1'
     OR p_envelope->>'environment' IS DISTINCT FROM v_environment
     OR p_envelope->>'domain' IS DISTINCT FROM v_domain
     OR jsonb_typeof(p_envelope->'drafts') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_envelope->'history') IS DISTINCT FROM 'array'
     OR coalesce(jsonb_typeof(p_envelope->'active'), '') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'MANJU_CONFIG_COMPAT_ENVELOPE_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('manju-config:' || v_environment || ':' || v_domain, 0)
  );

  SELECT * INTO v_state
    FROM public.manju_config_storage_state
   WHERE environment = v_environment
     AND domain = v_domain
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_STATE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_state.state <> 'compat' OR v_state.generation <> p_expected_generation THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_STATE_CONFLICT expected=compat/% actual=%/%',
      p_expected_generation, v_state.state, v_state.generation
      USING ERRCODE = '40001';
  END IF;

  v_setting_key := 'manju.config.v1.' || v_environment || '.' || v_domain;
  SELECT updated_at INTO v_current_storage_revision
    FROM public.platform_settings
   WHERE setting_key = v_setting_key
   FOR UPDATE;
  v_row_exists := FOUND;

  IF v_row_exists THEN
    IF p_expected_storage_revision IS NULL
       OR v_current_storage_revision IS DISTINCT FROM p_expected_storage_revision THEN
      RAISE EXCEPTION 'MANJU_CONFIG_COMPAT_STORAGE_CONFLICT' USING ERRCODE = '40001';
    END IF;
  ELSIF p_expected_storage_revision IS NOT NULL THEN
    RAISE EXCEPTION 'MANJU_CONFIG_COMPAT_STORAGE_CONFLICT' USING ERRCODE = '40001';
  END IF;

  v_envelope := jsonb_set(p_envelope, '{updated_at}', to_jsonb(v_now), true);
  IF v_row_exists THEN
    UPDATE public.platform_settings
       SET setting_value = v_envelope::text,
           updated_at = v_now
     WHERE setting_key = v_setting_key;
  ELSE
    INSERT INTO public.platform_settings (setting_key, setting_value, updated_at)
    VALUES (v_setting_key, v_envelope::text, v_now);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'environment', v_environment,
    'domain', v_domain,
    'storage_mode', 'compat',
    'storage_generation', p_expected_generation,
    'storage_revision', v_now
  );
END;
$$;

-- Resolve an automatically quarantined `migrating` scope back to compat only
-- after an operator supplies exact evidence for both stores.  Divergent
-- payloads require a separately visible approval bit and are always audited.
CREATE FUNCTION public.reconcile_manju_config_storage_to_compat(
  p_environment text,
  p_domain text,
  p_expected_generation bigint,
  p_expected_compat_storage_revision timestamptz,
  p_expected_compat_active_release_id uuid,
  p_expected_compat_active_revision_id uuid,
  p_expected_compat_payload_hash text,
  p_expected_native_active_release_id uuid,
  p_expected_native_active_revision_id uuid,
  p_expected_native_payload_hash text,
  p_allow_payload_divergence boolean,
  p_actor_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_environment text := lower(trim(coalesce(p_environment, '')));
  v_domain text := lower(trim(coalesce(p_domain, '')));
  v_setting_key text;
  v_state public.manju_config_storage_state%ROWTYPE;
  v_compat jsonb;
  v_compat_storage_revision timestamptz;
  v_compat_release_id uuid;
  v_compat_revision_id uuid;
  v_compat_payload_hash text;
  v_native_active public.manju_config_active%ROWTYPE;
  v_native_release public.manju_config_releases%ROWTYPE;
  v_native_revision public.manju_config_revisions%ROWTYPE;
  v_payload_diverged boolean;
  v_now timestamptz := now();
BEGIN
  IF v_environment NOT IN ('production', 'staging', 'development')
     OR v_domain NOT IN (
       'prompt', 'skill', 'agent', 'workflow', 'content', 'media',
       'feature_flags', 'model_policy', 'ui'
     ) THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_RECONCILE_SCOPE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_expected_generation IS NULL
     OR p_expected_compat_storage_revision IS NULL
     OR p_expected_compat_active_release_id IS NULL
     OR p_expected_compat_active_revision_id IS NULL
     OR p_expected_compat_payload_hash IS NULL
     OR p_expected_compat_payload_hash !~ '^[0-9a-f]{64}$'
     OR p_expected_native_active_release_id IS NULL
     OR p_expected_native_active_revision_id IS NULL
     OR p_expected_native_payload_hash IS NULL
     OR p_expected_native_payload_hash !~ '^[0-9a-f]{64}$'
     OR p_allow_payload_divergence IS NULL
     OR p_actor_id IS NULL
     OR char_length(btrim(p_actor_id)) NOT BETWEEN 1 AND 128
     OR p_actor_id <> btrim(p_actor_id) THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_RECONCILE_EXPECTATIONS_REQUIRED'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('manju-config:' || v_environment || ':' || v_domain, 0)
  );

  SELECT * INTO v_state
    FROM public.manju_config_storage_state
   WHERE environment = v_environment
     AND domain = v_domain
   FOR UPDATE;
  IF NOT FOUND OR v_state.state <> 'migrating'
     OR v_state.generation <> p_expected_generation THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_RECONCILE_STATE_CONFLICT'
      USING ERRCODE = '40001';
  END IF;

  v_setting_key := 'manju.config.v1.' || v_environment || '.' || v_domain;
  SELECT setting_value::jsonb, updated_at
    INTO v_compat, v_compat_storage_revision
    FROM public.platform_settings
   WHERE setting_key = v_setting_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_RECONCILE_COMPAT_INVALID'
      USING ERRCODE = '40001';
  END IF;
  IF v_compat_storage_revision IS DISTINCT FROM p_expected_compat_storage_revision
     OR v_compat->>'format' IS DISTINCT FROM 'manju-platform-settings-v1'
     OR v_compat->>'environment' IS DISTINCT FROM v_environment
     OR v_compat->>'domain' IS DISTINCT FROM v_domain
     OR coalesce(v_compat->>'updated_at', '') = ''
     OR jsonb_typeof(v_compat->'drafts') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_compat->'history') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_compat->'active') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_RECONCILE_COMPAT_INVALID'
      USING ERRCODE = '40001';
  END IF;
  IF jsonb_array_length(v_compat->'history') < 1 THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_RECONCILE_COMPAT_INVALID'
      USING ERRCODE = '40001';
  END IF;

  BEGIN
    v_compat_release_id := (v_compat #>> '{active,release,id}')::uuid;
    v_compat_revision_id := (v_compat #>> '{active,revision,id}')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_RECONCILE_COMPAT_ID_INVALID'
      USING ERRCODE = '22023';
  END;
  v_compat_payload_hash := lower(coalesce(v_compat #>> '{active,revision,payload_hash}', ''));
  IF v_compat_release_id IS NULL
     OR v_compat_revision_id IS NULL
     OR v_compat_release_id <> p_expected_compat_active_release_id
     OR v_compat_revision_id <> p_expected_compat_active_revision_id
     OR v_compat_payload_hash <> lower(p_expected_compat_payload_hash)
     OR v_compat #>> '{active,pointer,environment}' IS DISTINCT FROM v_environment
     OR v_compat #>> '{active,pointer,domain}' IS DISTINCT FROM v_domain
     OR v_compat #>> '{active,pointer,active_release_id}' IS DISTINCT FROM v_compat_release_id::text
     OR v_compat #>> '{active,pointer,active_revision_id}' IS DISTINCT FROM v_compat_revision_id::text
     OR v_compat #>> '{active,release,environment}' IS DISTINCT FROM v_environment
     OR v_compat #>> '{active,release,domain}' IS DISTINCT FROM v_domain
     OR v_compat #>> '{active,release,revision_id}' IS DISTINCT FROM v_compat_revision_id::text
     OR coalesce(v_compat #>> '{active,release,release_kind}', '') NOT IN ('publish', 'rollback')
     OR (
       v_compat #>> '{active,release,release_kind}' = 'publish'
       AND jsonb_typeof(v_compat #> '{active,release,rollback_of_release_id}') IS DISTINCT FROM 'null'
     )
     OR (
       v_compat #>> '{active,release,release_kind}' = 'rollback'
       AND jsonb_typeof(v_compat #> '{active,release,rollback_of_release_id}') IS DISTINCT FROM 'string'
     )
     OR coalesce(v_compat #>> '{active,release,release_number}', '') !~ '^[1-9][0-9]*$'
     OR v_compat #>> '{active,release,etag}' IS DISTINCT FROM
        (v_compat_payload_hash || ':' || (v_compat #>> '{active,release,release_number}'))
     OR v_compat #>> '{active,pointer,etag}' IS DISTINCT FROM v_compat #>> '{active,release,etag}'
     OR v_compat #>> '{active,revision,environment}' IS DISTINCT FROM v_environment
     OR v_compat #>> '{active,revision,domain}' IS DISTINCT FROM v_domain
     OR v_compat #>> '{active,revision,status}' IS DISTINCT FROM 'published'
     OR coalesce(v_compat #>> '{active,revision,published_at}', '') = ''
     OR (
       v_domain IN ('prompt', 'content', 'media', 'feature_flags')
       AND v_compat #>> '{active,revision,schema_version}' IS DISTINCT FROM '1.1.0'
     )
     OR v_compat #>> '{history,0,release,id}' IS DISTINCT FROM v_compat_release_id::text
     OR v_compat #>> '{history,0,revision,id}' IS DISTINCT FROM v_compat_revision_id::text
     OR v_compat #>> '{history,0,release,etag}' IS DISTINCT FROM
        v_compat #>> '{active,release,etag}' THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_RECONCILE_COMPAT_CONFLICT'
      USING ERRCODE = '40001';
  END IF;

  -- The advisory lock is shared by every supported native mutation.  Read and
  -- lock the native pointer and its exact release/revision evidence before
  -- choosing compat, so the decision cannot race a publish or rollback.
  SELECT * INTO v_native_active
    FROM public.manju_config_active
   WHERE environment = v_environment
     AND domain = v_domain
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_NATIVE_ACTIVE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_native_release
    FROM public.manju_config_releases
   WHERE id = v_native_active.active_release_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_NATIVE_RELEASE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_native_revision
    FROM public.manju_config_revisions
   WHERE id = v_native_active.active_revision_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_NATIVE_REVISION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_native_active.active_release_id IS DISTINCT FROM p_expected_native_active_release_id
     OR v_native_active.active_revision_id IS DISTINCT FROM p_expected_native_active_revision_id
     OR v_native_release.environment IS DISTINCT FROM v_environment
     OR v_native_release.domain IS DISTINCT FROM v_domain
     OR v_native_release.revision_id IS DISTINCT FROM v_native_active.active_revision_id
     OR v_native_release.etag IS DISTINCT FROM v_native_active.etag
     OR v_native_release.etag IS DISTINCT FROM
        (v_native_revision.payload_hash || ':' || v_native_release.release_number::text)
     OR v_native_revision.environment IS DISTINCT FROM v_environment
     OR v_native_revision.domain IS DISTINCT FROM v_domain
     OR v_native_revision.status IS DISTINCT FROM 'published'
     OR v_native_revision.published_at IS NULL
     OR v_native_revision.payload_hash IS DISTINCT FROM lower(p_expected_native_payload_hash) THEN
    RAISE EXCEPTION 'MANJU_CONFIG_NATIVE_ACTIVE_CONFLICT' USING ERRCODE = '40001';
  END IF;

  v_payload_diverged := v_native_revision.payload_hash IS DISTINCT FROM v_compat_payload_hash;
  IF v_payload_diverged AND p_allow_payload_divergence IS NOT TRUE THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_RECONCILE_DIVERGENCE_REQUIRES_APPROVAL'
      USING ERRCODE = '55000',
            HINT = 'Review the exact compat and native payload hashes, then retry with p_allow_payload_divergence=true only when choosing compat is explicitly approved.';
  END IF;

  UPDATE public.manju_config_storage_state
     SET state = 'compat',
         generation = generation + 1,
         compat_storage_revision = v_compat_storage_revision,
         compat_active_release_id = v_compat_release_id,
         compat_active_revision_id = v_compat_revision_id,
         compat_payload_hash = v_compat_payload_hash,
         native_active_release_id = v_native_active.active_release_id,
         native_active_revision_id = v_native_active.active_revision_id,
         native_payload_hash = v_native_revision.payload_hash,
         last_verified_at = v_now
   WHERE environment = v_environment
     AND domain = v_domain;

  INSERT INTO public.manju_config_audit (
    action, environment, domain, revision_id, release_id, actor_id, detail
  ) VALUES (
    'storage_reconcile', v_environment, v_domain,
    v_native_active.active_revision_id, v_native_active.active_release_id, p_actor_id,
    jsonb_build_object(
      'storage', 'compat',
      'previous_storage', v_state.state,
      'previous_generation', p_expected_generation,
      'generation', p_expected_generation + 1,
      'compat_storage_revision', v_compat_storage_revision,
      'compat_active_release_id', v_compat_release_id,
      'compat_active_revision_id', v_compat_revision_id,
      'payload_hash', v_compat_payload_hash,
      'compat_payload_hash', v_compat_payload_hash,
      'native_active_release_id', v_native_active.active_release_id,
      'native_active_revision_id', v_native_active.active_revision_id,
      'native_payload_hash', v_native_revision.payload_hash,
      'payload_diverged', v_payload_diverged,
      'payload_divergence_approved', p_allow_payload_divergence,
      'payload_divergence_accepted', v_payload_diverged AND p_allow_payload_divergence
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'storage_reconcile',
    'environment', v_environment,
    'domain', v_domain,
    'storage_mode', 'compat',
    'storage_generation', p_expected_generation + 1,
    'active_release_id', v_compat_release_id,
    'active_revision_id', v_compat_revision_id,
    'payload_hash', v_compat_payload_hash,
    'native_payload_hash', v_native_revision.payload_hash,
    'payload_diverged', v_payload_diverged,
    'payload_divergence_accepted', v_payload_diverged AND p_allow_payload_divergence
  );
END;
$$;

-- Adopt an already-published native scope only when the compatibility store
-- has no active version. This closes the upgrade path for environments that
-- used the original native control plane before the storage marker existed.
CREATE FUNCTION public.reconcile_manju_config_storage_to_native(
  p_environment text,
  p_domain text,
  p_expected_generation bigint,
  p_expected_native_active_release_id uuid,
  p_expected_native_active_revision_id uuid,
  p_expected_native_payload_hash text,
  p_actor_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_environment text := lower(trim(coalesce(p_environment, '')));
  v_domain text := lower(trim(coalesce(p_domain, '')));
  v_setting_key text;
  v_state public.manju_config_storage_state%ROWTYPE;
  v_compat jsonb;
  v_has_compat boolean := false;
  v_native_active public.manju_config_active%ROWTYPE;
  v_native_release public.manju_config_releases%ROWTYPE;
  v_native_revision public.manju_config_revisions%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  IF v_environment NOT IN ('production', 'staging', 'development')
     OR v_domain NOT IN (
       'prompt', 'skill', 'agent', 'workflow', 'content', 'media',
       'feature_flags', 'model_policy', 'ui'
     ) THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_RECONCILE_SCOPE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_expected_generation IS NULL
     OR p_expected_native_active_release_id IS NULL
     OR p_expected_native_active_revision_id IS NULL
     OR p_expected_native_payload_hash IS NULL
     OR p_expected_native_payload_hash !~ '^[0-9a-f]{64}$'
     OR p_actor_id IS NULL
     OR char_length(btrim(p_actor_id)) NOT BETWEEN 1 AND 128
     OR p_actor_id <> btrim(p_actor_id) THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_RECONCILE_EXPECTATIONS_REQUIRED'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('manju-config:' || v_environment || ':' || v_domain, 0)
  );

  SELECT * INTO v_state
    FROM public.manju_config_storage_state
   WHERE environment = v_environment
     AND domain = v_domain
   FOR UPDATE;
  IF NOT FOUND OR v_state.state <> 'migrating'
     OR v_state.generation <> p_expected_generation THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_RECONCILE_STATE_CONFLICT'
      USING ERRCODE = '40001';
  END IF;

  v_setting_key := 'manju.config.v1.' || v_environment || '.' || v_domain;
  SELECT setting_value::jsonb INTO v_compat
    FROM public.platform_settings
   WHERE setting_key = v_setting_key
   FOR UPDATE;
  v_has_compat := FOUND;
  IF v_has_compat AND (
    v_compat->>'format' IS DISTINCT FROM 'manju-platform-settings-v1'
    OR v_compat->>'environment' IS DISTINCT FROM v_environment
    OR v_compat->>'domain' IS DISTINCT FROM v_domain
    OR jsonb_typeof(v_compat->'active') IS DISTINCT FROM 'null'
  ) THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_RECONCILE_COMPAT_ACTIVE_EXISTS'
      USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_native_active
    FROM public.manju_config_active
   WHERE environment = v_environment
     AND domain = v_domain
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_NATIVE_ACTIVE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_native_release
    FROM public.manju_config_releases
   WHERE id = v_native_active.active_release_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_NATIVE_RELEASE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_native_revision
    FROM public.manju_config_revisions
   WHERE id = v_native_active.active_revision_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_NATIVE_REVISION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_native_active.active_release_id IS DISTINCT FROM p_expected_native_active_release_id
     OR v_native_active.active_revision_id IS DISTINCT FROM p_expected_native_active_revision_id
     OR v_native_release.environment IS DISTINCT FROM v_environment
     OR v_native_release.domain IS DISTINCT FROM v_domain
     OR v_native_release.revision_id IS DISTINCT FROM v_native_active.active_revision_id
     OR v_native_release.etag IS DISTINCT FROM v_native_active.etag
     OR v_native_release.etag IS DISTINCT FROM
        (v_native_revision.payload_hash || ':' || v_native_release.release_number::text)
     OR v_native_revision.environment IS DISTINCT FROM v_environment
     OR v_native_revision.domain IS DISTINCT FROM v_domain
     OR v_native_revision.status IS DISTINCT FROM 'published'
     OR v_native_revision.published_at IS NULL
     OR v_native_revision.payload_hash IS DISTINCT FROM lower(p_expected_native_payload_hash) THEN
    RAISE EXCEPTION 'MANJU_CONFIG_NATIVE_ACTIVE_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF v_domain IN ('prompt', 'content', 'media', 'feature_flags')
     AND v_native_revision.schema_version IS DISTINCT FROM '1.1.0' THEN
    RAISE EXCEPTION
      'MANJU_CONFIG_ACTIVATION_SCHEMA_VERSION_UNSUPPORTED domain=% expected=1.1.0 actual=%',
      v_domain,
      coalesce(v_native_revision.schema_version, '<null>')
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.manju_config_storage_state
     SET state = 'native',
         generation = generation + 1,
         compat_storage_revision = NULL,
         compat_active_release_id = NULL,
         compat_active_revision_id = NULL,
         compat_payload_hash = NULL,
         native_active_release_id = v_native_active.active_release_id,
         native_active_revision_id = v_native_active.active_revision_id,
         native_payload_hash = v_native_revision.payload_hash,
         cutover_at = v_now,
         cutover_by = p_actor_id,
         last_verified_at = v_now
   WHERE environment = v_environment
     AND domain = v_domain;

  INSERT INTO public.manju_config_audit (
    action, environment, domain, revision_id, release_id, actor_id, detail
  ) VALUES (
    'storage_reconcile', v_environment, v_domain,
    v_native_active.active_revision_id, v_native_active.active_release_id, p_actor_id,
    jsonb_build_object(
      'storage', 'native',
      'previous_storage', 'migrating',
      'reason', 'native-active-without-compat-active',
      'previous_generation', p_expected_generation,
      'generation', p_expected_generation + 1,
      'payload_hash', v_native_revision.payload_hash
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'storage_reconcile',
    'environment', v_environment,
    'domain', v_domain,
    'storage_mode', 'native',
    'storage_generation', p_expected_generation + 1,
    'active_release_id', v_native_active.active_release_id,
    'active_revision_id', v_native_active.active_revision_id,
    'payload_hash', v_native_revision.payload_hash
  );
END;
$$;

CREATE FUNCTION public.cutover_manju_config_storage(
  p_environment text,
  p_domain text,
  p_expected_generation bigint,
  p_expected_compat_storage_revision timestamptz,
  p_expected_compat_active_release_id uuid,
  p_expected_compat_active_revision_id uuid,
  p_expected_compat_payload_hash text,
  p_expected_native_active_release_id uuid,
  p_expected_native_active_revision_id uuid,
  p_expected_native_payload_hash text,
  p_actor_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_environment text := lower(trim(coalesce(p_environment, '')));
  v_domain text := lower(trim(coalesce(p_domain, '')));
  v_setting_key text;
  v_state public.manju_config_storage_state%ROWTYPE;
  v_compat jsonb;
  v_compat_storage_revision timestamptz;
  v_compat_release_id uuid;
  v_compat_revision_id uuid;
  v_compat_payload_hash text;
  v_native_active public.manju_config_active%ROWTYPE;
  v_native_release public.manju_config_releases%ROWTYPE;
  v_native_revision public.manju_config_revisions%ROWTYPE;
  v_now timestamptz := now();
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
  IF p_expected_generation IS NULL
     OR p_expected_compat_storage_revision IS NULL
     OR p_expected_compat_active_release_id IS NULL
     OR p_expected_compat_active_revision_id IS NULL
     OR p_expected_compat_payload_hash IS NULL
     OR p_expected_compat_payload_hash !~ '^[0-9a-f]{64}$'
     OR p_expected_native_active_release_id IS NULL
     OR p_expected_native_active_revision_id IS NULL
     OR p_expected_native_payload_hash IS NULL
     OR p_expected_native_payload_hash !~ '^[0-9a-f]{64}$'
     OR p_actor_id IS NULL
     OR char_length(btrim(p_actor_id)) NOT BETWEEN 1 AND 128
     OR p_actor_id <> btrim(p_actor_id) THEN
    RAISE EXCEPTION 'MANJU_CONFIG_CUTOVER_EXPECTATIONS_REQUIRED'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('manju-config:' || v_environment || ':' || v_domain, 0)
  );

  SELECT * INTO v_state
    FROM public.manju_config_storage_state
   WHERE environment = v_environment
     AND domain = v_domain
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_STATE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_state.state NOT IN ('compat', 'migrating')
     OR v_state.generation <> p_expected_generation THEN
    RAISE EXCEPTION 'MANJU_CONFIG_STORAGE_STATE_CONFLICT expected=compat-or-migrating/% actual=%/%',
      p_expected_generation, v_state.state, v_state.generation
      USING ERRCODE = '40001';
  END IF;

  v_setting_key := 'manju.config.v1.' || v_environment || '.' || v_domain;
  SELECT setting_value::jsonb, updated_at
    INTO v_compat, v_compat_storage_revision
    FROM public.platform_settings
   WHERE setting_key = v_setting_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_COMPAT_ACTIVE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_compat_storage_revision IS DISTINCT FROM p_expected_compat_storage_revision THEN
    RAISE EXCEPTION 'MANJU_CONFIG_COMPAT_STORAGE_CONFLICT'
      USING ERRCODE = '40001';
  END IF;
  IF v_compat->>'format' IS DISTINCT FROM 'manju-platform-settings-v1'
     OR v_compat->>'environment' IS DISTINCT FROM v_environment
     OR v_compat->>'domain' IS DISTINCT FROM v_domain
     OR coalesce(v_compat->>'updated_at', '') = ''
     OR jsonb_typeof(v_compat->'drafts') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_compat->'history') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v_compat->'active') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'MANJU_CONFIG_COMPAT_ENVELOPE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(v_compat->'history') < 1 THEN
    RAISE EXCEPTION 'MANJU_CONFIG_COMPAT_ENVELOPE_INVALID' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_compat_release_id := (v_compat #>> '{active,release,id}')::uuid;
    v_compat_revision_id := (v_compat #>> '{active,revision,id}')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'MANJU_CONFIG_COMPAT_ID_INVALID' USING ERRCODE = '22023';
  END;
  v_compat_payload_hash := lower(coalesce(v_compat #>> '{active,revision,payload_hash}', ''));
  IF v_compat_release_id IS NULL
     OR v_compat_revision_id IS NULL
     OR v_compat_release_id <> p_expected_compat_active_release_id
     OR v_compat_revision_id <> p_expected_compat_active_revision_id
     OR v_compat_payload_hash <> lower(p_expected_compat_payload_hash)
     OR v_compat #>> '{active,pointer,environment}' IS DISTINCT FROM v_environment
     OR v_compat #>> '{active,pointer,domain}' IS DISTINCT FROM v_domain
     OR v_compat #>> '{active,pointer,active_release_id}' IS DISTINCT FROM v_compat_release_id::text
     OR v_compat #>> '{active,pointer,active_revision_id}' IS DISTINCT FROM v_compat_revision_id::text
     OR v_compat #>> '{active,release,environment}' IS DISTINCT FROM v_environment
     OR v_compat #>> '{active,release,domain}' IS DISTINCT FROM v_domain
     OR v_compat #>> '{active,release,revision_id}' IS DISTINCT FROM v_compat_revision_id::text
     OR coalesce(v_compat #>> '{active,release,release_kind}', '') NOT IN ('publish', 'rollback')
     OR (
       v_compat #>> '{active,release,release_kind}' = 'publish'
       AND jsonb_typeof(v_compat #> '{active,release,rollback_of_release_id}') IS DISTINCT FROM 'null'
     )
     OR (
       v_compat #>> '{active,release,release_kind}' = 'rollback'
       AND jsonb_typeof(v_compat #> '{active,release,rollback_of_release_id}') IS DISTINCT FROM 'string'
     )
     OR coalesce(v_compat #>> '{active,release,release_number}', '') !~ '^[1-9][0-9]*$'
     OR v_compat #>> '{active,release,etag}' IS DISTINCT FROM
        (v_compat_payload_hash || ':' || (v_compat #>> '{active,release,release_number}'))
     OR v_compat #>> '{active,pointer,etag}' IS DISTINCT FROM v_compat #>> '{active,release,etag}'
     OR v_compat #>> '{active,revision,environment}' IS DISTINCT FROM v_environment
     OR v_compat #>> '{active,revision,domain}' IS DISTINCT FROM v_domain
     OR v_compat #>> '{active,revision,status}' IS DISTINCT FROM 'published'
     OR coalesce(v_compat #>> '{active,revision,published_at}', '') = ''
     OR v_compat #>> '{history,0,release,id}' IS DISTINCT FROM v_compat_release_id::text
     OR v_compat #>> '{history,0,revision,id}' IS DISTINCT FROM v_compat_revision_id::text
     OR v_compat #>> '{history,0,release,etag}' IS DISTINCT FROM
        v_compat #>> '{active,release,etag}' THEN
    RAISE EXCEPTION 'MANJU_CONFIG_COMPAT_ACTIVE_CONFLICT' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_native_active
    FROM public.manju_config_active
   WHERE environment = v_environment
     AND domain = v_domain
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_NATIVE_ACTIVE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_native_release
    FROM public.manju_config_releases
   WHERE id = v_native_active.active_release_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_NATIVE_RELEASE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_native_revision
    FROM public.manju_config_revisions
   WHERE id = v_native_active.active_revision_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANJU_CONFIG_NATIVE_REVISION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_native_active.active_release_id IS DISTINCT FROM p_expected_native_active_release_id
     OR v_native_active.active_revision_id IS DISTINCT FROM p_expected_native_active_revision_id
     OR v_native_release.environment IS DISTINCT FROM v_environment
     OR v_native_release.domain IS DISTINCT FROM v_domain
     OR v_native_release.revision_id IS DISTINCT FROM v_native_active.active_revision_id
     OR v_native_release.etag IS DISTINCT FROM v_native_active.etag
     OR v_native_release.etag IS DISTINCT FROM
        (v_native_revision.payload_hash || ':' || v_native_release.release_number::text)
     OR v_native_revision.environment IS DISTINCT FROM v_environment
     OR v_native_revision.domain IS DISTINCT FROM v_domain
     OR v_native_revision.status IS DISTINCT FROM 'published'
     OR v_native_revision.published_at IS NULL
     OR v_native_revision.payload_hash IS DISTINCT FROM lower(p_expected_native_payload_hash)
     OR v_native_revision.payload_hash IS DISTINCT FROM v_compat_payload_hash THEN
    RAISE EXCEPTION 'MANJU_CONFIG_NATIVE_ACTIVE_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF v_domain IN ('prompt', 'content', 'media', 'feature_flags')
     AND v_native_revision.schema_version IS DISTINCT FROM '1.1.0' THEN
    RAISE EXCEPTION
      'MANJU_CONFIG_ACTIVATION_SCHEMA_VERSION_UNSUPPORTED domain=% expected=1.1.0 actual=%',
      v_domain,
      coalesce(v_native_revision.schema_version, '<null>')
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.manju_config_storage_state
     SET state = 'native',
         generation = generation + 1,
         compat_storage_revision = v_compat_storage_revision,
         compat_active_release_id = v_compat_release_id,
         compat_active_revision_id = v_compat_revision_id,
         compat_payload_hash = v_compat_payload_hash,
         native_active_release_id = v_native_active.active_release_id,
         native_active_revision_id = v_native_active.active_revision_id,
         native_payload_hash = v_native_revision.payload_hash,
         cutover_at = v_now,
         cutover_by = p_actor_id,
         last_verified_at = v_now,
         updated_at = v_now
   WHERE environment = v_environment
     AND domain = v_domain;

  INSERT INTO public.manju_config_audit (
    action, environment, domain, revision_id, release_id, actor_id, detail
  ) VALUES (
    'cutover', v_environment, v_domain, v_native_active.active_revision_id,
    v_native_active.active_release_id, p_actor_id,
    jsonb_build_object(
      'previous_storage', v_state.state,
      'storage', 'native',
      'previous_generation', p_expected_generation,
      'generation', p_expected_generation + 1,
      'compat_storage_revision', v_compat_storage_revision,
      'compat_active_release_id', v_compat_release_id,
      'compat_active_revision_id', v_compat_revision_id,
      'payload_hash', v_native_revision.payload_hash
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'cutover',
    'environment', v_environment,
    'domain', v_domain,
    'storage_mode', 'native',
    'storage_generation', p_expected_generation + 1,
    'active_release_id', v_native_active.active_release_id,
    'active_revision_id', v_native_active.active_revision_id,
    'payload_hash', v_native_revision.payload_hash
  );
END;
$$;

ALTER TABLE public.manju_config_storage_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.manju_config_storage_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.manju_config_storage_state TO service_role;

REVOKE ALL ON FUNCTION public.manju_config_guard_storage_state()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_manju_config_compat_envelope(
  text, text, bigint, timestamptz, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_manju_config_storage_to_compat(
  text, text, bigint, timestamptz, uuid, uuid, text, uuid, uuid, text, boolean, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_manju_config_storage_to_native(
  text, text, bigint, uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cutover_manju_config_storage(
  text, text, bigint, timestamptz, uuid, uuid, text, uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.commit_manju_config_compat_envelope(
  text, text, bigint, timestamptz, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_manju_config_storage_to_compat(
  text, text, bigint, timestamptz, uuid, uuid, text, uuid, uuid, text, boolean, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_manju_config_storage_to_native(
  text, text, bigint, uuid, uuid, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.cutover_manju_config_storage(
  text, text, bigint, timestamptz, uuid, uuid, text, uuid, uuid, text, text
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
