BEGIN;

-- Compatibility-only forward repair. Reintroducing a hard pgcrypto dependency
-- would make DNS verification fail on valid PostgreSQL 15 installations, so a
-- standalone rollback intentionally keeps the built-in SHA-256 implementation.
-- Rolling back the parent 20261009051000 control plane removes the function.
DO $$ BEGIN NULL; END $$;

COMMIT;
