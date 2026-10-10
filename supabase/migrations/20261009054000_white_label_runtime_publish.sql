BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- White-label runtime publication is display routing only. Host is never an
-- identity, membership, wallet, content, or other business-data authority.
ALTER TABLE public.white_label_profiles
  ADD COLUMN IF NOT EXISTS published_release_id uuid REFERENCES public.site_brand_releases(release_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS brand_generation integer NOT NULL DEFAULT 0 CHECK (brand_generation >= 0),
  ADD COLUMN IF NOT EXISTS brand_slogan text NOT NULL DEFAULT '' CHECK (char_length(brand_slogan) <= 120),
  ADD COLUMN IF NOT EXISTS brand_description text NOT NULL DEFAULT '' CHECK (char_length(brand_description) <= 500),
  ADD COLUMN IF NOT EXISTS draft_asset_ids jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(draft_asset_ids) = 'object');

UPDATE public.site_brand_releases r
   SET source_system = 'public.white_label_profiles'
  FROM public.white_label_profiles p
 WHERE r.release_id = p.brand_release_id
   AND r.release_status = 'draft';

CREATE TABLE IF NOT EXISTS public.white_label_assets (
  asset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.white_label_profiles(profile_id) ON DELETE RESTRICT,
  tenant_key text NOT NULL REFERENCES public.tenants(tenant_key) ON DELETE RESTRICT,
  site_key text NOT NULL REFERENCES public.sites(site_key) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN (
    'logo_square','logo_horizontal_light','logo_horizontal_dark','favicon',
    'social_share','login_background','contact_wechat_qr_primary','contact_wechat_qr_secondary'
  )),
  storage_provider text NOT NULL CHECK (storage_provider IN ('coze_s3','tencent_cos','local')),
  storage_key text NOT NULL CHECK (
    char_length(storage_key) BETWEEN 1 AND 1024
    AND storage_key !~ '^(https?:)?//'
    AND storage_key !~ '[?#]'
  ),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 5242880),
  width integer NOT NULL CHECK (width BETWEEN 16 AND 8192),
  height integer NOT NULL CHECK (height BETWEEN 16 AND 8192),
  created_by text NOT NULL CHECK (char_length(btrim(created_by)) BETWEEN 1 AND 200),
  request_key text NOT NULL UNIQUE CHECK (char_length(request_key) BETWEEN 8 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (profile_id, asset_id),
  FOREIGN KEY (tenant_key, site_key) REFERENCES public.sites(tenant_key, site_key) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS white_label_assets_profile_idx
  ON public.white_label_assets(profile_id, purpose, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.white_label_release_assets (
  release_id uuid NOT NULL REFERENCES public.site_brand_releases(release_id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL REFERENCES public.white_label_assets(asset_id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN (
    'logo_square','logo_horizontal_light','logo_horizontal_dark','favicon',
    'social_share','login_background','contact_wechat_qr_primary','contact_wechat_qr_secondary'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (release_id, purpose),
  UNIQUE (release_id, asset_id)
);

ALTER TABLE public.white_label_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.white_label_release_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.white_label_assets FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.white_label_release_assets FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.white_label_profile_events
  DROP CONSTRAINT IF EXISTS white_label_profile_events_action_check;
ALTER TABLE public.white_label_profile_events
  ADD CONSTRAINT white_label_profile_events_action_check
  CHECK (action IN ('draft_save','domain_verify','publish'));

CREATE OR REPLACE FUNCTION public.guard_published_white_label_release()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.source_system <> 'public.white_label_profiles' OR OLD.release_status <> 'published' THEN
    RETURN coalesce(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'WHITE_LABEL_PUBLISHED_RELEASE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.release_status = 'retired'
     AND NEW.release_id = OLD.release_id
     AND NEW.tenant_key = OLD.tenant_key
     AND NEW.site_key = OLD.site_key
     AND NEW.brand_profile_key IS NOT DISTINCT FROM OLD.brand_profile_key
     AND NEW.external_revision_id IS NOT DISTINCT FROM OLD.external_revision_id
     AND NEW.source_system = OLD.source_system
     AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
     AND NEW.evidence_uri IS NOT DISTINCT FROM OLD.evidence_uri
     AND NEW.evidence_sha256 IS NOT DISTINCT FROM OLD.evidence_sha256
     AND NEW.metadata = OLD.metadata THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'WHITE_LABEL_PUBLISHED_RELEASE_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS site_brand_white_label_published_immutable ON public.site_brand_releases;
CREATE TRIGGER site_brand_white_label_published_immutable
  BEFORE UPDATE OR DELETE ON public.site_brand_releases
  FOR EACH ROW EXECUTE FUNCTION public.guard_published_white_label_release();

CREATE OR REPLACE FUNCTION public.save_white_label_draft_v2_atomic(
  p_profile_id uuid,
  p_expected_revision integer,
  p_brand_name text,
  p_brand_short_name text,
  p_contact_name text,
  p_contact_wechat text,
  p_contact_phone text,
  p_contact_email text,
  p_requested_hostname text,
  p_ascii_hostname text,
  p_unicode_hostname text,
  p_expected_txt_name text,
  p_verification_token_hash text,
  p_verification_token_hint text,
  p_brand_slogan text,
  p_brand_description text,
  p_asset_ids jsonb,
  p_actor_id text,
  p_request_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_action text;
  v_existing_receipt jsonb;
  v_base_request_key text;
  v_receipt jsonb;
  v_profile_id uuid;
  v_asset record;
BEGIN
  IF char_length(coalesce(p_request_key,'')) NOT BETWEEN 8 AND 200
     OR char_length(coalesce(p_brand_slogan,'')) > 120
     OR char_length(coalesce(p_brand_description,'')) > 500
     OR jsonb_typeof(coalesce(p_asset_ids, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'WHITE_LABEL_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT action, receipt INTO v_existing_action, v_existing_receipt
    FROM public.white_label_profile_events WHERE request_key = p_request_key;
  IF FOUND THEN
    IF v_existing_action <> 'draft_save' THEN
      RAISE EXCEPTION 'WHITE_LABEL_IDEMPOTENCY_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing_receipt || jsonb_build_object('replayed', true);
  END IF;

  FOR v_asset IN
    SELECT entry.key AS purpose, entry.value AS asset_id
      FROM jsonb_each_text(coalesce(p_asset_ids, '{}'::jsonb)) entry
  LOOP
    IF v_asset.purpose NOT IN (
      'logo_square','logo_horizontal_light','logo_horizontal_dark','favicon',
      'social_share','login_background','contact_wechat_qr_primary','contact_wechat_qr_secondary'
    ) OR v_asset.asset_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR NOT EXISTS (
         SELECT 1 FROM public.white_label_assets a
          WHERE a.asset_id = v_asset.asset_id::uuid
            AND a.purpose = v_asset.purpose
            AND a.deleted_at IS NULL
            AND p_profile_id IS NOT NULL
            AND a.profile_id = p_profile_id
       ) THEN
      RAISE EXCEPTION 'WHITE_LABEL_ASSET_REFERENCE_INVALID' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  v_base_request_key := 'wl-base-' || encode(pg_catalog.sha256(convert_to(p_request_key, 'UTF8')), 'hex');
  v_receipt := public.save_white_label_draft_atomic(
    p_profile_id, p_expected_revision, p_brand_name, p_brand_short_name,
    p_contact_name, p_contact_wechat, p_contact_phone, p_contact_email,
    p_requested_hostname, p_ascii_hostname, p_unicode_hostname, p_expected_txt_name,
    p_verification_token_hash, p_verification_token_hint, p_actor_id, v_base_request_key
  );
  v_profile_id := (v_receipt->>'profileId')::uuid;

  UPDATE public.white_label_profiles
     SET brand_slogan = btrim(coalesce(p_brand_slogan,'')),
         brand_description = btrim(coalesce(p_brand_description,'')),
         draft_asset_ids = coalesce(p_asset_ids, '{}'::jsonb),
         lifecycle_status = CASE
           WHEN published_release_id IS NOT NULL THEN 'published'
           ELSE lifecycle_status
         END
   WHERE profile_id = v_profile_id;
  UPDATE public.site_brand_releases r
     SET source_system = 'public.white_label_profiles',
         metadata = r.metadata || jsonb_build_object(
           'brandSlogan', btrim(coalesce(p_brand_slogan,'')),
           'brandDescription', btrim(coalesce(p_brand_description,'')),
           'assetIds', coalesce(p_asset_ids, '{}'::jsonb)
         ),
         updated_at = now()
    FROM public.white_label_profiles p
   WHERE p.profile_id = v_profile_id
     AND r.release_id = p.brand_release_id
     AND r.release_status = 'draft';

  v_receipt := v_receipt || jsonb_build_object(
    'assetIds', coalesce(p_asset_ids, '{}'::jsonb),
    'replayed', false
  );
  INSERT INTO public.white_label_profile_events(profile_id, request_key, action, result, actor_id, receipt)
  VALUES (v_profile_id, p_request_key, 'draft_save', 'success', p_actor_id, v_receipt);
  RETURN v_receipt;
END;
$$;

CREATE OR REPLACE FUNCTION public.register_white_label_asset_atomic(
  p_profile_id uuid,
  p_expected_revision integer,
  p_purpose text,
  p_storage_provider text,
  p_storage_key text,
  p_sha256 text,
  p_mime_type text,
  p_bytes integer,
  p_width integer,
  p_height integer,
  p_actor_id text,
  p_request_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile public.white_label_profiles%ROWTYPE;
  v_asset_id uuid;
  v_created_at timestamptz;
  v_existing public.white_label_assets%ROWTYPE;
BEGIN
  SELECT * INTO v_existing FROM public.white_label_assets WHERE request_key = p_request_key;
  IF FOUND THEN
    IF v_existing.profile_id <> p_profile_id
       OR v_existing.purpose <> p_purpose
       OR v_existing.sha256 <> p_sha256
       OR v_existing.mime_type <> p_mime_type
       OR v_existing.bytes <> p_bytes
       OR v_existing.width <> p_width
       OR v_existing.height <> p_height THEN
      RAISE EXCEPTION 'WHITE_LABEL_IDEMPOTENCY_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'id', v_existing.asset_id, 'profileId', v_existing.profile_id, 'purpose', v_existing.purpose,
      'mimeType', v_existing.mime_type, 'bytes', v_existing.bytes, 'width', v_existing.width,
      'height', v_existing.height, 'sha256', v_existing.sha256, 'createdAt', v_existing.created_at,
      'storageKey', v_existing.storage_key, 'replayed', true
    );
  END IF;
  SELECT * INTO v_profile FROM public.white_label_profiles WHERE profile_id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WHITE_LABEL_PROFILE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_profile.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'WHITE_LABEL_REVISION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF p_purpose NOT IN (
       'logo_square','logo_horizontal_light','logo_horizontal_dark','favicon',
       'social_share','login_background','contact_wechat_qr_primary','contact_wechat_qr_secondary'
     )
     OR p_storage_provider NOT IN ('coze_s3','tencent_cos','local')
     OR char_length(coalesce(p_storage_key,'')) NOT BETWEEN 1 AND 1024
     OR p_storage_key ~ '^(https?:)?//' OR p_storage_key ~ '[?#]'
     OR p_sha256 !~ '^[a-f0-9]{64}$'
     OR p_mime_type NOT IN ('image/png','image/jpeg','image/webp')
     OR p_bytes NOT BETWEEN 1 AND 5242880
     OR p_width NOT BETWEEN 16 AND 8192 OR p_height NOT BETWEEN 16 AND 8192
     OR char_length(btrim(coalesce(p_actor_id,''))) NOT BETWEEN 1 AND 200
     OR char_length(coalesce(p_request_key,'')) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'WHITE_LABEL_ASSET_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.white_label_assets(
    profile_id, tenant_key, site_key, purpose, storage_provider, storage_key,
    sha256, mime_type, bytes, width, height, created_by, request_key
  ) VALUES (
    v_profile.profile_id, v_profile.tenant_key, v_profile.site_key, p_purpose,
    p_storage_provider, p_storage_key, p_sha256, p_mime_type,
    p_bytes, p_width, p_height, p_actor_id, p_request_key
  ) RETURNING asset_id, created_at INTO v_asset_id, v_created_at;
  RETURN jsonb_build_object(
    'id', v_asset_id, 'profileId', v_profile.profile_id, 'purpose', p_purpose,
    'mimeType', p_mime_type, 'bytes', p_bytes, 'width', p_width, 'height', p_height,
    'sha256', p_sha256, 'createdAt', v_created_at, 'storageKey', p_storage_key, 'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_white_label_draft_atomic(
  p_profile_id uuid,
  p_expected_revision integer,
  p_actor_id text,
  p_request_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile public.white_label_profiles%ROWTYPE;
  v_claim public.domain_claims%ROWTYPE;
  v_hostname public.domain_hostnames%ROWTYPE;
  v_release public.site_brand_releases%ROWTYPE;
  v_existing_action text;
  v_existing_receipt jsonb;
  v_snapshot jsonb;
  v_snapshot_sha256 text;
  v_generation integer;
  v_next_draft_id uuid;
  v_receipt jsonb;
BEGIN
  IF char_length(coalesce(p_request_key,'')) NOT BETWEEN 8 AND 200
     OR char_length(btrim(coalesce(p_actor_id,''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'WHITE_LABEL_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT action, receipt INTO v_existing_action, v_existing_receipt
    FROM public.white_label_profile_events WHERE request_key = p_request_key;
  IF FOUND THEN
    IF v_existing_action <> 'publish' THEN
      RAISE EXCEPTION 'WHITE_LABEL_IDEMPOTENCY_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing_receipt || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_profile FROM public.white_label_profiles WHERE profile_id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WHITE_LABEL_PROFILE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_profile.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'WHITE_LABEL_REVISION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO v_claim FROM public.domain_claims WHERE claim_id = v_profile.domain_claim_id FOR UPDATE;
  SELECT * INTO v_hostname FROM public.domain_hostnames WHERE claim_id = v_profile.domain_claim_id FOR UPDATE;
  SELECT * INTO v_release FROM public.site_brand_releases WHERE release_id = v_profile.brand_release_id FOR UPDATE;
  IF v_claim.claim_id IS NULL OR v_hostname.hostname_id IS NULL OR v_release.release_id IS NULL THEN
    RAISE EXCEPTION 'WHITE_LABEL_RUNTIME_LINK_MISSING' USING ERRCODE = 'P0002';
  END IF;
  IF v_claim.claim_status <> 'verified' OR v_hostname.ownership_status <> 'verified'
     OR NOT EXISTS (
       SELECT 1 FROM public.site_hostnames s
        WHERE s.hostname = v_claim.ascii_hostname
          AND s.tenant_key = v_profile.tenant_key
          AND s.site_key = v_profile.site_key
          AND s.verification_status IN ('claimed','verified')
     ) THEN
    RAISE EXCEPTION 'WHITE_LABEL_DOMAIN_NOT_VERIFIED' USING ERRCODE = '55000';
  END IF;
  IF v_release.release_status <> 'draft' OR v_release.source_system <> 'public.white_label_profiles' THEN
    RAISE EXCEPTION 'WHITE_LABEL_DRAFT_RELEASE_INVALID' USING ERRCODE = '55000';
  END IF;

  v_generation := v_profile.brand_generation + 1;
  v_snapshot := jsonb_build_object(
    'schema', 'platform-brand/v1',
    'name', v_profile.brand_name,
    'shortName', v_profile.brand_short_name,
    'slogan', v_profile.brand_slogan,
    'welcomeMessage', '',
    'description', v_profile.brand_description,
    'seo', jsonb_build_object('title', v_profile.brand_name, 'description', ''),
    'colors', jsonb_build_object('primary', '#168D7A', 'accent', '#2F80FF'),
    'contact', jsonb_build_object(
      'name', v_profile.contact_name,
      'wechat', v_profile.contact_wechat,
      'phone', v_profile.contact_phone,
      'email', v_profile.contact_email
    ),
    'assetIds', v_profile.draft_asset_ids
  );
  v_snapshot_sha256 := encode(pg_catalog.sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex');

  IF v_profile.published_release_id IS NOT NULL THEN
    UPDATE public.site_brand_releases
       SET release_status = 'retired', updated_at = now()
     WHERE release_id = v_profile.published_release_id AND release_status = 'published';
  END IF;

  UPDATE public.site_brand_releases
     SET brand_profile_key = v_profile.profile_id::text,
         external_revision_id = v_release.release_id::text,
         release_status = 'published',
         source_system = 'public.white_label_profiles',
         published_at = now(),
         evidence_uri = 'internal://white-label/publication/' || p_request_key,
         evidence_sha256 = v_snapshot_sha256,
         metadata = metadata || jsonb_build_object(
           'schemaVersion', 1,
           'generation', v_generation,
           'snapshot', v_snapshot,
           'snapshotSha256', v_snapshot_sha256,
           'hostname', v_claim.ascii_hostname
         ),
         updated_at = now()
   WHERE release_id = v_release.release_id;

  INSERT INTO public.white_label_release_assets(release_id, asset_id, purpose)
  SELECT v_release.release_id, a.asset_id, entry.key
    FROM jsonb_each_text(v_profile.draft_asset_ids) entry
    JOIN public.white_label_assets a
      ON a.asset_id = entry.value::uuid
     AND a.profile_id = v_profile.profile_id
     AND a.purpose = entry.key
     AND a.deleted_at IS NULL;

  INSERT INTO public.site_brand_releases(
    tenant_key, site_key, brand_profile_key, release_status, source_system, metadata
  ) VALUES (
    v_profile.tenant_key, v_profile.site_key, v_profile.profile_id::text,
    'draft', 'public.white_label_profiles',
    jsonb_build_object(
      'whiteLabelProfileId', v_profile.profile_id,
      'brandName', v_profile.brand_name,
      'brandShortName', v_profile.brand_short_name,
      'assetIds', v_profile.draft_asset_ids,
      'parentReleaseId', v_release.release_id
    )
  ) RETURNING release_id INTO v_next_draft_id;

  INSERT INTO public.domain_brand_release_bindings(
    hostname_id, brand_release_id, tenant_key, site_key,
    binding_status, blocked_reason, created_by
  ) VALUES (
    v_hostname.hostname_id, v_next_draft_id, v_profile.tenant_key, v_profile.site_key,
    'blocked', 'EXTERNAL_DNS_TLS_GATEWAY_REQUIRED', p_actor_id
  );

  UPDATE public.white_label_profiles
     SET published_release_id = v_release.release_id,
         brand_release_id = v_next_draft_id,
         brand_generation = v_generation,
         lifecycle_status = 'published',
         revision = revision + 1,
         updated_by = p_actor_id,
         updated_at = now()
   WHERE profile_id = v_profile.profile_id;
  UPDATE public.sites
     SET brand_scope_status = 'verified', updated_at = now()
   WHERE site_key = v_profile.site_key AND tenant_key = v_profile.tenant_key;

  v_receipt := jsonb_build_object(
    'profileId', v_profile.profile_id,
    'revision', v_profile.revision + 1,
    'generation', v_generation,
    'hostname', v_claim.ascii_hostname,
    'publishedReleaseId', v_release.release_id,
    'draftReleaseId', v_next_draft_id,
    'snapshotSha256', v_snapshot_sha256,
    'externalDnsTlsRequired', true,
    'replayed', false
  );
  INSERT INTO public.white_label_profile_events(profile_id, request_key, action, result, actor_id, receipt)
  VALUES (v_profile.profile_id, p_request_key, 'publish', 'success', p_actor_id, v_receipt);
  INSERT INTO public.domain_release_audits(
    idempotency_key, claim_id, hostname_id, actor_id, action, result, reason_code, metadata
  ) VALUES (
    left(p_request_key || ':publish', 240), v_claim.claim_id, v_hostname.hostname_id,
    p_actor_id, 'white_label_brand_published', 'recorded', 'WHITE_LABEL_BRAND_PUBLISHED',
    jsonb_build_object('profileId', v_profile.profile_id, 'releaseId', v_release.release_id, 'generation', v_generation)
  );
  RETURN v_receipt;
END;
$$;

CREATE OR REPLACE FUNCTION public.read_published_white_label_brand(p_hostname text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'source', 'white_label',
    'hostname', s.hostname,
    'tenantKey', p.tenant_key,
    'siteKey', p.site_key,
    'generation', p.brand_generation,
    'revisionId', r.release_id,
    'revisionVersion', p.brand_generation,
    'publishedAt', r.published_at,
    'snapshot', r.metadata->'snapshot',
    'snapshotSha256', r.metadata->>'snapshotSha256',
    'assets', coalesce((
      SELECT jsonb_object_agg(ra.purpose, jsonb_build_object(
        'id', a.asset_id,
        'purpose', ra.purpose,
        'mimeType', a.mime_type,
        'bytes', a.bytes,
        'width', a.width,
        'height', a.height,
        'sha256', a.sha256
      ))
      FROM public.white_label_release_assets ra
      JOIN public.white_label_assets a ON a.asset_id = ra.asset_id AND a.deleted_at IS NULL
      WHERE ra.release_id = r.release_id
    ), '{}'::jsonb)
  )
  FROM public.site_hostnames s
  JOIN public.white_label_profiles p
    ON p.tenant_key = s.tenant_key AND p.site_key = s.site_key
  JOIN public.site_brand_releases r
    ON r.release_id = p.published_release_id
   AND r.release_status = 'published'
   AND r.source_system = 'public.white_label_profiles'
  WHERE s.hostname = lower(btrim(p_hostname))
    AND s.verification_status IN ('claimed','verified')
    AND p.lifecycle_status = 'published'
    AND r.metadata->>'hostname' = s.hostname
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.read_published_white_label_asset(
  p_hostname text,
  p_release_id uuid,
  p_asset_id uuid
)
RETURNS TABLE(
  id uuid,
  release_id uuid,
  storage_provider text,
  storage_key text,
  sha256 text,
  mime_type text,
  bytes integer,
  width integer,
  height integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.asset_id, r.release_id, a.storage_provider, a.storage_key, a.sha256,
         a.mime_type, a.bytes, a.width, a.height
  FROM public.site_hostnames s
  JOIN public.white_label_profiles p
    ON p.tenant_key = s.tenant_key AND p.site_key = s.site_key
  JOIN public.site_brand_releases r
    ON r.release_id = p.published_release_id
   AND r.release_status = 'published'
   AND r.source_system = 'public.white_label_profiles'
  JOIN public.white_label_release_assets ra
    ON ra.release_id = r.release_id AND ra.asset_id = p_asset_id
  JOIN public.white_label_assets a
    ON a.asset_id = ra.asset_id AND a.purpose = ra.purpose AND a.deleted_at IS NULL
  WHERE s.hostname = lower(btrim(p_hostname))
    AND s.verification_status IN ('claimed','verified')
    AND p.lifecycle_status = 'published'
    AND r.release_id = p_release_id
    AND r.metadata->>'hostname' = s.hostname
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.read_white_label_admin_state()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'schemaVersion', 2,
    'asOf', clock_timestamp(),
    'profiles', coalesce(jsonb_agg(
      jsonb_build_object(
        'profileId', p.profile_id,
        'tenantKey', p.tenant_key,
        'siteKey', p.site_key,
        'brandName', p.brand_name,
        'brandShortName', p.brand_short_name,
        'brandSlogan', p.brand_slogan,
        'brandDescription', p.brand_description,
        'contact', jsonb_build_object('name', p.contact_name, 'wechat', p.contact_wechat, 'phone', p.contact_phone, 'email', p.contact_email),
        'draftAssetIds', p.draft_asset_ids,
        'lifecycleStatus', p.lifecycle_status,
        'revision', p.revision,
        'brandGeneration', p.brand_generation,
        'draftReleaseId', p.brand_release_id,
        'publishedReleaseId', p.published_release_id,
        'hostname', c.ascii_hostname,
        'requestedHostname', c.requested_hostname,
        'claimStatus', c.claim_status,
        'expectedTxtName', c.expected_txt_name,
        'expectedTxtValue', c.verification_token_hash,
        'ownershipStatus', h.ownership_status,
        'routingStatus', h.routing_status,
        'tlsStatus', h.tls_status,
        'httpsStatus', h.https_status,
        'brandReleaseStatus', r.release_status,
        'brandBindingStatus', b.binding_status,
        'createdAt', p.created_at,
        'updatedAt', p.updated_at
      ) ORDER BY p.updated_at DESC
    ) FILTER (WHERE p.profile_id IS NOT NULL), '[]'::jsonb)
  )
  FROM public.white_label_profiles p
  LEFT JOIN public.domain_claims c ON c.claim_id = p.domain_claim_id
  LEFT JOIN public.domain_hostnames h ON h.claim_id = c.claim_id
  LEFT JOIN public.site_brand_releases r ON r.release_id = p.brand_release_id
  LEFT JOIN public.domain_brand_release_bindings b ON b.hostname_id = h.hostname_id AND b.brand_release_id = r.release_id
$$;

REVOKE ALL ON FUNCTION public.guard_published_white_label_release() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.save_white_label_draft_v2_atomic(uuid,integer,text,text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.register_white_label_asset_atomic(uuid,integer,text,text,text,text,text,integer,integer,integer,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.publish_white_label_draft_atomic(uuid,integer,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.read_published_white_label_brand(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.read_published_white_label_asset(text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.read_white_label_admin_state() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_white_label_draft_v2_atomic(uuid,integer,text,text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_white_label_asset_atomic(uuid,integer,text,text,text,text,text,integer,integer,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_white_label_draft_atomic(uuid,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_published_white_label_brand(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_published_white_label_asset(text,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_white_label_admin_state() TO service_role;

COMMENT ON FUNCTION public.read_published_white_label_brand(text) IS
  'Exact normalized Host display-brand lookup only. It MUST NOT be used for tenant identity or business-data authorization.';
COMMENT ON TABLE public.white_label_release_assets IS
  'Immutable asset membership for a published white-label site_brand_release revision.';
COMMENT ON TABLE public.white_label_assets IS
  'Tenant/profile-owned white-label assets. They are never stored in the default platform brand asset pool.';

NOTIFY pgrst, 'reload schema';
COMMIT;
