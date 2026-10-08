-- Reconcile server-only RPC grants and remove accidental client execution
-- privileges after schema-only/data-only imports.

BEGIN;

-- Only the five-argument CAS endpoint is valid. The old overload bypasses
-- the expected-current and expected-manifest checks.
DROP FUNCTION IF EXISTS public.publish_commerce_config_release_atomic(uuid, uuid);

REVOKE ALL ON FUNCTION public.publish_commerce_config_release_atomic(uuid, uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_commerce_config_release_atomic(uuid, uuid, text, uuid, text)
  TO service_role;

-- These RPCs are server-only entry points. Some imported databases retained
-- their definitions but lost the corresponding service-role grants.
REVOKE ALL ON FUNCTION public.claim_payment_order_creation_atomic(uuid, text, text, text, text, numeric, integer, text, text, timestamptz, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment_order_creation_atomic(uuid, text, text, text, text, numeric, integer, text, text, timestamptz, text, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.mark_payment_order_creation_provider_started_atomic(text, text, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_payment_order_creation_provider_started_atomic(text, text, text, bigint)
  TO service_role;

REVOKE ALL ON FUNCTION public.finalize_payment_order_creation_atomic(text, text, text, bigint, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_payment_order_creation_atomic(text, text, text, bigint, text, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.mark_payment_order_creation_reconciliation_atomic(text, text, text, bigint, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_payment_order_creation_reconciliation_atomic(text, text, text, bigint, text, text, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.ingest_external_site_monitor_probe(text, text, text, text, text, text, text, text, timestamptz, timestamptz, text, integer, timestamptz, timestamptz, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_external_site_monitor_probe(text, text, text, text, text, text, text, text, timestamptz, timestamptz, text, integer, timestamptz, timestamptz, text, text, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.get_external_site_monitor_status(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_external_site_monitor_status(integer)
  TO service_role;

-- Trigger helpers are not client RPCs. Revoke accidental default EXECUTE
-- grants consistently, including helpers that predate the explicit policy.
DO $block$
DECLARE
  trigger_function regprocedure;
BEGIN
  FOR trigger_function IN
    SELECT p.oid::regprocedure
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prorettype = 'trigger'::regtype
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      trigger_function
    );
  END LOOP;
END
$block$;

-- Prevent newly created functions owned by the migration role from silently
-- becoming public RPCs. Explicit GRANT statements remain required.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;
