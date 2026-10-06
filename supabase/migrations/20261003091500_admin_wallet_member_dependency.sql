BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Every wallet adjustment targets a member account. Keep the member identity
-- read dependency in the durable catalog so the UI, API and database cannot
-- drift into a state where a finance operator can mutate an unseen account.
UPDATE public.admin_permission_catalog
SET dependency_keys = '["members.view","billing.view"]'::jsonb,
    updated_at = now()
WHERE permission_key = 'wallet.adjust'
  AND dependency_keys IS DISTINCT FROM '["members.view","billing.view"]'::jsonb;

CREATE TEMP TABLE permission_v3_changed_admins(
  user_id text PRIMARY KEY,
  old_permission_keys jsonb NOT NULL,
  new_permission_keys jsonb NOT NULL
) ON COMMIT DROP;

INSERT INTO permission_v3_changed_admins(user_id, old_permission_keys, new_permission_keys)
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
  JOIN permission_v3_changed_admins changed ON changed.user_id = profile.user_id
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
FROM permission_v3_changed_admins changed
WHERE session.actor_id = changed.user_id
  AND session.revoked_at IS NULL;

INSERT INTO public.admin_governance_audit (
  actor_id, actor_level, target_user_id, permission_key, action, result,
  reason_code, resource, metadata
)
SELECT NULL, 'system', changed.user_id, 'wallet.adjust',
       'admin_permission_dependency_v3_migration', 'success', '', 'admin_access_profile',
       jsonb_build_object(
         'migration', '20261003091500',
         'old_permission_keys', changed.old_permission_keys,
         'new_permission_keys', changed.new_permission_keys
       )
FROM permission_v3_changed_admins changed;

COMMIT;
