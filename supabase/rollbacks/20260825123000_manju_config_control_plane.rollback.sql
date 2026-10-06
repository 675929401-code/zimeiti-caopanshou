BEGIN;

-- Destructive manual rollback for
-- 20260825123000_manju_config_control_plane.sql.
--
-- WARNING: running this script permanently deletes every Manju configuration
-- draft, published revision, release, active pointer and audit record.  Export
-- and reconcile those records before execution.  This file intentionally lives
-- outside supabase/migrations so it cannot be applied as a forward migration.

DROP TRIGGER IF EXISTS manju_config_audit_immutable
  ON public.manju_config_audit;
DROP TRIGGER IF EXISTS manju_config_active_pointer_guard
  ON public.manju_config_active;
DROP TRIGGER IF EXISTS manju_config_release_immutable
  ON public.manju_config_releases;
DROP TRIGGER IF EXISTS manju_config_release_guard
  ON public.manju_config_releases;
DROP TRIGGER IF EXISTS manju_config_revision_touch_updated_at
  ON public.manju_config_revisions;
DROP TRIGGER IF EXISTS manju_config_revision_guard
  ON public.manju_config_revisions;

DROP FUNCTION IF EXISTS public.rollback_manju_config_release(text, text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.publish_manju_config_revision(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.save_manju_config_draft(
  text, text, jsonb, text, text, uuid, timestamptz, uuid
);

-- No CASCADE: an unexpected dependent object aborts rollback for manual review.
DROP TABLE IF EXISTS public.manju_config_audit;
DROP TABLE IF EXISTS public.manju_config_active;
DROP TABLE IF EXISTS public.manju_config_releases;
DROP TABLE IF EXISTS public.manju_config_revisions;

DROP FUNCTION IF EXISTS public.manju_config_reject_audit_mutation();
DROP FUNCTION IF EXISTS public.manju_config_guard_active_pointer();
DROP FUNCTION IF EXISTS public.manju_config_reject_release_mutation();
DROP FUNCTION IF EXISTS public.manju_config_guard_release();
DROP FUNCTION IF EXISTS public.manju_config_touch_revision_updated_at();
DROP FUNCTION IF EXISTS public.manju_config_guard_revision();

NOTIFY pgrst, 'reload schema';

COMMIT;
