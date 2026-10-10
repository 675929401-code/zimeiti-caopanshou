BEGIN;
SET LOCAL lock_timeout = '10s';

-- Rollback restores catalog delegability only.  It intentionally does not
-- re-grant prompt/internal permissions removed from ordinary administrators;
-- a security rollback must never silently restore privileged access.
UPDATE public.admin_permission_catalog
SET is_delegable = true,
    dependency_keys = CASE permission_key
      WHEN 'prompts.view' THEN '["agents.view"]'::jsonb
      WHEN 'prompts.edit' THEN '["prompts.view","agents.view"]'::jsonb
      WHEN 'internal_tools.manage' THEN '["agents.view"]'::jsonb
      ELSE dependency_keys
    END,
    updated_at = now()
WHERE permission_key IN ('prompts.view','prompts.edit','internal_tools.manage');

COMMIT;
