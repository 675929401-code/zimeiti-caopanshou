BEGIN;

CREATE TABLE IF NOT EXISTS conversation_message_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  conversation_id text NOT NULL,
  message_id uuid NOT NULL,
  asset_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_message_attachments_message_asset_unique
    UNIQUE(message_id, asset_id),
  CONSTRAINT conversation_message_attachments_conversation_id_check
    CHECK (char_length(conversation_id) BETWEEN 1 AND 200),
  CONSTRAINT conversation_message_attachments_asset_id_check
    CHECK (asset_id ~ '^[A-Za-z0-9_-]{1,160}$')
);

CREATE INDEX IF NOT EXISTS conversation_message_attachments_history_idx
  ON conversation_message_attachments(user_id, conversation_id, message_id, created_at);

ALTER TABLE conversation_message_attachments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE conversation_message_attachments FROM anon, authenticated;
GRANT ALL ON TABLE conversation_message_attachments TO service_role;

DROP POLICY IF EXISTS conversation_message_attachments_service_role_all
  ON conversation_message_attachments;
CREATE POLICY conversation_message_attachments_service_role_all
  ON conversation_message_attachments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
