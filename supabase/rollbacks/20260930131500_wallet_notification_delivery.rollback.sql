BEGIN;
DROP FUNCTION IF EXISTS public.enqueue_user_notification_once(text, text, text, text, text, jsonb);
DROP INDEX IF EXISTS public.user_notifications_dedupe_key_unique;
NOTIFY pgrst, 'reload schema';
COMMIT;
