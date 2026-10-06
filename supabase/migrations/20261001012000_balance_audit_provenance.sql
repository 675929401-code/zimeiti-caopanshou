BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.balance_audit_log
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.balance_audit_log
  DROP CONSTRAINT IF EXISTS balance_audit_log_ip_address_length;
ALTER TABLE public.balance_audit_log
  ADD CONSTRAINT balance_audit_log_ip_address_length
  CHECK (ip_address IS NULL OR (length(ip_address) BETWEEN 3 AND 64));

CREATE INDEX IF NOT EXISTS balance_audit_log_source_created_idx
  ON public.balance_audit_log (source, created_at DESC);
CREATE INDEX IF NOT EXISTS balance_audit_log_user_created_idx
  ON public.balance_audit_log (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.balance_audit_source_facets()
RETURNS TABLE(raw_source text, record_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(nullif(btrim(source), ''), 'unknown')::text, count(*)::bigint
  FROM public.balance_audit_log
  GROUP BY coalesce(nullif(btrim(source), ''), 'unknown')
  ORDER BY count(*) DESC, coalesce(nullif(btrim(source), ''), 'unknown');
$$;

REVOKE ALL ON FUNCTION public.balance_audit_source_facets() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.balance_audit_source_facets() TO service_role;

COMMENT ON COLUMN public.balance_audit_log.ip_address IS
  'IP for this exact balance-changing request when captured; never inferred from login history.';
COMMENT ON COLUMN public.balance_audit_log.context IS
  'Non-secret provenance such as request route and writer version; credentials are forbidden.';
COMMENT ON FUNCTION public.balance_audit_source_facets() IS
  'Exact raw source counts for the administrator billing audit catalogue.';

NOTIFY pgrst, 'reload schema';
COMMIT;

