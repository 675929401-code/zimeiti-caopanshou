BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

UPDATE public.admin_permission_catalog
SET dependency_keys = '["billing.view"]'::jsonb,
    updated_at = now()
WHERE permission_key = 'wallet.adjust';

-- Profiles keep any already granted members.view capability. Removing it here
-- could revoke an independently assigned permission without reliable history.
-- A later explicit access-profile edit can remove it under the prior policy.

COMMIT;
