BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.domain_release_audits)
     OR EXISTS (SELECT 1 FROM public.domain_brand_release_bindings)
     OR EXISTS (SELECT 1 FROM public.domain_tls_probes)
     OR EXISTS (SELECT 1 FROM public.domain_verification_attempts)
     OR EXISTS (SELECT 1 FROM public.domain_hostnames)
     OR EXISTS (SELECT 1 FROM public.domain_claims) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_DOMAIN_RELEASE_EVIDENCE_EXISTS' USING ERRCODE = '55000';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.get_domain_tls_brand_release_status();

DROP TABLE IF EXISTS public.domain_release_audits;
DROP TABLE IF EXISTS public.domain_brand_release_bindings;
DROP TABLE IF EXISTS public.domain_tls_probes;
DROP TABLE IF EXISTS public.domain_verification_attempts;
DROP TABLE IF EXISTS public.domain_hostnames;
DROP TABLE IF EXISTS public.domain_claims;

DROP FUNCTION IF EXISTS public.reject_domain_release_evidence_mutation();
DROP FUNCTION IF EXISTS public.enforce_domain_site_tenant_consistency();
DROP FUNCTION IF EXISTS public.is_reserved_domain_ascii_hostname(text);
DROP FUNCTION IF EXISTS public.is_valid_domain_ascii_hostname(text);

COMMIT;
