BEGIN;
-- Only storyboard deliveries participate. Accounting/task rows are never removed.
ALTER TABLE public.video_tasks ADD COLUMN IF NOT EXISTS storyboard_archive_expires_at timestamptz;
ALTER TABLE public.video_tasks ADD COLUMN IF NOT EXISTS storyboard_archive_state text;
ALTER TABLE public.video_history_archive_jobs ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE public.video_history_archive_jobs ADD COLUMN IF NOT EXISTS object_key text;
ALTER TABLE public.video_history_archive_jobs ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.video_history_archive_jobs ADD COLUMN IF NOT EXISTS cleanup_completed_at timestamptz;

-- AFTER trigger cannot set NEW; BEFORE trigger cannot insert an FK on new rows.
-- Completed inserts get an AFTER enqueue and an independently assigned immutable expiry.
CREATE OR REPLACE FUNCTION public.set_storyboard_video_archive_expiry() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.task_label LIKE '分镜工作台%' AND NEW.status='completed' AND NEW.completed_at IS NOT NULL THEN
  IF TG_OP='UPDATE' THEN NEW.storyboard_archive_expires_at:=coalesce(OLD.storyboard_archive_expires_at, NEW.completed_at+interval '72 hours');
  ELSE NEW.storyboard_archive_expires_at:=NEW.completed_at+interval '72 hours'; END IF;
  NEW.storyboard_archive_state:=coalesce(NEW.storyboard_archive_state,'queued');
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.enqueue_storyboard_video_archive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.task_label LIKE '分镜工作台%' AND NEW.status='completed' AND NEW.storyboard_archive_expires_at IS NOT NULL THEN
  INSERT INTO public.video_history_archive_jobs(task_id,expires_at)
   VALUES(NEW.id::text,NEW.storyboard_archive_expires_at) ON CONFLICT(task_id) DO UPDATE
   SET expires_at=coalesce(video_history_archive_jobs.expires_at,excluded.expires_at),
       state=CASE WHEN video_history_archive_jobs.state IN ('source_expired','dead_letter')
          AND NEW.storyboard_archive_expires_at>now() AND NEW.history_hidden_at IS NULL AND NEW.source_expired_at IS NULL
          AND coalesce(NEW.provider_result_url,NEW.video_url,'') ~ '^https?://'
          AND (video_history_archive_jobs.lease_until IS NULL OR video_history_archive_jobs.lease_until<=now())
        THEN 'queued' ELSE video_history_archive_jobs.state END,
       next_attempt_at=CASE WHEN video_history_archive_jobs.state IN ('source_expired','dead_letter')
          AND NEW.storyboard_archive_expires_at>now() AND NEW.history_hidden_at IS NULL AND NEW.source_expired_at IS NULL
          AND coalesce(NEW.provider_result_url,NEW.video_url,'') ~ '^https?://'
          AND (video_history_archive_jobs.lease_until IS NULL OR video_history_archive_jobs.lease_until<=now())
        THEN now() ELSE video_history_archive_jobs.next_attempt_at END;
   UPDATE public.video_tasks task SET storyboard_archive_state=job.state
    FROM public.video_history_archive_jobs job WHERE task.id=NEW.id AND job.task_id=NEW.id::text;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER video_tasks_storyboard_archive_expiry BEFORE INSERT OR UPDATE OF status,completed_at ON public.video_tasks
 FOR EACH ROW EXECUTE FUNCTION public.set_storyboard_video_archive_expiry();
CREATE TRIGGER video_tasks_storyboard_archive_enqueue AFTER INSERT OR UPDATE OF status,completed_at ON public.video_tasks
 FOR EACH ROW EXECUTE FUNCTION public.enqueue_storyboard_video_archive();
UPDATE public.video_tasks SET storyboard_archive_expires_at=completed_at+interval '72 hours',storyboard_archive_state='queued'
 WHERE task_label LIKE '分镜工作台%' AND status='completed' AND completed_at IS NOT NULL AND storyboard_archive_expires_at IS NULL;
