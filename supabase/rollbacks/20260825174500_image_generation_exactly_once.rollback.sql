-- Manual destructive rollback for 20260825174500_image_generation_exactly_once.sql.
-- Run only after the image generation service has been stopped and all intents
-- have been reconciled.

REVOKE ALL ON FUNCTION public.save_image_generation_request(text, text, text, jsonb)
  FROM service_role;
REVOKE ALL ON FUNCTION public.finalize_image_generation_delivery(text, text, text, text, text, bigint, text, text, jsonb)
  FROM service_role;
REVOKE ALL ON FUNCTION public.claim_image_generation_request(text, text, text, text, text, text)
  FROM service_role;
DROP FUNCTION IF EXISTS public.save_image_generation_request(text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.finalize_image_generation_delivery(text, text, text, text, text, bigint, text, text, jsonb);
DROP FUNCTION IF EXISTS public.claim_image_generation_request(text, text, text, text, text, text);
DROP TABLE IF EXISTS public.image_generation_requests;
