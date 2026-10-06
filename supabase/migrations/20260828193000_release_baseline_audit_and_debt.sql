BEGIN;

-- These two runtime tables were referenced by production code but had no
-- checked-in migration. Keep them service-role only: neither debt ledgers nor
-- password audit history may be read or written directly by browser clients.

CREATE TABLE IF NOT EXISTS public.cash_debt_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  amount numeric(14,4) NOT NULL,
  description text NOT NULL,
  reference_id text,
  status text NOT NULL DEFAULT 'unpaid',
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  CONSTRAINT cash_debt_records_amount_check CHECK (amount > 0),
  CONSTRAINT cash_debt_records_description_check CHECK (char_length(description) BETWEEN 1 AND 2000),
  CONSTRAINT cash_debt_records_reference_check CHECK (
    reference_id IS NULL OR char_length(reference_id) BETWEEN 1 AND 240
  ),
  CONSTRAINT cash_debt_records_status_check CHECK (status IN ('unpaid', 'paid')),
  CONSTRAINT cash_debt_records_paid_state_check CHECK (
    (status = 'unpaid' AND paid_at IS NULL) OR (status = 'paid' AND paid_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS cash_debt_records_collection_idx
  ON public.cash_debt_records(user_id, status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS cash_debt_records_reference_once_idx
  ON public.cash_debt_records(user_id, reference_id)
  WHERE reference_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.password_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  action text NOT NULL,
  performed_by text,
  performed_by_role text,
  performed_by_name text,
  old_hash_prefix text,
  new_hash_prefix text,
  ip_address text,
  user_agent text,
  details text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_audit_log_user_check CHECK (char_length(user_id) BETWEEN 1 AND 200),
  CONSTRAINT password_audit_log_action_check CHECK (
    action IN ('register', 'admin_create', 'admin_update', 'admin_reset', 'self_change', 'emergency_reset')
  ),
  CONSTRAINT password_audit_log_old_prefix_check CHECK (
    old_hash_prefix IS NULL OR char_length(old_hash_prefix) <= 32
  ),
  CONSTRAINT password_audit_log_new_prefix_check CHECK (
    new_hash_prefix IS NULL OR char_length(new_hash_prefix) <= 32
  )
);

CREATE INDEX IF NOT EXISTS password_audit_log_user_created_idx
  ON public.password_audit_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS password_audit_log_action_created_idx
  ON public.password_audit_log(action, created_at DESC);

ALTER TABLE public.cash_debt_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.cash_debt_records FROM anon, authenticated;
REVOKE ALL ON TABLE public.password_audit_log FROM anon, authenticated;
GRANT ALL ON TABLE public.cash_debt_records TO service_role;
GRANT ALL ON TABLE public.password_audit_log TO service_role;

DROP POLICY IF EXISTS cash_debt_records_service_role_all ON public.cash_debt_records;
CREATE POLICY cash_debt_records_service_role_all
  ON public.cash_debt_records
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS password_audit_log_service_role_all ON public.password_audit_log;
CREATE POLICY password_audit_log_service_role_all
  ON public.password_audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
