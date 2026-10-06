DROP FUNCTION IF EXISTS public.finalize_video_generation_task_atomic(text, text, text, text, bigint, boolean);

ALTER FUNCTION public.finalize_video_generation_task_persistent_v1(text, text, text, text, bigint, boolean)
  RENAME TO finalize_video_generation_task_atomic;

REVOKE ALL ON FUNCTION public.finalize_video_generation_task_atomic(text, text, text, text, bigint, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_video_generation_task_atomic(text, text, text, text, bigint, boolean)
  TO service_role;
