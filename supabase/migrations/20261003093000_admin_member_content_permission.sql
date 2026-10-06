BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Member identity and member-created content are different trust domains.
-- Support staff may inspect an account without automatically gaining access
-- to private chats, generated works, or media owned by that member.
INSERT INTO public.admin_permission_catalog (
  permission_key, group_key, label, description, risk_level,
  step_up_required, sort_order, is_active, is_delegable, dependency_keys
) VALUES (
  'member_content.view',
  'member',
  '查看会员内容',
  '查看会员聊天、作品与其私有媒体；下载或导出仍需二次确认。',
  'sensitive',
  false,
  25,
  true,
  true,
  '["members.view"]'::jsonb
)
ON CONFLICT (permission_key) DO UPDATE SET
  group_key = EXCLUDED.group_key,
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  risk_level = EXCLUDED.risk_level,
  step_up_required = EXCLUDED.step_up_required,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  is_delegable = EXCLUDED.is_delegable,
  dependency_keys = EXCLUDED.dependency_keys,
  updated_at = now();

SELECT set_config('app.admin_governance_write', 'on', true);

INSERT INTO public.admin_governance_audit (
  actor_id, actor_level, target_user_id, permission_key, action, result,
  reason_code, resource, metadata
) VALUES (
  NULL,
  'system',
  NULL,
  'admin.accounts.manage',
  'admin_member_content_permission_v4_migration',
  'success',
  '',
  'admin_permission_catalog',
  jsonb_build_object(
    'migration', '20261003093000',
    'permission_key', 'member_content.view',
    'dependency_keys', '["members.view"]'::jsonb
  )
);

COMMIT;
