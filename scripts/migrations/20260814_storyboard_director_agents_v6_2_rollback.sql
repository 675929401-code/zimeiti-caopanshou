BEGIN;

DO $preflight$
BEGIN
  IF (
    SELECT count(*)
    FROM agent_config_migration_backups
    WHERE migration_key = '20260814_storyboard_director_agents_v6_2'
      AND agent_id IN (
        'agent-1786633444187-594spj',
        'agent-1786642714227-e1zid1',
        'agent-1786642714448-m6iaou'
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'storyboard v6.2 rollback preflight failed: expected exactly 3 backup rows';
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
    RAISE EXCEPTION 'storyboard v6.2 rollback preflight failed: targets missing';
  END IF;
END
$preflight$;

UPDATE agents AS agent
SET
  name = backup.payload->>'name',
  description = backup.payload->>'description',
  category = backup.payload->>'category',
  source = backup.payload->>'source',
  model = backup.payload->>'model',
  model_id = backup.payload->>'model_id',
  is_active = NULLIF(backup.payload->>'is_active', '')::boolean,
  user_access = backup.payload->>'user_access',
  sort_order = NULLIF(backup.payload->>'sort_order', '')::integer,
  system_prompt = backup.payload->>'system_prompt',
  preset_fields = backup.payload->'preset_fields',
  output_style = backup.payload->'output_style',
  response_format = backup.payload->>'response_format',
  max_context_rounds = NULLIF(backup.payload->>'max_context_rounds', '')::integer,
  max_context_tokens = NULLIF(backup.payload->>'max_context_tokens', '')::integer,
  max_reply_tokens = NULLIF(backup.payload->>'max_reply_tokens', '')::integer,
  temperature = NULLIF(backup.payload->>'temperature', '')::integer,
  timeout = NULLIF(backup.payload->>'timeout', '')::integer,
  enable_web_search = NULLIF(backup.payload->>'enable_web_search', '')::boolean,
  guide_message = backup.payload->>'guide_message',
  updated_at = NULLIF(backup.payload->>'updated_at', '')::timestamptz
FROM agent_config_migration_backups AS backup
WHERE backup.migration_key = '20260814_storyboard_director_agents_v6_2'
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
     AND backup.migration_key = '20260814_storyboard_director_agents_v6_2'
    WHERE agent.id IN (
      'agent-1786633444187-594spj',
      'agent-1786642714227-e1zid1',
      'agent-1786642714448-m6iaou'
    )
      AND agent.name IS NOT DISTINCT FROM backup.payload->>'name'
      AND agent.system_prompt IS NOT DISTINCT FROM backup.payload->>'system_prompt'
      AND agent.preset_fields IS NOT DISTINCT FROM backup.payload->'preset_fields'
      AND agent.output_style IS NOT DISTINCT FROM backup.payload->'output_style'
      AND agent.response_format IS NOT DISTINCT FROM backup.payload->>'response_format'
      AND agent.updated_at IS NOT DISTINCT FROM NULLIF(backup.payload->>'updated_at', '')::timestamptz
  ) <> 3 THEN
    RAISE EXCEPTION 'storyboard v6.2 rollback postcondition failed';
  END IF;
END
$postcondition$;

DELETE FROM prompt_versions
WHERE agent_id IN (
  'agent-1786633444187-594spj',
  'agent-1786642714227-e1zid1',
  'agent-1786642714448-m6iaou'
)
  AND (
    prompt LIKE '<!-- v6.2 前置备份/8-10-15秒适配前 -->%'
    OR prompt LIKE '<!-- 故事版导演 v6.2 / 8-10-15秒适配 -->%'
  );

COMMIT;
