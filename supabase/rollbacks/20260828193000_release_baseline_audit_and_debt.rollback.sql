BEGIN;

-- Destructive rollback: use only after an application rollback and an
-- explicit backup/retention decision for debt and security audit records.
DROP TABLE IF EXISTS public.password_audit_log;
DROP TABLE IF EXISTS public.cash_debt_records;

COMMIT;