INSERT INTO public.video_history_archive_jobs(task_id,expires_at)
 SELECT id::text,storyboard_archive_expires_at FROM public.video_tasks
 WHERE task_label LIKE '分镜工作台%' AND status='completed' AND storyboard_archive_expires_at IS NOT NULL
 ON CONFLICT(task_id) DO UPDATE SET expires_at=excluded.expires_at,
 state=CASE WHEN video_history_archive_jobs.last_error_code='ARCHIVE_POLICY_RETIRED_DIRECT_DELIVERY' THEN 'queued' ELSE video_history_archive_jobs.state END;

CREATE OR REPLACE FUNCTION public.claim_storyboard_video_archive(p_worker_id text,p_limit integer DEFAULT 2)
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_slots integer; r record; v_token uuid;
BEGIN
 IF nullif(trim(p_worker_id),'') IS NULL THEN RAISE EXCEPTION 'ARCHIVE_WORKER_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('storyboard-video-archive-v1'));
 SELECT greatest(0,2-count(*)::integer) INTO v_slots FROM public.video_history_archive_jobs j JOIN public.video_tasks t ON t.id::text=j.task_id
 WHERE t.task_label LIKE '分镜工作台%' AND j.lease_until>now();
 FOR r IN SELECT j.*,t.user_id,t.model_id,t.task_id_external,t.provider_result_url,t.video_url
 FROM public.video_history_archive_jobs j JOIN public.video_tasks t ON t.id::text=j.task_id
 WHERE t.task_label LIKE '分镜工作台%' AND t.status='completed' AND j.expires_at IS NOT NULL
 AND (j.lease_until IS NULL OR j.lease_until<=now()) AND j.next_attempt_at<=now()
 AND ((j.expires_at<=now() AND j.cleanup_completed_at IS NULL)
  OR (j.expires_at>now() AND j.state IN ('queued','retry','leased')))
 ORDER BY j.expires_at<=now() DESC,j.next_attempt_at,j.task_id
 LIMIT least(greatest(0,p_limit),v_slots) FOR UPDATE OF j SKIP LOCKED
 LOOP
  v_token:=gen_random_uuid();
  UPDATE public.video_history_archive_jobs SET state='leased',lease_owner=p_worker_id,lease_token=v_token,
   lease_until=now()+interval '10 minutes',attempt_count=attempt_count+1,updated_at=now() WHERE task_id=r.task_id;
  UPDATE public.video_tasks SET storyboard_archive_state=CASE WHEN r.expires_at<=now() THEN 'expired' ELSE 'leased' END WHERE id::text=r.task_id;
  RETURN NEXT jsonb_build_object('task_id',r.task_id,'user_id',r.user_id,'model_id',r.model_id,
   'provider_task_id',r.task_id_external,'source_url',coalesce(nullif(r.provider_result_url,''),r.video_url),
   'lease_token',v_token,'object_key',r.object_key,'expires_at',r.expires_at,'cleanup',r.expires_at<=now(),'attempt_no',r.attempt_count+1);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.storyboard_archive_mutate(p_task_id text,p_token uuid,p_action text,p_key text DEFAULT NULL,p_error text DEFAULT NULL,p_metadata jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.video_history_archive_jobs%ROWTYPE; t public.video_tasks%ROWTYPE; v_uri text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('storyboard-video-archive-v1'));
 SELECT * INTO t FROM public.video_tasks WHERE id::text=p_task_id FOR UPDATE;
 IF NOT FOUND OR coalesce(t.task_label,'') NOT LIKE '分镜工作台%' THEN RAISE EXCEPTION 'ARCHIVE_SCOPE_INVALID'; END IF;
 SELECT * INTO j FROM public.video_history_archive_jobs WHERE task_id=p_task_id FOR UPDATE;
 IF NOT FOUND OR p_token IS NULL OR j.lease_token IS DISTINCT FROM p_token OR j.lease_until IS NULL OR j.lease_until<=now() OR j.state<>'leased'
 THEN RAISE EXCEPTION 'ARCHIVE_LEASE_INVALID'; END IF;
 IF p_action='renew' THEN
  UPDATE public.video_history_archive_jobs SET lease_until=now()+interval '10 minutes' WHERE task_id=p_task_id;
 ELSIF p_action='prepare' THEN
  IF j.expires_at<=now() THEN RAISE EXCEPTION 'ARCHIVE_EXPIRED'; END IF;
  IF p_key IS NULL OR p_key !~ '^videos/scoped/storyboard-delivery/[a-f0-9]{64}/[a-f0-9]{64}/[a-f0-9-]{36}[.]mp4$' THEN RAISE EXCEPTION 'ARCHIVE_KEY_INVALID'; END IF;
  IF split_part(p_key,'/',4)<>encode(pg_catalog.sha256(convert_to(t.user_id::text,'UTF8')),'hex')
    OR split_part(p_key,'/',5)<>encode(pg_catalog.sha256(convert_to(p_task_id,'UTF8')),'hex') THEN RAISE EXCEPTION 'ARCHIVE_KEY_OWNER_INVALID'; END IF;
  IF j.object_key IS NOT NULL AND j.object_key<>p_key THEN RAISE EXCEPTION 'ARCHIVE_KEY_CONFLICT'; END IF;
  UPDATE public.video_history_archive_jobs SET object_key=p_key WHERE task_id=p_task_id;
 ELSIF p_action='complete' THEN
  IF t.status<>'completed' OR (t.history_hidden_at IS NOT NULL AND t.history_hidden_at IS DISTINCT FROM t.source_expired_at) THEN RAISE EXCEPTION 'ARCHIVE_TASK_PUBLICATION_FORBIDDEN'; END IF;
  IF j.expires_at IS NULL OR j.expires_at<=now() OR j.object_key IS DISTINCT FROM p_key THEN RAISE EXCEPTION 'ARCHIVE_EXPIRED_OR_KEY_CONFLICT'; END IF;
  IF p_metadata IS NOT NULL AND (p_metadata->>'size')::bigint BETWEEN 1 AND 536870912 AND p_metadata->>'contentType'='video/mp4' THEN
   INSERT INTO public.user_files(user_id,storage_provider,storage_key,file_name,file_category,file_size,content_type,source,meta,is_public)
    SELECT t.user_id,'tencent_cos',p_key,split_part(p_key,'/',6),'video',(p_metadata->>'size')::bigint,'video/mp4','video-generation',
     jsonb_build_object('taskId',p_task_id,'archivePolicy','storyboard-video-72h-v1','retainedUntil',j.expires_at),false
    WHERE NOT EXISTS(SELECT 1 FROM public.user_files WHERE storage_key=p_key AND storage_provider='tencent_cos');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.user_files f WHERE f.user_id::text=t.user_id::text AND f.storage_provider='tencent_cos'
   AND f.storage_key=p_key AND f.file_category='video' AND f.meta->>'taskId'=p_task_id AND f.meta->>'archivePolicy'='storyboard-video-72h-v1')
  THEN RAISE EXCEPTION 'ARCHIVE_OWNERSHIP_MISSING'; END IF;
  v_uri:='object://tencent_cos/'||replace(p_key,'/','%2F');
  UPDATE public.video_tasks SET storage_url=v_uri,storyboard_archive_state='completed' WHERE id=t.id;
  UPDATE public.video_history_archive_jobs SET state='completed',storage_url=v_uri,archived_at=now(),lease_token=NULL,lease_owner=NULL,lease_until=NULL,last_error_code=NULL WHERE task_id=p_task_id;
 ELSIF p_action='cleaned' THEN
  IF j.expires_at>now() OR j.object_key IS DISTINCT FROM p_key THEN RAISE EXCEPTION 'ARCHIVE_CLEANUP_INVALID'; END IF;
  DELETE FROM public.user_files WHERE user_id::text=t.user_id::text AND storage_provider='tencent_cos' AND storage_key=p_key
   AND meta->>'taskId'=p_task_id AND meta->>'archivePolicy'='storyboard-video-72h-v1';
  v_uri:='object://tencent_cos/'||replace(p_key,'/','%2F');
  UPDATE public.video_tasks SET storage_url=CASE WHEN storage_url=v_uri THEN NULL ELSE storage_url END,
   video_url=CASE WHEN video_url=v_uri THEN NULL ELSE video_url END,storyboard_archive_state='expired' WHERE id=t.id;
  UPDATE public.video_history_archive_jobs SET state='source_expired',source_expired_at=coalesce(source_expired_at,now()),cleanup_completed_at=now(),storage_url=NULL,lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE task_id=p_task_id;
 ELSIF p_action='fail' THEN
  UPDATE public.video_history_archive_jobs SET state='retry',
   next_attempt_at=now()+make_interval(secs=>least(3600,30*(2^least(attempt_count,7))::integer)),
   last_error_code=left(regexp_replace(coalesce(p_error,'ARCHIVE_FAILED'),'[^A-Za-z0-9_.:-]','_','g'),120),lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE task_id=p_task_id;
  UPDATE public.video_tasks SET storyboard_archive_state=CASE WHEN j.expires_at<=now() THEN 'expired' ELSE 'retry' END WHERE id=t.id;
 ELSE RAISE EXCEPTION 'ARCHIVE_ACTION_INVALID'; END IF;
 RETURN jsonb_build_object('ok',true);
