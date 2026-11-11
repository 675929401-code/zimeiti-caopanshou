-- Candidate containment rollback only. Not applied by code/build tooling.
-- Preserve every draft, attempt, grant, quota debit and canonical identity.
-- Existing official/browser readback and legacy execution guards remain installed.
-- Re-enabling requires reviewed forward replacement of these two entrypoints.
BEGIN;
CREATE OR REPLACE FUNCTION public.mutate_native_official_atomic(p_user_id text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 RAISE EXCEPTION 'NATIVE_OFFICIAL_SCHEMA_NOT_READY';
END $$;
CREATE OR REPLACE FUNCTION public.prepare_browser_local_atomic(p_owner text,p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$BEGIN
 PERFORM public.pub_assert_actor(p_owner);
 RAISE EXCEPTION 'NATIVE_BROWSER_SCHEMA_NOT_READY';
END $$;
REVOKE ALL ON FUNCTION public.mutate_native_official_atomic(text,jsonb),public.prepare_browser_local_atomic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mutate_native_official_atomic(text,jsonb),public.prepare_browser_local_atomic(text,jsonb) TO service_role;
COMMIT;
