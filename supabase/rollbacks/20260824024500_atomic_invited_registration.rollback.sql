-- Manual structural rollback for
-- 20260824024500_atomic_invited_registration.sql.
-- This script does not delete invitation or user rows. It removes only the
-- server RPCs and the two uniqueness indexes introduced by the migration.

BEGIN;

DROP FUNCTION IF EXISTS public.register_invited_user_atomic(
  text, text, text, text, text, text, text
);
DROP FUNCTION IF EXISTS public.get_or_create_permanent_invitation_code(uuid);

-- No dependency override: an unknown dependency must abort for review.
DROP INDEX IF EXISTS public.invitation_codes_one_permanent_per_user;
DROP INDEX IF EXISTS public.invitation_codes_unique_normalized_code;

NOTIFY pgrst, 'reload schema';

COMMIT;
