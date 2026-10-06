-- Guarded teardown for an unconfigured platform-brand control plane only.
-- Once any revision, asset, or audit event exists, use a reviewed forward repair.

DO $$
BEGIN
  IF to_regclass('public.platform_brand_revisions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.platform_brand_revisions LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'PLATFORM_BRAND_ROLLBACK_REQUIRES_EMPTY_REVISIONS';
  END IF;
  IF to_regclass('public.platform_brand_assets') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.platform_brand_assets LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'PLATFORM_BRAND_ROLLBACK_REQUIRES_EMPTY_ASSETS';
  END IF;
  IF to_regclass('public.platform_brand_events') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.platform_brand_events LIMIT 1) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'PLATFORM_BRAND_ROLLBACK_REQUIRES_EMPTY_EVENTS';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS platform_settings_reject_signed_brand_url ON public.platform_settings;
DROP TRIGGER IF EXISTS platform_brand_revision_immutable ON public.platform_brand_revisions;
DROP TRIGGER IF EXISTS platform_brand_revision_assets_immutable ON public.platform_brand_revision_assets;
DROP TRIGGER IF EXISTS platform_brand_asset_immutable ON public.platform_brand_assets;
DROP TRIGGER IF EXISTS platform_brand_event_immutable ON public.platform_brand_events;

DROP FUNCTION IF EXISTS public.save_platform_brand_draft_atomic(bigint,jsonb,text,uuid,text);
DROP FUNCTION IF EXISTS public.publish_platform_brand_revision_atomic(bigint,uuid,uuid,text);
DROP FUNCTION IF EXISTS public.rollback_platform_brand_revision_atomic(bigint,uuid,uuid,text);
DROP FUNCTION IF EXISTS public.register_platform_brand_asset_atomic(text,text,text,text,text,bigint,integer,integer,uuid,text);
DROP FUNCTION IF EXISTS public.read_published_platform_brand();
DROP FUNCTION IF EXISTS public.read_published_platform_brand_asset(uuid);
DROP FUNCTION IF EXISTS public.reject_platform_brand_revision_mutation();
DROP FUNCTION IF EXISTS public.reject_published_platform_brand_asset_map_mutation();
DROP FUNCTION IF EXISTS public.reject_platform_brand_asset_mutation();
DROP FUNCTION IF EXISTS public.reject_platform_brand_event_mutation();
DROP FUNCTION IF EXISTS public.reject_signed_legacy_platform_brand_url();

ALTER TABLE IF EXISTS public.platform_brand_profiles
  DROP CONSTRAINT IF EXISTS platform_brand_profiles_draft_revision_fk;
ALTER TABLE IF EXISTS public.platform_brand_profiles
  DROP CONSTRAINT IF EXISTS platform_brand_profiles_published_revision_fk;

DROP TABLE IF EXISTS public.platform_brand_events;
DROP TABLE IF EXISTS public.platform_brand_revision_assets;
DROP TABLE IF EXISTS public.platform_brand_assets;
DROP TABLE IF EXISTS public.platform_brand_revisions;
DROP TABLE IF EXISTS public.platform_brand_profiles;

NOTIFY pgrst, 'reload schema';
