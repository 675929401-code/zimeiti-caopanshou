BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS public.white_label_profiles (
  profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL UNIQUE REFERENCES public.tenants(tenant_key) ON DELETE RESTRICT,
  site_key text NOT NULL UNIQUE REFERENCES public.sites(site_key) ON DELETE RESTRICT,
  domain_claim_id uuid UNIQUE REFERENCES public.domain_claims(claim_id) ON DELETE RESTRICT,
  brand_release_id uuid UNIQUE REFERENCES public.site_brand_releases(release_id) ON DELETE RESTRICT,
  brand_name text NOT NULL CHECK (char_length(btrim(brand_name)) BETWEEN 1 AND 120),
  brand_short_name text NOT NULL DEFAULT '' CHECK (char_length(brand_short_name) <= 60),
  contact_name text NOT NULL DEFAULT '' CHECK (char_length(contact_name) <= 80),
  contact_wechat text NOT NULL DEFAULT '' CHECK (char_length(contact_wechat) <= 80),
  contact_phone text NOT NULL DEFAULT '' CHECK (char_length(contact_phone) <= 40),
  contact_email text NOT NULL DEFAULT '' CHECK (char_length(contact_email) <= 254),
  lifecycle_status text NOT NULL DEFAULT 'pending_verification'
    CHECK (lifecycle_status IN ('draft','pending_verification','domain_verified','ready','published','suspended')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by text NOT NULL CHECK (char_length(btrim(created_by)) BETWEEN 1 AND 200),
  updated_by text NOT NULL CHECK (char_length(btrim(updated_by)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.white_label_profile_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES public.white_label_profiles(profile_id) ON DELETE RESTRICT,
  request_key text NOT NULL UNIQUE CHECK (char_length(request_key) BETWEEN 8 AND 200),
  action text NOT NULL CHECK (action IN ('draft_save','domain_verify')),
  result text NOT NULL CHECK (result IN ('success','failure')),
  actor_id text NOT NULL CHECK (char_length(btrim(actor_id)) BETWEEN 1 AND 200),
  receipt jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS white_label_profile_events_profile_idx
  ON public.white_label_profile_events(profile_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.reject_white_label_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'WHITE_LABEL_EVENT_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS white_label_profile_events_immutable ON public.white_label_profile_events;
CREATE TRIGGER white_label_profile_events_immutable
  BEFORE UPDATE OR DELETE ON public.white_label_profile_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_white_label_event_mutation();

ALTER TABLE public.white_label_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.white_label_profile_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.white_label_profiles FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.white_label_profile_events FROM PUBLIC, anon, authenticated, service_role;

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

CREATE OR REPLACE FUNCTION public.save_white_label_draft_atomic(
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
  v_profile_id uuid := coalesce(p_profile_id, gen_random_uuid());
  v_tenant_key text;
  v_site_key text;
  v_claim_id uuid;
  v_hostname_id uuid;
  v_release_id uuid;
  v_revision integer;
  v_receipt jsonb;
BEGIN
  IF char_length(coalesce(p_request_key,'')) NOT BETWEEN 8 AND 200
     OR char_length(btrim(coalesce(p_actor_id,''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'WHITE_LABEL_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT receipt INTO v_receipt FROM public.white_label_profile_events WHERE request_key = p_request_key;
  IF FOUND THEN RETURN v_receipt || jsonb_build_object('replayed', true); END IF;
  IF char_length(btrim(coalesce(p_brand_name,''))) NOT BETWEEN 1 AND 120
     OR char_length(coalesce(p_brand_short_name,'')) > 60
     OR char_length(coalesce(p_contact_name,'')) > 80
     OR char_length(coalesce(p_contact_wechat,'')) > 80
     OR char_length(coalesce(p_contact_phone,'')) > 40
     OR char_length(coalesce(p_contact_email,'')) > 254
     OR NOT public.is_valid_domain_ascii_hostname(p_ascii_hostname)
     OR public.is_reserved_domain_ascii_hostname(p_ascii_hostname)
     OR p_expected_txt_name <> '_zimeiti-domain-verification.' || p_ascii_hostname
     OR p_verification_token_hash !~ '^[a-f0-9]{64}$'
     OR p_verification_token_hint !~ '^[A-Za-z0-9_-]{4,12}$' THEN
    RAISE EXCEPTION 'WHITE_LABEL_DRAFT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF p_profile_id IS NULL THEN
    IF coalesce(p_expected_revision, 0) <> 0 THEN
      RAISE EXCEPTION 'WHITE_LABEL_REVISION_CONFLICT' USING ERRCODE = '40001';
    END IF;
    v_tenant_key := 'wl-' || replace(v_profile_id::text, '-', '');
    v_site_key := 'wls-' || replace(v_profile_id::text, '-', '');

    INSERT INTO public.tenants(
      tenant_key, display_name, lifecycle_status, operating_mode, boundary_status,
      status_reason, session_claim_status, business_read_scope_status,
      business_write_scope_status, cross_tenant_test_status, metadata
    ) VALUES (
      v_tenant_key, btrim(p_brand_name), 'foundation_only', 'single_tenant', 'unavailable',
      'CROSS_TENANT_ISOLATION_NOT_IMPLEMENTED', 'unavailable', 'unavailable',
      'unavailable', 'not_run', jsonb_build_object('whiteLabelProfileId', v_profile_id)
    );
    INSERT INTO public.sites(
      site_key, tenant_key, display_name, lifecycle_status, is_default,
      routing_status, brand_scope_status, status_reason, metadata
    ) VALUES (
      v_site_key, v_tenant_key, btrim(p_brand_name), 'foundation_only', false,
      'unavailable', 'linked', 'DOMAIN_RUNTIME_NOT_CONNECTED',
      jsonb_build_object('whiteLabelProfileId', v_profile_id)
    );
    INSERT INTO public.white_label_profiles(
      profile_id, tenant_key, site_key, brand_name, brand_short_name,
      contact_name, contact_wechat, contact_phone, contact_email,
      lifecycle_status, revision, created_by, updated_by
    ) VALUES (
      v_profile_id, v_tenant_key, v_site_key, btrim(p_brand_name), btrim(coalesce(p_brand_short_name,'')),
      btrim(coalesce(p_contact_name,'')), btrim(coalesce(p_contact_wechat,'')),
      btrim(coalesce(p_contact_phone,'')), btrim(coalesce(p_contact_email,'')),
      'pending_verification', 1, p_actor_id, p_actor_id
    );
    INSERT INTO public.domain_claims(
      tenant_key, site_key, requested_hostname, ascii_hostname, unicode_hostname,
      claim_kind, claim_status, verification_token_hash, verification_token_hint,
      expected_txt_name, metadata, created_by
    ) VALUES (
      v_tenant_key, v_site_key, p_requested_hostname, p_ascii_hostname, nullif(p_unicode_hostname,''),
      'custom', 'pending_verification', p_verification_token_hash, p_verification_token_hint,
      p_expected_txt_name, jsonb_build_object('whiteLabelProfileId', v_profile_id), p_actor_id
    ) RETURNING claim_id INTO v_claim_id;
    INSERT INTO public.domain_hostnames(
      claim_id, tenant_key, site_key, ascii_hostname, hostname_kind,
      lifecycle_status, ownership_status, metadata
    ) VALUES (
      v_claim_id, v_tenant_key, v_site_key, p_ascii_hostname, 'custom',
      'claimed', 'pending', jsonb_build_object('whiteLabelProfileId', v_profile_id)
    ) RETURNING hostname_id INTO v_hostname_id;
    INSERT INTO public.site_hostnames(
      hostname, site_key, tenant_key, hostname_kind, verification_status, metadata
    ) VALUES (
      p_ascii_hostname, v_site_key, v_tenant_key, 'custom', 'claimed',
      jsonb_build_object('whiteLabelProfileId', v_profile_id)
    );
    INSERT INTO public.site_brand_releases(
      tenant_key, site_key, brand_profile_key, release_status, metadata
    ) VALUES (
      v_tenant_key, v_site_key, v_profile_id::text, 'draft',
      jsonb_build_object('whiteLabelProfileId', v_profile_id, 'brandName', btrim(p_brand_name), 'brandShortName', btrim(coalesce(p_brand_short_name,'')))
    ) RETURNING release_id INTO v_release_id;
    INSERT INTO public.domain_brand_release_bindings(
      hostname_id, brand_release_id, tenant_key, site_key,
      binding_status, blocked_reason, created_by
    ) VALUES (
      v_hostname_id, v_release_id, v_tenant_key, v_site_key,
      'blocked', 'DOMAIN_RUNTIME_NOT_CONNECTED', p_actor_id
    );
    UPDATE public.white_label_profiles
    SET domain_claim_id = v_claim_id, brand_release_id = v_release_id
    WHERE profile_id = v_profile_id;
    v_revision := 1;
  ELSE
    SELECT * INTO v_profile FROM public.white_label_profiles WHERE profile_id = p_profile_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'WHITE_LABEL_PROFILE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
    IF v_profile.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'WHITE_LABEL_REVISION_CONFLICT' USING ERRCODE = '40001';
    END IF;
    SELECT * INTO v_claim FROM public.domain_claims WHERE claim_id = v_profile.domain_claim_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'WHITE_LABEL_DOMAIN_CLAIM_MISSING' USING ERRCODE = 'P0002'; END IF;
    IF v_claim.ascii_hostname <> p_ascii_hostname THEN
      IF v_claim.claim_status = 'verified' THEN
        RAISE EXCEPTION 'WHITE_LABEL_VERIFIED_DOMAIN_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      UPDATE public.domain_claims SET
        requested_hostname = p_requested_hostname,
        ascii_hostname = p_ascii_hostname,
        unicode_hostname = nullif(p_unicode_hostname,''),
        claim_status = 'pending_verification',
        verification_token_hash = p_verification_token_hash,
        verification_token_hint = p_verification_token_hint,
        expected_txt_name = p_expected_txt_name,
        ownership_verified_at = NULL,
        ownership_evidence_sha256 = NULL,
        updated_at = now()
      WHERE claim_id = v_claim.claim_id;
      UPDATE public.domain_hostnames SET
        ascii_hostname = p_ascii_hostname,
        lifecycle_status = 'claimed', ownership_status = 'pending',
        routing_status = 'unavailable', tls_status = 'unavailable', https_status = 'unavailable',
        ownership_verified_at = NULL, routing_verified_at = NULL,
        tls_not_before = NULL, tls_not_after = NULL, https_verified_at = NULL,
        latest_evidence_sha256 = NULL, updated_at = now()
      WHERE claim_id = v_claim.claim_id;
      UPDATE public.site_hostnames SET
        hostname = p_ascii_hostname, verification_status = 'claimed',
        verified_at = NULL, ownership_evidence_uri = NULL,
        ownership_evidence_sha256 = NULL, tls_evidence_uri = NULL, updated_at = now()
      WHERE tenant_key = v_profile.tenant_key AND site_key = v_profile.site_key;
    END IF;
    v_revision := v_profile.revision + 1;
    UPDATE public.white_label_profiles SET
      brand_name = btrim(p_brand_name),
      brand_short_name = btrim(coalesce(p_brand_short_name,'')),
      contact_name = btrim(coalesce(p_contact_name,'')),
      contact_wechat = btrim(coalesce(p_contact_wechat,'')),
      contact_phone = btrim(coalesce(p_contact_phone,'')),
      contact_email = btrim(coalesce(p_contact_email,'')),
      lifecycle_status = CASE WHEN v_claim.claim_status = 'verified' THEN 'domain_verified' ELSE 'pending_verification' END,
      revision = v_revision, updated_by = p_actor_id, updated_at = now()
    WHERE profile_id = v_profile.profile_id;
    UPDATE public.tenants SET display_name = btrim(p_brand_name), updated_at = now()
      WHERE tenant_key = v_profile.tenant_key;
    UPDATE public.sites SET display_name = btrim(p_brand_name), updated_at = now()
      WHERE site_key = v_profile.site_key;
    UPDATE public.site_brand_releases SET
      metadata = metadata || jsonb_build_object('brandName', btrim(p_brand_name), 'brandShortName', btrim(coalesce(p_brand_short_name,''))),
      updated_at = now()
      WHERE release_id = v_profile.brand_release_id;
    v_profile_id := v_profile.profile_id;
    v_claim_id := v_profile.domain_claim_id;
  END IF;

  SELECT jsonb_build_object(
    'profileId', p.profile_id,
    'revision', p.revision,
    'lifecycleStatus', p.lifecycle_status,
    'hostname', c.ascii_hostname,
    'expectedTxtName', c.expected_txt_name,
    'expectedTxtValue', c.verification_token_hash,
    'replayed', false
  ) INTO v_receipt
  FROM public.white_label_profiles p
  JOIN public.domain_claims c ON c.claim_id = p.domain_claim_id
  WHERE p.profile_id = v_profile_id;

  INSERT INTO public.white_label_profile_events(profile_id, request_key, action, result, actor_id, receipt)
  VALUES (v_profile_id, p_request_key, 'draft_save', 'success', p_actor_id, v_receipt);
  INSERT INTO public.domain_release_audits(
    idempotency_key, claim_id, actor_id, action, result, reason_code, metadata
  ) VALUES (
    left(p_request_key || ':domain', 240), v_claim_id, p_actor_id,
    'white_label_draft_saved', 'recorded', 'WHITE_LABEL_DRAFT_SAVED',
    jsonb_build_object('profileId', v_profile_id, 'revision', v_revision)
  );
  RETURN v_receipt;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_white_label_domain_verification(
  p_profile_id uuid,
  p_expected_revision integer,
  p_passed boolean,
  p_observed_values_hash text,
  p_evidence_sha256 text,
  p_resolver_name text,
  p_error_code text,
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
  v_receipt jsonb;
  v_revision integer;
BEGIN
  IF char_length(coalesce(p_request_key,'')) NOT BETWEEN 8 AND 200
     OR p_observed_values_hash !~ '^[a-f0-9]{64}$'
     OR p_evidence_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'WHITE_LABEL_VERIFICATION_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT receipt INTO v_receipt FROM public.white_label_profile_events WHERE request_key = p_request_key;
  IF FOUND THEN RETURN v_receipt || jsonb_build_object('replayed', true); END IF;
  SELECT * INTO v_profile FROM public.white_label_profiles WHERE profile_id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WHITE_LABEL_PROFILE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_profile.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'WHITE_LABEL_REVISION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO v_claim FROM public.domain_claims WHERE claim_id = v_profile.domain_claim_id FOR UPDATE;
  SELECT * INTO v_hostname FROM public.domain_hostnames WHERE claim_id = v_profile.domain_claim_id FOR UPDATE;
  IF v_claim.claim_id IS NULL OR v_hostname.hostname_id IS NULL THEN
    RAISE EXCEPTION 'WHITE_LABEL_DOMAIN_CLAIM_MISSING' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.domain_verification_attempts(
    claim_id, hostname_id, idempotency_key, attempt_kind, attempt_status,
    expected_record_name, expected_value_hash, observed_values_hash,
    resolver_name, attempted_at, completed_at, error_code, evidence_sha256, details
  ) VALUES (
    v_claim.claim_id, v_hostname.hostname_id, p_request_key, 'txt_ownership',
    CASE WHEN p_passed THEN 'passed' ELSE 'failed' END,
    v_claim.expected_txt_name,
    encode(digest('zimeiti-verification=' || v_claim.verification_token_hash, 'sha256'), 'hex'),
    p_observed_values_hash, nullif(btrim(coalesce(p_resolver_name,'')),''),
    now(), now(), CASE WHEN p_passed THEN NULL ELSE coalesce(nullif(p_error_code,''),'DNS_VALUE_MISMATCH') END,
    p_evidence_sha256, jsonb_build_object('observedValueCountRedacted', true)
  );
  UPDATE public.domain_claims SET
    claim_status = CASE WHEN p_passed THEN 'verified' ELSE 'pending_verification' END,
    ownership_verified_at = CASE WHEN p_passed THEN now() ELSE NULL END,
    ownership_evidence_sha256 = CASE WHEN p_passed THEN p_evidence_sha256 ELSE NULL END,
    updated_at = now()
  WHERE claim_id = v_claim.claim_id;
  UPDATE public.domain_hostnames SET
    lifecycle_status = CASE WHEN p_passed THEN 'dns_verified' ELSE 'claimed' END,
    ownership_status = CASE WHEN p_passed THEN 'verified' ELSE 'failed' END,
    ownership_verified_at = CASE WHEN p_passed THEN now() ELSE NULL END,
    latest_evidence_sha256 = p_evidence_sha256,
    updated_at = now()
  WHERE hostname_id = v_hostname.hostname_id;
  UPDATE public.site_hostnames SET
    -- This legacy aggregate status also requires real TLS evidence.  DNS
    -- ownership alone therefore remains "claimed" and must not masquerade as
    -- a fully verified/routable hostname.
    verification_status = CASE WHEN p_passed THEN 'claimed' ELSE 'failed' END,
    verified_at = NULL,
    ownership_evidence_uri = CASE WHEN p_passed THEN 'internal://white-label/dns-verification/' || p_request_key ELSE NULL END,
    ownership_evidence_sha256 = CASE WHEN p_passed THEN p_evidence_sha256 ELSE NULL END,
    tls_evidence_uri = NULL,
    updated_at = now()
  WHERE tenant_key = v_profile.tenant_key AND site_key = v_profile.site_key;
  v_revision := v_profile.revision + 1;
  UPDATE public.white_label_profiles SET
    lifecycle_status = CASE WHEN p_passed THEN 'domain_verified' ELSE 'pending_verification' END,
    revision = v_revision, updated_by = p_actor_id, updated_at = now()
  WHERE profile_id = v_profile.profile_id;

  v_receipt := jsonb_build_object(
    'profileId', v_profile.profile_id,
    'revision', v_revision,
    'verified', p_passed,
    'hostname', v_claim.ascii_hostname,
    'replayed', false
  );
  INSERT INTO public.white_label_profile_events(profile_id, request_key, action, result, actor_id, receipt)
  VALUES (v_profile.profile_id, p_request_key, 'domain_verify', CASE WHEN p_passed THEN 'success' ELSE 'failure' END, p_actor_id, v_receipt);
  INSERT INTO public.domain_release_audits(
    idempotency_key, claim_id, hostname_id, actor_id, action, result, reason_code, metadata
  ) VALUES (
    left(p_request_key || ':audit', 240), v_claim.claim_id, v_hostname.hostname_id,
    p_actor_id, 'white_label_dns_verification',
    CASE WHEN p_passed THEN 'recorded' ELSE 'failed' END,
    CASE WHEN p_passed THEN 'DNS_OWNERSHIP_VERIFIED' ELSE 'DNS_OWNERSHIP_NOT_VERIFIED' END,
    jsonb_build_object('profileId', v_profile.profile_id, 'revision', v_revision)
  );
  RETURN v_receipt;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_white_label_event_mutation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.read_white_label_admin_state() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.save_white_label_draft_atomic(uuid,integer,text,text,text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_white_label_domain_verification(uuid,integer,boolean,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_white_label_admin_state() TO service_role;
GRANT EXECUTE ON FUNCTION public.save_white_label_draft_atomic(uuid,integer,text,text,text,text,text,text,text,text,text,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_white_label_domain_verification(uuid,integer,boolean,text,text,text,text,text,text) TO service_role;

COMMENT ON TABLE public.white_label_profiles IS 'Saved white-label customer, brand contact and domain-onboarding drafts. A saved draft is not proof of live routing.';
COMMENT ON FUNCTION public.read_white_label_admin_state() IS 'Admin-only read model; exposed through a separately authorized server route.';

NOTIFY pgrst, 'reload schema';
COMMIT;
