BEGIN;

-- No schema is changed by the forward migration. A rollback only refreshes
-- the current cache again after the surrounding release rollback completes.
NOTIFY pgrst, 'reload schema';

COMMIT;
