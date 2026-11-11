BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='120s';
-- PostgreSQL POSIX bounded repetition cannot exceed 255. Keep the 256-character
-- contract via an explicit length check and an unbounded closed character class.
CREATE OR REPLACE FUNCTION public.pub2_assert_input_shape(p_input jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
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
   IF r->>'kind' IS NULL OR r->>'kind' NOT IN ('video_task','image_asset','image_record') OR jsonb_typeof(r->'id') IS DISTINCT FROM 'string' OR length(r->>'id') NOT BETWEEN 1 AND 256 OR r->>'id' !~ '^[A-Za-z0-9_.:-]+$' THEN RAISE EXCEPTION 'PUBLISH_INPUT_INVALID'; END IF;
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

NOTIFY pgrst,'reload schema';
COMMIT;
