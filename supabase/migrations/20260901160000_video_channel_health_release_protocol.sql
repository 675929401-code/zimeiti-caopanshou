-- Release protocol for video-channel health evidence.
-- This migration never marks a channel healthy or verified. Existing rows are
-- invalidated only at the release-evidence layer; missing active rows are
-- safely created as unverified and unhealthy.

DO $$
BEGIN
  IF to_regclass('public.video_models') IS NULL THEN
    RAISE EXCEPTION 'VIDEO_MODELS_BASELINE_REQUIRED';
  END IF;
  IF to_regclass('public.video_channel_health') IS NULL THEN
    RAISE EXCEPTION 'VIDEO_CHANNEL_HEALTH_BASELINE_REQUIRED';
  END IF;
END;
$$;

ALTER TABLE public.video_channel_health
  ADD COLUMN IF NOT EXISTS health_protocol_version text,
  ADD COLUMN IF NOT EXISTS verification_state text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.video_channel_health
  DROP CONSTRAINT IF EXISTS video_channel_health_verification_state_check;
ALTER TABLE public.video_channel_health
  ADD CONSTRAINT video_channel_health_verification_state_check
  CHECK (verification_state IN ('unverified', 'verified', 'revoked'));

ALTER TABLE public.video_channel_health
  DROP CONSTRAINT IF EXISTS video_channel_health_verification_shape_check;
ALTER TABLE public.video_channel_health
  ADD CONSTRAINT video_channel_health_verification_shape_check CHECK (
    jsonb_typeof(verification_evidence) = 'object'
    AND (
      verification_state <> 'verified'
      OR (
        health_protocol_version = 'video-channel-health.v2'
        AND is_healthy IS TRUE
        AND last_success_at IS NOT NULL
        AND verified_at IS NOT NULL
        AND verified_at >= last_success_at
        AND length(trim(coalesce(verification_evidence ->> 'evidence_id', ''))) >= 8
        AND length(trim(coalesce(verification_evidence ->> 'task_id', ''))) >= 8
      )
    )
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.video_channel_health
     GROUP BY channel_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'VIDEO_CHANNEL_HEALTH_DUPLICATE_CHANNEL_ID';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS video_channel_health_channel_unique
  ON public.video_channel_health (channel_id);

-- A protocol change requires a new, attributable canary. Preserve operational
-- metrics and the legacy is_healthy value, but do not inherit old evidence.
UPDATE public.video_channel_health
   SET health_protocol_version = 'video-channel-health.v2',
       verification_state = 'unverified',
       verified_at = NULL,
       verification_evidence = jsonb_build_object(
         'reason', 'current_protocol_canary_required',
         'migrated_at', now()
       ),
       updated_at = now()
 WHERE health_protocol_version IS DISTINCT FROM 'video-channel-health.v2';

INSERT INTO public.video_channel_health (
  channel_id,
  total_requests,
  success_count,
  fail_count,
  timeout_count,
  avg_response_ms,
  consecutive_failures,
  is_healthy,
  health_protocol_version,
  verification_state,
  verified_at,
  verification_evidence,
  updated_at
)
SELECT
  model.id,
  0,
  0,
  0,
  0,
  0,
  0,
  false,
  'video-channel-health.v2',
  'unverified',
  NULL,
  jsonb_build_object('reason', 'active_model_backfill_requires_canary'),
  now()
FROM public.video_models AS model
WHERE model.is_active IS TRUE
  AND NOT EXISTS (
    SELECT 1
      FROM public.video_channel_health AS health
     WHERE health.channel_id = model.id
  );

CREATE INDEX IF NOT EXISTS video_channel_health_release_protocol_idx
  ON public.video_channel_health (health_protocol_version, verification_state, is_healthy);
