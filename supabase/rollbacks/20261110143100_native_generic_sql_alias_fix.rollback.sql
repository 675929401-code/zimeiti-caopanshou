-- The preceding body is a known runtime failure. Never reinstall it as an
-- automatic rollback or delete an applied migration ledger row.
DO $$BEGIN RAISE EXCEPTION 'NATIVE_OFFICIAL_ALIAS_FIX_REQUIRES_REVIEWED_FORWARD_REPAIR_OR_BACKUP_RESTORE';END $$;
