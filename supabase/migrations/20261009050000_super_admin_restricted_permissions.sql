BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Password re-verification proves the current operator's identity; it must not
-- upgrade an ordinary administrator into the platform-owner boundary.  Prompt
-- source and internal tool wiring therefore remain super-admin only.
UPDATE public.admin_permission_catalog
SET is_delegable = false,
    dependency_keys = '[]'::jsonb,
    updated_at = now()
WHERE permission_key IN (
  'admin.accounts.manage',
  'prompts.view',
  'prompts.edit',
  'internal_tools.manage'
)
AND (is_delegable IS DISTINCT FROM false OR dependency_keys IS DISTINCT FROM '[]'::jsonb);

CREATE TEMP TABLE restricted_permission_changed_admins(
  user_id text PRIMARY KEY,
  old_permission_keys jsonb NOT NULL,
  new_permission_keys jsonb NOT NULL
) ON COMMIT DROP;

INSERT INTO restricted_permission_changed_admins(user_id, old_permission_keys, new_permission_keys)
SELECT profile.user_id,
       profile.permission_keys,
       public.normalize_delegable_admin_permission_keys(profile.permission_keys)
FROM public.admin_access_profiles profile
WHERE profile.admin_level = 'admin'
  AND profile.permission_keys IS DISTINCT FROM public.normalize_delegable_admin_permission_keys(profile.permission_keys);

SELECT set_config('app.admin_governance_write', 'on', true);

WITH normalized AS (
  SELECT profile.user_id,
         changed.new_permission_keys AS permission_keys,
         profile.revision + 1 AS revision,
         profile.is_active
  FROM public.admin_access_profiles profile
  JOIN restricted_permission_changed_admins changed ON changed.user_id = profile.user_id
)
UPDATE public.admin_access_profiles profile
SET permission_keys = normalized.permission_keys,
    revision = normalized.revision,
    checksum = public.admin_access_checksum(
      profile.user_id,
      'admin',
      normalized.permission_keys,
      normalized.revision,
      normalized.is_active
    ),
    updated_at = now()
FROM normalized
WHERE profile.user_id = normalized.user_id;

UPDATE public.admin_step_up_sessions session
SET revoked_at = coalesce(session.revoked_at, now())
FROM restricted_permission_changed_admins changed
WHERE session.actor_id = changed.user_id
  AND session.revoked_at IS NULL;

INSERT INTO public.admin_governance_audit (
  actor_id, actor_level, target_user_id, permission_key, action, result,
  reason_code, resource, metadata
)
SELECT NULL, 'system', changed.user_id, 'prompts.view',
       'super_admin_restricted_permission_migration', 'success',
       'SUPER_ADMIN_REQUIRED', 'admin_access_profile',
       jsonb_build_object(
         'migration', '20261009050000',
         'old_permission_keys', changed.old_permission_keys,
         'new_permission_keys', changed.new_permission_keys
       )
FROM restricted_permission_changed_admins changed;

COMMIT;
