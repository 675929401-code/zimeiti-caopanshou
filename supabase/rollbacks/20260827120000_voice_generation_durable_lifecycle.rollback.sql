BEGIN;

DROP FUNCTION IF EXISTS public.refund_voice_generation_atomic(
  text, text, text, numeric, text, text, text, jsonb, boolean
);
DROP FUNCTION IF EXISTS public.finalize_voice_generation_atomic(
  text, text, text, text, text, text, jsonb, jsonb
);
DROP FUNCTION IF EXISTS public.begin_voice_generation_atomic(
  text, text, text, text, text, text, text, numeric, numeric, boolean, jsonb, jsonb
);
DROP TABLE IF EXISTS public.voice_generation_requests;

NOTIFY pgrst, 'reload schema';

COMMIT;
