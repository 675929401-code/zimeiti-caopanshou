BEGIN;

DROP INDEX IF EXISTS public.operation_flight_events_trace_sequence_idx;
ALTER TABLE IF EXISTS public.operation_flight_events
  DROP COLUMN IF EXISTS capture_sequence;

COMMIT;
