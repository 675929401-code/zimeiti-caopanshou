BEGIN;
SET LOCAL lock_timeout='10s';
CREATE TABLE public.digital_video_dispatch_jobs (
 task_id text PRIMARY KEY REFERENCES public.video_tasks(id),
 user_id uuid NOT NULL,
 provider_key text NOT NULL CHECK(provider_key ~ '^[0-9a-f]{64}$'),
 model_hash text NOT NULL CHECK(model_hash ~ '^[0-9a-f]{64}$'),
 inputs jsonb NOT NULL CHECK(jsonb_typeof(inputs)='object'),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','dispatching','running','finalizing','submission_unknown','completed','failed','cancelled')),
 lease_owner text, lease_until timestamptz, next_run_at timestamptz NOT NULL DEFAULT now(),
 provider_result_url text, error_code text, error_message text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX digital_video_dispatch_ready ON public.digital_video_dispatch_jobs(state,next_run_at,created_at);
CREATE INDEX digital_video_dispatch_channel ON public.digital_video_dispatch_jobs(provider_key,state);
ALTER TABLE public.digital_video_dispatch_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.digital_video_dispatch_jobs FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.digital_video_dispatch_jobs TO service_role;

-- Both records commit together. A process crash cannot leave a reserved task
-- that looks accepted but was never durably queued.
CREATE FUNCTION public.reserve_queued_digital_video_task(p_task jsonb,p_dispatch jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb; j public.digital_video_dispatch_jobs%ROWTYPE;
BEGIN
 IF coalesce(p_task->>'p_task_label','') NOT LIKE 'digital-human:%'
 OR coalesce(p_dispatch->>'providerKey','') !~ '^[0-9a-f]{64}$'
 OR coalesce(p_dispatch->>'modelHash','') !~ '^[0-9a-f]{64}$'
 OR jsonb_typeof(p_dispatch->'inputs') IS DISTINCT FROM 'object'
 OR pg_column_size(p_dispatch)>32000 THEN RAISE EXCEPTION 'DIGITAL_QUEUE_INPUT_INVALID'; END IF;
 r:=public.reserve_video_generation_task_atomic(
 p_task_id=>p_task->>'p_task_id',p_user_id=>p_task->>'p_user_id',p_model_id=>p_task->>'p_model_id',
 p_client_request_id=>p_task->>'p_client_request_id',p_request_fingerprint=>p_task->>'p_request_fingerprint',
 p_billing_price_yuan=>(p_task->>'p_billing_price_yuan')::numeric,p_billing_cost_price_yuan=>(p_task->>'p_billing_cost_price_yuan')::numeric,
 p_billing_unit=>p_task->>'p_billing_unit',p_billing_quantity=>(p_task->>'p_billing_quantity')::numeric,
 p_explicitly_free=>(p_task->>'p_explicitly_free')::boolean,p_billing_exempt=>(p_task->>'p_billing_exempt')::boolean,
 p_task_label=>p_task->>'p_task_label',p_batch_id=>p_task->>'p_batch_id',p_batch_topic=>p_task->>'p_batch_topic',p_card_index=>(p_task->>'p_card_index')::integer,
 p_prompt=>p_task->>'p_prompt',p_first_frame_url=>p_task->>'p_first_frame_url',p_last_frame_url=>p_task->>'p_last_frame_url',p_reference_image_url=>p_task->>'p_reference_image_url',
 p_aspect_ratio=>p_task->>'p_aspect_ratio',p_resolution=>p_task->>'p_resolution',p_duration_seconds=>(p_task->>'p_duration_seconds')::numeric);
 SELECT * INTO j FROM public.digital_video_dispatch_jobs WHERE task_id=p_task->>'p_task_id';
 IF FOUND THEN
  IF j.provider_key IS DISTINCT FROM p_dispatch->>'providerKey' OR j.model_hash IS DISTINCT FROM p_dispatch->>'modelHash' OR j.inputs IS DISTINCT FROM p_dispatch->'inputs' THEN RAISE EXCEPTION 'VIDEO_REQUEST_IDEMPOTENCY_CONFLICT'; END IF;
 ELSIF (r->>'created')::boolean THEN
  INSERT INTO public.digital_video_dispatch_jobs(task_id,user_id,provider_key,model_hash,inputs)
  VALUES(p_task->>'p_task_id',(p_task->>'p_user_id')::uuid,p_dispatch->>'providerKey',p_dispatch->>'modelHash',p_dispatch->'inputs');
  UPDATE public.video_tasks SET status='queued',error_message=NULL WHERE id=p_task->>'p_task_id';
  r:=jsonb_set(r,'{status}','"queued"'::jsonb);
 END IF;
 RETURN r;
END $$;

-- A single supplier credential has one render slot until terminal outcome.
-- Polling leases may expire safely. Dispatch leases never cause a second POST.
CREATE FUNCTION public.claim_digital_video_dispatch(p_worker text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.digital_video_dispatch_jobs%ROWTYPE; v_count integer;
BEGIN
 IF length(p_worker)<16 OR length(p_worker)>100 THEN RAISE EXCEPTION 'DIGITAL_QUEUE_WORKER_INVALID'; END IF;
 UPDATE public.digital_video_dispatch_jobs q SET state=CASE WHEN t.task_id_external IS NOT NULL THEN 'running' ELSE 'submission_unknown' END,
  error_code=CASE WHEN t.task_id_external IS NULL THEN 'VIDEO_SUBMIT_OUTCOME_UNKNOWN' ELSE NULL END,
  error_message=CASE WHEN t.task_id_external IS NULL THEN '正在确认原任务，请勿重复生成' ELSE NULL END,
  lease_until=NULL,next_run_at=now(),updated_at=now()
 FROM public.video_tasks t WHERE t.id=q.task_id AND q.state='dispatching' AND q.lease_until<now();
 UPDATE public.digital_video_dispatch_jobs q SET state='running',error_code=NULL,error_message=NULL,next_run_at=now(),updated_at=now()
 FROM public.video_tasks t WHERE t.id=q.task_id AND q.state='submission_unknown' AND q.error_code IN ('VIDEO_SUBMIT_OUTCOME_UNKNOWN','VIDEO_PROVIDER_TASK_ID_MISSING') AND t.task_id_external IS NOT NULL;
 FOR j IN SELECT * FROM public.digital_video_dispatch_jobs WHERE state IN ('queued','running','finalizing') AND next_run_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY CASE WHEN state='queued' THEN 1 ELSE 0 END,next_run_at,created_at LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
  IF j.state='queued' THEN
   IF NOT pg_try_advisory_xact_lock(hashtextextended('digital-video-channel:'||j.provider_key,0)) THEN CONTINUE; END IF;
   SELECT count(*) INTO v_count FROM public.digital_video_dispatch_jobs WHERE provider_key=j.provider_key AND state IN ('dispatching','running','submission_unknown');
   IF v_count>=1 THEN CONTINUE; END IF;
  END IF;
  UPDATE public.digital_video_dispatch_jobs SET state=CASE WHEN j.state='queued' THEN 'dispatching' ELSE j.state END,
    lease_owner=p_worker,lease_until=now()+interval '5 minutes',updated_at=now() WHERE task_id=j.task_id RETURNING * INTO j;
  RETURN to_jsonb(j);
 END LOOP;
 RETURN NULL;
END $$;

CREATE FUNCTION public.update_digital_video_dispatch(p_task_id text,p_worker text,p_state text,p_result_url text DEFAULT NULL,p_error_code text DEFAULT NULL,p_error_message text DEFAULT NULL,p_delay_seconds integer DEFAULT 5) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.digital_video_dispatch_jobs%ROWTYPE;
BEGIN
 SELECT * INTO j FROM public.digital_video_dispatch_jobs WHERE task_id=p_task_id FOR UPDATE;
 IF NOT FOUND OR j.lease_owner IS DISTINCT FROM p_worker OR j.state IN ('completed','failed','cancelled') THEN RETURN false; END IF;
 IF p_state NOT IN ('running','finalizing','submission_unknown','completed','failed','cancelled') THEN RAISE EXCEPTION 'DIGITAL_QUEUE_STATE_INVALID'; END IF;
 IF p_state='completed' AND NOT EXISTS(SELECT 1 FROM public.video_tasks WHERE id=p_task_id AND status='completed') THEN RAISE EXCEPTION 'DIGITAL_QUEUE_RESULT_NOT_SAVED'; END IF;
 IF p_state='failed' THEN
  UPDATE public.video_tasks SET status='failed',error_message=p_error_message,submission_error_code=p_error_code,completed_at=now(),price_charged=0,billing_state=CASE WHEN task_id_external IS NULL THEN 'submission_failed' ELSE billing_state END
  WHERE id=p_task_id AND status NOT IN ('completed','failed','cancelled','expired') AND coalesce(price_charged,0)=0;
  IF NOT EXISTS(SELECT 1 FROM public.video_tasks WHERE id=p_task_id AND status IN ('failed','cancelled','expired')) THEN RAISE EXCEPTION 'DIGITAL_QUEUE_FAILURE_CONFLICT'; END IF;
 END IF;
 IF p_state IN ('running','finalizing','submission_unknown') THEN
  UPDATE public.video_tasks SET status=CASE WHEN p_state='submission_unknown' THEN 'pending' ELSE 'processing' END,
  error_message=p_error_message,submission_error_code=p_error_code
  WHERE id=p_task_id AND status NOT IN ('completed','failed','cancelled','expired');
 END IF;
 UPDATE public.digital_video_dispatch_jobs SET state=p_state,provider_result_url=coalesce(p_result_url,provider_result_url),error_code=p_error_code,error_message=p_error_message,
 lease_until=NULL,next_run_at=now()+make_interval(secs=>greatest(2,least(p_delay_seconds,300))),updated_at=now() WHERE task_id=p_task_id;
 RETURN true;
END $$;
CREATE FUNCTION public.begin_digital_video_post(p_task_id text,p_worker text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.digital_video_dispatch_jobs SET lease_until=now()+interval '5 minutes',updated_at=now()
 WHERE task_id=p_task_id AND state='dispatching' AND lease_owner=p_worker AND lease_until>now();
 RETURN FOUND;
END $$;
CREATE FUNCTION public.cancel_queued_digital_video(p_task_id text,p_user_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j public.digital_video_dispatch_jobs%ROWTYPE;
BEGIN
 SELECT * INTO j FROM public.digital_video_dispatch_jobs WHERE task_id=p_task_id AND user_id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN RETURN 'not_found'; END IF;
 IF j.state='cancelled' THEN RETURN 'cancelled'; END IF;
 IF j.state<>'queued' THEN RETURN 'started'; END IF;
 UPDATE public.video_tasks SET status='cancelled',price_charged=0,error_message='已取消排队，本次未扣费',completed_at=now(),billing_state='submission_failed'
 WHERE id=p_task_id AND user_id=p_user_id AND task_id_external IS NULL AND status IN ('pending','queued') AND coalesce(price_charged,0)=0;
 IF NOT FOUND THEN RETURN 'started'; END IF;
 UPDATE public.digital_video_dispatch_jobs SET state='cancelled',lease_until=NULL,updated_at=now() WHERE task_id=p_task_id;
 RETURN 'cancelled';
END $$;
REVOKE ALL ON FUNCTION public.begin_digital_video_post(text,text),public.cancel_queued_digital_video(text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_digital_video_post(text,text),public.cancel_queued_digital_video(text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.reserve_queued_digital_video_task(jsonb,jsonb),public.claim_digital_video_dispatch(text),public.update_digital_video_dispatch(text,text,text,text,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_queued_digital_video_task(jsonb,jsonb),public.claim_digital_video_dispatch(text),public.update_digital_video_dispatch(text,text,text,text,text,text,integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
