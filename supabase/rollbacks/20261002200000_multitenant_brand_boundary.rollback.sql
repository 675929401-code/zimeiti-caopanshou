BEGIN;
SET LOCAL lock_timeout = '10s';

-- Refuse to remove any membership, hostname, release, isolation receipt, audit,
-- tenant/site change, or integration evidence that could be real.
DO $$
DECLARE
  v_expected_resources text[] := ARRAY[
    'users-table','auth-sessions-table','payment-orders-table',
    'conversation-messages-table','user-notifications-table',
    'unified-messaging-campaigns-table','user-files-table',
    'announcements-table','platform-brand-profile','site-config-route',
    'public-branding-route','proxy-host-runtime','auth-routes','order-routes',
    'message-routes','asset-routes','announcement-routes','brand-admin-routes'
  ];
BEGIN
  IF EXISTS (SELECT 1 FROM public.tenant_members)
     OR EXISTS (SELECT 1 FROM public.site_hostnames)
     OR EXISTS (SELECT 1 FROM public.site_brand_releases)
     OR EXISTS (SELECT 1 FROM public.tenant_isolation_receipts)
     OR EXISTS (SELECT 1 FROM public.tenant_audits) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'MULTITENANT_ROLLBACK_REFUSED_EVIDENCE_EXISTS';
  END IF;

  IF (SELECT count(*) FROM public.tenants) <> 1
     OR EXISTS (
       SELECT 1 FROM public.tenants
       WHERE tenant_key <> 'default'
          OR display_name <> '当前单站点平台'
          OR lifecycle_status <> 'foundation_only'
          OR operating_mode <> 'single_tenant'
          OR boundary_status <> 'unavailable'
          OR status_reason <> 'CROSS_TENANT_ISOLATION_NOT_IMPLEMENTED'
          OR session_claim_status <> 'unavailable'
          OR business_read_scope_status <> 'unavailable'
          OR business_write_scope_status <> 'unavailable'
          OR cross_tenant_test_status <> 'not_run'
          OR isolation_verified_at IS NOT NULL
          OR isolation_evidence_uri IS NOT NULL
          OR isolation_evidence_sha256 IS NOT NULL
          OR revision <> 1
          OR metadata <> '{"fact":"current_platform_is_single_tenant","legacyRowsAttached":false}'::jsonb
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'MULTITENANT_ROLLBACK_REFUSED_TENANT_CHANGED';
  END IF;

  IF (SELECT count(*) FROM public.sites) <> 1
     OR EXISTS (
       SELECT 1 FROM public.sites
       WHERE site_key <> 'default'
          OR tenant_key <> 'default'
          OR display_name <> '当前默认站点'
          OR lifecycle_status <> 'foundation_only'
          OR is_default IS NOT TRUE
          OR routing_status <> 'unavailable'
          OR brand_scope_status <> 'unavailable'
          OR status_reason <> 'STATIC_SINGLE_SITE_ONLY'
          OR routing_verified_at IS NOT NULL
          OR routing_evidence_uri IS NOT NULL
          OR routing_evidence_sha256 IS NOT NULL
          OR revision <> 1
          OR metadata <> '{"fact":"platform_brand_profile_is_fixed_to_default","hostAuthorizationEnabled":false}'::jsonb
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'MULTITENANT_ROLLBACK_REFUSED_SITE_CHANGED';
  END IF;

  IF (SELECT count(*) FROM public.tenant_resource_integrations) <> cardinality(v_expected_resources)
     OR EXISTS (
       SELECT 1 FROM public.tenant_resource_integrations
       WHERE resource_key <> ALL(v_expected_resources)
          OR integration_status <> 'unintegrated'
          OR read_scope_status NOT IN ('unavailable','partial')
          OR write_scope_status NOT IN ('unavailable','partial')
          OR database_policy_status NOT IN ('unavailable','service_only')
          OR session_claim_status <> 'unavailable'
          OR cross_tenant_test_status <> 'not_run'
          OR verified_at IS NOT NULL
          OR evidence_uri IS NOT NULL
          OR evidence_sha256 IS NOT NULL
          OR revision <> 1
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'MULTITENANT_ROLLBACK_REFUSED_INTEGRATION_EVIDENCE_EXISTS';
  END IF;
END;
$$;

DROP TABLE public.tenant_audits;
DROP FUNCTION public.reject_tenant_audit_mutation();
DROP TABLE public.tenant_isolation_receipts;
DROP TABLE public.tenant_resource_integrations;
DROP TABLE public.site_brand_releases;
DROP TABLE public.site_hostnames;
DROP TABLE public.tenant_members;
DROP TABLE public.sites;
DROP TABLE public.tenants;
DROP FUNCTION public.bump_multitenant_record_revision();

NOTIFY pgrst, 'reload schema';
COMMIT;
