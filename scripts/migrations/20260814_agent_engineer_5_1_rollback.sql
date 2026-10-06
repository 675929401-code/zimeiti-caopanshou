BEGIN;

DO $preflight$
BEGIN
  IF (
    SELECT count(*)
    FROM agent_config_migration_backups
    WHERE migration_key = '20260814_agent_engineer_5_1'
      AND agent_id = 'agent-1781690935600-gkt1xg'
  ) <> 1 THEN
    RAISE EXCEPTION 'agent_engineer_5_1 rollback preflight failed: backup row missing or duplicated';
  END IF;
  IF (
    SELECT count(*)
    FROM agents
    WHERE id = 'agent-1781690935600-gkt1xg'
      AND deleted_at IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'agent_engineer_5_1 rollback preflight failed: target row missing';
  END IF;
END
$preflight$;

UPDATE agents AS agent
SET
  name = backup.payload->>'name',
  system_prompt = backup.payload->>'system_prompt',
  preset_fields = backup.payload->'preset_fields',
  output_style = backup.payload->'output_style',
  response_format = backup.payload->>'response_format',
  max_context_rounds = NULLIF(backup.payload->>'max_context_rounds', '')::integer,
  max_context_tokens = NULLIF(backup.payload->>'max_context_tokens', '')::integer,
  max_reply_tokens = NULLIF(backup.payload->>'max_reply_tokens', '')::integer,
  guide_message = backup.payload->>'guide_message',
  updated_at = now()
FROM agent_config_migration_backups AS backup
WHERE backup.migration_key = '20260814_agent_engineer_5_1'
  AND backup.agent_id = 'agent-1781690935600-gkt1xg'
  AND agent.id = backup.agent_id;

DO $postcondition$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM agents AS agent
    JOIN agent_config_migration_backups AS backup
      ON backup.agent_id = agent.id
     AND backup.migration_key = '20260814_agent_engineer_5_1'
    WHERE agent.id = 'agent-1781690935600-gkt1xg'
      AND agent.name IS NOT DISTINCT FROM backup.payload->>'name'
      AND agent.system_prompt IS NOT DISTINCT FROM backup.payload->>'system_prompt'
      AND agent.preset_fields IS NOT DISTINCT FROM backup.payload->'preset_fields'
  ) THEN
    RAISE EXCEPTION 'agent_engineer_5_1 rollback postcondition failed';
  END IF;
END
$postcondition$;

COMMIT;
