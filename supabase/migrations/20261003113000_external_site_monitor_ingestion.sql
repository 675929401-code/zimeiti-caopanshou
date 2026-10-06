BEGIN;
SET LOCAL lock_timeout = '10s';

-- Extends the existing append-only domain/TLS evidence control plane with a
-- signed external-probe receiver. This migration does not schedule a worker,
-- make an outbound request, alter DNS/TLS, or activate a hostname.

CREATE OR REPLACE FUNCTION public.ingest_external_site_monitor_probe(
  p_hostname text,
  p_idempotency_key text,
  p_probe_run_id text,
  p_scheduler_id text,
  p_key_id text,
  p_probe_status text,
  p_certificate_fingerprint_sha256 text,
  p_san_set_sha256 text,
  p_certificate_not_before timestamptz,
  p_certificate_not_after timestamptz,
  p_negotiated_protocol text,
  p_http_status integer,
  p_attempted_at timestamptz,
  p_completed_at timestamptz,
  p_error_code text,
  p_evidence_sha256 text,
  p_details jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hostname public.domain_hostnames%ROWTYPE;
  v_existing public.domain_tls_probes%ROWTYPE;
  v_probe_id uuid;
  v_received_at timestamptz;
BEGIN
  IF p_hostname IS NULL OR NOT public.is_valid_domain_ascii_hostname(p_hostname)
     OR public.is_reserved_domain_ascii_hostname(p_hostname) THEN
    RAISE EXCEPTION 'EXTERNAL_SITE_MONITOR_HOSTNAME_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'EXTERNAL_SITE_MONITOR_IDEMPOTENCY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_probe_run_id IS NULL OR char_length(p_probe_run_id) NOT BETWEEN 8 AND 100
     OR p_scheduler_id IS NULL OR char_length(p_scheduler_id) NOT BETWEEN 3 AND 100
     OR p_key_id IS NULL OR char_length(p_key_id) NOT BETWEEN 3 AND 100 THEN
    RAISE EXCEPTION 'EXTERNAL_SITE_MONITOR_IDENTITY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_probe_status NOT IN ('passed','failed') THEN
    RAISE EXCEPTION 'EXTERNAL_SITE_MONITOR_STATUS_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_attempted_at IS NULL OR p_completed_at IS NULL OR p_completed_at < p_attempted_at
     OR p_completed_at - p_attempted_at > interval '5 minutes' THEN
    RAISE EXCEPTION 'EXTERNAL_SITE_MONITOR_WINDOW_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_evidence_sha256 IS NULL OR p_evidence_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'EXTERNAL_SITE_MONITOR_EVIDENCE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_details IS NULL OR jsonb_typeof(p_details) <> 'object'
     OR p_details->>'monitorKind' <> 'external_site_monitor'
     OR p_details->>'contractVersion' <> '1'
     OR p_details->'payload'->'vantage'->>'kind' <> 'external'
     OR p_details->'payload'->'target'->>'hostname' <> p_hostname
     OR p_details->'payload'->>'schedulerId' <> p_scheduler_id
     OR p_details->'payload'->>'probeRunId' <> p_probe_run_id
     OR p_details->'payload'->>'evidenceSha256' <> p_evidence_sha256
     OR octet_length(p_details::text) > 65536 THEN
    RAISE EXCEPTION 'EXTERNAL_SITE_MONITOR_DETAILS_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_hostname
    FROM public.domain_hostnames
   WHERE ascii_hostname = p_hostname
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXTERNAL_SITE_MONITOR_HOSTNAME_NOT_REGISTERED' USING ERRCODE = '23503';
  END IF;

  SELECT * INTO v_existing
    FROM public.domain_tls_probes
   WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.hostname_id <> v_hostname.hostname_id
       OR v_existing.evidence_sha256 IS DISTINCT FROM p_evidence_sha256 THEN
      RAISE EXCEPTION 'EXTERNAL_SITE_MONITOR_REPLAY_COLLISION' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'accepted', true,
      'duplicate', true,
      'probeId', v_existing.probe_id,
      'receivedAt', v_existing.created_at
    );
  END IF;

  INSERT INTO public.domain_tls_probes (
    hostname_id,
    idempotency_key,
    probe_kind,
    probe_status,
    certificate_fingerprint_sha256,
    san_set_sha256,
    certificate_not_before,
    certificate_not_after,
    negotiated_protocol,
    http_status,
    attempted_at,
    completed_at,
    error_code,
    evidence_sha256,
    details
  ) VALUES (
    v_hostname.hostname_id,
    p_idempotency_key,
    'https_get',
    p_probe_status,
    p_certificate_fingerprint_sha256,
    p_san_set_sha256,
    p_certificate_not_before,
    p_certificate_not_after,
    p_negotiated_protocol,
    p_http_status,
    p_attempted_at,
    p_completed_at,
    p_error_code,
    p_evidence_sha256,
    p_details
  )
  RETURNING probe_id, created_at INTO v_probe_id, v_received_at;

  INSERT INTO public.domain_release_audits (
    idempotency_key,
    hostname_id,
    actor_id,
    action,
    result,
    reason_code,
    metadata,
    occurred_at
  ) VALUES (
    'external-monitor-audit:' || p_idempotency_key,
    v_hostname.hostname_id,
    'external-probe:' || p_key_id,
    'external_site_monitor_probe_ingested',
    'recorded',
    CASE WHEN p_probe_status = 'passed' THEN 'EXTERNAL_SITE_MONITOR_SAMPLE_RECORDED' ELSE 'EXTERNAL_SITE_MONITOR_FAILURE_RECORDED' END,
    jsonb_build_object(
      'probeId', v_probe_id,
      'probeRunId', p_probe_run_id,
      'schedulerId', p_scheduler_id,
      'evidenceSha256', p_evidence_sha256
    ),
    p_completed_at
  );

  RETURN jsonb_build_object(
    'accepted', true,
    'duplicate', false,
    'probeId', v_probe_id,
    'receivedAt', v_received_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_external_site_monitor_status(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 100));
  v_hostnames jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(to_jsonb(rows) ORDER BY rows.hostname), '[]'::jsonb)
    INTO v_hostnames
    FROM (
      SELECT
        h.ascii_hostname AS hostname,
        h.tenant_key AS "tenantKey",
        h.site_key AS "siteKey",
        CASE WHEN latest.probe_id IS NULL THEN NULL ELSE jsonb_build_object(
          'probeId', latest.probe_id,
          'probeStatus', latest.probe_status,
          'attemptedAt', latest.attempted_at,
          'completedAt', latest.completed_at,
          'receivedAt', latest.created_at,
          'evidenceSha256', latest.evidence_sha256,
          'details', latest.details
        ) END AS "latestProbe"
      FROM public.domain_hostnames h
      LEFT JOIN LATERAL (
        SELECT p.*
          FROM public.domain_tls_probes p
         WHERE p.hostname_id = h.hostname_id
           AND p.details->>'monitorKind' = 'external_site_monitor'
         ORDER BY p.completed_at DESC NULLS LAST, p.created_at DESC, p.probe_id DESC
         LIMIT 1
      ) latest ON true
      ORDER BY h.ascii_hostname
      LIMIT v_limit
    ) rows;

  RETURN jsonb_build_object(
    'schemaVersion', 1,
    'migration', '20261003113000',
    'asOf', clock_timestamp(),
    'scope', 'external_vantage_only',
    'hostnameCount', (SELECT count(*) FROM public.domain_hostnames),
    'externalProbeCount', (
      SELECT count(*) FROM public.domain_tls_probes p
       WHERE p.details->>'monitorKind' = 'external_site_monitor'
    ),
    'hostnames', v_hostnames
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_external_site_monitor_probe(
  text,text,text,text,text,text,text,text,timestamptz,timestamptz,text,integer,timestamptz,timestamptz,text,text,jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_external_site_monitor_status(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ingest_external_site_monitor_probe(
  text,text,text,text,text,text,text,text,timestamptz,timestamptz,text,integer,timestamptz,timestamptz,text,text,jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_external_site_monitor_status(integer) TO service_role;

COMMENT ON FUNCTION public.ingest_external_site_monitor_probe(
  text,text,text,text,text,text,text,text,timestamptz,timestamptz,text,integer,timestamptz,timestamptz,text,text,jsonb
) IS 'Service-role-only append of HMAC-authenticated external site evidence. The HTTP receiver verifies HMAC, timestamp, nonce and payload digest before invoking this function.';
COMMENT ON FUNCTION public.get_external_site_monitor_status(integer)
  IS 'Bounded read model for external-vantage site monitoring. It performs no network checks.';

NOTIFY pgrst, 'reload schema';
COMMIT;
