BEGIN;

-- 真实删除过期视频历史（不是隐藏）。
-- 规则与前端一致：终态 + 计费已确定 + 超过 5 天；进行中/未知计费永不删除；
-- 数字人任务不在此策略内（其历史不走 5 天窗口），且被其它表引用的任务跳过。

CREATE OR REPLACE FUNCTION public.purge_expired_video_history(
  p_retention_days integer DEFAULT 5,
  p_limit integer DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
           OR (t.billing_state = 'provider_submitted' AND coalesce(t.completed_at, t.created_at) < v_cutoff)
         )
         AND coalesce(t.task_label, '') NOT LIKE 'digital-human:%'
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
$$;

REVOKE ALL ON FUNCTION public.purge_expired_video_history(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_video_history(integer, integer) TO service_role;

COMMENT ON FUNCTION public.purge_expired_video_history(integer, integer) IS
  'Hard-deletes terminal video history rows past the retention window; keeps in-flight and unknown-billing rows, and skips digital-human/referenced tasks.';

COMMIT;
