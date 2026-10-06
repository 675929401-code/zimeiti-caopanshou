# Database migration and rollback operations

`supabase/migrations/` is forward-only and may be scanned automatically by a
Supabase-compatible migration runner. Never place `rollback`, `down`, backup,
scratch, or duplicate-timestamp SQL files in that directory.

Guarded teardown scripts live in this directory so they cannot be selected by
`supabase db push` or another forward migration runner. They are operational
artifacts, not forward migrations.

## Deployment gate

Before executing a migration:

1. Confirm the exact database environment and take a recoverable backup.
2. Run `scripts/apply-short-drama-core-migration.ts` without `--apply`. Its
   local preflight rejects rollback/down SQL, non-canonical filenames, duplicate
   14-digit versions, a partial remote schema, an owner-ID type mismatch, and an
   unavailable SQL executor.
3. Verify the SHA-256 of the exact forward SQL and explicitly select only that
   file in the approved SQL Editor or direct PostgreSQL session. Do not expose a
   general-purpose `exec_sql` RPC merely to deploy a migration.
4. Deploy `20260823043000_short_drama_core.sql` before enabling paid Film Studio
   calls. `20260825062000_text_chat_controls.sql` is independent but still needs
   the same target, backup, schema-cache refresh, and post-deploy checks.
5. Refresh the PostgREST schema cache, then verify tables, columns, RLS,
   policies, grants, RPC signatures, indexes, and the application readiness
   endpoints before allowing model or payment traffic.

The current repository contains no linked Supabase project or direct database
connection. A dry-run is evidence only; it must never be treated as deployment.

## Rollback gate

`20260823043000_short_drama_core.rollback.sql` may be executed only by an
approved operator against the confirmed target after a backup. It refuses to
run if any short-drama table contains data and uses no `CASCADE`. If the schema
contains user data or an unknown dependency, stop and create a reviewed forward
repair migration instead of editing or bypassing the guard.
