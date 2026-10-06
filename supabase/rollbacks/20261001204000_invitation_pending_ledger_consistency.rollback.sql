BEGIN;

DROP TRIGGER IF EXISTS member_package_assignments_sync_invitation_welcome
  ON public.member_package_assignments;
DROP FUNCTION IF EXISTS public.sync_invitation_welcome_reward_from_package_assignment();

-- Intentionally keep reconciled sent receipts. Reverting truthful package
-- delivery history would corrupt wallets, notifications, and the audit trail.

COMMIT;
