BEGIN;

-- Production Skill package control/data plane.
--
-- Design invariants:
--   * package versions begin as drafts and released payloads are immutable;
--   * the package row is the only mutable active-version pointer;
--   * installs are pinned to a released package version and replaced atomically;
--   * invocations are claimed exactly once per (user, idempotency key);
--   * unresolved/unknown provider outcomes remain terminal and fail closed;
--   * actors and subjects use bounded text identifiers to match main-site JWTs;
--   * secrets are references only -- inline credentials are rejected recursively;
--   * no direct anon/authenticated access is granted.

CREATE FUNCTION public.skill_runtime_actor_valid(p_actor_id text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_actor_id IS NULL
      OR (
        char_length(p_actor_id) BETWEEN 1 AND 128
        AND p_actor_id = btrim(p_actor_id)
        AND p_actor_id !~ '[[:cntrl:]]'
      );
$$;

CREATE FUNCTION public.skill_runtime_subject_valid(p_subject_id text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_subject_id IS NOT NULL
     AND char_length(p_subject_id) BETWEEN 1 AND 128
     AND p_subject_id = btrim(p_subject_id)
     AND p_subject_id !~ '[[:cntrl:]]';
$$;

CREATE FUNCTION public.skill_runtime_secret_ref_valid(p_secret_ref text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_secret_ref IS NOT NULL
     AND char_length(p_secret_ref) BETWEEN 5 AND 512
     AND p_secret_ref = btrim(p_secret_ref)
     AND p_secret_ref ~ '^(secret|vault|env|supabase-vault)://[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,500}$';
$$;

CREATE FUNCTION public.skill_runtime_asset_ids_valid(p_asset_ids text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(p_asset_ids) <= 512
     AND array_position(p_asset_ids, NULL) IS NULL
     AND cardinality(p_asset_ids) = (
       SELECT count(DISTINCT asset_id.value)
       FROM unnest(p_asset_ids) AS asset_id(value)
     )
     AND NOT EXISTS (
       SELECT 1
       FROM unnest(p_asset_ids) AS asset_id(value)
       WHERE char_length(asset_id.value) NOT BETWEEN 1 AND 512
          OR asset_id.value <> btrim(asset_id.value)
          OR asset_id.value ~ '[[:cntrl:]]'
     );
$$;

CREATE FUNCTION public.skill_runtime_json_secret_safe(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
  v_normalized_key text;
  v_compact_key text;
  v_child jsonb;
  v_ref text;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      FOR v_key, v_child IN SELECT key, value FROM jsonb_each(p_value)
      LOOP
        v_normalized_key := lower(replace(v_key, '-', '_'));
        v_compact_key := regexp_replace(lower(v_key), '[^a-z0-9]+', '', 'g');
        IF v_normalized_key IN (
             'secret', 'secret_value', 'token', 'access_token', 'refresh_token',
             'password', 'passphrase', 'api_key', 'private_key', 'client_secret',
             'credential', 'credentials', 'authorization'
           )
           OR v_compact_key IN (
             'secret', 'secretvalue', 'secretref', 'token', 'accesstoken',
             'refreshtoken', 'password', 'passphrase', 'apikey', 'privatekey',
             'clientsecret', 'credential', 'credentials', 'authorization'
           )
           OR v_compact_key ~ '(token|password|passphrase|apikey|privatekey|clientsecret|credential|credentials|authorization)$' THEN
          IF jsonb_typeof(v_child) = 'string' THEN
            v_ref := v_child #>> '{}';
          ELSIF jsonb_typeof(v_child) = 'object'
                AND (SELECT count(*) FROM jsonb_object_keys(v_child)) = 1
                AND v_child ? '$secret_ref'
                AND jsonb_typeof(v_child -> '$secret_ref') = 'string' THEN
            v_ref := v_child ->> '$secret_ref';
          ELSE
            RETURN false;
          END IF;

          IF NOT public.skill_runtime_secret_ref_valid(v_ref) THEN
            RETURN false;
          END IF;
        ELSIF NOT public.skill_runtime_json_secret_safe(v_child) THEN
          RETURN false;
        END IF;
      END LOOP;
      RETURN true;
    WHEN 'array' THEN
      FOR v_child IN SELECT value FROM jsonb_array_elements(p_value)
      LOOP
        IF NOT public.skill_runtime_json_secret_safe(v_child) THEN
          RETURN false;
        END IF;
      END LOOP;
      RETURN true;
    ELSE
      RETURN true;
  END CASE;
END;
$$;

CREATE FUNCTION public.skill_runtime_package_payload_valid(p_payload jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT jsonb_typeof(p_payload) = 'object'
     AND jsonb_typeof(p_payload -> 'routing') = 'object'
     AND jsonb_typeof(p_payload -> 'orchestration') = 'object'
     AND jsonb_typeof(p_payload -> 'instructions') = 'string'
     AND char_length(p_payload ->> 'instructions') BETWEEN 1 AND 200000
     AND jsonb_typeof(p_payload -> 'input_schema') = 'object'
     AND jsonb_typeof(p_payload -> 'output_schema') = 'object'
     AND jsonb_typeof(p_payload -> 'tools') = 'array'
     AND jsonb_array_length(p_payload -> 'tools') <= 128
     AND jsonb_typeof(p_payload -> 'resources') = 'array'
     AND jsonb_array_length(p_payload -> 'resources') <= 256
     AND public.skill_runtime_json_secret_safe(p_payload);
$$;

CREATE TABLE public.skill_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  display_name text NOT NULL,
  summary text NOT NULL DEFAULT '',
  origin text NOT NULL DEFAULT 'custom',
  visibility text NOT NULL DEFAULT 'private',
  runtime_kind text NOT NULL DEFAULT 'prompt',
  lifecycle text NOT NULL DEFAULT 'draft',
  active_version_id uuid,
  latest_version_number bigint NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_packages_slug_unique UNIQUE (slug),
  CONSTRAINT skill_packages_slug_check CHECK (
    char_length(slug) BETWEEN 1 AND 80
    AND slug = lower(slug)
    AND slug ~ '^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$'
  ),
  CONSTRAINT skill_packages_display_name_check CHECK (
    char_length(display_name) BETWEEN 1 AND 160
    AND display_name = btrim(display_name)
    AND display_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT skill_packages_summary_check CHECK (char_length(summary) <= 2000),
  CONSTRAINT skill_packages_origin_check CHECK (
    origin IN ('builtin', 'open_source', 'community', 'custom')
  ),
  CONSTRAINT skill_packages_visibility_check CHECK (
    visibility IN ('private', 'tenant', 'public')
  ),
  CONSTRAINT skill_packages_runtime_kind_check CHECK (
    runtime_kind IN ('prompt', 'tool', 'workflow', 'hybrid')
  ),
  CONSTRAINT skill_packages_lifecycle_check CHECK (
    lifecycle IN ('draft', 'published', 'archived')
  ),
  CONSTRAINT skill_packages_pointer_state_check CHECK (
    (lifecycle = 'published' AND active_version_id IS NOT NULL)
    OR (lifecycle IN ('draft', 'archived') AND active_version_id IS NULL)
  ),
  CONSTRAINT skill_packages_latest_version_check CHECK (latest_version_number >= 0),
  CONSTRAINT skill_packages_metadata_check CHECK (
    jsonb_typeof(metadata) = 'object'
    AND public.skill_runtime_json_secret_safe(metadata)
  ),
  CONSTRAINT skill_packages_created_by_check CHECK (public.skill_runtime_actor_valid(created_by)),
  CONSTRAINT skill_packages_updated_by_check CHECK (public.skill_runtime_actor_valid(updated_by)),
  CONSTRAINT skill_packages_composite_identity_unique UNIQUE (id, slug)
);

CREATE TABLE public.skill_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES public.skill_packages(id) ON DELETE RESTRICT,
  version_number bigint NOT NULL,
  semver text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  schema_version text NOT NULL DEFAULT '1.0.0',
  parent_version_id uuid,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT skill_versions_number_check CHECK (version_number >= 1),
  CONSTRAINT skill_versions_semver_check CHECK (
    char_length(semver) BETWEEN 1 AND 80
    AND semver ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]{0,63})?(\+[A-Za-z0-9][A-Za-z0-9.-]{0,63})?$'
  ),
  CONSTRAINT skill_versions_status_check CHECK (status IN ('draft', 'released')),
  CONSTRAINT skill_versions_payload_check CHECK (
    public.skill_runtime_package_payload_valid(payload)
  ),
  CONSTRAINT skill_versions_payload_hash_check CHECK (
    payload_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT skill_versions_schema_version_check CHECK (
    schema_version ~ '^[A-Za-z0-9][A-Za-z0-9._+\-]{0,79}$'
  ),
  CONSTRAINT skill_versions_publish_time_check CHECK (
    (status = 'draft' AND published_at IS NULL)
    OR (status = 'released' AND published_at IS NOT NULL)
  ),
  CONSTRAINT skill_versions_created_by_check CHECK (public.skill_runtime_actor_valid(created_by)),
  CONSTRAINT skill_versions_updated_by_check CHECK (public.skill_runtime_actor_valid(updated_by)),
  CONSTRAINT skill_versions_package_number_unique UNIQUE (package_id, version_number),
  CONSTRAINT skill_versions_package_semver_unique UNIQUE (package_id, semver),
  CONSTRAINT skill_versions_composite_identity_unique UNIQUE (id, package_id),
  CONSTRAINT skill_versions_parent_fk
    FOREIGN KEY (parent_version_id, package_id)
    REFERENCES public.skill_versions(id, package_id)
    ON DELETE RESTRICT
);

ALTER TABLE public.skill_packages
  ADD CONSTRAINT skill_packages_active_version_fk
  FOREIGN KEY (active_version_id, id)
  REFERENCES public.skill_versions(id, package_id)
  ON DELETE RESTRICT;

CREATE TABLE public.skill_secret_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES public.skill_packages(id) ON DELETE RESTRICT,
  environment text NOT NULL,
  secret_name text NOT NULL,
  secret_ref text NOT NULL,
  binding_status text NOT NULL DEFAULT 'active',
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_secret_bindings_environment_check CHECK (
    environment IN ('production', 'staging', 'development')
  ),
  CONSTRAINT skill_secret_bindings_name_check CHECK (
    char_length(secret_name) BETWEEN 1 AND 120
    AND secret_name ~ '^[A-Za-z][A-Za-z0-9._-]{0,119}$'
  ),
  CONSTRAINT skill_secret_bindings_ref_check CHECK (
    public.skill_runtime_secret_ref_valid(secret_ref)
  ),
  CONSTRAINT skill_secret_bindings_status_check CHECK (
    binding_status IN ('active', 'disabled')
  ),
  CONSTRAINT skill_secret_bindings_created_by_check CHECK (
    public.skill_runtime_actor_valid(created_by)
  ),
  CONSTRAINT skill_secret_bindings_updated_by_check CHECK (
    public.skill_runtime_actor_valid(updated_by)
  ),
  CONSTRAINT skill_secret_bindings_scope_unique
    UNIQUE (package_id, environment, secret_name)
);

CREATE TABLE public.agent_skill_installations (
  agent_id text NOT NULL,
  package_id uuid NOT NULL REFERENCES public.skill_packages(id) ON DELETE RESTRICT,
  version_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  priority smallint NOT NULL DEFAULT 0,
  install_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  installed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, package_id),
  CONSTRAINT agent_skill_installations_agent_check CHECK (
    public.skill_runtime_subject_valid(agent_id)
  ),
  CONSTRAINT agent_skill_installations_priority_check CHECK (priority BETWEEN -1000 AND 1000),
  CONSTRAINT agent_skill_installations_config_check CHECK (
    jsonb_typeof(install_config) = 'object'
    AND public.skill_runtime_json_secret_safe(install_config)
  ),
  CONSTRAINT agent_skill_installations_actor_check CHECK (
    public.skill_runtime_actor_valid(installed_by)
  ),
  CONSTRAINT agent_skill_installations_version_fk
    FOREIGN KEY (version_id, package_id)
    REFERENCES public.skill_versions(id, package_id)
    ON DELETE RESTRICT
);

CREATE TABLE public.user_skill_installations (
  user_id text NOT NULL,
  package_id uuid NOT NULL REFERENCES public.skill_packages(id) ON DELETE RESTRICT,
  version_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  priority smallint NOT NULL DEFAULT 0,
  install_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  installed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, package_id),
  CONSTRAINT user_skill_installations_user_check CHECK (
    public.skill_runtime_subject_valid(user_id)
  ),
  CONSTRAINT user_skill_installations_priority_check CHECK (priority BETWEEN -1000 AND 1000),
  CONSTRAINT user_skill_installations_config_check CHECK (
    jsonb_typeof(install_config) = 'object'
    AND public.skill_runtime_json_secret_safe(install_config)
  ),
  CONSTRAINT user_skill_installations_actor_check CHECK (
    public.skill_runtime_actor_valid(installed_by)
  ),
  CONSTRAINT user_skill_installations_version_fk
    FOREIGN KEY (version_id, package_id)
    REFERENCES public.skill_versions(id, package_id)
    ON DELETE RESTRICT
);

CREATE TABLE public.skill_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  agent_id text,
  package_id uuid NOT NULL REFERENCES public.skill_packages(id) ON DELETE RESTRICT,
  version_id uuid NOT NULL,
  client_idempotency_key text NOT NULL,
  payload_fingerprint text NOT NULL,
  input jsonb NOT NULL,
  state text NOT NULL DEFAULT 'claimed',
  output jsonb,
  error_code text,
  error_detail jsonb,
  model_id text,
  billing_operation_id text,
  task_id text,
  provider_task_id text,
  asset_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  charged_credits numeric(20,6) NOT NULL DEFAULT 0,
  charged_cash numeric(20,6) NOT NULL DEFAULT 0,
  cost_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT skill_invocations_user_check CHECK (public.skill_runtime_subject_valid(user_id)),
  CONSTRAINT skill_invocations_agent_check CHECK (
    agent_id IS NULL OR public.skill_runtime_subject_valid(agent_id)
  ),
  CONSTRAINT skill_invocations_client_key_check CHECK (
    char_length(client_idempotency_key) BETWEEN 1 AND 200
    AND client_idempotency_key = btrim(client_idempotency_key)
    AND client_idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT skill_invocations_fingerprint_check CHECK (
    payload_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT skill_invocations_input_check CHECK (jsonb_typeof(input) = 'object'),
  CONSTRAINT skill_invocations_model_id_check CHECK (
    model_id IS NULL OR (
      char_length(model_id) BETWEEN 1 AND 200
      AND model_id = btrim(model_id)
      AND model_id !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT skill_invocations_billing_operation_check CHECK (
    billing_operation_id IS NULL OR (
      char_length(billing_operation_id) BETWEEN 1 AND 200
      AND billing_operation_id = btrim(billing_operation_id)
      AND billing_operation_id !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT skill_invocations_task_id_check CHECK (
    task_id IS NULL OR (
      char_length(task_id) BETWEEN 1 AND 200
      AND task_id = btrim(task_id)
      AND task_id !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT skill_invocations_provider_task_id_check CHECK (
    provider_task_id IS NULL OR (
      char_length(provider_task_id) BETWEEN 1 AND 200
      AND provider_task_id = btrim(provider_task_id)
      AND provider_task_id !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT skill_invocations_state_check CHECK (
    state IN ('claimed', 'completed', 'failed', 'failed_unknown')
  ),
  CONSTRAINT skill_invocations_terminal_shape_check CHECK (
    (
      state = 'claimed'
      AND output IS NULL
      AND error_code IS NULL
      AND error_detail IS NULL
      AND completed_at IS NULL
    )
    OR (
      state = 'completed'
      AND output IS NOT NULL
      AND jsonb_typeof(output) = 'object'
      AND error_code IS NULL
      AND error_detail IS NULL
      AND completed_at IS NOT NULL
    )
    OR (
      state IN ('failed', 'failed_unknown')
      AND output IS NULL
      AND error_code IS NOT NULL
      AND char_length(error_code) BETWEEN 1 AND 120
      AND error_detail IS NOT NULL
      AND jsonb_typeof(error_detail) = 'object'
      AND completed_at IS NOT NULL
    )
  ),
  CONSTRAINT skill_invocations_asset_ids_check CHECK (
    public.skill_runtime_asset_ids_valid(asset_ids)
  ),
  CONSTRAINT skill_invocations_charge_check CHECK (
    charged_credits >= 0
    AND charged_cash >= 0
    AND charged_credits::text NOT IN ('NaN', 'Infinity', '-Infinity')
    AND charged_cash::text NOT IN ('NaN', 'Infinity', '-Infinity')
  ),
  CONSTRAINT skill_invocations_cost_snapshot_check CHECK (
    jsonb_typeof(cost_snapshot) = 'object'
    AND public.skill_runtime_json_secret_safe(cost_snapshot)
  ),
  CONSTRAINT skill_invocations_user_idempotency_unique
    UNIQUE (user_id, client_idempotency_key),
  CONSTRAINT skill_invocations_version_fk
    FOREIGN KEY (version_id, package_id)
    REFERENCES public.skill_versions(id, package_id)
    ON DELETE RESTRICT
);

CREATE TABLE public.skill_release_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES public.skill_packages(id) ON DELETE RESTRICT,
  version_id uuid NOT NULL,
  previous_version_id uuid,
  sequence bigint NOT NULL,
  action text NOT NULL,
  actor_id text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_release_audit_sequence_check CHECK (sequence >= 1),
  CONSTRAINT skill_release_audit_action_check CHECK (
    action IN ('create_draft', 'update_draft', 'publish', 'rollback')
  ),
  CONSTRAINT skill_release_audit_actor_check CHECK (
    public.skill_runtime_actor_valid(actor_id)
  ),
  CONSTRAINT skill_release_audit_detail_check CHECK (
    jsonb_typeof(detail) = 'object'
    AND public.skill_runtime_json_secret_safe(detail)
  ),
  CONSTRAINT skill_release_audit_package_sequence_unique UNIQUE (package_id, sequence),
  CONSTRAINT skill_release_audit_version_fk
    FOREIGN KEY (version_id, package_id)
    REFERENCES public.skill_versions(id, package_id)
    ON DELETE RESTRICT,
  CONSTRAINT skill_release_audit_previous_version_fk
    FOREIGN KEY (previous_version_id, package_id)
    REFERENCES public.skill_versions(id, package_id)
    ON DELETE RESTRICT
);

CREATE INDEX skill_packages_public_catalog_idx
  ON public.skill_packages (visibility, lifecycle, updated_at DESC);
CREATE INDEX skill_versions_package_status_idx
  ON public.skill_versions (package_id, status, version_number DESC);
CREATE INDEX skill_versions_hash_idx
  ON public.skill_versions (package_id, payload_hash);
CREATE INDEX skill_secret_bindings_lookup_idx
  ON public.skill_secret_bindings (package_id, environment, binding_status);
CREATE INDEX agent_skill_installations_runtime_idx
  ON public.agent_skill_installations (agent_id, enabled, priority DESC, updated_at DESC);
CREATE INDEX agent_skill_installations_version_idx
  ON public.agent_skill_installations (version_id);
CREATE INDEX user_skill_installations_runtime_idx
  ON public.user_skill_installations (user_id, enabled, priority DESC, updated_at DESC);
CREATE INDEX user_skill_installations_version_idx
  ON public.user_skill_installations (version_id);
CREATE INDEX skill_invocations_user_history_idx
  ON public.skill_invocations (user_id, created_at DESC);
CREATE INDEX skill_invocations_agent_history_idx
  ON public.skill_invocations (agent_id, created_at DESC)
  WHERE agent_id IS NOT NULL;
CREATE INDEX skill_invocations_package_state_idx
  ON public.skill_invocations (package_id, version_id, state, updated_at DESC);
CREATE INDEX skill_invocations_task_idx
  ON public.skill_invocations (task_id)
  WHERE task_id IS NOT NULL;
CREATE INDEX skill_release_audit_history_idx
  ON public.skill_release_audit (package_id, sequence DESC);

CREATE FUNCTION public.skill_runtime_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.skill_runtime_guard_package()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle <> 'draft'
       OR NEW.active_version_id IS NOT NULL
       OR NEW.latest_version_number <> 0 THEN
      RAISE EXCEPTION 'SKILL_PACKAGE_MUST_START_AS_DRAFT' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.slug <> OLD.slug OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'SKILL_PACKAGE_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF NEW.latest_version_number < OLD.latest_version_number THEN
      RAISE EXCEPTION 'SKILL_PACKAGE_VERSION_COUNTER_DECREASE' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF NEW.active_version_id IS NOT NULL THEN
    SELECT status INTO v_status
      FROM public.skill_versions
     WHERE id = NEW.active_version_id
       AND package_id = NEW.id;
    IF NOT FOUND OR v_status <> 'released' THEN
      RAISE EXCEPTION 'SKILL_PACKAGE_ACTIVE_VERSION_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.skill_runtime_guard_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'SKILL_VERSION_MUST_START_AS_DRAFT' USING ERRCODE = '22023';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SKILL_VERSION_DELETE_FORBIDDEN' USING ERRCODE = '55000';
  ELSE
    IF OLD.status = 'released' THEN
      RAISE EXCEPTION 'SKILL_RELEASED_VERSION_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF NEW.id <> OLD.id
       OR NEW.package_id <> OLD.package_id
       OR NEW.version_number <> OLD.version_number
       OR NEW.created_at <> OLD.created_at
       OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'SKILL_VERSION_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF NEW.status = 'draft' AND NEW.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'SKILL_DRAFT_PUBLISH_TIME_FORBIDDEN' USING ERRCODE = '22023';
    END IF;
    IF NEW.status = 'released' AND NEW.published_at IS NULL THEN
      RAISE EXCEPTION 'SKILL_RELEASE_TIME_REQUIRED' USING ERRCODE = '22023';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.skill_runtime_guard_installation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_lifecycle text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.package_id <> OLD.package_id
       OR NEW.created_at <> OLD.created_at
       OR (to_jsonb(NEW) ->> 'agent_id') IS DISTINCT FROM (to_jsonb(OLD) ->> 'agent_id')
       OR (to_jsonb(NEW) ->> 'user_id') IS DISTINCT FROM (to_jsonb(OLD) ->> 'user_id')
     ) THEN
    RAISE EXCEPTION 'SKILL_INSTALLATION_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  SELECT version.status, package.lifecycle
    INTO v_status, v_lifecycle
    FROM public.skill_versions version
    JOIN public.skill_packages package ON package.id = version.package_id
   WHERE version.id = NEW.version_id
     AND version.package_id = NEW.package_id;
  IF NOT FOUND OR v_status <> 'released' OR v_lifecycle <> 'published' THEN
    RAISE EXCEPTION 'SKILL_INSTALLATION_VERSION_NOT_RELEASED' USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.skill_runtime_guard_invocation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'claimed' THEN
      RAISE EXCEPTION 'SKILL_INVOCATION_MUST_START_CLAIMED' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF OLD.state <> 'claimed' THEN
      RAISE EXCEPTION 'SKILL_INVOCATION_TERMINAL_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF NEW.id <> OLD.id
       OR NEW.user_id <> OLD.user_id
       OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
       OR NEW.package_id <> OLD.package_id
       OR NEW.version_id <> OLD.version_id
       OR NEW.client_idempotency_key <> OLD.client_idempotency_key
       OR NEW.payload_fingerprint <> OLD.payload_fingerprint
       OR NEW.input <> OLD.input
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'SKILL_INVOCATION_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF NEW.state NOT IN ('completed', 'failed', 'failed_unknown') THEN
      RAISE EXCEPTION 'SKILL_INVOCATION_TRANSITION_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.skill_runtime_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'SKILL_RELEASE_AUDIT_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER skill_packages_guard
  BEFORE INSERT OR UPDATE ON public.skill_packages
  FOR EACH ROW EXECUTE FUNCTION public.skill_runtime_guard_package();
CREATE TRIGGER skill_versions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.skill_versions
  FOR EACH ROW EXECUTE FUNCTION public.skill_runtime_guard_version();
CREATE TRIGGER skill_secret_bindings_touch
  BEFORE UPDATE ON public.skill_secret_bindings
  FOR EACH ROW EXECUTE FUNCTION public.skill_runtime_touch_updated_at();
CREATE TRIGGER agent_skill_installations_guard
  BEFORE INSERT OR UPDATE ON public.agent_skill_installations
  FOR EACH ROW EXECUTE FUNCTION public.skill_runtime_guard_installation();
CREATE TRIGGER user_skill_installations_guard
  BEFORE INSERT OR UPDATE ON public.user_skill_installations
  FOR EACH ROW EXECUTE FUNCTION public.skill_runtime_guard_installation();
CREATE TRIGGER skill_invocations_guard
  BEFORE INSERT OR UPDATE ON public.skill_invocations
  FOR EACH ROW EXECUTE FUNCTION public.skill_runtime_guard_invocation();
CREATE TRIGGER skill_release_audit_immutable
  BEFORE UPDATE OR DELETE ON public.skill_release_audit
  FOR EACH ROW EXECUTE FUNCTION public.skill_runtime_reject_audit_mutation();

CREATE FUNCTION public.save_skill_package_draft(
  p_slug text,
  p_display_name text,
  p_summary text,
  p_origin text,
  p_visibility text,
  p_runtime_kind text,
  p_payload jsonb,
  p_payload_hash text,
  p_semver text,
  p_schema_version text,
  p_metadata jsonb,
  p_package_id uuid,
  p_version_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_display_name text := btrim(coalesce(p_display_name, ''));
  v_summary text := coalesce(p_summary, '');
  v_origin text := lower(btrim(coalesce(p_origin, '')));
  v_visibility text := lower(btrim(coalesce(p_visibility, '')));
  v_runtime_kind text := lower(btrim(coalesce(p_runtime_kind, '')));
  v_payload_hash text := lower(btrim(coalesce(p_payload_hash, '')));
  v_semver text := btrim(coalesce(p_semver, ''));
  v_schema_version text := btrim(coalesce(p_schema_version, ''));
  v_package public.skill_packages%ROWTYPE;
  v_version public.skill_versions%ROWTYPE;
  v_previous_updated_at timestamptz;
  v_next_version bigint;
  v_audit_sequence bigint;
  v_action text;
BEGIN
  IF v_slug = '' OR v_display_name = '' THEN
    RAISE EXCEPTION 'SKILL_PACKAGE_IDENTITY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF v_origin NOT IN ('builtin', 'open_source', 'community', 'custom')
     OR v_visibility NOT IN ('private', 'tenant', 'public')
     OR v_runtime_kind NOT IN ('prompt', 'tool', 'workflow', 'hybrid') THEN
    RAISE EXCEPTION 'SKILL_PACKAGE_CLASSIFICATION_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_payload IS NULL OR NOT public.skill_runtime_package_payload_valid(p_payload) THEN
    RAISE EXCEPTION 'SKILL_PACKAGE_PAYLOAD_INVALID_OR_UNSAFE' USING ERRCODE = '22023';
  END IF;
  IF v_payload_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SKILL_PACKAGE_PAYLOAD_HASH_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_semver !~ '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]{0,63})?(\+[A-Za-z0-9][A-Za-z0-9.-]{0,63})?$'
     OR v_schema_version !~ '^[A-Za-z0-9][A-Za-z0-9._+\-]{0,79}$' THEN
    RAISE EXCEPTION 'SKILL_PACKAGE_VERSION_LABEL_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_metadata IS NULL
     OR jsonb_typeof(p_metadata) <> 'object'
     OR NOT public.skill_runtime_json_secret_safe(p_metadata) THEN
    RAISE EXCEPTION 'SKILL_PACKAGE_METADATA_INVALID_OR_UNSAFE' USING ERRCODE = '22023';
  END IF;
  IF p_actor_id IS NULL OR NOT public.skill_runtime_actor_valid(p_actor_id) THEN
    RAISE EXCEPTION 'SKILL_PACKAGE_ACTOR_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('skill-package:' || v_slug, 0));

  IF p_package_id IS NULL THEN
    IF p_version_id IS NOT NULL OR p_expected_updated_at IS NOT NULL THEN
      RAISE EXCEPTION 'SKILL_PACKAGE_NEW_DRAFT_POINTER_FORBIDDEN' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.skill_packages (
      slug, display_name, summary, origin, visibility, runtime_kind,
      lifecycle, latest_version_number, metadata, created_by, updated_by
    ) VALUES (
      v_slug, v_display_name, v_summary, v_origin, v_visibility, v_runtime_kind,
      'draft', 0, p_metadata, p_actor_id, p_actor_id
    ) RETURNING * INTO v_package;
  ELSE
    SELECT * INTO v_package
      FROM public.skill_packages
     WHERE id = p_package_id
       AND slug = v_slug
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SKILL_PACKAGE_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF v_package.lifecycle = 'archived' THEN
      RAISE EXCEPTION 'SKILL_PACKAGE_ARCHIVED' USING ERRCODE = '55000';
    END IF;
    UPDATE public.skill_packages
       SET display_name = v_display_name,
           summary = v_summary,
           origin = v_origin,
           visibility = v_visibility,
           runtime_kind = v_runtime_kind,
           metadata = p_metadata,
           updated_by = p_actor_id
     WHERE id = v_package.id
     RETURNING * INTO v_package;
  END IF;

  IF p_version_id IS NULL THEN
    IF p_expected_updated_at IS NOT NULL THEN
      RAISE EXCEPTION 'SKILL_VERSION_NEW_DRAFT_EXPECTATION_FORBIDDEN' USING ERRCODE = '22023';
    END IF;
    v_next_version := v_package.latest_version_number + 1;
    INSERT INTO public.skill_versions (
      package_id, version_number, semver, status, payload, payload_hash,
      schema_version, parent_version_id, created_by, updated_by
    ) VALUES (
      v_package.id, v_next_version, v_semver, 'draft', p_payload, v_payload_hash,
      v_schema_version, v_package.active_version_id, p_actor_id, p_actor_id
    ) RETURNING * INTO v_version;

    UPDATE public.skill_packages
       SET latest_version_number = v_next_version,
           updated_by = p_actor_id
     WHERE id = v_package.id
     RETURNING * INTO v_package;
    v_action := 'create_draft';
  ELSE
    IF p_expected_updated_at IS NULL THEN
      RAISE EXCEPTION 'SKILL_VERSION_EXPECTED_UPDATED_AT_REQUIRED' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_version
      FROM public.skill_versions
     WHERE id = p_version_id
       AND package_id = v_package.id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SKILL_VERSION_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF v_version.status <> 'draft' THEN
      RAISE EXCEPTION 'SKILL_VERSION_NOT_DRAFT' USING ERRCODE = '55000';
    END IF;
    IF v_version.updated_at <> p_expected_updated_at THEN
      RAISE EXCEPTION 'SKILL_VERSION_DRAFT_CONFLICT expected=% actual=%',
        p_expected_updated_at, v_version.updated_at USING ERRCODE = '40001';
    END IF;
    v_previous_updated_at := v_version.updated_at;
    UPDATE public.skill_versions
       SET semver = v_semver,
           payload = p_payload,
           payload_hash = v_payload_hash,
           schema_version = v_schema_version,
           updated_by = p_actor_id
     WHERE id = v_version.id
     RETURNING * INTO v_version;
    v_action := 'update_draft';
  END IF;

  SELECT coalesce(max(sequence), 0) + 1 INTO v_audit_sequence
    FROM public.skill_release_audit
   WHERE package_id = v_package.id;
  INSERT INTO public.skill_release_audit (
    package_id, version_id, previous_version_id, sequence, action, actor_id, detail
  ) VALUES (
    v_package.id,
    v_version.id,
    v_version.parent_version_id,
    v_audit_sequence,
    v_action,
    p_actor_id,
    jsonb_build_object(
      'slug', v_package.slug,
      'version_number', v_version.version_number,
      'semver', v_version.semver,
      'payload_hash', v_version.payload_hash,
      'schema_version', v_version.schema_version,
      'previous_updated_at', v_previous_updated_at,
      'updated_at', v_version.updated_at
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', v_action,
    'package_id', v_package.id,
    'slug', v_package.slug,
    'lifecycle', v_package.lifecycle,
    'active_version_id', v_package.active_version_id,
    'version_id', v_version.id,
    'version_number', v_version.version_number,
    'semver', v_version.semver,
    'status', v_version.status,
    'payload_hash', v_version.payload_hash,
    'updated_at', v_version.updated_at
  );
END;
$$;

CREATE FUNCTION public.publish_skill_version(
  p_version_id uuid,
  p_expected_active_version_id uuid,
  p_actor_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_slug text;
  v_version public.skill_versions%ROWTYPE;
  v_package public.skill_packages%ROWTYPE;
  v_audit_sequence bigint;
BEGIN
  IF p_version_id IS NULL
     OR p_actor_id IS NULL
     OR NOT public.skill_runtime_actor_valid(p_actor_id) THEN
    RAISE EXCEPTION 'SKILL_PUBLISH_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT package.slug INTO v_slug
    FROM public.skill_versions version
    JOIN public.skill_packages package ON package.id = version.package_id
   WHERE version.id = p_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKILL_VERSION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-package:' || v_slug, 0));

  SELECT * INTO v_version
    FROM public.skill_versions
   WHERE id = p_version_id
   FOR UPDATE;
  SELECT * INTO v_package
    FROM public.skill_packages
   WHERE id = v_version.package_id
   FOR UPDATE;
  IF v_package.lifecycle = 'archived' OR v_version.status <> 'draft' THEN
    RAISE EXCEPTION 'SKILL_VERSION_NOT_PUBLISHABLE' USING ERRCODE = '55000';
  END IF;
  IF (v_package.active_version_id IS NULL AND p_expected_active_version_id IS NOT NULL)
     OR (v_package.active_version_id IS NOT NULL AND p_expected_active_version_id IS NULL)
     OR (v_package.active_version_id IS NOT NULL AND v_package.active_version_id <> p_expected_active_version_id) THEN
    RAISE EXCEPTION 'SKILL_ACTIVE_VERSION_CONFLICT expected=% actual=%',
      coalesce(p_expected_active_version_id::text, '<none>'),
      coalesce(v_package.active_version_id::text, '<none>') USING ERRCODE = '40001';
  END IF;

  UPDATE public.skill_versions
     SET status = 'released',
         published_at = now(),
         updated_by = p_actor_id
   WHERE id = v_version.id
   RETURNING * INTO v_version;
  UPDATE public.skill_packages
     SET lifecycle = 'published',
         active_version_id = v_version.id,
         updated_by = p_actor_id
   WHERE id = v_package.id
   RETURNING * INTO v_package;

  SELECT coalesce(max(sequence), 0) + 1 INTO v_audit_sequence
    FROM public.skill_release_audit
   WHERE package_id = v_package.id;
  INSERT INTO public.skill_release_audit (
    package_id, version_id, previous_version_id, sequence, action, actor_id, detail
  ) VALUES (
    v_package.id, v_version.id, p_expected_active_version_id, v_audit_sequence,
    'publish', p_actor_id,
    jsonb_build_object(
      'slug', v_package.slug,
      'version_number', v_version.version_number,
      'semver', v_version.semver,
      'payload_hash', v_version.payload_hash,
      'expected_active_version_id', p_expected_active_version_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'publish',
    'package_id', v_package.id,
    'version_id', v_version.id,
    'version_number', v_version.version_number,
    'semver', v_version.semver,
    'active_version_id', v_package.active_version_id,
    'published_at', v_version.published_at
  );
END;
$$;

CREATE FUNCTION public.rollback_skill_package_version(
  p_package_id uuid,
  p_target_version_id uuid,
  p_expected_active_version_id uuid,
  p_actor_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_slug text;
  v_package public.skill_packages%ROWTYPE;
  v_target public.skill_versions%ROWTYPE;
  v_audit_sequence bigint;
BEGIN
  IF p_package_id IS NULL
     OR p_target_version_id IS NULL
     OR p_expected_active_version_id IS NULL
     OR p_actor_id IS NULL
     OR NOT public.skill_runtime_actor_valid(p_actor_id) THEN
    RAISE EXCEPTION 'SKILL_ROLLBACK_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT slug INTO v_slug FROM public.skill_packages WHERE id = p_package_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKILL_PACKAGE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-package:' || v_slug, 0));

  SELECT * INTO v_package
    FROM public.skill_packages
   WHERE id = p_package_id
   FOR UPDATE;
  IF v_package.lifecycle <> 'published'
     OR v_package.active_version_id <> p_expected_active_version_id THEN
    RAISE EXCEPTION 'SKILL_ACTIVE_VERSION_CONFLICT expected=% actual=%',
      p_expected_active_version_id,
      coalesce(v_package.active_version_id::text, '<none>') USING ERRCODE = '40001';
  END IF;
  IF v_package.active_version_id = p_target_version_id THEN
    RAISE EXCEPTION 'SKILL_ROLLBACK_TARGET_ALREADY_ACTIVE' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_target
    FROM public.skill_versions
   WHERE id = p_target_version_id
     AND package_id = p_package_id
   FOR UPDATE;
  IF NOT FOUND OR v_target.status <> 'released' THEN
    RAISE EXCEPTION 'SKILL_ROLLBACK_TARGET_NOT_RELEASED' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.skill_packages
     SET active_version_id = v_target.id,
         updated_by = p_actor_id
   WHERE id = v_package.id
   RETURNING * INTO v_package;

  SELECT coalesce(max(sequence), 0) + 1 INTO v_audit_sequence
    FROM public.skill_release_audit
   WHERE package_id = v_package.id;
  INSERT INTO public.skill_release_audit (
    package_id, version_id, previous_version_id, sequence, action, actor_id, detail
  ) VALUES (
    v_package.id, v_target.id, p_expected_active_version_id, v_audit_sequence,
    'rollback', p_actor_id,
    jsonb_build_object(
      'slug', v_package.slug,
      'target_version_number', v_target.version_number,
      'target_semver', v_target.semver,
      'target_payload_hash', v_target.payload_hash,
      'expected_active_version_id', p_expected_active_version_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'rollback',
    'package_id', v_package.id,
    'version_id', v_target.id,
    'version_number', v_target.version_number,
    'semver', v_target.semver,
    'previous_version_id', p_expected_active_version_id,
    'active_version_id', v_package.active_version_id
  );
END;
$$;

CREATE FUNCTION public.replace_agent_skill_installations(
  p_agent_id text,
  p_installations jsonb,
  p_actor_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_agent_id text := btrim(coalesce(p_agent_id, ''));
  v_item jsonb;
  v_package_id uuid;
  v_version_id uuid;
  v_enabled boolean;
  v_priority integer;
  v_config jsonb;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_installed integer := 0;
  v_removed integer := 0;
BEGIN
  IF NOT public.skill_runtime_subject_valid(v_agent_id)
     OR p_actor_id IS NULL
     OR NOT public.skill_runtime_actor_valid(p_actor_id)
     OR p_installations IS NULL
     OR jsonb_typeof(p_installations) <> 'array'
     OR jsonb_array_length(p_installations) > 128 THEN
    RAISE EXCEPTION 'SKILL_AGENT_INSTALLATIONS_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-agent-installs:' || v_agent_id, 0));

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_installations)
  LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR coalesce(v_item->>'package_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR coalesce(v_item->>'version_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'SKILL_AGENT_INSTALLATION_ID_INVALID' USING ERRCODE = '22023';
    END IF;
    v_package_id := (v_item->>'package_id')::uuid;
    v_version_id := (v_item->>'version_id')::uuid;
    IF v_package_id = ANY(v_seen) THEN
      RAISE EXCEPTION 'SKILL_AGENT_INSTALLATION_DUPLICATE_PACKAGE' USING ERRCODE = '22023';
    END IF;
    v_seen := array_append(v_seen, v_package_id);

    IF v_item ? 'enabled'
       AND (
         jsonb_typeof(v_item->'enabled') <> 'boolean'
         OR lower(v_item->>'enabled') NOT IN ('true', 'false')
       ) THEN
      RAISE EXCEPTION 'SKILL_AGENT_INSTALLATION_ENABLED_INVALID' USING ERRCODE = '22023';
    END IF;
    v_enabled := coalesce((v_item->>'enabled')::boolean, true);
    IF v_item ? 'priority' AND coalesce(v_item->>'priority', '') !~ '^-?[0-9]{1,4}$' THEN
      RAISE EXCEPTION 'SKILL_AGENT_INSTALLATION_PRIORITY_INVALID' USING ERRCODE = '22023';
    END IF;
    v_priority := coalesce((v_item->>'priority')::integer, 0);
    IF v_priority NOT BETWEEN -1000 AND 1000 THEN
      RAISE EXCEPTION 'SKILL_AGENT_INSTALLATION_PRIORITY_INVALID' USING ERRCODE = '22023';
    END IF;
    v_config := coalesce(v_item->'config', '{}'::jsonb);
    IF jsonb_typeof(v_config) <> 'object' OR NOT public.skill_runtime_json_secret_safe(v_config) THEN
      RAISE EXCEPTION 'SKILL_AGENT_INSTALLATION_CONFIG_UNSAFE' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.agent_skill_installations (
      agent_id, package_id, version_id, enabled, priority, install_config, installed_by
    ) VALUES (
      v_agent_id, v_package_id, v_version_id, v_enabled, v_priority, v_config, p_actor_id
    )
    ON CONFLICT (agent_id, package_id) DO UPDATE SET
      version_id = EXCLUDED.version_id,
      enabled = EXCLUDED.enabled,
      priority = EXCLUDED.priority,
      install_config = EXCLUDED.install_config,
      installed_by = EXCLUDED.installed_by;
    v_installed := v_installed + 1;
  END LOOP;

  DELETE FROM public.agent_skill_installations
   WHERE agent_id = v_agent_id
     AND (cardinality(v_seen) = 0 OR NOT (package_id = ANY(v_seen)));
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'replace_agent_installations',
    'agent_id', v_agent_id,
    'installed_count', v_installed,
    'removed_count', v_removed
  );
END;
$$;

CREATE FUNCTION public.replace_user_skill_installations(
  p_user_id text,
  p_installations jsonb,
  p_actor_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id text := btrim(coalesce(p_user_id, ''));
  v_item jsonb;
  v_package_id uuid;
  v_version_id uuid;
  v_enabled boolean;
  v_priority integer;
  v_config jsonb;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_installed integer := 0;
  v_removed integer := 0;
BEGIN
  IF NOT public.skill_runtime_subject_valid(v_user_id)
     OR p_actor_id IS NULL
     OR NOT public.skill_runtime_actor_valid(p_actor_id)
     OR p_installations IS NULL
     OR jsonb_typeof(p_installations) <> 'array'
     OR jsonb_array_length(p_installations) > 128 THEN
    RAISE EXCEPTION 'SKILL_USER_INSTALLATIONS_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-user-installs:' || v_user_id, 0));

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_installations)
  LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR coalesce(v_item->>'package_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR coalesce(v_item->>'version_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'SKILL_USER_INSTALLATION_ID_INVALID' USING ERRCODE = '22023';
    END IF;
    v_package_id := (v_item->>'package_id')::uuid;
    v_version_id := (v_item->>'version_id')::uuid;
    IF v_package_id = ANY(v_seen) THEN
      RAISE EXCEPTION 'SKILL_USER_INSTALLATION_DUPLICATE_PACKAGE' USING ERRCODE = '22023';
    END IF;
    v_seen := array_append(v_seen, v_package_id);

    IF v_item ? 'enabled'
       AND (
         jsonb_typeof(v_item->'enabled') <> 'boolean'
         OR lower(v_item->>'enabled') NOT IN ('true', 'false')
       ) THEN
      RAISE EXCEPTION 'SKILL_USER_INSTALLATION_ENABLED_INVALID' USING ERRCODE = '22023';
    END IF;
    v_enabled := coalesce((v_item->>'enabled')::boolean, true);
    IF v_item ? 'priority' AND coalesce(v_item->>'priority', '') !~ '^-?[0-9]{1,4}$' THEN
      RAISE EXCEPTION 'SKILL_USER_INSTALLATION_PRIORITY_INVALID' USING ERRCODE = '22023';
    END IF;
    v_priority := coalesce((v_item->>'priority')::integer, 0);
    IF v_priority NOT BETWEEN -1000 AND 1000 THEN
      RAISE EXCEPTION 'SKILL_USER_INSTALLATION_PRIORITY_INVALID' USING ERRCODE = '22023';
    END IF;
    v_config := coalesce(v_item->'config', '{}'::jsonb);
    IF jsonb_typeof(v_config) <> 'object' OR NOT public.skill_runtime_json_secret_safe(v_config) THEN
      RAISE EXCEPTION 'SKILL_USER_INSTALLATION_CONFIG_UNSAFE' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.user_skill_installations (
      user_id, package_id, version_id, enabled, priority, install_config, installed_by
    ) VALUES (
      v_user_id, v_package_id, v_version_id, v_enabled, v_priority, v_config, p_actor_id
    )
    ON CONFLICT (user_id, package_id) DO UPDATE SET
      version_id = EXCLUDED.version_id,
      enabled = EXCLUDED.enabled,
      priority = EXCLUDED.priority,
      install_config = EXCLUDED.install_config,
      installed_by = EXCLUDED.installed_by;
    v_installed := v_installed + 1;
  END LOOP;

  DELETE FROM public.user_skill_installations
   WHERE user_id = v_user_id
     AND (cardinality(v_seen) = 0 OR NOT (package_id = ANY(v_seen)));
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'replace_user_installations',
    'user_id', v_user_id,
    'installed_count', v_installed,
    'removed_count', v_removed
  );
END;
$$;

CREATE FUNCTION public.claim_skill_invocation(
  p_invocation_id uuid,
  p_user_id text,
  p_agent_id text,
  p_package_id uuid,
  p_version_id uuid,
  p_client_idempotency_key text,
  p_payload_fingerprint text,
  p_input jsonb,
  p_model_id text,
  p_billing_operation_id text,
  p_task_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invocation_id uuid := coalesce(p_invocation_id, gen_random_uuid());
  v_user_id text := btrim(coalesce(p_user_id, ''));
  v_agent_id text := nullif(btrim(coalesce(p_agent_id, '')), '');
  v_client_key text := btrim(coalesce(p_client_idempotency_key, ''));
  v_fingerprint text := lower(btrim(coalesce(p_payload_fingerprint, '')));
  v_row public.skill_invocations%ROWTYPE;
  v_created boolean := false;
  v_version_status text;
  v_package_lifecycle text;
  v_install_allowed boolean := false;
BEGIN
  IF NOT public.skill_runtime_subject_valid(v_user_id)
     OR (v_agent_id IS NOT NULL AND NOT public.skill_runtime_subject_valid(v_agent_id))
     OR p_package_id IS NULL
     OR p_version_id IS NULL
     OR char_length(v_client_key) NOT BETWEEN 1 AND 200
     OR v_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_input IS NULL
     OR jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'SKILL_INVOCATION_CLAIM_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT version.status, package.lifecycle
    INTO v_version_status, v_package_lifecycle
    FROM public.skill_versions version
    JOIN public.skill_packages package ON package.id = version.package_id
   WHERE version.id = p_version_id
     AND version.package_id = p_package_id;
  IF NOT FOUND OR v_version_status <> 'released' OR v_package_lifecycle <> 'published' THEN
    RAISE EXCEPTION 'SKILL_INVOCATION_VERSION_NOT_RELEASED' USING ERRCODE = '22023';
  END IF;

  IF v_agent_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.agent_skill_installations installation
       WHERE installation.agent_id = v_agent_id
         AND installation.package_id = p_package_id
         AND installation.version_id = p_version_id
         AND installation.enabled
    ) INTO v_install_allowed;
  END IF;
  IF NOT v_install_allowed THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_skill_installations installation
       WHERE installation.user_id = v_user_id
         AND installation.package_id = p_package_id
         AND installation.version_id = p_version_id
         AND installation.enabled
    ) INTO v_install_allowed;
  END IF;
  IF NOT v_install_allowed THEN
    RAISE EXCEPTION 'SKILL_INVOCATION_NOT_INSTALLED' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.skill_invocations (
    id, user_id, agent_id, package_id, version_id, client_idempotency_key,
    payload_fingerprint, input, state, model_id, billing_operation_id, task_id
  ) VALUES (
    v_invocation_id, v_user_id, v_agent_id, p_package_id, p_version_id,
    v_client_key, v_fingerprint, p_input, 'claimed',
    nullif(btrim(coalesce(p_model_id, '')), ''),
    nullif(btrim(coalesce(p_billing_operation_id, '')), ''),
    nullif(btrim(coalesce(p_task_id, '')), '')
  )
  ON CONFLICT (user_id, client_idempotency_key) DO NOTHING
  RETURNING * INTO v_row;
  v_created := FOUND;

  IF NOT v_created THEN
    SELECT * INTO v_row
      FROM public.skill_invocations
     WHERE user_id = v_user_id
       AND client_idempotency_key = v_client_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SKILL_INVOCATION_LOOKUP_FAILED';
    END IF;
    IF (p_invocation_id IS NOT NULL AND v_row.id <> p_invocation_id)
       OR v_row.agent_id IS DISTINCT FROM v_agent_id
       OR v_row.package_id <> p_package_id
       OR v_row.version_id <> p_version_id
       OR v_row.payload_fingerprint <> v_fingerprint
       OR v_row.input <> p_input
       OR v_row.model_id IS DISTINCT FROM nullif(btrim(coalesce(p_model_id, '')), '')
       OR v_row.billing_operation_id IS DISTINCT FROM nullif(btrim(coalesce(p_billing_operation_id, '')), '')
       OR v_row.task_id IS DISTINCT FROM nullif(btrim(coalesce(p_task_id, '')), '') THEN
      RAISE EXCEPTION 'SKILL_INVOCATION_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'claim',
    'created', v_created,
    'invocation_id', v_row.id,
    'state', v_row.state,
    'record', to_jsonb(v_row)
  );
END;
$$;

CREATE FUNCTION public.complete_skill_invocation(
  p_invocation_id uuid,
  p_payload_fingerprint text,
  p_output jsonb,
  p_model_id text,
  p_billing_operation_id text,
  p_task_id text,
  p_provider_task_id text,
  p_asset_ids text[],
  p_charged_credits numeric,
  p_charged_cash numeric,
  p_cost_snapshot jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fingerprint text := lower(btrim(coalesce(p_payload_fingerprint, '')));
  v_asset_ids text[] := coalesce(p_asset_ids, ARRAY[]::text[]);
  v_credits numeric := coalesce(p_charged_credits, 0);
  v_cash numeric := coalesce(p_charged_cash, 0);
  v_cost_snapshot jsonb := coalesce(p_cost_snapshot, '{}'::jsonb);
  v_model_id text := nullif(btrim(coalesce(p_model_id, '')), '');
  v_billing_operation_id text := nullif(btrim(coalesce(p_billing_operation_id, '')), '');
  v_task_id text := nullif(btrim(coalesce(p_task_id, '')), '');
  v_provider_task_id text := nullif(btrim(coalesce(p_provider_task_id, '')), '');
  v_row public.skill_invocations%ROWTYPE;
BEGIN
  IF p_invocation_id IS NULL
     OR v_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_output IS NULL
     OR jsonb_typeof(p_output) <> 'object'
     OR NOT public.skill_runtime_asset_ids_valid(v_asset_ids)
     OR v_credits < 0
     OR v_cash < 0
     OR v_credits::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_cash::text IN ('NaN', 'Infinity', '-Infinity')
     OR jsonb_typeof(v_cost_snapshot) <> 'object'
     OR NOT public.skill_runtime_json_secret_safe(v_cost_snapshot) THEN
    RAISE EXCEPTION 'SKILL_INVOCATION_COMPLETION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM public.skill_invocations
   WHERE id = p_invocation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKILL_INVOCATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.payload_fingerprint <> v_fingerprint THEN
    RAISE EXCEPTION 'SKILL_INVOCATION_FINGERPRINT_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF (v_row.model_id IS NOT NULL AND v_model_id IS NOT NULL AND v_row.model_id <> v_model_id)
     OR (
       v_row.billing_operation_id IS NOT NULL
       AND v_billing_operation_id IS NOT NULL
       AND v_row.billing_operation_id <> v_billing_operation_id
     )
     OR (v_row.task_id IS NOT NULL AND v_task_id IS NOT NULL AND v_row.task_id <> v_task_id) THEN
    RAISE EXCEPTION 'SKILL_INVOCATION_CLAIM_METADATA_CONFLICT' USING ERRCODE = '22023';
  END IF;
  v_model_id := coalesce(v_model_id, v_row.model_id);
  v_billing_operation_id := coalesce(v_billing_operation_id, v_row.billing_operation_id);
  v_task_id := coalesce(v_task_id, v_row.task_id);
  IF v_row.state = 'completed' THEN
    IF v_row.output IS DISTINCT FROM p_output
       OR v_row.model_id IS DISTINCT FROM v_model_id
       OR v_row.billing_operation_id IS DISTINCT FROM v_billing_operation_id
       OR v_row.task_id IS DISTINCT FROM v_task_id
       OR v_row.provider_task_id IS DISTINCT FROM v_provider_task_id
       OR v_row.asset_ids IS DISTINCT FROM v_asset_ids
       OR v_row.charged_credits <> v_credits
       OR v_row.charged_cash <> v_cash
       OR v_row.cost_snapshot IS DISTINCT FROM v_cost_snapshot THEN
      RAISE EXCEPTION 'SKILL_INVOCATION_RESULT_CONFLICT' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('ok', true, 'action', 'complete', 'record', to_jsonb(v_row));
  END IF;
  IF v_row.state <> 'claimed' THEN
    RAISE EXCEPTION 'SKILL_INVOCATION_ALREADY_FAILED' USING ERRCODE = '55000';
  END IF;

  UPDATE public.skill_invocations
     SET state = 'completed',
         output = p_output,
         error_code = NULL,
         error_detail = NULL,
          model_id = v_model_id,
          billing_operation_id = v_billing_operation_id,
          task_id = v_task_id,
          provider_task_id = v_provider_task_id,
         asset_ids = v_asset_ids,
         charged_credits = v_credits,
         charged_cash = v_cash,
         cost_snapshot = v_cost_snapshot,
         completed_at = now()
   WHERE id = v_row.id
   RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'complete',
    'invocation_id', v_row.id,
    'state', v_row.state,
    'record', to_jsonb(v_row)
  );
END;
$$;

CREATE FUNCTION public.fail_skill_invocation(
  p_invocation_id uuid,
  p_payload_fingerprint text,
  p_failure_kind text,
  p_error_code text,
  p_error_detail jsonb,
  p_billing_operation_id text,
  p_task_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fingerprint text := lower(btrim(coalesce(p_payload_fingerprint, '')));
  v_failure_kind text := lower(btrim(coalesce(p_failure_kind, '')));
  v_state text;
  v_error_code text := btrim(coalesce(p_error_code, ''));
  v_error_detail jsonb := coalesce(p_error_detail, '{}'::jsonb);
  v_billing_operation_id text := nullif(btrim(coalesce(p_billing_operation_id, '')), '');
  v_task_id text := nullif(btrim(coalesce(p_task_id, '')), '');
  v_row public.skill_invocations%ROWTYPE;
BEGIN
  IF p_invocation_id IS NULL
     OR v_fingerprint !~ '^[0-9a-f]{64}$'
     OR v_failure_kind NOT IN ('terminal', 'unknown')
     OR char_length(v_error_code) NOT BETWEEN 1 AND 120
     OR v_error_code !~ '^[A-Z0-9][A-Z0-9_:-]{0,119}$'
     OR jsonb_typeof(v_error_detail) <> 'object' THEN
    RAISE EXCEPTION 'SKILL_INVOCATION_FAILURE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_state := CASE WHEN v_failure_kind = 'unknown' THEN 'failed_unknown' ELSE 'failed' END;

  SELECT * INTO v_row
    FROM public.skill_invocations
   WHERE id = p_invocation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKILL_INVOCATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.payload_fingerprint <> v_fingerprint THEN
    RAISE EXCEPTION 'SKILL_INVOCATION_FINGERPRINT_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF (
       v_row.billing_operation_id IS NOT NULL
       AND v_billing_operation_id IS NOT NULL
       AND v_row.billing_operation_id <> v_billing_operation_id
     )
     OR (v_row.task_id IS NOT NULL AND v_task_id IS NOT NULL AND v_row.task_id <> v_task_id) THEN
    RAISE EXCEPTION 'SKILL_INVOCATION_CLAIM_METADATA_CONFLICT' USING ERRCODE = '22023';
  END IF;
  v_billing_operation_id := coalesce(v_billing_operation_id, v_row.billing_operation_id);
  v_task_id := coalesce(v_task_id, v_row.task_id);
  IF v_row.state IN ('failed', 'failed_unknown') THEN
    IF v_row.state <> v_state
       OR v_row.error_code <> v_error_code
       OR v_row.error_detail IS DISTINCT FROM v_error_detail
       OR v_row.billing_operation_id IS DISTINCT FROM v_billing_operation_id
       OR v_row.task_id IS DISTINCT FROM v_task_id THEN
      RAISE EXCEPTION 'SKILL_INVOCATION_FAILURE_CONFLICT' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('ok', true, 'action', 'fail', 'record', to_jsonb(v_row));
  END IF;
  IF v_row.state = 'completed' THEN
    RAISE EXCEPTION 'SKILL_INVOCATION_ALREADY_COMPLETED' USING ERRCODE = '55000';
  END IF;

  UPDATE public.skill_invocations
     SET state = v_state,
         output = NULL,
         error_code = v_error_code,
         error_detail = v_error_detail,
          billing_operation_id = v_billing_operation_id,
          task_id = v_task_id,
         completed_at = now()
   WHERE id = v_row.id
   RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'action', 'fail',
    'invocation_id', v_row.id,
    'state', v_row.state,
    'record', to_jsonb(v_row)
  );
END;
$$;

ALTER TABLE public.skill_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skill_secret_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_skill_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_skill_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skill_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skill_release_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.skill_packages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.skill_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.skill_secret_bindings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.agent_skill_installations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.user_skill_installations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.skill_invocations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.skill_release_audit FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.skill_release_audit_id_seq FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.skill_packages TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.skill_versions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.skill_secret_bindings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_skill_installations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_skill_installations TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.skill_invocations TO service_role;
GRANT SELECT, INSERT ON TABLE public.skill_release_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.skill_release_audit_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.skill_runtime_actor_valid(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skill_runtime_subject_valid(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skill_runtime_secret_ref_valid(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skill_runtime_asset_ids_valid(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skill_runtime_json_secret_safe(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skill_runtime_package_payload_valid(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skill_runtime_touch_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skill_runtime_guard_package() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skill_runtime_guard_version() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skill_runtime_guard_installation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skill_runtime_guard_invocation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skill_runtime_reject_audit_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_skill_package_draft(
  text, text, text, text, text, text, jsonb, text, text, text, jsonb,
  uuid, uuid, timestamptz, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_skill_version(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rollback_skill_package_version(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.replace_agent_skill_installations(text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.replace_user_skill_installations(text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_skill_invocation(
  uuid, text, text, uuid, uuid, text, text, jsonb, text, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_skill_invocation(
  uuid, text, jsonb, text, text, text, text, text[], numeric, numeric, jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_skill_invocation(
  uuid, text, text, text, jsonb, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.skill_runtime_actor_valid(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.skill_runtime_subject_valid(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.skill_runtime_secret_ref_valid(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.skill_runtime_asset_ids_valid(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.skill_runtime_json_secret_safe(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.skill_runtime_package_payload_valid(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_skill_package_draft(
  text, text, text, text, text, text, jsonb, text, text, text, jsonb,
  uuid, uuid, timestamptz, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_skill_version(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rollback_skill_package_version(uuid, uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.replace_agent_skill_installations(text, jsonb, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.replace_user_skill_installations(text, jsonb, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_skill_invocation(
  uuid, text, text, uuid, uuid, text, text, jsonb, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_skill_invocation(
  uuid, text, jsonb, text, text, text, text, text[], numeric, numeric, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_skill_invocation(
  uuid, text, text, text, jsonb, text, text
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
