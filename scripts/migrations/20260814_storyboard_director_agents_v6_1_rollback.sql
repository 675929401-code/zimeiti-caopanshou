BEGIN;

DO $preflight$
BEGIN
  IF (
    SELECT count(*)
    FROM agent_config_migration_backups
    WHERE migration_key = '20260814_storyboard_director_agents_v6_1'
      AND agent_id IN (
        'agent-1786633444187-594spj',
        'agent-1786642714227-e1zid1',
        'agent-1786642714448-m6iaou'
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'storyboard v6.1 rollback preflight failed: expected exactly 3 backup rows';
  END IF;
  IF (
    SELECT count(*)
    FROM agents
    WHERE id IN (
      'agent-1786633444187-594spj',
      'agent-1786642714227-e1zid1',
      'agent-1786642714448-m6iaou'
    )
      AND deleted_at IS NULL
  ) <> 3 THEN
    RAISE EXCEPTION 'storyboard v6.1 rollback preflight failed: targets missing';
  END IF;
END
$preflight$;

UPDATE agents AS agent
SET
  name = backup.payload->>'name',
  description = backup.payload->>'description',
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
WHERE backup.migration_key = '20260814_storyboard_director_agents_v6_1'
  AND backup.agent_id = agent.id
  AND agent.id IN (
    'agent-1786633444187-594spj',
    'agent-1786642714227-e1zid1',
    'agent-1786642714448-m6iaou'
  );

DO $postcondition$
BEGIN
  IF (
    SELECT count(*)
    FROM agents AS agent
    JOIN agent_config_migration_backups AS backup
      ON backup.agent_id = agent.id
     AND backup.migration_key = '20260814_storyboard_director_agents_v6_1'
    WHERE agent.id IN (
      'agent-1786633444187-594spj',
      'agent-1786642714227-e1zid1',
      'agent-1786642714448-m6iaou'
    )
      AND agent.name IS NOT DISTINCT FROM backup.payload->>'name'
      AND agent.system_prompt IS NOT DISTINCT FROM backup.payload->>'system_prompt'
      AND agent.preset_fields IS NOT DISTINCT FROM backup.payload->'preset_fields'
  ) <> 3 THEN
    RAISE EXCEPTION 'storyboard v6.1 rollback postcondition failed';
  END IF;
END
$postcondition$;

COMMIT;
