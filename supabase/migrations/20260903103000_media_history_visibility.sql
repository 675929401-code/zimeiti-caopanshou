BEGIN;
ALTER TABLE public.video_tasks ADD COLUMN IF NOT EXISTS history_hidden_at timestamptz;
ALTER TABLE public.conversation_messages ADD COLUMN IF NOT EXISTS media_hidden_indices integer[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS video_tasks_visible_history_idx ON public.video_tasks(user_id, created_at DESC) WHERE history_hidden_at IS NULL;
CREATE OR REPLACE FUNCTION public.hide_media_history_item(p_user_id text, p_kind text, p_record_id text, p_index integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_task public.video_tasks%ROWTYPE; v_message public.conversation_messages%ROWTYPE; v_gallery jsonb; v_images jsonb;
BEGIN
 IF p_kind = 'video' THEN
  SELECT * INTO v_task FROM public.video_tasks WHERE id=p_record_id AND user_id::text=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_HISTORY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF coalesce(v_task.status,'') NOT IN ('completed','failed','cancelled','expired') OR coalesce(v_task.billing_state,'') IN ('reserved','provider_submitted','settling','settlement_pending','unknown') THEN
   RAISE EXCEPTION 'MEDIA_HISTORY_TASK_PENDING' USING ERRCODE='P0001';
  END IF;
  UPDATE public.video_tasks SET history_hidden_at=coalesce(history_hidden_at,clock_timestamp()) WHERE id=p_record_id;
 ELSIF p_kind = 'image' THEN
  SELECT * INTO v_message FROM public.conversation_messages WHERE id=p_record_id AND user_id=p_user_id AND role='assistant' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_HISTORY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  BEGIN v_gallery := v_message.content::jsonb; EXCEPTION WHEN OTHERS THEN v_gallery := NULL; END;
  IF v_gallery->>'type' IS DISTINCT FROM 'image_gallery' OR jsonb_typeof(v_gallery->'images') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'MEDIA_HISTORY_NOT_FOUND' USING ERRCODE='P0002';
  END IF;
  SELECT coalesce(jsonb_agg(e.value ORDER BY e.ordinality),'[]'::jsonb) INTO v_images FROM jsonb_array_elements(v_gallery->'images') WITH ORDINALITY e(value,ordinality) WHERE jsonb_typeof(e.value)='object' AND jsonb_typeof(e.value->'url')='string';
  IF p_index IS NULL OR p_index<0 OR p_index>=jsonb_array_length(v_images) THEN RAISE EXCEPTION 'MEDIA_HISTORY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  UPDATE public.conversation_messages SET media_hidden_indices=CASE WHEN p_index=ANY(media_hidden_indices) THEN media_hidden_indices ELSE array_append(media_hidden_indices,p_index) END WHERE id=p_record_id;
 ELSE RAISE EXCEPTION 'MEDIA_HISTORY_INVALID_KIND' USING ERRCODE='22023';
 END IF;
 RETURN jsonb_build_object('success',true);
END;
$$;
REVOKE ALL ON FUNCTION public.hide_media_history_item(text,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hide_media_history_item(text,text,text,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
