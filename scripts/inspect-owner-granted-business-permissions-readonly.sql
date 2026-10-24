BEGIN TRANSACTION READ ONLY;

-- Only capability policy is returned; no accounts, sessions, audit or secrets.
SELECT permission_key, is_active, is_delegable, step_up_required, dependency_keys
FROM public.admin_permission_catalog
WHERE permission_key IN (
  'admin.accounts.manage', 'prompts.view', 'prompts.edit', 'internal_tools.manage'
)
ORDER BY permission_key;

SELECT public.normalize_delegable_admin_permission_keys('["prompts.edit"]'::jsonb)
         AS prompt_edit_with_dependencies,
       public.normalize_delegable_admin_permission_keys('["admin.accounts.manage"]'::jsonb)
         AS owner_control_must_be_empty;

SELECT proname,
       position('super_admin' IN pg_get_functiondef(p.oid)) > 0 AS owner_guard_present,
       position('p_expected_revision' IN pg_get_functiondef(p.oid)) > 0 AS revision_parameter_present
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (
  'set_admin_access_profile_atomic', 'create_admin_account_atomic',
  'promote_existing_member_to_admin_atomic'
);

ROLLBACK;
