BEGIN;

DO $$
DECLARE
  current_type text;
BEGIN
  SELECT data_type
    INTO current_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'conversation_message_attachments'
     AND column_name = 'message_id';

  IF current_type IS NULL THEN
    RAISE EXCEPTION 'conversation_message_attachments.message_id is missing';
  ELSIF current_type = 'uuid' THEN
    ALTER TABLE public.conversation_message_attachments
      ALTER COLUMN message_id TYPE text USING message_id::text;
  ELSIF current_type <> 'text' THEN
    RAISE EXCEPTION 'unexpected message_id type: %', current_type;
  END IF;
END $$;

COMMIT;
