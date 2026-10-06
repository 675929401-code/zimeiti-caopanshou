BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE member_content_permission_changed_admins(
  user_id text PRIMARY KEY,
  old_permission_keys jsonb NOT NULL,
  new_permission_keys jsonb NOT NULL
) ON COMMIT DROP;

INSERT INTO member_content_permission_changed_admins(user_id, old_permission_keys, new_permission_keys)
SELECT profile.user_id,
       profile.permission_keys,
       profile.permission_keys - 'member_content.view'
FROM public.admin_access_profiles profile
WHERE profile.permission_keys ? 'member_content.view';

SELECT set_config('app.admin_governance_write', 'on', true);
WITH revised AS (
  SELECT profile.user_id,
         changed.new_permission_keys,
         profile.revision + 1 AS revision,
         profile.is_active
  FROM public.admin_access_profiles profile
  JOIN member_content_permission_changed_admins changed ON changed.user_id = profile.user_id
)
UPDATE public.admin_access_profiles profile
SET permission_keys = revised.new_permission_keys,
    revision = revised.revision,
    checksum = public.admin_access_checksum(
      profile.user_id,
      profile.admin_level,
      revised.new_permission_keys,
      revised.revision,
      revised.is_active
    ),
    updated_at = now()
FROM revised
WHERE profile.user_id = revised.user_id;

UPDATE public.admin_step_up_sessions session
SET revoked_at = coalesce(session.revoked_at, now())
FROM member_content_permission_changed_admins changed
WHERE session.actor_id = changed.user_id
  AND session.revoked_at IS NULL;

INSERT INTO public.admin_governance_audit (
  actor_id, actor_level, target_user_id, permission_key, action, result,
  reason_code, resource, metadata
)
SELECT NULL,
       'system',
       changed.user_id,
       'admin.accounts.manage',
       'admin_member_content_permission_v4_rollback',
       'success',
       '',
       'admin_access_profile',
       jsonb_build_object(
         'migration', '20261003093000',
         'old_permission_keys', changed.old_permission_keys,
         'new_permission_keys', changed.new_permission_keys
       )
FROM member_content_permission_changed_admins changed;

DELETE FROM public.admin_permission_catalog
WHERE permission_key = 'member_content.view';

COMMIT;
