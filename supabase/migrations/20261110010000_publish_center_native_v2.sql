BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
CREATE TABLE public.pub2_collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,name text NOT NULL,description text NOT NULL DEFAULT '',revision integer NOT NULL DEFAULT 1,archived boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id));
CREATE TABLE public.pub2_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,collection_id uuid,revision integer NOT NULL DEFAULT 1,archived boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,id),FOREIGN KEY(user_id,collection_id) REFERENCES public.pub2_collections(user_id,id));
CREATE TABLE public.pub2_draft_versions(user_id varchar(36) NOT NULL,draft_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(draft_id,version),FOREIGN KEY(user_id,draft_id) REFERENCES public.pub2_drafts(user_id,id) ON DELETE CASCADE);
CREATE TABLE public.pub2_groups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,name text NOT NULL,account_ids jsonb NOT NULL DEFAULT '[]',revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.pub2_account_meta(account_id uuid PRIMARY KEY REFERENCES public.pub_accounts(id),user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,label text NOT NULL DEFAULT '',notes text NOT NULL DEFAULT '',updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.pub2_batches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,draft_id uuid NOT NULL,draft_version integer NOT NULL,target_ids jsonb NOT NULL,account_snapshots jsonb NOT NULL,request_key text NOT NULL,fingerprint text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,request_key),FOREIGN KEY(draft_id,draft_version) REFERENCES public.pub2_draft_versions(draft_id,version));
CREATE TABLE public.pub2_schedules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,draft_id uuid NOT NULL,draft_version integer NOT NULL,target_id uuid NOT NULL,scheduled_at timestamptz NOT NULL,revision integer NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','cancelled','claimed')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,draft_id,draft_version,target_id),FOREIGN KEY(draft_id,draft_version) REFERENCES public.pub2_draft_versions(draft_id,version));
CREATE TABLE public.pub2_attempts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,batch_id uuid NOT NULL REFERENCES public.pub2_batches(id),target_id uuid NOT NULL,entitlement_id uuid NOT NULL REFERENCES public.pub_entitlements(id),platform text NOT NULL CHECK(platform IN ('xhs','wxSph')),transport text NOT NULL DEFAULT 'browser_plugin' CHECK(transport='browser_plugin'),snapshot jsonb NOT NULL,snapshot_hash text NOT NULL,request_key text NOT NULL,fingerprint text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,request_key),UNIQUE(batch_id,target_id));
CREATE TABLE public.pub2_attempt_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,attempt_id uuid NOT NULL REFERENCES public.pub2_attempts(id),kind text NOT NULL CHECK(kind IN ('browser_report','append_link')),request_key text NOT NULL,payload jsonb NOT NULL,source text NOT NULL CHECK((kind='browser_report' AND source='browser_reported') OR (kind='append_link' AND source='user_reported')),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,request_key));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pub2_collections','pub2_drafts','pub2_draft_versions','pub2_groups','pub2_account_meta','pub2_batches','pub2_schedules','pub2_attempts','pub2_attempt_events'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',t);
  EXECUTE format('CREATE INDEX %I ON public.%I(user_id)',t||'_owner_idx',t);
 END LOOP;
END $$;
CREATE FUNCTION public.pub2_immutable_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.users WHERE id=OLD.user_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'PUBLISH_V2_IMMUTABLE'; END $$;
CREATE TRIGGER pub2_versions_immutable BEFORE UPDATE OR DELETE ON public.pub2_draft_versions FOR EACH ROW EXECUTE FUNCTION public.pub2_immutable_guard();
CREATE TRIGGER pub2_batches_immutable BEFORE UPDATE OR DELETE ON public.pub2_batches FOR EACH ROW EXECUTE FUNCTION public.pub2_immutable_guard();
CREATE TRIGGER pub2_attempts_immutable BEFORE UPDATE OR DELETE ON public.pub2_attempts FOR EACH ROW EXECUTE FUNCTION public.pub2_immutable_guard();
CREATE TRIGGER pub2_events_immutable BEFORE UPDATE OR DELETE ON public.pub2_attempt_events FOR EACH ROW EXECUTE FUNCTION public.pub2_immutable_guard();

