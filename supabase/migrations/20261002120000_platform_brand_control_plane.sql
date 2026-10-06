-- Versioned platform-brand control plane. Browser clients never receive
-- storage keys or signed URLs; only the service role can read these tables.

CREATE TABLE IF NOT EXISTS public.platform_brand_profiles (
  id text PRIMARY KEY CHECK (id = 'default'),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  draft_revision_id uuid,
  published_revision_id uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.platform_brand_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id text NOT NULL REFERENCES public.platform_brand_profiles(id) ON DELETE RESTRICT,
  revision_version bigint NOT NULL CHECK (revision_version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  schema_version text NOT NULL DEFAULT 'platform-brand/v1' CHECK (schema_version = 'platform-brand/v1'),
  snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot) = 'object'
    AND snapshot ?& ARRAY['schema', 'name', 'shortName', 'slogan', 'welcomeMessage', 'description', 'seo', 'colors', 'assetIds']
    AND snapshot - ARRAY['schema', 'name', 'shortName', 'slogan', 'welcomeMessage', 'description', 'seo', 'colors', 'assetIds'] = '{}'::jsonb
    AND snapshot->>'schema' = 'platform-brand/v1'
    AND jsonb_typeof(snapshot->'name') = 'string'
    AND length(snapshot->>'name') BETWEEN 1 AND 80
    AND jsonb_typeof(snapshot->'shortName') = 'string'
    AND length(snapshot->>'shortName') <= 40
    AND jsonb_typeof(snapshot->'slogan') = 'string'
    AND length(snapshot->>'slogan') <= 120
    AND jsonb_typeof(snapshot->'welcomeMessage') = 'string'
    AND length(snapshot->>'welcomeMessage') <= 240
    AND jsonb_typeof(snapshot->'description') = 'string'
    AND length(snapshot->>'description') <= 500
    AND jsonb_typeof(snapshot->'seo') = 'object'
    AND (snapshot->'seo') ?& ARRAY['title', 'description']
    AND (snapshot->'seo') - ARRAY['title', 'description'] = '{}'::jsonb
    AND jsonb_typeof(snapshot->'seo'->'title') = 'string'
    AND length(snapshot->'seo'->>'title') <= 70
    AND jsonb_typeof(snapshot->'seo'->'description') = 'string'
    AND length(snapshot->'seo'->>'description') <= 180
    AND jsonb_typeof(snapshot->'colors') = 'object'
    AND (snapshot->'colors') ?& ARRAY['primary', 'accent']
    AND (snapshot->'colors') - ARRAY['primary', 'accent'] = '{}'::jsonb
    AND snapshot->'colors'->>'primary' ~ '^#[0-9A-F]{6}$'
    AND snapshot->'colors'->>'accent' ~ '^#[0-9A-F]{6}$'
    AND jsonb_typeof(snapshot->'assetIds') = 'object'
    AND (snapshot->'assetIds') - ARRAY[
      'logo_square', 'logo_horizontal_light', 'logo_horizontal_dark',
      'favicon', 'social_share', 'login_background'
    ] = '{}'::jsonb
  ),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  parent_revision_id uuid REFERENCES public.platform_brand_revisions(id) ON DELETE RESTRICT,
  rollback_target_id uuid REFERENCES public.platform_brand_revisions(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL,
  published_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (profile_id, revision_version),
  CHECK (
    (status = 'draft' AND published_by IS NULL AND published_at IS NULL)
    OR (status = 'published' AND published_by IS NOT NULL AND published_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.platform_brand_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id text NOT NULL REFERENCES public.platform_brand_profiles(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN (
    'logo_square', 'logo_horizontal_light', 'logo_horizontal_dark',
    'favicon', 'social_share', 'login_background'
  )),
  storage_provider text NOT NULL CHECK (storage_provider IN ('coze_s3', 'tencent_cos', 'local')),
  storage_key text NOT NULL CHECK (
    length(storage_key) BETWEEN 1 AND 1024
    AND storage_key !~* '^(https?:)?//'
    AND storage_key !~ '[?#]'
  ),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes bigint NOT NULL CHECK (bytes > 0 AND bytes <= 5242880),
  width integer NOT NULL CHECK (width BETWEEN 16 AND 8192),
  height integer NOT NULL CHECK (height BETWEEN 16 AND 8192),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (storage_provider, storage_key)
);

CREATE TABLE IF NOT EXISTS public.platform_brand_revision_assets (
  revision_id uuid NOT NULL REFERENCES public.platform_brand_revisions(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL REFERENCES public.platform_brand_assets(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN (
    'logo_square', 'logo_horizontal_light', 'logo_horizontal_dark',
    'favicon', 'social_share', 'login_background'
  )),
  PRIMARY KEY (revision_id, purpose),
  UNIQUE (revision_id, asset_id)
);

CREATE TABLE IF NOT EXISTS public.platform_brand_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  profile_id text NOT NULL DEFAULT 'default' REFERENCES public.platform_brand_profiles(id) ON DELETE RESTRICT,
  actor_id uuid,
  action text NOT NULL CHECK (action IN ('asset_upload', 'draft_save', 'publish', 'rollback')),
  result text NOT NULL CHECK (result IN ('success', 'failure')),
  reason_code text NOT NULL DEFAULT '',
  revision_id uuid,
  asset_id uuid,
  generation bigint,
  request_key text NOT NULL DEFAULT '',
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_brand_profiles_draft_revision_fk') THEN
    ALTER TABLE public.platform_brand_profiles
      ADD CONSTRAINT platform_brand_profiles_draft_revision_fk
      FOREIGN KEY (draft_revision_id) REFERENCES public.platform_brand_revisions(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_brand_profiles_published_revision_fk') THEN
    ALTER TABLE public.platform_brand_profiles
      ADD CONSTRAINT platform_brand_profiles_published_revision_fk
      FOREIGN KEY (published_revision_id) REFERENCES public.platform_brand_revisions(id) ON DELETE RESTRICT;
  END IF;
END;
$$;

INSERT INTO public.platform_brand_profiles (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

-- The legacy URL field remains readable during migration, but expiring signed
-- URLs must not be written back because they cannot serve as durable branding.
CREATE OR REPLACE FUNCTION public.reject_signed_legacy_platform_brand_url()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.setting_key = 'platform_cover'
     AND coalesce(NEW.setting_value, '') ~* '[?&](signature|sig|token|expires|credential|x-amz-[^=]*|q-sign-[^=]*)=' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PLATFORM_BRAND_SIGNED_URL_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_signed_legacy_platform_brand_url() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_signed_legacy_platform_brand_url() TO service_role;

DROP TRIGGER IF EXISTS platform_settings_reject_signed_brand_url ON public.platform_settings;
CREATE TRIGGER platform_settings_reject_signed_brand_url
  BEFORE INSERT OR UPDATE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.reject_signed_legacy_platform_brand_url();

CREATE INDEX IF NOT EXISTS platform_brand_revisions_profile_idx
  ON public.platform_brand_revisions (profile_id, revision_version DESC);
CREATE INDEX IF NOT EXISTS platform_brand_assets_profile_idx
  ON public.platform_brand_assets (profile_id, purpose, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS platform_brand_events_profile_idx
  ON public.platform_brand_events (profile_id, created_at DESC);

ALTER TABLE public.platform_brand_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_brand_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_brand_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_brand_revision_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_brand_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.platform_brand_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.platform_brand_revisions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.platform_brand_assets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.platform_brand_revision_assets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.platform_brand_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_brand_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_brand_revisions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_brand_assets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_brand_revision_assets TO service_role;
GRANT SELECT, INSERT ON public.platform_brand_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.platform_brand_events_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.reject_platform_brand_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_BRAND_REVISION_DELETE_FORBIDDEN';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
     OR NEW.revision_version IS DISTINCT FROM OLD.revision_version
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
     OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id
     OR NEW.rollback_target_id IS DISTINCT FROM OLD.rollback_target_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_BRAND_SNAPSHOT_IMMUTABLE';
  END IF;
  IF OLD.status = 'published' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_BRAND_PUBLISHED_IMMUTABLE';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'published'
     AND NEW.published_by IS NOT NULL AND NEW.published_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_BRAND_REVISION_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS platform_brand_revision_immutable ON public.platform_brand_revisions;
CREATE TRIGGER platform_brand_revision_immutable
  BEFORE UPDATE OR DELETE ON public.platform_brand_revisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_platform_brand_revision_mutation();

CREATE OR REPLACE FUNCTION public.reject_published_platform_brand_asset_map_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_revision_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.revision_id ELSE NEW.revision_id END;
  v_status text;
  v_profile_id text;
  v_asset_profile_id text;
  v_asset_purpose text;
BEGIN
  SELECT status, profile_id INTO v_status, v_profile_id
    FROM public.platform_brand_revisions WHERE id = v_revision_id;
  IF v_status = 'published' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_BRAND_PUBLISHED_ASSETS_IMMUTABLE';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT profile_id, purpose INTO v_asset_profile_id, v_asset_purpose
      FROM public.platform_brand_assets WHERE id = NEW.asset_id AND deleted_at IS NULL;
    IF v_status IS NULL OR v_asset_profile_id IS NULL
       OR v_profile_id IS DISTINCT FROM v_asset_profile_id
       OR NEW.purpose IS DISTINCT FROM v_asset_purpose THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PLATFORM_BRAND_ASSET_MAPPING_INVALID';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS platform_brand_revision_assets_immutable ON public.platform_brand_revision_assets;
CREATE TRIGGER platform_brand_revision_assets_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.platform_brand_revision_assets
  FOR EACH ROW EXECUTE FUNCTION public.reject_published_platform_brand_asset_map_mutation();

CREATE OR REPLACE FUNCTION public.reject_platform_brand_asset_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_BRAND_ASSET_DELETE_FORBIDDEN';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.bytes IS DISTINCT FROM OLD.bytes
     OR NEW.width IS DISTINCT FROM OLD.width
     OR NEW.height IS DISTINCT FROM OLD.height
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_BRAND_ASSET_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND EXISTS (
    SELECT 1
      FROM public.platform_brand_revision_assets mapping
      JOIN public.platform_brand_revisions revision ON revision.id = mapping.revision_id
     WHERE mapping.asset_id = OLD.id AND revision.status = 'published'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_BRAND_PUBLISHED_ASSET_DELETE_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS platform_brand_asset_immutable ON public.platform_brand_assets;
CREATE TRIGGER platform_brand_asset_immutable
  BEFORE UPDATE OR DELETE ON public.platform_brand_assets
  FOR EACH ROW EXECUTE FUNCTION public.reject_platform_brand_asset_mutation();

CREATE OR REPLACE FUNCTION public.reject_platform_brand_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'PLATFORM_BRAND_EVENT_IMMUTABLE';
END;
$$;

DROP TRIGGER IF EXISTS platform_brand_event_immutable ON public.platform_brand_events;
CREATE TRIGGER platform_brand_event_immutable
  BEFORE UPDATE OR DELETE ON public.platform_brand_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_platform_brand_event_mutation();

CREATE OR REPLACE FUNCTION public.save_platform_brand_draft_atomic(
  p_expected_generation bigint,
  p_snapshot jsonb,
  p_snapshot_sha256 text,
  p_actor_id uuid,
  p_request_key text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile public.platform_brand_profiles%ROWTYPE;
  v_revision public.platform_brand_revisions%ROWTYPE;
  v_next_version bigint;
  v_item record;
  v_asset public.platform_brand_assets%ROWTYPE;
BEGIN
  IF p_expected_generation < 0 OR p_actor_id IS NULL
     OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
     OR p_snapshot->>'schema' <> 'platform-brand/v1'
     OR jsonb_typeof(p_snapshot->'assetIds') IS DISTINCT FROM 'object'
     OR p_snapshot_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PLATFORM_BRAND_DRAFT_INVALID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-brand:default', 0));
  SELECT * INTO v_profile FROM public.platform_brand_profiles WHERE id = 'default' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_BRAND_PROFILE_MISSING'; END IF;
  IF v_profile.generation <> p_expected_generation THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'PLATFORM_BRAND_GENERATION_CONFLICT';
  END IF;

  FOR v_item IN SELECT key, value FROM jsonb_each_text(p_snapshot->'assetIds') LOOP
    IF v_item.key NOT IN ('logo_square', 'logo_horizontal_light', 'logo_horizontal_dark', 'favicon', 'social_share', 'login_background')
       OR v_item.value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PLATFORM_BRAND_ASSET_REFERENCE_INVALID';
    END IF;
    SELECT * INTO v_asset FROM public.platform_brand_assets
     WHERE id = v_item.value::uuid AND profile_id = 'default' AND purpose = v_item.key AND deleted_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PLATFORM_BRAND_ASSET_REFERENCE_MISSING'; END IF;
  END LOOP;

  SELECT coalesce(max(revision_version), 0) + 1 INTO v_next_version
    FROM public.platform_brand_revisions WHERE profile_id = 'default';
  INSERT INTO public.platform_brand_revisions (
    profile_id, revision_version, status, snapshot, snapshot_sha256,
    parent_revision_id, created_by
  ) VALUES (
    'default', v_next_version, 'draft', p_snapshot, p_snapshot_sha256,
    coalesce(v_profile.draft_revision_id, v_profile.published_revision_id), p_actor_id
  ) RETURNING * INTO v_revision;

  INSERT INTO public.platform_brand_revision_assets (revision_id, asset_id, purpose)
  SELECT v_revision.id, value::uuid, key FROM jsonb_each_text(p_snapshot->'assetIds');

  UPDATE public.platform_brand_profiles
     SET draft_revision_id = v_revision.id,
         generation = generation + 1,
         updated_by = p_actor_id,
         updated_at = now()
   WHERE id = 'default'
   RETURNING * INTO v_profile;

  INSERT INTO public.platform_brand_events (
    actor_id, action, result, revision_id, generation, request_key, details
  ) VALUES (
    p_actor_id, 'draft_save', 'success', v_revision.id, v_profile.generation,
    left(coalesce(p_request_key, ''), 200),
    jsonb_build_object(
      'revisionVersion', v_revision.revision_version,
      'assetCount', (SELECT count(*) FROM jsonb_object_keys(p_snapshot->'assetIds'))
    )
  );

  RETURN jsonb_build_object(
    'generation', v_profile.generation,
    'revisionId', v_revision.id,
    'revisionVersion', v_revision.revision_version,
    'status', v_revision.status,
    'snapshotSha256', v_revision.snapshot_sha256
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_platform_brand_revision_atomic(
  p_expected_generation bigint,
  p_revision_id uuid,
  p_actor_id uuid,
  p_request_key text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile public.platform_brand_profiles%ROWTYPE;
  v_revision public.platform_brand_revisions%ROWTYPE;
BEGIN
  IF p_expected_generation < 0 OR p_revision_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PLATFORM_BRAND_PUBLISH_INVALID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-brand:default', 0));
  SELECT * INTO v_profile FROM public.platform_brand_profiles WHERE id = 'default' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_BRAND_PROFILE_MISSING'; END IF;
  IF v_profile.generation <> p_expected_generation THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'PLATFORM_BRAND_GENERATION_CONFLICT';
  END IF;
  SELECT * INTO v_revision FROM public.platform_brand_revisions
   WHERE id = p_revision_id AND profile_id = 'default' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PLATFORM_BRAND_REVISION_NOT_FOUND'; END IF;
  IF v_revision.status <> 'draft' OR v_profile.draft_revision_id IS DISTINCT FROM v_revision.id THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PLATFORM_BRAND_REVISION_NOT_CURRENT_DRAFT';
  END IF;

  UPDATE public.platform_brand_revisions
     SET status = 'published', published_by = p_actor_id, published_at = now()
   WHERE id = v_revision.id
   RETURNING * INTO v_revision;
  UPDATE public.platform_brand_profiles
     SET published_revision_id = v_revision.id,
         draft_revision_id = NULL,
         generation = generation + 1,
         updated_by = p_actor_id,
         updated_at = now()
   WHERE id = 'default'
   RETURNING * INTO v_profile;
  INSERT INTO public.platform_brand_events (
    actor_id, action, result, revision_id, generation, request_key,
    details
  ) VALUES (
    p_actor_id, 'publish', 'success', v_revision.id, v_profile.generation,
    left(coalesce(p_request_key, ''), 200),
    jsonb_build_object('revisionVersion', v_revision.revision_version, 'snapshotSha256', v_revision.snapshot_sha256)
  );
  RETURN jsonb_build_object(
    'generation', v_profile.generation,
    'revisionId', v_revision.id,
    'revisionVersion', v_revision.revision_version,
    'status', v_revision.status,
    'publishedAt', v_revision.published_at,
    'snapshotSha256', v_revision.snapshot_sha256
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rollback_platform_brand_revision_atomic(
  p_expected_generation bigint,
  p_revision_id uuid,
  p_actor_id uuid,
  p_request_key text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile public.platform_brand_profiles%ROWTYPE;
  v_target public.platform_brand_revisions%ROWTYPE;
  v_revision public.platform_brand_revisions%ROWTYPE;
  v_next_version bigint;
BEGIN
  IF p_expected_generation < 0 OR p_revision_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PLATFORM_BRAND_ROLLBACK_INVALID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-brand:default', 0));
  SELECT * INTO v_profile FROM public.platform_brand_profiles WHERE id = 'default' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_BRAND_PROFILE_MISSING'; END IF;
  IF v_profile.generation <> p_expected_generation THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'PLATFORM_BRAND_GENERATION_CONFLICT';
  END IF;
  SELECT * INTO v_target FROM public.platform_brand_revisions
   WHERE id = p_revision_id AND profile_id = 'default' AND status = 'published' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PLATFORM_BRAND_ROLLBACK_TARGET_INVALID'; END IF;
  IF v_profile.published_revision_id = v_target.id THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PLATFORM_BRAND_ALREADY_CURRENT';
  END IF;

  SELECT coalesce(max(revision_version), 0) + 1 INTO v_next_version
    FROM public.platform_brand_revisions WHERE profile_id = 'default';
  INSERT INTO public.platform_brand_revisions (
    profile_id, revision_version, status, snapshot, snapshot_sha256,
    parent_revision_id, rollback_target_id, created_by
  ) VALUES (
    'default', v_next_version, 'draft', v_target.snapshot, v_target.snapshot_sha256,
    v_profile.published_revision_id, v_target.id, p_actor_id
  ) RETURNING * INTO v_revision;
  INSERT INTO public.platform_brand_revision_assets (revision_id, asset_id, purpose)
  SELECT v_revision.id, asset_id, purpose
    FROM public.platform_brand_revision_assets WHERE revision_id = v_target.id;
  UPDATE public.platform_brand_revisions
     SET status = 'published', published_by = p_actor_id, published_at = now()
   WHERE id = v_revision.id
   RETURNING * INTO v_revision;
  UPDATE public.platform_brand_profiles
     SET published_revision_id = v_revision.id,
         draft_revision_id = NULL,
         generation = generation + 1,
         updated_by = p_actor_id,
         updated_at = now()
   WHERE id = 'default'
   RETURNING * INTO v_profile;
  INSERT INTO public.platform_brand_events (
    actor_id, action, result, revision_id, generation, request_key,
    details
  ) VALUES (
    p_actor_id, 'rollback', 'success', v_revision.id, v_profile.generation,
    left(coalesce(p_request_key, ''), 200),
    jsonb_build_object(
      'revisionVersion', v_revision.revision_version,
      'rollbackTargetId', v_target.id,
      'rollbackTargetVersion', v_target.revision_version,
      'snapshotSha256', v_revision.snapshot_sha256
    )
  );
  RETURN jsonb_build_object(
    'generation', v_profile.generation,
    'revisionId', v_revision.id,
    'revisionVersion', v_revision.revision_version,
    'status', v_revision.status,
    'publishedAt', v_revision.published_at,
    'snapshotSha256', v_revision.snapshot_sha256
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.register_platform_brand_asset_atomic(
  p_purpose text,
  p_storage_provider text,
  p_storage_key text,
  p_sha256 text,
  p_mime_type text,
  p_bytes bigint,
  p_width integer,
  p_height integer,
  p_actor_id uuid,
  p_request_key text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_asset public.platform_brand_assets%ROWTYPE;
  v_generation bigint;
BEGIN
  IF p_actor_id IS NULL
     OR p_purpose NOT IN ('logo_square', 'logo_horizontal_light', 'logo_horizontal_dark', 'favicon', 'social_share', 'login_background')
     OR p_storage_provider NOT IN ('coze_s3', 'tencent_cos', 'local')
     OR length(coalesce(p_storage_key, '')) NOT BETWEEN 1 AND 1024
     OR p_storage_key ~* '^(https?:)?//'
     OR p_storage_key ~ '[?#]'
     OR p_sha256 !~ '^[a-f0-9]{64}$'
     OR p_mime_type NOT IN ('image/png', 'image/jpeg', 'image/webp')
     OR p_bytes < 1 OR p_bytes > 5242880
     OR p_width NOT BETWEEN 16 AND 8192 OR p_height NOT BETWEEN 16 AND 8192 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PLATFORM_BRAND_ASSET_INVALID';
  END IF;
  SELECT generation INTO v_generation FROM public.platform_brand_profiles WHERE id = 'default';
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_BRAND_PROFILE_MISSING'; END IF;
  INSERT INTO public.platform_brand_assets (
    profile_id, purpose, storage_provider, storage_key, sha256,
    mime_type, bytes, width, height, created_by
  ) VALUES (
    'default', p_purpose, p_storage_provider, p_storage_key, p_sha256,
    p_mime_type, p_bytes, p_width, p_height, p_actor_id
  ) RETURNING * INTO v_asset;
  INSERT INTO public.platform_brand_events (
    actor_id, action, result, asset_id, generation, request_key, details
  ) VALUES (
    p_actor_id, 'asset_upload', 'success', v_asset.id, v_generation,
    left(coalesce(p_request_key, ''), 200),
    jsonb_build_object('purpose', p_purpose, 'mimeType', p_mime_type, 'bytes', p_bytes, 'width', p_width, 'height', p_height, 'sha256', p_sha256)
  );
  RETURN jsonb_build_object(
    'id', v_asset.id, 'purpose', v_asset.purpose, 'mimeType', v_asset.mime_type,
    'bytes', v_asset.bytes, 'width', v_asset.width, 'height', v_asset.height,
    'sha256', v_asset.sha256, 'createdAt', v_asset.created_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.read_published_platform_brand()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN revision.id IS NULL THEN NULL ELSE jsonb_build_object(
    'generation', profile.generation,
    'revisionId', revision.id,
    'revisionVersion', revision.revision_version,
    'publishedAt', revision.published_at,
    'snapshotSha256', revision.snapshot_sha256,
    'snapshot', revision.snapshot,
    'assets', coalesce((
      SELECT jsonb_object_agg(mapping.purpose, jsonb_build_object(
        'id', asset.id,
        'purpose', asset.purpose,
        'mimeType', asset.mime_type,
        'bytes', asset.bytes,
        'width', asset.width,
        'height', asset.height,
        'sha256', asset.sha256
      ))
      FROM public.platform_brand_revision_assets mapping
      JOIN public.platform_brand_assets asset ON asset.id = mapping.asset_id AND asset.deleted_at IS NULL
      WHERE mapping.revision_id = revision.id
    ), '{}'::jsonb)
  ) END
  FROM public.platform_brand_profiles profile
  LEFT JOIN public.platform_brand_revisions revision
    ON revision.id = profile.published_revision_id AND revision.status = 'published'
  WHERE profile.id = 'default';
$$;

CREATE OR REPLACE FUNCTION public.read_published_platform_brand_asset(p_asset_id uuid)
RETURNS TABLE (
  id uuid,
  storage_provider text,
  storage_key text,
  sha256 text,
  mime_type text,
  bytes bigint,
  width integer,
  height integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT asset.id, asset.storage_provider, asset.storage_key, asset.sha256,
         asset.mime_type, asset.bytes, asset.width, asset.height
    FROM public.platform_brand_profiles profile
    JOIN public.platform_brand_revisions revision
      ON revision.id = profile.published_revision_id AND revision.status = 'published'
    JOIN public.platform_brand_revision_assets mapping ON mapping.revision_id = revision.id
    JOIN public.platform_brand_assets asset
      ON asset.id = mapping.asset_id AND asset.deleted_at IS NULL
   WHERE profile.id = 'default' AND asset.id = p_asset_id;
$$;

REVOKE ALL ON FUNCTION public.save_platform_brand_draft_atomic(bigint,jsonb,text,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_platform_brand_revision_atomic(bigint,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rollback_platform_brand_revision_atomic(bigint,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_platform_brand_asset_atomic(text,text,text,text,text,bigint,integer,integer,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_published_platform_brand() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_published_platform_brand_asset(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_platform_brand_draft_atomic(bigint,jsonb,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_platform_brand_revision_atomic(bigint,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rollback_platform_brand_revision_atomic(bigint,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_platform_brand_asset_atomic(text,text,text,text,text,bigint,integer,integer,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_published_platform_brand() TO service_role;
GRANT EXECUTE ON FUNCTION public.read_published_platform_brand_asset(uuid) TO service_role;
