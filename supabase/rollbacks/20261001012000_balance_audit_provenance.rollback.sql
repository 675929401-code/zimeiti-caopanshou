BEGIN;
DROP FUNCTION IF EXISTS public.balance_audit_source_facets();
DROP INDEX IF EXISTS public.balance_audit_log_source_created_idx;
DROP INDEX IF EXISTS public.balance_audit_log_user_created_idx;
ALTER TABLE public.balance_audit_log DROP CONSTRAINT IF EXISTS balance_audit_log_ip_address_length;
ALTER TABLE public.balance_audit_log DROP COLUMN IF EXISTS context;
ALTER TABLE public.balance_audit_log DROP COLUMN IF EXISTS ip_address;
COMMIT;
