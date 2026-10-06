BEGIN;

-- The local REST process can survive a database migration. Explicitly reload
-- PostgREST so the newly-created maintenance-lock RPCs become callable without
-- restarting or weakening the API fallback behavior.
NOTIFY pgrst, 'reload schema';

COMMIT;
