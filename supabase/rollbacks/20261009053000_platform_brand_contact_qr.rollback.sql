BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $rollback_guard$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.platform_brand_revisions
     WHERE snapshot ? 'contact'
        OR coalesce(snapshot->'assetIds', '{}'::jsonb) ?| ARRAY[
          'contact_wechat_qr_primary', 'contact_wechat_qr_secondary'
        ]
  ) OR EXISTS (
    SELECT 1
      FROM public.platform_brand_assets
     WHERE purpose IN ('contact_wechat_qr_primary', 'contact_wechat_qr_secondary')
  ) OR EXISTS (
    SELECT 1
      FROM public.platform_brand_revision_assets
     WHERE purpose IN ('contact_wechat_qr_primary', 'contact_wechat_qr_secondary')
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_PLATFORM_BRAND_CONTACT_QR_DATA_EXISTS'
      USING ERRCODE = '55000';
  END IF;
END
$rollback_guard$;

ALTER TABLE public.platform_brand_revisions
  DROP CONSTRAINT IF EXISTS platform_brand_revisions_snapshot_check;
ALTER TABLE public.platform_brand_revisions
  ADD CONSTRAINT platform_brand_revisions_snapshot_check CHECK (
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
  );

ALTER TABLE public.platform_brand_assets
  DROP CONSTRAINT IF EXISTS platform_brand_assets_purpose_check;
ALTER TABLE public.platform_brand_assets
  ADD CONSTRAINT platform_brand_assets_purpose_check CHECK (purpose IN (
    'logo_square', 'logo_horizontal_light', 'logo_horizontal_dark',
    'favicon', 'social_share', 'login_background'
  ));

ALTER TABLE public.platform_brand_revision_assets
  DROP CONSTRAINT IF EXISTS platform_brand_revision_assets_purpose_check;
ALTER TABLE public.platform_brand_revision_assets
  ADD CONSTRAINT platform_brand_revision_assets_purpose_check CHECK (purpose IN (
    'logo_square', 'logo_horizontal_light', 'logo_horizontal_dark',
    'favicon', 'social_share', 'login_background'
  ));

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
    IF v_item.key NOT IN (
         'logo_square', 'logo_horizontal_light', 'logo_horizontal_dark',
         'favicon', 'social_share', 'login_background'
       )
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
     OR p_purpose NOT IN (
       'logo_square', 'logo_horizontal_light', 'logo_horizontal_dark',
       'favicon', 'social_share', 'login_background'
     )
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
    jsonb_build_object(
      'purpose', p_purpose,
      'mimeType', p_mime_type,
      'bytes', p_bytes,
      'width', p_width,
      'height', p_height,
      'sha256', p_sha256
    )
  );
  RETURN jsonb_build_object(
    'id', v_asset.id,
    'purpose', v_asset.purpose,
    'mimeType', v_asset.mime_type,
    'bytes', v_asset.bytes,
    'width', v_asset.width,
    'height', v_asset.height,
    'sha256', v_asset.sha256,
    'createdAt', v_asset.created_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_platform_brand_draft_atomic(bigint,jsonb,text,uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_platform_brand_asset_atomic(text,text,text,text,text,bigint,integer,integer,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_platform_brand_draft_atomic(bigint,jsonb,text,uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.register_platform_brand_asset_atomic(text,text,text,text,text,bigint,integer,integer,uuid,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
