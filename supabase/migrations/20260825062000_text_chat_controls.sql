BEGIN;

CREATE TABLE IF NOT EXISTS text_chat_conversation_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Live PostgREST metadata exposes conversations.user_id as uuid while the
  -- legacy users.id column is varchar(36). Keep the control tables on the
  -- conversation ownership type and enforce ownership in the authenticated API;
  -- a cross-type FK to users(id) would be undeployable.
  user_id uuid NOT NULL,
  conversation_id text NOT NULL,
  paid_tool_authorization_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT text_chat_conversation_settings_owner_unique UNIQUE(user_id, conversation_id),
  CONSTRAINT text_chat_conversation_settings_conversation_id_check
    CHECK (char_length(conversation_id) BETWEEN 1 AND 200)
);

CREATE TABLE IF NOT EXISTS text_chat_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  content text NOT NULL,
  source_conversation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT text_chat_memories_content_check
    CHECK (char_length(btrim(content)) BETWEEN 1 AND 2000)
);

CREATE INDEX IF NOT EXISTS text_chat_conversation_settings_owner_idx
  ON text_chat_conversation_settings(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS text_chat_memories_owner_idx
  ON text_chat_memories(user_id, updated_at DESC);

ALTER TABLE text_chat_conversation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE text_chat_memories ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE text_chat_conversation_settings FROM anon, authenticated;
REVOKE ALL ON TABLE text_chat_memories FROM anon, authenticated;
GRANT ALL ON TABLE text_chat_conversation_settings TO service_role;
GRANT ALL ON TABLE text_chat_memories TO service_role;

DROP POLICY IF EXISTS text_chat_conversation_settings_service_role_all
  ON text_chat_conversation_settings;
CREATE POLICY text_chat_conversation_settings_service_role_all
  ON text_chat_conversation_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS text_chat_memories_service_role_all ON text_chat_memories;
CREATE POLICY text_chat_memories_service_role_all
  ON text_chat_memories
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
