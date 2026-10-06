BEGIN;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'llm_request_attempts',
    'image_generation_requests',
    'video_tasks',
    'voice_generation_requests',
    'extraction_attempts'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS operation_flight_recorder ON public.%I', v_table);
    END IF;
  END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS public.capture_operation_flight_event();
DROP TABLE IF EXISTS public.operation_flight_events;

COMMIT;
