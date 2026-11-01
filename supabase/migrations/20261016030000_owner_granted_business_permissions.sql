BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Forward-only catalog policy. This does not restore historical grants, edit
-- any access profile or create an unlock session. Existing owner-only grant
-- RPCs, revision CAS, integrity checks and audit remain unchanged.
UPDATE public.admin_permission_catalog
SET is_delegable = true,
    dependency_keys = CASE permission_key
      WHEN 'prompts.view' THEN '["agents.view"]'::jsonb
      WHEN 'prompts.edit' THEN '["prompts.view","agents.view"]'::jsonb
      WHEN 'internal_tools.manage' THEN '["agents.view"]'::jsonb
    END,
    updated_at = now()
WHERE permission_key IN ('prompts.view', 'prompts.edit', 'internal_tools.manage');

DO $$
BEGIN
  IF (SELECT count(*) FROM public.admin_permission_catalog
      WHERE permission_key IN ('prompts.view', 'prompts.edit', 'internal_tools.manage')
        AND is_active = true AND is_delegable = true AND step_up_required = true) <> 3 THEN
    RAISE EXCEPTION 'OWNER_GRANTED_BUSINESS_CATALOG_NOT_READY';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admin_permission_catalog
      WHERE permission_key = 'admin.accounts.manage'
        AND is_delegable = false AND dependency_keys = '[]'::jsonb) THEN
    RAISE EXCEPTION 'OWNER_CONTROL_PLANE_MUST_REMAIN_NON_DELEGABLE';
  END IF;
END $$;

COMMIT;