END $$;
REVOKE ALL ON FUNCTION public.set_storyboard_video_archive_expiry(),public.enqueue_storyboard_video_archive(),public.claim_storyboard_video_archive(text,integer),public.storyboard_archive_mutate(text,uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_storyboard_video_archive(text,integer),public.storyboard_archive_mutate(text,uuid,text,text,text,jsonb) TO service_role;

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
$$;

REVOKE ALL ON FUNCTION public.purge_expired_video_history(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_video_history(integer, integer) TO service_role;

COMMENT ON FUNCTION public.purge_expired_video_history(integer, integer) IS
  'Hard-deletes terminal video history rows past the retention window; keeps in-flight and unknown-billing rows, and skips digital-human/referenced tasks.';

CREATE OR REPLACE FUNCTION public.mark_video_upstream_source_expired(
  p_task_id text,
  p_user_id text,
  p_http_status integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_task public.video_tasks%ROWTYPE;
  v_marked_at timestamptz;
BEGIN
  IF trim(coalesce(p_task_id, '')) = ''
     OR trim(coalesce(p_user_id, '')) = ''
     OR p_http_status NOT IN (404, 410) THEN
    RAISE EXCEPTION 'VIDEO_SOURCE_EXPIRY_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_task
    FROM public.video_tasks
   WHERE id::text = trim(p_task_id)
     AND user_id::text = trim(p_user_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VIDEO_SOURCE_EXPIRY_TASK_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_task.status <> 'completed' THEN
    RAISE EXCEPTION 'VIDEO_SOURCE_EXPIRY_TASK_NOT_COMPLETED' USING ERRCODE = '55000';
  END IF;
  IF v_task.task_label LIKE '分镜工作台%' THEN
    UPDATE public.video_tasks SET source_expired_at=coalesce(source_expired_at,clock_timestamp()) WHERE id=v_task.id;
    RETURN jsonb_build_object('marked',true,'task_id',v_task.id::text,'reason','storyboard_upstream_only');
  END IF;
  IF nullif(trim(coalesce(v_task.storage_url, '')), '') IS NOT NULL THEN
    RETURN jsonb_build_object(
      'marked', false,
      'reason', 'persistent_legacy_asset',
      'task_id', v_task.id::text
    );
  END IF;

  v_marked_at := coalesce(v_task.source_expired_at, clock_timestamp());
  UPDATE public.video_tasks
     SET source_expired_at = v_marked_at,
         history_hidden_at = coalesce(history_hidden_at, v_marked_at),
         provider_result_url = NULL,
         video_url = NULL,
         content_url = NULL,
         thumbnail_url = NULL,
         needs_proxy = false
   WHERE id = v_task.id;

  UPDATE public.video_history_archive_jobs
     SET state = 'source_expired',
         source_expired_at = coalesce(source_expired_at, v_marked_at),
         lease_owner = NULL,
         lease_until = NULL,
         last_error_code = 'UPSTREAM_SOURCE_HTTP_' || p_http_status::text,
         updated_at = now()
   WHERE task_id = v_task.id::text
     AND state <> 'completed';

  RETURN jsonb_build_object(
    'marked', true,
    'already_marked', v_task.source_expired_at IS NOT NULL,
    'task_id', v_task.id::text,
    'source_expired_at', v_marked_at,
    'http_status', p_http_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mark_video_upstream_source_expired(text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_video_upstream_source_expired(text, text, integer)
  TO service_role;


NOTIFY pgrst, 'reload schema';
COMMIT;