CREATE FUNCTION public.pub2_assert_json_keys(p_value jsonb,p_allowed text[],p_required text[]) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' OR NOT (p_value ?& p_required) OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_value) k WHERE NOT(k=ANY(p_allowed))) THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
END $$;
CREATE FUNCTION public.pub2_safe_https(p_url text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(length(p_url)<=2048 AND p_url ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,63}(:443)?([/?#]|$)' AND p_url !~* '^https://[^/?#]*\.(local|internal|localhost|test|invalid)(:443)?([/?#]|$)' AND p_url !~* '[?&#;][^=&#;]*(cookie|token|authorization|secret|password|passwd|api.?key|signature|credential)[^=&#;]*[=:]' AND p_url !~* '[?&#;](key|auth|session|sessionid|session_id)[=:]' AND p_url !~ '[\s\\]' AND p_url !~* '%(3[dD]|26|23|3[aA])',false)
$$;
CREATE FUNCTION public.pub2_assert_timestamp(p_value text) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF p_value IS NULL OR p_value !~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-](0\d|1[0-4]):[0-5]\d)$' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 PERFORM p_value::timestamptz;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END $$;
CREATE FUNCTION public.pub2_assert_input_shape(p_input jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE a text:=p_input->>'action'; required text[]; allowed text[]; d jsonb; m jsonb; t jsonb; o jsonb; r jsonb; k text; BEGIN
 CASE a
 WHEN 'save-collection' THEN required:=ARRAY['action','expectedRevision','name','description','archived'];
 WHEN 'save-draft' THEN required:=ARRAY['action','expectedRevision','draft'];
 WHEN 'archive-draft','delete-group','cancel-schedule' THEN required:=ARRAY['action','id','expectedRevision'];
 WHEN 'save-group' THEN required:=ARRAY['action','expectedRevision','name','accountIds'];
 WHEN 'save-account-meta' THEN required:=ARRAY['action','accountId','label','notes'];
 WHEN 'create-batch' THEN required:=ARRAY['action','draftId','draftVersion','targetIds','idempotencyKey'];
 WHEN 'save-schedule' THEN required:=ARRAY['action','draftId','draftVersion','targetId','scheduledAt'];
 WHEN 'reschedule' THEN required:=ARRAY['action','id','expectedRevision','scheduledAt'];
 WHEN 'claim' THEN required:=ARRAY['action','batchId','targetId','entitlementId','idempotencyKey'];
 WHEN 'report' THEN required:=ARRAY['action','attemptId','idempotencyKey','success'];
 WHEN 'append-link' THEN required:=ARRAY['action','attemptId','idempotencyKey','shareLink'];
 ELSE RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END CASE;
 allowed:=required;
 IF a IN ('save-collection','save-draft','save-group') THEN allowed:=allowed||ARRAY['id']; END IF;
 IF a IN ('report','append-link') THEN allowed:=allowed||ARRAY['workId','shareLink','note']; END IF;
 IF a='report' THEN allowed:=allowed||ARRAY['mediaMd5sum','videoClipTaskId','scheduledTime','publishTime','errorCode']; END IF;
 IF a='claim' THEN allowed:=allowed||ARRAY['scheduleId']; END IF;
 PERFORM public.pub2_assert_json_keys(p_input,allowed,required);
 IF EXISTS(SELECT 1 FROM jsonb_each(p_input) e WHERE e.value='null'::jsonb) THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 FOREACH k IN ARRAY ARRAY['id','accountId','draftId','batchId','targetId','entitlementId','attemptId','scheduleId'] LOOP
  IF p_input ? k AND (jsonb_typeof(p_input->k) IS DISTINCT FROM 'string' OR p_input->>k !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['expectedRevision','draftVersion'] LOOP
  IF p_input ? k AND (jsonb_typeof(p_input->k) IS DISTINCT FROM 'number' OR p_input->>k !~ '^\d+$') THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['name','description','label','notes','workId','shareLink','note','scheduledAt','idempotencyKey'] LOOP
  IF p_input ? k AND jsonb_typeof(p_input->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 END LOOP;
 IF p_input ? 'name' AND length(trim(p_input->>'name')) NOT BETWEEN 1 AND 200 OR p_input ? 'description' AND length(p_input->>'description')>2000 OR p_input ? 'label' AND length(p_input->>'label')>200 OR p_input ? 'notes' AND length(p_input->>'notes')>1000 OR p_input ? 'workId' AND length(p_input->>'workId')>240 OR p_input ? 'note' AND length(p_input->>'note')>1000 THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 IF p_input ? 'scheduledAt' AND p_input->>'scheduledAt' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 IF p_input ? 'scheduledAt' THEN PERFORM public.pub2_assert_timestamp(p_input->>'scheduledAt'); END IF;
 IF p_input ? 'publishTime' THEN PERFORM public.pub2_assert_timestamp(p_input->>'publishTime'); END IF;
 IF p_input ? 'shareLink' AND public.pub2_safe_https(p_input->>'shareLink') IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 IF a='report' THEN
  IF p_input ? 'mediaMd5sum' AND (jsonb_typeof(p_input->'mediaMd5sum') IS DISTINCT FROM 'string' OR p_input->>'mediaMd5sum' !~* '^[a-f0-9]{32}$') OR p_input ? 'videoClipTaskId' AND (jsonb_typeof(p_input->'videoClipTaskId') IS DISTINCT FROM 'string' OR p_input->>'videoClipTaskId' !~ '^[A-Za-z0-9_.:-]{1,200}$') OR p_input ? 'scheduledTime' AND (jsonb_typeof(p_input->'scheduledTime') IS DISTINCT FROM 'number' OR p_input->>'scheduledTime' !~ '^\d+$' OR (p_input->>'scheduledTime')::numeric NOT BETWEEN 1 AND 8639999999999999) OR p_input ? 'publishTime' AND (jsonb_typeof(p_input->'publishTime') IS DISTINCT FROM 'string' OR p_input->>'publishTime' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$') OR p_input ? 'errorCode' AND coalesce(p_input->>'errorCode','') NOT IN ('WX_SPH_LOGIN_EXPIRED','PUBLISH_FAILED','NETWORK_ERROR','UPLOAD_FAILED') THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 END IF;
 IF p_input ? 'idempotencyKey' AND (length(p_input->>'idempotencyKey') NOT BETWEEN 8 AND 160 OR p_input->>'idempotencyKey' !~ '^[A-Za-z0-9_.:-]+$') THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 IF p_input ? 'success' AND jsonb_typeof(p_input->'success') IS DISTINCT FROM 'boolean' OR p_input ? 'archived' AND jsonb_typeof(p_input->'archived') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 FOREACH k IN ARRAY ARRAY['targetIds','accountIds'] LOOP
  IF p_input ? k THEN
   IF jsonb_typeof(p_input->k) IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->k)>100 THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->k) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR x#>>'{}' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
   IF a='create-batch' AND jsonb_array_length(p_input->k)=0 THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  END IF;
 END LOOP;
 IF a<>'save-draft' THEN RETURN; END IF;
 d:=p_input->'draft';
 PERFORM public.pub2_assert_json_keys(d,ARRAY['schemaVersion','collectionId','contentType','title','body','topics','media','targets'],ARRAY['schemaVersion','collectionId','contentType','title','body','topics','media','targets']);
 IF d->'schemaVersion' IS DISTINCT FROM '2'::jsonb OR d->>'contentType' IS NULL OR d->>'contentType' NOT IN ('image','video') OR jsonb_typeof(d->'title') IS DISTINCT FROM 'string' OR length(d->>'title')>200 OR jsonb_typeof(d->'body') IS DISTINCT FROM 'string' OR length(d->>'body')>50000 OR jsonb_typeof(d->'topics') IS DISTINCT FROM 'array' OR jsonb_typeof(d->'media') IS DISTINCT FROM 'array' OR jsonb_typeof(d->'targets') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 IF d->'collectionId'<>'null'::jsonb AND (jsonb_typeof(d->'collectionId') IS DISTINCT FROM 'string' OR d->>'collectionId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 IF jsonb_array_length(d->'topics')>30 OR jsonb_array_length(d->'media')>30 OR jsonb_array_length(d->'targets')>100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'topics') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR length(trim(x#>>'{}')) NOT BETWEEN 1 AND 100) THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 FOR m IN SELECT * FROM jsonb_array_elements(d->'media') LOOP
  PERFORM public.pub2_assert_json_keys(m,ARRAY['id','role','fileName','size','type','lastModified','hash','width','height','duration','source','requiresReselection','reference'],ARRAY['id','role','fileName','size','type','lastModified','source','requiresReselection']);
  IF m->>'id' IS NULL OR m->>'id' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR m->>'role' IS NULL OR m->>'role' NOT IN ('image','video','cover') OR m->>'source' IS NULL OR m->>'source' NOT IN ('local_file','main_asset') OR jsonb_typeof(m->'fileName') IS DISTINCT FROM 'string' OR length(m->>'fileName') NOT BETWEEN 1 AND 255 OR jsonb_typeof(m->'type') IS DISTINCT FROM 'string' OR jsonb_typeof(m->'size') IS DISTINCT FROM 'number' OR jsonb_typeof(m->'lastModified') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 IF m->>'size' !~ '^\d+$' OR (m->>'size')::numeric>10737418240 OR m->>'lastModified' !~ '^\d+$' OR length(m->>'type')>120 OR m ? 'hash' AND (jsonb_typeof(m->'hash') IS DISTINCT FROM 'string' OR m->>'hash' !~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  FOREACH k IN ARRAY ARRAY['width','height','duration'] LOOP IF m ? k AND (jsonb_typeof(m->k) IS DISTINCT FROM 'number' OR (m->>k)::numeric<=0) THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF; END LOOP;
  IF m->>'source'='local_file' THEN
   IF m->'requiresReselection' IS DISTINCT FROM 'true'::jsonb OR m ? 'reference' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  ELSE
   IF m->'requiresReselection' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
   r:=m->'reference'; PERFORM public.pub2_assert_json_keys(r,ARRAY['kind','id'],ARRAY['kind','id']);
   IF r->>'kind' IS NULL OR r->>'kind' NOT IN ('video_task','image_asset','image_record') OR jsonb_typeof(r->'id') IS DISTINCT FROM 'string' OR r->>'id' !~ '^[A-Za-z0-9_.:-]{1,256}$' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  END IF;
 END LOOP;
 FOR t IN SELECT * FROM jsonb_array_elements(d->'targets') LOOP
  PERFORM public.pub2_assert_json_keys(t,ARRAY['id','accountId','platform','scheduledAt','titleOverride','bodyOverride','topicsOverride','mediaIds','coverMediaId','options'],ARRAY['id','accountId','platform','scheduledAt','options']);
  IF t->>'id' IS NULL OR t->>'accountId' IS NULL OR t->>'id' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR t->>'accountId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR t->>'platform' IS NULL OR t->>'platform' NOT IN ('xhs','wxSph','douyin') OR t->'scheduledAt'<>'null'::jsonb AND jsonb_typeof(t->'scheduledAt') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  FOREACH k IN ARRAY ARRAY['titleOverride','bodyOverride'] LOOP IF t ? k AND jsonb_typeof(t->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF; END LOOP;
  IF t ? 'titleOverride' AND length(t->>'titleOverride')>200 OR t ? 'bodyOverride' AND length(t->>'bodyOverride')>50000 OR t->'scheduledAt'<>'null'::jsonb AND t->>'scheduledAt' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  IF t->'scheduledAt'<>'null'::jsonb THEN PERFORM public.pub2_assert_timestamp(t->>'scheduledAt'); END IF;
  IF t ? 'topicsOverride' THEN
   IF jsonb_typeof(t->'topicsOverride') IS DISTINCT FROM 'array' OR jsonb_array_length(t->'topicsOverride')>30 OR EXISTS(SELECT 1 FROM jsonb_array_elements(t->'topicsOverride') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR length(trim(x#>>'{}')) NOT BETWEEN 1 AND 100) THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  END IF;
  IF t ? 'mediaIds' THEN
   IF jsonb_typeof(t->'mediaIds') IS DISTINCT FROM 'array' OR jsonb_array_length(t->'mediaIds') NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(t->'mediaIds') i WHERE jsonb_typeof(i) IS DISTINCT FROM 'string' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'media') mm WHERE mm->'id'=i)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(t->'mediaIds') i GROUP BY i HAVING count(*)>1) THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  END IF;
  IF t ? 'coverMediaId' AND (jsonb_typeof(t->'coverMediaId') IS DISTINCT FROM 'string' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'media') mm WHERE mm->'id'=t->'coverMediaId' AND mm->>'role' IN ('image','cover'))) THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  o:=t->'options';
  IF t->>'platform'='xhs' THEN
   PERFORM public.pub2_assert_json_keys(o,ARRAY['declaration'],ARRAY[]::text[]);
   IF o ? 'declaration' AND o->'declaration' NOT IN ('1'::jsonb,'2'::jsonb,'3'::jsonb) THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  ELSIF t->>'platform'='douyin' THEN
   PERFORM public.pub2_assert_json_keys(o,ARRAY['privacyLevel'],ARRAY[]::text[]);
   IF o ? 'privacyLevel' AND coalesce(o->>'privacyLevel','') NOT IN ('public','private') THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  ELSE
   PERFORM public.pub2_assert_json_keys(o,ARRAY['poiInfo','event','extLink','postFlag'],ARRAY[]::text[]);
   IF o ? 'postFlag' AND o->'postFlag' NOT IN ('0'::jsonb,'1'::jsonb) THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
   IF o ? 'extLink' AND (jsonb_typeof(o->'extLink') IS DISTINCT FROM 'string' OR public.pub2_safe_https(o->>'extLink') IS NOT TRUE) THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
   IF o ? 'poiInfo' THEN
    r:=o->'poiInfo'; PERFORM public.pub2_assert_json_keys(r,ARRAY['latitude','longitude','poiCity','poiName','poiAddress','poiId','province','region','fullAddress','poiCheckSum'],ARRAY[]::text[]);
    IF coalesce(nullif(trim(r->>'poiId'),''),trim(r->>'poiName'),'')='' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
    FOR k IN SELECT jsonb_object_keys(r) LOOP IF k IN ('latitude','longitude') THEN IF jsonb_typeof(r->k) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF; ELSIF jsonb_typeof(r->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF; END LOOP;
    IF r ? 'latitude' AND abs((r->>'latitude')::numeric)>90 OR r ? 'longitude' AND abs((r->>'longitude')::numeric)>180 THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
    FOR k IN SELECT jsonb_object_keys(r) LOOP IF k NOT IN ('latitude','longitude') AND length(r->>k)>(CASE WHEN k IN ('poiAddress','fullAddress') THEN 500 ELSE 200 END) THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF; END LOOP;
   END IF;
   IF o ? 'event' THEN
    r:=o->'event'; PERFORM public.pub2_assert_json_keys(r,ARRAY['eventTopicId','eventName','eventCreatorNickname','eventAttendCount'],ARRAY['eventTopicId','eventName']);
    IF coalesce(trim(r->>'eventTopicId'),'')='' OR coalesce(trim(r->>'eventName'),'')='' OR jsonb_typeof(r->'eventTopicId') IS DISTINCT FROM 'string' OR jsonb_typeof(r->'eventName') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
    IF length(r->>'eventTopicId')>200 OR length(r->>'eventName')>200 OR r ? 'eventCreatorNickname' AND (jsonb_typeof(r->'eventCreatorNickname') IS DISTINCT FROM 'string' OR length(r->>'eventCreatorNickname')>200) OR r ? 'eventAttendCount' AND (jsonb_typeof(r->'eventAttendCount') IS DISTINCT FROM 'number' OR r->>'eventAttendCount' !~ '^\d+$') THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
   END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'media') x GROUP BY x->>'id' HAVING count(*)>1) OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'targets') x GROUP BY x->>'id' HAVING count(*)>1) OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'targets') x GROUP BY x->>'platform',x->>'accountId' HAVING count(*)>1) THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
 IF d->>'contentType'='image' AND EXISTS(SELECT 1 FROM jsonb_array_elements(d->'media') x WHERE x->>'role'='video') THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
