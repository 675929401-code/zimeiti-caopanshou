BEGIN;

-- Manual destructive rollback for 20260827093000_skill_packages_runtime.sql.
-- This file intentionally avoids CASCADE so unexpected dependencies stop the
-- rollback instead of being removed silently.

DROP FUNCTION IF EXISTS public.fail_skill_invocation(
  uuid, text, text, text, jsonb, text, text
);
DROP FUNCTION IF EXISTS public.complete_skill_invocation(
  uuid, text, jsonb, text, text, text, text, text[], numeric, numeric, jsonb
);
DROP FUNCTION IF EXISTS public.claim_skill_invocation(
  uuid, text, text, uuid, uuid, text, text, jsonb, text, text, text
);
DROP FUNCTION IF EXISTS public.replace_user_skill_installations(text, jsonb, text);
DROP FUNCTION IF EXISTS public.replace_agent_skill_installations(text, jsonb, text);
DROP FUNCTION IF EXISTS public.rollback_skill_package_version(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.publish_skill_version(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.save_skill_package_draft(
  text, text, text, text, text, text, jsonb, text, text, text, jsonb,
  uuid, uuid, timestamptz, text
);

DROP TRIGGER IF EXISTS skill_release_audit_immutable ON public.skill_release_audit;
DROP TRIGGER IF EXISTS skill_invocations_guard ON public.skill_invocations;
DROP TRIGGER IF EXISTS user_skill_installations_guard ON public.user_skill_installations;
DROP TRIGGER IF EXISTS agent_skill_installations_guard ON public.agent_skill_installations;
DROP TRIGGER IF EXISTS skill_secret_bindings_touch ON public.skill_secret_bindings;
DROP TRIGGER IF EXISTS skill_versions_guard ON public.skill_versions;
DROP TRIGGER IF EXISTS skill_packages_guard ON public.skill_packages;

DROP FUNCTION IF EXISTS public.skill_runtime_reject_audit_mutation();
DROP FUNCTION IF EXISTS public.skill_runtime_guard_invocation();
DROP FUNCTION IF EXISTS public.skill_runtime_guard_installation();
DROP FUNCTION IF EXISTS public.skill_runtime_guard_version();
DROP FUNCTION IF EXISTS public.skill_runtime_guard_package();
DROP FUNCTION IF EXISTS public.skill_runtime_touch_updated_at();

ALTER TABLE IF EXISTS public.skill_packages
  DROP CONSTRAINT IF EXISTS skill_packages_active_version_fk;

DROP TABLE IF EXISTS public.skill_release_audit;
DROP TABLE IF EXISTS public.skill_invocations;
DROP TABLE IF EXISTS public.user_skill_installations;
DROP TABLE IF EXISTS public.agent_skill_installations;
DROP TABLE IF EXISTS public.skill_secret_bindings;
DROP TABLE IF EXISTS public.skill_versions;
DROP TABLE IF EXISTS public.skill_packages;

DROP FUNCTION IF EXISTS public.skill_runtime_package_payload_valid(jsonb);
DROP FUNCTION IF EXISTS public.skill_runtime_json_secret_safe(jsonb);
DROP FUNCTION IF EXISTS public.skill_runtime_asset_ids_valid(text[]);
DROP FUNCTION IF EXISTS public.skill_runtime_secret_ref_valid(text);
DROP FUNCTION IF EXISTS public.skill_runtime_subject_valid(text);
DROP FUNCTION IF EXISTS public.skill_runtime_actor_valid(text);

NOTIFY pgrst, 'reload schema';

COMMIT;
