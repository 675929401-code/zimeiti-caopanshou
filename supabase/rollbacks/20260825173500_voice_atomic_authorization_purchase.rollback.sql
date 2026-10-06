-- Manual destructive rollback for 20260825173500_voice_atomic_authorization_purchase.sql.
-- Run only after disabling Voice Studio writes and taking a database backup.

REVOKE EXECUTE ON FUNCTION public.purchase_voice_nest_slots_atomic(text, integer, text)
  FROM service_role;
REVOKE EXECUTE ON FUNCTION public.reserve_voice_training_authorization_atomic(text, text, text, text)
  FROM service_role;
REVOKE EXECUTE ON FUNCTION public.release_voice_training_authorization_atomic(text, text, text, text, text)
  FROM service_role;
REVOKE EXECUTE ON FUNCTION public.finalize_voice_training_authorization_atomic(text, text, text, text, text, text, text, jsonb, jsonb)
  FROM service_role;

DROP FUNCTION IF EXISTS public.finalize_voice_training_authorization_atomic(text, text, text, text, text, text, text, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.release_voice_training_authorization_atomic(text, text, text, text, text);
DROP FUNCTION IF EXISTS public.reserve_voice_training_authorization_atomic(text, text, text, text);
DROP FUNCTION IF EXISTS public.purchase_voice_nest_slots_atomic(text, integer, text);

DROP TABLE IF EXISTS public.voice_training_authorization_jobs;
DROP TABLE IF EXISTS public.voice_nest_purchase_requests;
DROP TABLE IF EXISTS public.voice_nest_price_versions;

-- Legacy voice_nest_slots, voice_clone_licenses and user_voices are retained:
-- they may predate this migration and contain user data.  The additive
-- compatibility columns are harmless when the atomic feature is disabled.

NOTIFY pgrst, 'reload schema';