END $$;

CREATE FUNCTION public.pub2_assert_media(p_user_id text,p_payload jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m jsonb; r jsonb; BEGIN
 FOR m IN SELECT * FROM jsonb_array_elements(p_payload->'media') LOOP
  IF m->>'source'='main_asset' THEN
   r:=m->'reference';
   IF r->>'kind'='video_task' THEN
    IF m->>'role'<>'video' OR NOT EXISTS(SELECT 1 FROM public.video_tasks WHERE id::text=r->>'id' AND user_id::text=p_user_id AND status='completed' AND source_expired_at IS NULL) THEN RAISE EXCEPTION 'PUBLISH_V2_ASSET_UNAVAILABLE'; END IF;
   ELSIF r->>'kind'='image_asset' THEN
    IF m->>'role'='video' OR NOT EXISTS(SELECT 1 FROM public.user_files WHERE id::text=r->>'id' AND user_id::text=p_user_id AND content_type LIKE 'image/%') THEN RAISE EXCEPTION 'PUBLISH_V2_ASSET_UNAVAILABLE'; END IF;
   ELSIF r->>'kind'='image_record' THEN
    IF m->>'role'='video' OR NOT EXISTS(SELECT 1 FROM public.image_generation_requests WHERE record_id=r->>'id' AND user_id::text=p_user_id AND state='completed' AND delivery_state='delivered' AND response->>'deliveryMode'='provider_url' AND coalesce(response->>'sourceExpiredAt','')='') THEN RAISE EXCEPTION 'PUBLISH_V2_ASSET_UNAVAILABLE'; END IF;
   ELSE RAISE EXCEPTION 'PUBLISH_V2_ASSET_UNAVAILABLE'; END IF;
  ELSIF m->>'source'<>'local_file' THEN RAISE EXCEPTION 'PUBLISH_V2_ASSET_UNAVAILABLE'; END IF;
 END LOOP;
END $$;
CREATE FUNCTION public.mutate_publish_v2_atomic(p_user_id text,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a text:=p_input->>'action'; v_id uuid; v_row jsonb; v_draft public.pub2_drafts%ROWTYPE; v_payload jsonb; v_version integer; v_target jsonb; v_account public.pub_accounts%ROWTYPE; v_batch public.pub2_batches%ROWTYPE; v_schedule public.pub2_schedules%ROWTYPE; v_attempt public.pub2_attempts%ROWTYPE; v_event public.pub2_attempt_events%ROWTYPE; v_ent public.pub_entitlements%ROWTYPE; v_config public.pub_config_versions%ROWTYPE; v_fingerprint text; v_snapshot jsonb; v_receipt jsonb; v_kind text; v_accounts jsonb; v_binding jsonb; v_media jsonb; v_cover jsonb;
BEGIN
 PERFORM public.pub_assert_actor(p_user_id);
 PERFORM public.pub2_assert_input_shape(p_input);
 IF p_input ? 'id' THEN v_id:=(p_input->>'id')::uuid; END IF;
 IF a='save-collection' THEN
  IF v_id IS NULL THEN
   IF (p_input->>'expectedRevision')::integer<>0 THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
   INSERT INTO public.pub2_collections(user_id,name,description,archived) VALUES(p_user_id,p_input->>'name',p_input->>'description',(p_input->>'archived')::boolean) RETURNING to_jsonb(pub2_collections.*) INTO v_row;
  ELSE
   UPDATE public.pub2_collections SET name=p_input->>'name',description=p_input->>'description',archived=(p_input->>'archived')::boolean,revision=revision+1,updated_at=now() WHERE id=v_id AND user_id=p_user_id AND revision=(p_input->>'expectedRevision')::integer RETURNING to_jsonb(pub2_collections.*) INTO v_row;
   IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
  END IF;
  RETURN jsonb_build_object('kind','collection','row',v_row);
 ELSIF a IN ('save-draft','archive-draft') THEN
  IF v_id IS NULL THEN
   IF (p_input->>'expectedRevision')::integer<>0 OR a='archive-draft' THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
   INSERT INTO public.pub2_drafts(user_id) VALUES(p_user_id) RETURNING * INTO v_draft;
  ELSE
   SELECT * INTO v_draft FROM public.pub2_drafts WHERE id=v_id AND user_id=p_user_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_DRAFT_NOT_FOUND'; END IF;
   IF v_draft.revision<>(p_input->>'expectedRevision')::integer OR v_draft.archived THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
   v_draft.revision:=v_draft.revision+1;
  END IF;
  IF a='archive-draft' THEN
   SELECT payload INTO v_payload FROM public.pub2_draft_versions WHERE draft_id=v_draft.id AND version=v_draft.revision-1;
  ELSE v_payload:=p_input->'draft'; END IF;
  IF a='save-draft' THEN PERFORM public.pub2_assert_media(p_user_id,v_payload); END IF;
  IF a='save-draft' AND v_payload->>'collectionId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.pub2_collections WHERE id=(v_payload->>'collectionId')::uuid AND user_id=p_user_id AND NOT archived) THEN RAISE EXCEPTION 'PUBLISH_V2_COLLECTION_NOT_FOUND'; END IF;
  IF a='save-draft' AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'targets') t WHERE NOT EXISTS(SELECT 1 FROM public.pub_accounts ac WHERE ac.id=(t->>'accountId')::uuid AND ac.user_id=p_user_id AND ac.platform=t->>'platform')) THEN RAISE EXCEPTION 'PUBLISH_ACCOUNT_NOT_FOUND'; END IF;
  UPDATE public.pub2_drafts SET collection_id=(v_payload->>'collectionId')::uuid,revision=v_draft.revision,archived=(a='archive-draft'),updated_at=now() WHERE id=v_draft.id RETURNING * INTO v_draft;
  INSERT INTO public.pub2_draft_versions(user_id,draft_id,version,payload) VALUES(p_user_id,v_draft.id,v_draft.revision,v_payload);
  RETURN jsonb_build_object('kind','draft','row',to_jsonb(v_draft)||jsonb_build_object('payload',v_payload));
 ELSIF a='save-group' THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_input->'accountIds') i WHERE NOT EXISTS(SELECT 1 FROM public.pub_accounts ac WHERE ac.id=i::uuid AND ac.user_id=p_user_id)) THEN RAISE EXCEPTION 'PUBLISH_ACCOUNT_NOT_FOUND'; END IF;
  IF v_id IS NULL THEN
   IF (p_input->>'expectedRevision')::integer<>0 THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
   INSERT INTO public.pub2_groups(user_id,name,account_ids) VALUES(p_user_id,p_input->>'name',p_input->'accountIds') RETURNING to_jsonb(pub2_groups.*) INTO v_row;
  ELSE
   UPDATE public.pub2_groups SET name=p_input->>'name',account_ids=p_input->'accountIds',revision=revision+1,updated_at=now() WHERE id=v_id AND user_id=p_user_id AND revision=(p_input->>'expectedRevision')::integer RETURNING to_jsonb(pub2_groups.*) INTO v_row;
   IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
  END IF;
  RETURN jsonb_build_object('kind','group','row',v_row);
 ELSIF a='delete-group' THEN
  DELETE FROM public.pub2_groups WHERE id=v_id AND user_id=p_user_id AND revision=(p_input->>'expectedRevision')::integer;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
  RETURN jsonb_build_object('deleted',true);
 ELSIF a='save-account-meta' THEN
  IF NOT EXISTS(SELECT 1 FROM public.pub_accounts WHERE id=(p_input->>'accountId')::uuid AND user_id=p_user_id) THEN RAISE EXCEPTION 'PUBLISH_ACCOUNT_NOT_FOUND'; END IF;
  INSERT INTO public.pub2_account_meta(account_id,user_id,label,notes) VALUES((p_input->>'accountId')::uuid,p_user_id,p_input->>'label',p_input->>'notes') ON CONFLICT(account_id) DO UPDATE SET label=EXCLUDED.label,notes=EXCLUDED.notes,updated_at=now() RETURNING to_jsonb(pub2_account_meta.*) INTO v_row;
  RETURN jsonb_build_object('kind','accountMeta','row',v_row);
 ELSIF a IN ('create-batch','save-schedule') THEN
  SELECT * INTO v_draft FROM public.pub2_drafts WHERE id=(p_input->>'draftId')::uuid AND user_id=p_user_id AND NOT archived;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_DRAFT_NOT_FOUND'; END IF;
  v_version:=(p_input->>'draftVersion')::integer;
  SELECT payload INTO v_payload FROM public.pub2_draft_versions WHERE draft_id=v_draft.id AND user_id=p_user_id AND version=v_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_REVISION_CONFLICT'; END IF;
  IF a='create-batch' THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_input->'targetIds') i WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'targets') t WHERE t->>'id'=i)) THEN RAISE EXCEPTION 'PUBLISH_V2_TARGET_NOT_FOUND'; END IF;
   v_fingerprint:=encode(sha256(convert_to((p_input-'idempotencyKey')::text,'UTF8')),'hex');
   SELECT * INTO v_batch FROM public.pub2_batches WHERE user_id=p_user_id AND request_key=p_input->>'idempotencyKey';
   IF FOUND THEN
    IF v_batch.fingerprint<>v_fingerprint THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN jsonb_build_object('kind','batch','row',to_jsonb(v_batch),'alreadyFulfilled',true);
   END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'targets') t WHERE p_input->'targetIds' ? (t->>'id') AND NOT EXISTS(SELECT 1 FROM public.pub_accounts ac WHERE ac.id=(t->>'accountId')::uuid AND ac.user_id=p_user_id AND ac.platform=t->>'platform')) THEN RAISE EXCEPTION 'PUBLISH_ACCOUNT_NOT_FOUND'; END IF;
   SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('id',ac.id,'platform',ac.platform,'platformAccountId',ac.platform_account_id,'displayName',ac.display_name,'updatedAt',ac.updated_at)),'[]') INTO v_accounts FROM public.pub_accounts ac JOIN jsonb_array_elements(v_payload->'targets') t ON ac.id=(t->>'accountId')::uuid WHERE ac.user_id=p_user_id AND p_input->'targetIds' ? (t->>'id');
   INSERT INTO public.pub2_batches(user_id,draft_id,draft_version,target_ids,account_snapshots,request_key,fingerprint) VALUES(p_user_id,v_draft.id,v_version,p_input->'targetIds',v_accounts,p_input->>'idempotencyKey',v_fingerprint) RETURNING * INTO v_batch;
   RETURN jsonb_build_object('kind','batch','row',to_jsonb(v_batch));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'targets') t WHERE t->>'id'=p_input->>'targetId') THEN RAISE EXCEPTION 'PUBLISH_V2_TARGET_NOT_FOUND'; END IF;
  IF (p_input->>'scheduledAt')::timestamptz<=now() THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM public.pub2_attempts at JOIN public.pub2_batches b ON b.id=at.batch_id WHERE at.user_id=p_user_id AND b.draft_id=v_draft.id AND b.draft_version=v_version AND at.target_id=(p_input->>'targetId')::uuid) THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_LOCKED'; END IF;
  INSERT INTO public.pub2_schedules(user_id,draft_id,draft_version,target_id,scheduled_at) VALUES(p_user_id,v_draft.id,v_version,(p_input->>'targetId')::uuid,(p_input->>'scheduledAt')::timestamptz) RETURNING * INTO v_schedule;
  RETURN jsonb_build_object('kind','schedule','row',to_jsonb(v_schedule));
 ELSIF a IN ('reschedule','cancel-schedule') THEN
  IF a='reschedule' AND (p_input->>'scheduledAt')::timestamptz<=now() THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_INVALID'; END IF;
  UPDATE public.pub2_schedules SET scheduled_at=CASE WHEN a='reschedule' THEN (p_input->>'scheduledAt')::timestamptz ELSE scheduled_at END,state=CASE WHEN a='cancel-schedule' THEN 'cancelled' ELSE 'planned' END,revision=revision+1,updated_at=now() WHERE id=v_id AND user_id=p_user_id AND revision=(p_input->>'expectedRevision')::integer AND state='planned' RETURNING * INTO v_schedule;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_LOCKED'; END IF;
  RETURN jsonb_build_object('kind','schedule','row',to_jsonb(v_schedule));
 ELSIF a='claim' THEN
  v_fingerprint:=encode(sha256(convert_to((p_input-'idempotencyKey')::text,'UTF8')),'hex');
  SELECT * INTO v_attempt FROM public.pub2_attempts WHERE user_id=p_user_id AND request_key=p_input->>'idempotencyKey';
  IF FOUND THEN
   IF v_attempt.fingerprint<>v_fingerprint THEN RAISE EXCEPTION 'PUBLISH_IDEMPOTENCY_CONFLICT'; END IF;
   RETURN jsonb_build_object('kind','attempt','row',to_jsonb(v_attempt),'shouldExecute',false,'alreadyFulfilled',true);
  END IF;
  SELECT * INTO v_batch FROM public.pub2_batches WHERE id=(p_input->>'batchId')::uuid AND user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_V2_BATCH_NOT_FOUND'; END IF;
  IF NOT (v_batch.target_ids ? (p_input->>'targetId')) THEN RAISE EXCEPTION 'PUBLISH_V2_TARGET_NOT_FOUND'; END IF;
  SELECT * INTO v_attempt FROM public.pub2_attempts WHERE batch_id=v_batch.id AND target_id=(p_input->>'targetId')::uuid;
  IF FOUND THEN RAISE EXCEPTION 'PUBLISH_V2_TARGET_ALREADY_CLAIMED'; END IF;
  SELECT * INTO v_draft FROM public.pub2_drafts WHERE id=v_batch.draft_id AND user_id=p_user_id AND NOT archived;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_DRAFT_NOT_FOUND'; END IF;
  SELECT payload INTO v_payload FROM public.pub2_draft_versions WHERE draft_id=v_batch.draft_id AND version=v_batch.draft_version AND user_id=p_user_id;
  SELECT t INTO v_target FROM jsonb_array_elements(v_payload->'targets') t WHERE t->>'id'=p_input->>'targetId';
  IF v_target IS NULL THEN RAISE EXCEPTION 'PUBLISH_V2_TARGET_NOT_FOUND'; END IF;
  IF v_target->>'platform' NOT IN ('xhs','wxSph') THEN RAISE EXCEPTION 'PUBLISH_V2_TRANSPORT_UNCONFIGURED'; END IF;
  SELECT * INTO v_config FROM public.pub_config_versions ORDER BY version DESC LIMIT 1 FOR SHARE;
  IF NOT FOUND OR v_config.execution_enabled IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_EXECUTION_DISABLED'; END IF;
  IF coalesce(v_config.enabled_platforms ? (v_target->>'platform'),false) IS NOT TRUE THEN RAISE EXCEPTION 'PUBLISH_PLATFORM_DISABLED'; END IF;
  SELECT * INTO v_account FROM public.pub_accounts WHERE id=(v_target->>'accountId')::uuid AND user_id=p_user_id AND platform=v_target->>'platform' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_ACCOUNT_NOT_FOUND'; END IF;
  SELECT x INTO v_binding FROM jsonb_array_elements(v_batch.account_snapshots) x WHERE x->>'id'=v_account.id::text;
  IF v_binding IS NULL OR v_binding->'updatedAt'<>to_jsonb(v_account.updated_at) OR v_binding->>'platformAccountId'<>v_account.platform_account_id THEN RAISE EXCEPTION 'PUBLISH_V2_ACCOUNT_CHANGED'; END IF;
  v_media:=v_payload->'media';
  IF v_target ? 'mediaIds' THEN SELECT coalesce(jsonb_agg(m ORDER BY i.ordinality),'[]') INTO v_media FROM jsonb_array_elements_text(v_target->'mediaIds') WITH ORDINALITY i(id,ordinality) JOIN jsonb_array_elements(v_payload->'media') m ON m->>'id'=i.id; END IF;
  IF v_target ? 'coverMediaId' THEN
   SELECT m||'{"role":"cover"}'::jsonb INTO v_cover FROM jsonb_array_elements(v_payload->'media') m WHERE m->>'id'=v_target->>'coverMediaId';
   SELECT coalesce(jsonb_agg(m),'[]') INTO v_media FROM jsonb_array_elements(v_media) m WHERE m->>'role'<>'cover' AND m->>'id'<>v_target->>'coverMediaId';
   v_media:=v_media||jsonb_build_array(v_cover);
  END IF;
  PERFORM public.pub2_assert_media(p_user_id,jsonb_build_object('media',v_media));
  IF v_payload->>'contentType'='image' AND (v_target->>'platform'<>'xhs' OR (SELECT count(*) FROM jsonb_array_elements(v_media) m WHERE m->>'role'='image') NOT BETWEEN 1 AND 9) THEN RAISE EXCEPTION 'PUBLISH_V2_MEDIA_INVALID'; END IF;
  IF v_payload->>'contentType'='video' AND ((SELECT count(*) FROM jsonb_array_elements(v_media) m WHERE m->>'role'='video')<>1 OR (SELECT count(*) FROM jsonb_array_elements(v_media) m WHERE m->>'role'='cover')<>1) THEN RAISE EXCEPTION 'PUBLISH_V2_MEDIA_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_media) m WHERE coalesce((m->>'size')::numeric,0)<=0 OR (m->>'role'='video' AND m->>'type' NOT LIKE 'video/%') OR (m->>'role'<>'video' AND m->>'type' NOT LIKE 'image/%')) THEN RAISE EXCEPTION 'PUBLISH_V2_MEDIA_INVALID'; END IF;
  IF v_target->>'platform'='wxSph' AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_media) m WHERE m->>'role'='video' AND (coalesce((m->>'width')::numeric,0)<=0 OR coalesce((m->>'height')::numeric,0)<=0 OR coalesce((m->>'duration')::numeric,0)<=0)) THEN RAISE EXCEPTION 'PUBLISH_V2_MEDIA_INVALID'; END IF;
  IF v_target->>'platform'='xhs' AND v_target->>'scheduledAt' IS NOT NULL THEN RAISE EXCEPTION 'PUBLISH_V2_NATIVE_SCHEDULE_UNAVAILABLE'; END IF;
  IF v_target->>'scheduledAt' IS NOT NULL AND (v_target->>'scheduledAt')::timestamptz<=now() THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_INVALID'; END IF;
  IF p_input ? 'scheduleId' THEN
   SELECT * INTO v_schedule FROM public.pub2_schedules WHERE id=(p_input->>'scheduleId')::uuid AND user_id=p_user_id AND draft_id=v_batch.draft_id AND draft_version=v_batch.draft_version AND target_id=(p_input->>'targetId')::uuid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_NOT_FOUND'; END IF;
   IF v_schedule.state<>'planned' THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_LOCKED'; END IF;
   IF v_schedule.scheduled_at>now() THEN RAISE EXCEPTION 'PUBLISH_V2_SCHEDULE_NOT_DUE'; END IF;
  END IF;
  SELECT * INTO v_ent FROM public.pub_entitlements WHERE id=(p_input->>'entitlementId')::uuid AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_ENTITLEMENT_NOT_FOUND'; END IF;
  IF v_ent.expires_at<=now() THEN RAISE EXCEPTION 'PUBLISH_ENTITLEMENT_EXPIRED'; END IF;
  IF v_ent.used>=v_ent.quota THEN RAISE EXCEPTION 'PUBLISH_NO_QUOTA'; END IF;
  IF NOT (v_ent.platforms ? (v_target->>'platform')) THEN RAISE EXCEPTION 'PUBLISH_PLATFORM_NOT_ALLOWED'; END IF;
  v_snapshot:=jsonb_build_object('draft',v_payload,'draftId',v_batch.draft_id,'draftVersion',v_batch.draft_version,'target',v_target,'account',v_binding,'transport','browser_plugin','localSchedule',CASE WHEN v_schedule.id IS NULL THEN NULL ELSE jsonb_build_object('id',v_schedule.id,'scheduledAt',v_schedule.scheduled_at) END);
  UPDATE public.pub_entitlements SET used=used+1 WHERE id=v_ent.id;
  INSERT INTO public.pub2_attempts(user_id,batch_id,target_id,entitlement_id,platform,snapshot,snapshot_hash,request_key,fingerprint) VALUES(p_user_id,v_batch.id,(p_input->>'targetId')::uuid,v_ent.id,v_target->>'platform',v_snapshot,encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex'),p_input->>'idempotencyKey',v_fingerprint) RETURNING * INTO v_attempt;
  IF v_schedule.id IS NOT NULL THEN UPDATE public.pub2_schedules SET state='claimed',revision=revision+1,updated_at=now() WHERE id=v_schedule.id; END IF;
  RETURN jsonb_build_object('kind','attempt','row',to_jsonb(v_attempt),'shouldExecute',true,'alreadyFulfilled',false);
 ELSIF a IN ('report','append-link') THEN
  SELECT * INTO v_attempt FROM public.pub2_attempts WHERE id=(p_input->>'attemptId')::uuid AND user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_V2_ATTEMPT_NOT_FOUND'; END IF;
  v_kind:=CASE WHEN a='report' THEN 'browser_report' ELSE 'append_link' END;
  v_receipt:=p_input-'action'-'attemptId'-'idempotencyKey';
  IF p_input ? 'shareLink' AND NOT (CASE WHEN v_attempt.platform='xhs' THEN p_input->>'shareLink' ~* '^https://([A-Za-z0-9-]+\.)*(xiaohongshu\.com|xhslink\.com)(:443)?([/?#]|$)' ELSE p_input->>'shareLink' ~* '^https://([A-Za-z0-9-]+\.)*weixin\.qq\.com(:443)?([/?#]|$)' END) THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
  SELECT * INTO v_event FROM public.pub2_attempt_events WHERE user_id=p_user_id AND request_key=p_input->>'idempotencyKey';
  IF FOUND THEN
   IF v_event.attempt_id<>v_attempt.id OR v_event.kind<>v_kind OR v_event.payload<>v_receipt THEN RAISE EXCEPTION 'PUBLISH_RECEIPT_CONFLICT'; END IF;
   RETURN jsonb_build_object('kind','event','row',to_jsonb(v_event),'alreadyFulfilled',true);
  END IF;
  IF a='report' AND EXISTS(SELECT 1 FROM public.pub2_attempt_events WHERE attempt_id=v_attempt.id AND kind='browser_report' AND payload<>v_receipt) THEN RAISE EXCEPTION 'PUBLISH_RECEIPT_CONFLICT'; END IF;
  INSERT INTO public.pub2_attempt_events(user_id,attempt_id,kind,request_key,payload,source) VALUES(p_user_id,v_attempt.id,v_kind,p_input->>'idempotencyKey',v_receipt,CASE WHEN a='report' THEN 'browser_reported' ELSE 'user_reported' END) RETURNING * INTO v_event;
  RETURN jsonb_build_object('kind','event','row',to_jsonb(v_event));
 END IF;
 RAISE EXCEPTION 'PUBLISH_INPUT_INVALID';
END $$;
REVOKE ALL ON FUNCTION public.pub2_immutable_guard() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pub2_assert_json_keys(jsonb,text[],text[]) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pub2_safe_https(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pub2_assert_timestamp(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pub2_assert_input_shape(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pub2_assert_media(text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.mutate_publish_v2_atomic(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_publish_v2_atomic(text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
