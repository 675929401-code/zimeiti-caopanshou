-- Unsettled provider submission is never a hard-purge billing terminal state.
-- Preserve this environment's existing function owner and ACL exactly.
BEGIN;
DO $migration$
DECLARE
  v_before pg_proc%ROWTYPE;
  v_after pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_before FROM pg_proc
  WHERE oid = 'public.purge_expired_video_history(integer,integer)'::regprocedure;
  IF v_before.proowner IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE oid = v_before.proowner)
    OR pg_get_function_identity_arguments(v_before.oid) IS DISTINCT FROM 'p_retention_days integer, p_limit integer'
    OR pg_get_function_arguments(v_before.oid) IS DISTINCT FROM 'p_retention_days integer DEFAULT 5, p_limit integer DEFAULT 500'
    OR v_before.prorettype IS DISTINCT FROM 'jsonb'::regtype
    OR v_before.proretset IS DISTINCT FROM false
    OR v_before.prokind IS DISTINCT FROM 'f'
    OR (SELECT lanname FROM pg_language WHERE oid = v_before.prolang) IS DISTINCT FROM 'plpgsql'
    OR v_before.prosecdef IS DISTINCT FROM true
    OR v_before.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
    OR v_before.provolatile IS DISTINCT FROM 'v'
    OR v_before.proparallel IS DISTINCT FROM 'u'
    OR v_before.proisstrict IS DISTINCT FROM false
    OR v_before.proleakproof IS DISTINCT FROM false
    OR encode(sha256(convert_to(v_before.prosrc, 'UTF8')), 'hex') IS DISTINCT FROM '81dfd58e29b53ef623386e547c8e0d99cf683a3f6817e6ec89c33fbd8faafd79'
    OR has_function_privilege('service_role', v_before.oid, 'EXECUTE') IS DISTINCT FROM true
    OR has_function_privilege('anon', v_before.oid, 'EXECUTE') IS DISTINCT FROM false
    OR has_function_privilege('authenticated', v_before.oid, 'EXECUTE') IS DISTINCT FROM false
    OR EXISTS (
      SELECT 1 FROM aclexplode(coalesce(v_before.proacl, acldefault('f', v_before.proowner))) privilege
      WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'VIDEO_HISTORY_BILLING_PROTECTION_PRECONDITION_FAILED';
  END IF;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.purge_expired_video_history(
  p_retention_days integer DEFAULT 5,
  p_limit integer DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_days integer := greatest(1, least(coalesce(p_retention_days, 5), 365));
  v_limit integer := greatest(1, least(coalesce(p_limit, 500), 2000));
  v_cutoff timestamptz := clock_timestamp() - make_interval(days => v_days);
  v_ids text[] := ARRAY[]::text[];
  v_deleted integer := 0;
BEGIN
  SELECT coalesce(array_agg(candidate.id ORDER BY candidate.terminal_at, candidate.id), ARRAY[]::text[])
    INTO v_ids
    FROM (
      SELECT t.id,
             coalesce(t.completed_at, t.created_at) AS terminal_at
        FROM public.video_tasks t
       WHERE t.status IN ('completed', 'failed', 'cancelled', 'expired')
         AND coalesce(t.completed_at, t.created_at) < v_cutoff
         AND (
           t.billing_state IS NULL
           OR t.billing_state IN ('settled', 'not_required', 'exempt', 'failed', 'cancelled', 'submission_failed', 'refunded', 'not_charged')
         )
         AND coalesce(t.task_label, '') NOT LIKE 'digital-human:%'
         AND coalesce(t.task_label, '') NOT LIKE '分镜工作台%'
         AND NOT EXISTS (SELECT 1 FROM public.digital_video_dispatch_jobs d WHERE d.task_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM public.digital_human_long_segments s WHERE s.video_task_id = t.id)
       ORDER BY coalesce(t.completed_at, t.created_at), t.id
       LIMIT v_limit
       FOR UPDATE SKIP LOCKED
    ) candidate;

  IF cardinality(v_ids) > 0 THEN
    DELETE FROM public.video_tasks WHERE id = ANY(v_ids);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'deletedCount', v_deleted,
    'deletedIds', to_jsonb(v_ids),
    'cutoff', v_cutoff,
    'hasMore', v_deleted >= v_limit
  );
END;
$function$;
$ddl$;

  SELECT * INTO STRICT v_after FROM pg_proc WHERE oid = v_before.oid;
  IF v_after.proowner IS DISTINCT FROM v_before.proowner
    OR v_after.proacl IS DISTINCT FROM v_before.proacl
    OR v_after.proconfig IS DISTINCT FROM v_before.proconfig
    OR v_after.prolang IS DISTINCT FROM v_before.prolang
    OR v_after.prorettype IS DISTINCT FROM v_before.prorettype
    OR v_after.proretset IS DISTINCT FROM v_before.proretset
    OR v_after.prokind IS DISTINCT FROM v_before.prokind
    OR v_after.prosecdef IS DISTINCT FROM v_before.prosecdef
    OR v_after.provolatile IS DISTINCT FROM v_before.provolatile
    OR v_after.proparallel IS DISTINCT FROM v_before.proparallel
    OR v_after.proisstrict IS DISTINCT FROM v_before.proisstrict
    OR v_after.proleakproof IS DISTINCT FROM v_before.proleakproof
    OR v_after.proargnames IS DISTINCT FROM v_before.proargnames
    OR v_after.proargtypes IS DISTINCT FROM v_before.proargtypes
    OR v_after.proargmodes IS DISTINCT FROM v_before.proargmodes
    OR v_after.pronargdefaults IS DISTINCT FROM v_before.pronargdefaults
    OR pg_get_expr(v_after.proargdefaults, 0) IS DISTINCT FROM pg_get_expr(v_before.proargdefaults, 0)
    OR encode(sha256(convert_to(v_after.prosrc, 'UTF8')), 'hex') IS DISTINCT FROM 'b9258ff96251b71b8f441a7cb8afb910c53f9422207d353269f18360ff0f7cec' THEN
    RAISE EXCEPTION 'VIDEO_HISTORY_BILLING_PROTECTION_POSTCONDITION_FAILED';
  END IF;
END;
$migration$;
COMMIT;
