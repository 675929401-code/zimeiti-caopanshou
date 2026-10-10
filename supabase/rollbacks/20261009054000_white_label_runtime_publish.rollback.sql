BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.white_label_profiles
     WHERE brand_generation > 0 OR draft_asset_ids <> '{}'::jsonb
  ) OR EXISTS (SELECT 1 FROM public.white_label_release_assets) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_WHITE_LABEL_RUNTIME_DATA_EXISTS';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.read_published_white_label_asset(text,uuid,uuid);
DROP FUNCTION IF EXISTS public.read_published_white_label_brand(text);
DROP FUNCTION IF EXISTS public.publish_white_label_draft_atomic(uuid,integer,text,text);
DROP FUNCTION IF EXISTS public.register_white_label_asset_atomic(uuid,integer,text,text,text,text,text,integer,integer,integer,text,text);
DROP FUNCTION IF EXISTS public.save_white_label_draft_v2_atomic(uuid,integer,text,text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb,text,text);
DROP TRIGGER IF EXISTS site_brand_white_label_published_immutable ON public.site_brand_releases;
DROP FUNCTION IF EXISTS public.guard_published_white_label_release();
DROP TABLE IF EXISTS public.white_label_release_assets;
DROP TABLE IF EXISTS public.white_label_assets;

ALTER TABLE public.white_label_profile_events
  DROP CONSTRAINT IF EXISTS white_label_profile_events_action_check;
ALTER TABLE public.white_label_profile_events
  ADD CONSTRAINT white_label_profile_events_action_check
  CHECK (action IN ('draft_save','domain_verify'));

ALTER TABLE public.white_label_profiles
  DROP COLUMN IF EXISTS draft_asset_ids,
  DROP COLUMN IF EXISTS brand_description,
  DROP COLUMN IF EXISTS brand_slogan,
  DROP COLUMN IF EXISTS brand_generation,
  DROP COLUMN IF EXISTS published_release_id;

CREATE OR REPLACE FUNCTION public.read_white_label_admin_state()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'schemaVersion', 1,
    'asOf', clock_timestamp(),
    'profiles', coalesce(jsonb_agg(
      jsonb_build_object(
        'profileId', p.profile_id,
        'tenantKey', p.tenant_key,
        'siteKey', p.site_key,
        'brandName', p.brand_name,
        'brandShortName', p.brand_short_name,
        'contact', jsonb_build_object(
          'name', p.contact_name,
          'wechat', p.contact_wechat,
          'phone', p.contact_phone,
          'email', p.contact_email
        ),
        'lifecycleStatus', p.lifecycle_status,
        'revision', p.revision,
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
  LEFT JOIN public.domain_brand_release_bindings b
    ON b.hostname_id = h.hostname_id AND b.brand_release_id = r.release_id
$$;

REVOKE ALL ON FUNCTION public.read_white_label_admin_state() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_white_label_admin_state() TO service_role;

-- source_system provenance is intentionally retained as a forward repair.
-- Reverting it to platform_brand_profiles would create a false data claim.
NOTIFY pgrst, 'reload schema';
COMMIT;
