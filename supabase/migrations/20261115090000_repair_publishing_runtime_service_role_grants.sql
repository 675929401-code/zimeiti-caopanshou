-- 20261115090000_repair_publishing_runtime_service_role_grants.sql
-- The publishing v3 auth path invokes SECURITY DEFINER RPCs whose trigger
-- functions run as the PostgREST service_role. The cash-reference trigger reads
-- pub_cash_admissions, which was owned by zimeiti_owner without a service_role
-- grant, so official Douyin authorization returned
-- PUBLISH_API_SERVICE_UNAVAILABLE before the provider session could start.
--
-- Grant only this server-side runtime table. anon/authenticated receive nothing.
BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pub_cash_admissions TO service_role;

COMMIT;
