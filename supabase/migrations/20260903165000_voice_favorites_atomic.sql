BEGIN;
SET LOCAL lock_timeout='10s';
CREATE UNIQUE INDEX IF NOT EXISTS voice_favorites_account_voice_unique ON public.voice_favorites(user_id,voice_id,engine);
CREATE OR REPLACE FUNCTION public.save_voice_favorite_atomic(p_user_id text,p_voice_id text,p_voice_name text,p_engine text,p_gender text DEFAULT NULL,p_language text DEFAULT NULL,p_style_tags text[] DEFAULT '{}',p_is_cloned boolean DEFAULT false,p_clone_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_row public.voice_favorites%ROWTYPE; v_count integer;
BEGIN
 IF length(trim(coalesce(p_voice_id,''))) NOT BETWEEN 1 AND 160 OR length(trim(coalesce(p_voice_name,''))) NOT BETWEEN 1 AND 160 OR length(trim(coalesce(p_engine,''))) NOT BETWEEN 1 AND 40 THEN RAISE EXCEPTION 'VOICE_FAVORITE_INVALID'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('voice-favorites:'||p_user_id,0));
 SELECT * INTO v_row FROM public.voice_favorites WHERE user_id=p_user_id::uuid AND voice_id=p_voice_id AND engine=p_engine LIMIT 1;
 SELECT count(*) INTO v_count FROM public.voice_favorites WHERE user_id=p_user_id::uuid;
 IF FOUND AND v_row.id IS NOT NULL THEN RETURN jsonb_build_object('favorite',to_jsonb(v_row),'count',v_count,'max',100,'replayed',true); END IF;
 IF v_count>=100 THEN RAISE EXCEPTION 'VOICE_FAVORITE_LIMIT'; END IF;
 INSERT INTO public.voice_favorites(user_id,voice_id,voice_name,engine,gender,language,style_tags,is_cloned,clone_id) VALUES(p_user_id::uuid,p_voice_id,p_voice_name,p_engine,p_gender,p_language,p_style_tags,p_is_cloned,p_clone_id) RETURNING * INTO v_row;
 RETURN jsonb_build_object('favorite',to_jsonb(v_row),'count',v_count+1,'max',100);
END;$$;
REVOKE ALL ON FUNCTION public.save_voice_favorite_atomic(text,text,text,text,text,text,text[],boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_voice_favorite_atomic(text,text,text,text,text,text,text[],boolean,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
