-- The obsolete v6 migration is blocked and must never have changed the database.
-- There is therefore nothing to roll back. Use the v6.1 rollback only after v6.1.
BEGIN;
DO $blocked$
BEGIN
  RAISE EXCEPTION 'Blocked obsolete rollback: v6 migration must never be executed';
END
$blocked$;
ROLLBACK;
