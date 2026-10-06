BEGIN;

-- Short-drama core is intentionally provider-agnostic. It persists projects,
-- workflow state and immutable audit snapshots; it does not call paid models.

CREATE TABLE IF NOT EXISTS short_drama_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  client_request_id text,
  request_hash text,
  title varchar(120) NOT NULL,
  description text,
  project_type text NOT NULL DEFAULT 'short_drama',
  status text NOT NULL DEFAULT 'draft',
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT short_drama_projects_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  CONSTRAINT short_drama_projects_type_check CHECK (
    project_type IN ('short_drama', 'narrated_animation', 'pet_story', 'custom')
  ),
  CONSTRAINT short_drama_projects_status_check CHECK (
    status IN ('draft', 'active', 'generating', 'completed', 'failed', 'archived')
  ),
  CONSTRAINT short_drama_projects_payload_check CHECK (jsonb_typeof(source_payload) = 'object'),
  CONSTRAINT short_drama_projects_settings_check CHECK (jsonb_typeof(settings) = 'object'),
  CONSTRAINT short_drama_projects_revision_check CHECK (revision >= 1),
  CONSTRAINT short_drama_projects_idempotency_pair_check CHECK (
    (client_request_id IS NULL AND request_hash IS NULL)
    OR
    (client_request_id IS NOT NULL AND request_hash ~ '^[0-9a-f]{64}$')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS short_drama_projects_user_request_once_idx
  ON short_drama_projects(user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS short_drama_projects_user_updated_idx
  ON short_drama_projects(user_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS short_drama_projects_user_status_idx
  ON short_drama_projects(user_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS short_drama_project_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES short_drama_projects(id) ON DELETE CASCADE,
  user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  version integer NOT NULL,
  change_kind text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT short_drama_project_versions_version_check CHECK (version >= 1),
  CONSTRAINT short_drama_project_versions_kind_check CHECK (
    change_kind IN ('create', 'update', 'delete', 'restore', 'workflow')
  ),
  CONSTRAINT short_drama_project_versions_snapshot_check CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT short_drama_project_versions_once UNIQUE(project_id, version)
);

CREATE INDEX IF NOT EXISTS short_drama_project_versions_user_project_idx
  ON short_drama_project_versions(user_id, project_id, version DESC);

CREATE TABLE IF NOT EXISTS short_drama_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES short_drama_projects(id) ON DELETE CASCADE,
  user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_key varchar(120) NOT NULL,
  name varchar(160) NOT NULL,
  description text,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  reference_asset_uri text,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT short_drama_entities_type_check CHECK (
    entity_type IN ('character', 'location', 'prop', 'style', 'voice')
  ),
  CONSTRAINT short_drama_entities_key_check CHECK (length(btrim(entity_key)) BETWEEN 1 AND 120),
  CONSTRAINT short_drama_entities_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  CONSTRAINT short_drama_entities_attributes_check CHECK (jsonb_typeof(attributes) = 'object'),
  CONSTRAINT short_drama_entities_revision_check CHECK (revision >= 1),
  CONSTRAINT short_drama_entities_project_key_once UNIQUE(project_id, entity_type, entity_key)
);

CREATE INDEX IF NOT EXISTS short_drama_entities_user_project_idx
  ON short_drama_entities(user_id, project_id, entity_type);

CREATE TABLE IF NOT EXISTS short_drama_shots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES short_drama_projects(id) ON DELETE CASCADE,
  user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  scene_key varchar(120),
  title varchar(200),
  narration text,
  visual_description text,
  image_prompt text,
  video_prompt text,
  negative_prompt text,
  duration_seconds numeric(8,3) NOT NULL DEFAULT 5,
  aspect_ratio text NOT NULL DEFAULT '9:16',
  status text NOT NULL DEFAULT 'draft',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT short_drama_shots_sequence_check CHECK (sequence >= 1),
  CONSTRAINT short_drama_shots_duration_check CHECK (duration_seconds > 0 AND duration_seconds <= 120),
  CONSTRAINT short_drama_shots_aspect_check CHECK (
    aspect_ratio IN ('16:9', '9:16', '1:1', '4:3', '3:4', '21:9')
  ),
  CONSTRAINT short_drama_shots_status_check CHECK (
    status IN ('draft', 'ready', 'generating', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT short_drama_shots_metadata_check CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT short_drama_shots_revision_check CHECK (revision >= 1),
  CONSTRAINT short_drama_shots_project_sequence_once UNIQUE(project_id, sequence)
);

CREATE INDEX IF NOT EXISTS short_drama_shots_user_project_idx
  ON short_drama_shots(user_id, project_id, sequence);

CREATE TABLE IF NOT EXISTS short_drama_prompt_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES short_drama_projects(id) ON DELETE CASCADE,
  user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  stage text NOT NULL,
  -- Snapshot the logical agent identifier as text. Do not bind this audit row
  -- to the mutable agents table or assume that table's physical id type.
  agent_id text,
  prompt_version varchar(80) NOT NULL,
  prompt_hash text NOT NULL,
  template_text text NOT NULL,
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_public_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT short_drama_prompt_stage_check CHECK (
    stage IN (
      'script_analysis', 'entity_design', 'scene_design', 'shot_planning',
      'image_prompt', 'image_generation', 'video_prompt', 'video_generation',
      'audio_generation', 'final_assembly', 'export'
    )
  ),
  CONSTRAINT short_drama_prompt_hash_check CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT short_drama_prompt_variables_check CHECK (jsonb_typeof(variables) = 'object'),
  CONSTRAINT short_drama_prompt_snapshot_once UNIQUE(project_id, stage, prompt_hash)
);

CREATE INDEX IF NOT EXISTS short_drama_prompt_snapshots_user_project_idx
  ON short_drama_prompt_snapshots(user_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS short_drama_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_job_id text NOT NULL UNIQUE,
  project_id uuid NOT NULL REFERENCES short_drama_projects(id) ON DELETE CASCADE,
  user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  shot_id uuid REFERENCES short_drama_shots(id) ON DELETE CASCADE,
  prompt_snapshot_id uuid REFERENCES short_drama_prompt_snapshots(id) ON DELETE RESTRICT,
  client_request_id text NOT NULL,
  input_hash text NOT NULL,
  stage text NOT NULL,
  state text NOT NULL DEFAULT 'accepted',
  provider text,
  upstream_task_id text,
  model_public_id text,
  model_id_snapshot text,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  billing_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  not_before timestamptz,
  lease_owner text,
  lease_token bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  progress integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT short_drama_jobs_input_hash_check CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT short_drama_jobs_stage_check CHECK (
    stage IN (
      'script_analysis', 'entity_design', 'scene_design', 'shot_planning',
      'image_prompt', 'image_generation', 'video_prompt', 'video_generation',
      'audio_generation', 'final_assembly', 'export'
    )
  ),
  CONSTRAINT short_drama_jobs_state_check CHECK (
    state IN (
      'accepted', 'queued', 'running', 'result_staging', 'persisting',
      'finalizing', 'succeeded', 'retry_wait', 'failed', 'cancelled'
    )
  ),
  CONSTRAINT short_drama_jobs_payload_check CHECK (
    jsonb_typeof(request_payload) = 'object'
    AND jsonb_typeof(result_payload) = 'object'
    AND jsonb_typeof(billing_snapshot) = 'object'
  ),
  CONSTRAINT short_drama_jobs_attempt_check CHECK (
    attempt_count >= 0 AND max_attempts >= 1 AND attempt_count <= max_attempts
  ),
  CONSTRAINT short_drama_jobs_progress_check CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT short_drama_jobs_lease_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT short_drama_jobs_user_request_once UNIQUE(user_id, client_request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS short_drama_jobs_provider_task_once_idx
  ON short_drama_jobs(provider, upstream_task_id)
  WHERE provider IS NOT NULL AND upstream_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS short_drama_jobs_claim_idx
  ON short_drama_jobs(state, not_before, created_at)
  WHERE state IN ('accepted', 'queued', 'retry_wait');
CREATE INDEX IF NOT EXISTS short_drama_jobs_user_project_idx
  ON short_drama_jobs(user_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS short_drama_jobs_lease_idx
  ON short_drama_jobs(lease_expires_at)
  WHERE lease_owner IS NOT NULL;

CREATE TABLE IF NOT EXISTS short_drama_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES short_drama_projects(id) ON DELETE CASCADE,
  user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  shot_id uuid REFERENCES short_drama_shots(id) ON DELETE SET NULL,
  job_id uuid REFERENCES short_drama_jobs(id) ON DELETE SET NULL,
  asset_role text NOT NULL,
  provider text NOT NULL,
  object_key text NOT NULL,
  stable_uri text NOT NULL,
  mime_type varchar(160),
  byte_size bigint,
  checksum_sha256 text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT short_drama_assets_role_check CHECK (
    asset_role IN (
      'source', 'character_reference', 'scene_reference', 'storyboard',
      'image', 'video', 'audio', 'subtitle', 'export'
    )
  ),
  CONSTRAINT short_drama_assets_provider_check CHECK (provider ~ '^[a-z0-9_][a-z0-9_-]{1,63}$'),
  CONSTRAINT short_drama_assets_object_key_check CHECK (length(object_key) BETWEEN 1 AND 1024),
  CONSTRAINT short_drama_assets_stable_uri_check CHECK (
    stable_uri ~ '^object://[a-z0-9_][a-z0-9_-]{1,63}/[^?#]+$'
  ),
  CONSTRAINT short_drama_assets_size_check CHECK (byte_size IS NULL OR byte_size >= 0),
  CONSTRAINT short_drama_assets_checksum_check CHECK (
    checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT short_drama_assets_metadata_check CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT short_drama_assets_provider_key_once UNIQUE(provider, object_key)
);

CREATE INDEX IF NOT EXISTS short_drama_assets_user_project_idx
  ON short_drama_assets(user_id, project_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS short_drama_assets_job_idx
  ON short_drama_assets(job_id)
  WHERE job_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS short_drama_settlements (
  job_id uuid PRIMARY KEY REFERENCES short_drama_jobs(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES short_drama_projects(id) ON DELETE RESTRICT,
  user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  public_job_id text NOT NULL UNIQUE,
  billing_mode text NOT NULL,
  credits_charged numeric(18,6) NOT NULL DEFAULT 0,
  cash_charged numeric(18,6) NOT NULL DEFAULT 0,
  cost_amount numeric(18,6) NOT NULL DEFAULT 0,
  ledger_reference text,
  pricing_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT short_drama_settlements_mode_check CHECK (
    billing_mode IN ('free', 'credits', 'cash')
  ),
  CONSTRAINT short_drama_settlements_amount_check CHECK (
    credits_charged >= 0 AND cash_charged >= 0 AND cost_amount >= 0
  ),
  CONSTRAINT short_drama_settlements_pricing_check CHECK (jsonb_typeof(pricing_snapshot) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS short_drama_settlements_ledger_once_idx
  ON short_drama_settlements(ledger_reference)
  WHERE ledger_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS short_drama_settlements_user_project_idx
  ON short_drama_settlements(user_id, project_id, created_at DESC);

CREATE OR REPLACE FUNCTION short_drama_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS short_drama_projects_touch_updated_at ON short_drama_projects;
CREATE TRIGGER short_drama_projects_touch_updated_at
  BEFORE UPDATE ON short_drama_projects
  FOR EACH ROW EXECUTE FUNCTION short_drama_touch_updated_at();
DROP TRIGGER IF EXISTS short_drama_entities_touch_updated_at ON short_drama_entities;
CREATE TRIGGER short_drama_entities_touch_updated_at
  BEFORE UPDATE ON short_drama_entities
  FOR EACH ROW EXECUTE FUNCTION short_drama_touch_updated_at();
DROP TRIGGER IF EXISTS short_drama_shots_touch_updated_at ON short_drama_shots;
CREATE TRIGGER short_drama_shots_touch_updated_at
  BEFORE UPDATE ON short_drama_shots
  FOR EACH ROW EXECUTE FUNCTION short_drama_touch_updated_at();
DROP TRIGGER IF EXISTS short_drama_jobs_touch_updated_at ON short_drama_jobs;
CREATE TRIGGER short_drama_jobs_touch_updated_at
  BEFORE UPDATE ON short_drama_jobs
  FOR EACH ROW EXECUTE FUNCTION short_drama_touch_updated_at();
DROP TRIGGER IF EXISTS short_drama_assets_touch_updated_at ON short_drama_assets;
CREATE TRIGGER short_drama_assets_touch_updated_at
  BEFORE UPDATE ON short_drama_assets
  FOR EACH ROW EXECUTE FUNCTION short_drama_touch_updated_at();

ALTER TABLE short_drama_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE short_drama_project_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE short_drama_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE short_drama_shots ENABLE ROW LEVEL SECURITY;
ALTER TABLE short_drama_prompt_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE short_drama_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE short_drama_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE short_drama_settlements ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE short_drama_projects FROM anon, authenticated;
REVOKE ALL ON TABLE short_drama_project_versions FROM anon, authenticated;
REVOKE ALL ON TABLE short_drama_entities FROM anon, authenticated;
REVOKE ALL ON TABLE short_drama_shots FROM anon, authenticated;
REVOKE ALL ON TABLE short_drama_prompt_snapshots FROM anon, authenticated;
REVOKE ALL ON TABLE short_drama_jobs FROM anon, authenticated;
REVOKE ALL ON TABLE short_drama_assets FROM anon, authenticated;
REVOKE ALL ON TABLE short_drama_settlements FROM anon, authenticated;

GRANT ALL ON TABLE short_drama_projects TO service_role;
GRANT ALL ON TABLE short_drama_project_versions TO service_role;
GRANT ALL ON TABLE short_drama_entities TO service_role;
GRANT ALL ON TABLE short_drama_shots TO service_role;
GRANT ALL ON TABLE short_drama_prompt_snapshots TO service_role;
GRANT ALL ON TABLE short_drama_jobs TO service_role;
GRANT ALL ON TABLE short_drama_assets TO service_role;
GRANT ALL ON TABLE short_drama_settlements TO service_role;

DROP POLICY IF EXISTS short_drama_projects_service_role_all ON short_drama_projects;
CREATE POLICY short_drama_projects_service_role_all ON short_drama_projects
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS short_drama_project_versions_service_role_all ON short_drama_project_versions;
CREATE POLICY short_drama_project_versions_service_role_all ON short_drama_project_versions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS short_drama_entities_service_role_all ON short_drama_entities;
CREATE POLICY short_drama_entities_service_role_all ON short_drama_entities
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS short_drama_shots_service_role_all ON short_drama_shots;
CREATE POLICY short_drama_shots_service_role_all ON short_drama_shots
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS short_drama_prompt_snapshots_service_role_all ON short_drama_prompt_snapshots;
CREATE POLICY short_drama_prompt_snapshots_service_role_all ON short_drama_prompt_snapshots
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS short_drama_jobs_service_role_all ON short_drama_jobs;
CREATE POLICY short_drama_jobs_service_role_all ON short_drama_jobs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS short_drama_assets_service_role_all ON short_drama_assets;
CREATE POLICY short_drama_assets_service_role_all ON short_drama_assets
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS short_drama_settlements_service_role_all ON short_drama_settlements;
CREATE POLICY short_drama_settlements_service_role_all ON short_drama_settlements
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Creates the project and its initial version atomically. The first payload for
-- a user/client_request_id wins; retries return the original project.
CREATE OR REPLACE FUNCTION short_drama_create_project(
  p_user_id varchar,
  p_client_request_id text,
  p_request_hash text,
  p_title text,
  p_description text,
  p_project_type text,
  p_source_payload jsonb,
  p_settings jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_project short_drama_projects%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR btrim(p_user_id) = '' OR length(p_user_id) > 36 THEN
    RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_INVALID_USER';
  END IF;
  IF p_client_request_id IS NULL OR length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' THEN
    RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_INVALID_IDEMPOTENCY_KEY';
  END IF;
  IF p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_INVALID_REQUEST_HASH';
  END IF;
  IF p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_INVALID_TITLE';
  END IF;
  IF p_project_type NOT IN ('short_drama', 'narrated_animation', 'pet_story', 'custom') THEN
    RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_INVALID_TYPE';
  END IF;
  IF jsonb_typeof(COALESCE(p_source_payload, '{}'::jsonb)) <> 'object'
     OR jsonb_typeof(COALESCE(p_settings, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_INVALID_JSON';
  END IF;

  SELECT * INTO v_project
  FROM short_drama_projects
  WHERE user_id = p_user_id AND client_request_id = p_client_request_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_project.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'SHORT_DRAMA_IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN jsonb_build_object('project', to_jsonb(v_project), 'replayed', true);
  END IF;

  BEGIN
    INSERT INTO short_drama_projects(
      user_id, client_request_id, request_hash, title, description,
      project_type, source_payload, settings
    ) VALUES (
      p_user_id, p_client_request_id, p_request_hash, btrim(p_title), p_description,
      p_project_type, COALESCE(p_source_payload, '{}'::jsonb), COALESCE(p_settings, '{}'::jsonb)
    ) RETURNING * INTO v_project;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_project
    FROM short_drama_projects
    WHERE user_id = p_user_id AND client_request_id = p_client_request_id
    FOR UPDATE;
    IF NOT FOUND OR v_project.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'SHORT_DRAMA_IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN jsonb_build_object('project', to_jsonb(v_project), 'replayed', true);
  END;

  INSERT INTO short_drama_project_versions(project_id, user_id, version, change_kind, snapshot)
  VALUES (v_project.id, v_project.user_id, v_project.revision, 'create', to_jsonb(v_project));

  RETURN jsonb_build_object('project', to_jsonb(v_project), 'replayed', false);
END;
$function$;

-- Optimistic project update and version snapshot in one transaction.
CREATE OR REPLACE FUNCTION short_drama_update_project(
  p_user_id varchar,
  p_project_id uuid,
  p_expected_revision integer,
  p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_project short_drama_projects%ROWTYPE;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN
    RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_PATCH_INVALID';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_patch) AS keys(key_name)
    WHERE key_name NOT IN ('title', 'description', 'projectType', 'status', 'sourcePayload', 'settings')
  ) THEN
    RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_PATCH_INVALID_KEY';
  END IF;
  IF p_patch ? 'title' AND length(btrim(COALESCE(p_patch->>'title', ''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_INVALID_TITLE';
  END IF;
  IF p_patch ? 'projectType' AND COALESCE(p_patch->>'projectType', '') NOT IN (
    'short_drama', 'narrated_animation', 'pet_story', 'custom'
  ) THEN
    RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_INVALID_TYPE';
  END IF;
  IF p_patch ? 'status' AND COALESCE(p_patch->>'status', '') NOT IN (
    'draft', 'active', 'generating', 'completed', 'failed', 'archived'
  ) THEN
    RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_INVALID_STATUS';
  END IF;
  IF p_patch ? 'description' AND jsonb_typeof(p_patch->'description') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_INVALID_DESCRIPTION';
  END IF;
  IF p_patch ? 'sourcePayload' AND jsonb_typeof(p_patch->'sourcePayload') <> 'object' THEN
    RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_INVALID_SOURCE';
  END IF;
  IF p_patch ? 'settings' AND jsonb_typeof(p_patch->'settings') <> 'object' THEN
    RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_INVALID_SETTINGS';
  END IF;

  SELECT * INTO v_project
  FROM short_drama_projects
  WHERE id = p_project_id AND user_id = p_user_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_NOT_FOUND'; END IF;
  IF p_expected_revision IS NULL OR v_project.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'SHORT_DRAMA_REVISION_CONFLICT';
  END IF;

  UPDATE short_drama_projects
  SET
    title = CASE WHEN p_patch ? 'title' THEN btrim(p_patch->>'title') ELSE title END,
    description = CASE
      WHEN NOT (p_patch ? 'description') THEN description
      WHEN jsonb_typeof(p_patch->'description') = 'null' THEN NULL
      ELSE p_patch->>'description'
    END,
    project_type = CASE WHEN p_patch ? 'projectType' THEN p_patch->>'projectType' ELSE project_type END,
    status = CASE WHEN p_patch ? 'status' THEN p_patch->>'status' ELSE status END,
    source_payload = CASE WHEN p_patch ? 'sourcePayload' THEN p_patch->'sourcePayload' ELSE source_payload END,
    settings = CASE WHEN p_patch ? 'settings' THEN settings || (p_patch->'settings') ELSE settings END,
    revision = revision + 1,
    updated_at = now()
  WHERE id = v_project.id
  RETURNING * INTO v_project;

  INSERT INTO short_drama_project_versions(project_id, user_id, version, change_kind, snapshot)
  VALUES (v_project.id, v_project.user_id, v_project.revision, 'update', to_jsonb(v_project));

  RETURN jsonb_build_object('project', to_jsonb(v_project), 'replayed', false);
END;
$function$;

-- Owner-scoped soft delete with optional optimistic revision check.
CREATE OR REPLACE FUNCTION short_drama_delete_project(
  p_user_id varchar,
  p_project_id uuid,
  p_expected_revision integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_project short_drama_projects%ROWTYPE;
BEGIN
  SELECT * INTO v_project
  FROM short_drama_projects
  WHERE id = p_project_id AND user_id = p_user_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SHORT_DRAMA_PROJECT_NOT_FOUND'; END IF;
  IF p_expected_revision IS NOT NULL AND v_project.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'SHORT_DRAMA_REVISION_CONFLICT';
  END IF;

  UPDATE short_drama_projects
  SET status = 'archived', deleted_at = now(), revision = revision + 1, updated_at = now()
  WHERE id = v_project.id
  RETURNING * INTO v_project;

  INSERT INTO short_drama_project_versions(project_id, user_id, version, change_kind, snapshot)
  VALUES (v_project.id, v_project.user_id, v_project.revision, 'delete', to_jsonb(v_project));

  RETURN jsonb_build_object('project', to_jsonb(v_project), 'replayed', false);
END;
$function$;

REVOKE ALL ON FUNCTION short_drama_create_project(varchar, text, text, text, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION short_drama_update_project(varchar, uuid, integer, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION short_drama_delete_project(varchar, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION short_drama_create_project(varchar, text, text, text, text, text, jsonb, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION short_drama_update_project(varchar, uuid, integer, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION short_drama_delete_project(varchar, uuid, integer)
  TO service_role;

COMMIT;
