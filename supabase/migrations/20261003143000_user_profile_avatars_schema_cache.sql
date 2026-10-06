BEGIN;

-- PostgREST may keep the pre-migration schema cached while the service remains
-- online. Publishing this notification makes the avatar table available to
-- the service-role API without requiring a database restart.
NOTIFY pgrst, 'reload schema';

COMMIT;
