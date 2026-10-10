import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  getBotsCache,
  invalidateBotsCache,
  setBotsCache,
} from '../src/lib/bots-cache';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const migration = read('supabase/migrations/20261010123000_shared_agent_config_revision.sql');
const rollback = read('supabase/rollbacks/20261010123000_shared_agent_config_revision.rollback.sql');
const ownerMigration = read('supabase/migrations/20261010124000_shared_agent_function_owner_reconcile.sql');
const ownerRollback = read('supabase/rollbacks/20261010124000_shared_agent_function_owner_reconcile.rollback.sql');
const agentsRoute = read('src/app/api/admin/agents/route.ts');
const reorderRoute = read('src/app/api/admin/agents/reorder/route.ts');
const restoreRoute = read('src/app/api/admin/agents/restore/route.ts');
const categoriesRoute = read('src/app/api/admin/categories/route.ts');
const promptVersionsRoute = read('src/app/api/admin/prompt-versions/route.ts');
const agentConfigCas = read('src/lib/server/agent-config-cas.ts');
const cacheSource = read('src/lib/bots-cache.ts');
const importRoute = read('src/app/api/admin/sync/import/route.ts');
const importCozeRoute = read('src/app/api/admin/agents/import-coze/route.ts');
const adminPage = read('src/app/admin/page.tsx');
const marketplace = read('src/components/agent-marketplace.tsx');
const chatView = read('src/components/chat-view.tsx');
const promptHistory = read('src/components/prompt-version-history.tsx');

assert.match(migration, /ADD COLUMN IF NOT EXISTS config_revision bigint/u);
assert.match(migration, /ADD COLUMN IF NOT EXISTS agent_revision bigint/u);
assert.match(migration, /ADD COLUMN IF NOT EXISTS prompt_hash text/u);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_agent_revision_unique[\s\S]*?agent_id, agent_revision/u);
assert.match(migration, /NEW\.config_revision := OLD\.config_revision \+ 1/u);
assert.match(migration, /AFTER INSERT OR UPDATE ON public\.agents[\s\S]*?record_shared_agent_prompt_version/u);
assert.match(migration, /pg_catalog\.sha256\(convert_to\(NEW\.system_prompt, 'UTF8'\)\)/u);
assert.match(migration, /DROP TRIGGER IF EXISTS agents_config_revision_before_write/u);
assert.match(migration, /CREATE TRIGGER prompt_versions_prepare_legacy_insert[\s\S]*?prepare_shared_agent_prompt_version_insert/u);
assert.match(migration, /RETURN NULL;[\s\S]*?AGENT_PROMPT_VERSION_REVISION_CONFLICT/u);
assert.match(migration, /AGENT_PROMPT_VERSION_REVISION_MISMATCH/u);
assert.match(rollback, /Forward-compatible rollback/u);
assert.match(rollback, /do not run old and new writers concurrently in shared mode/u);
assert.doesNotMatch(rollback, /DROP\s+(?:COLUMN|TABLE|FUNCTION)|ALTER\s+TABLE[\s\S]*?DROP/iu);
assert.match(ownerMigration, /relation\.relname = 'agents'/u);
assert.match(ownerMigration, /JOIN pg_catalog\.pg_roles AS owner_role[\s\S]*?relation\.relowner/u);
assert.match(ownerMigration, /ALTER FUNCTION public\.%I\(\) OWNER TO %I/u);
assert.match(ownerMigration, /maintain_shared_agent_config_revision/u);
assert.match(ownerMigration, /record_shared_agent_prompt_version/u);
assert.match(ownerMigration, /prepare_shared_agent_prompt_version_insert/u);
assert.doesNotMatch(ownerMigration, /OWNER TO (?:postgres|zimeiti_owner)/iu);
assert.match(ownerRollback, /Forward-compatible rollback/u);
assert.match(ownerRollback, /Intentionally no ALTER OWNER/u);
assert.doesNotMatch(ownerRollback, /ALTER\s+FUNCTION[\s\S]*?OWNER\s+TO/iu);

assert.match(agentsRoute, /authorizeAdminCapability\(request, 'agents\.manage'/u);
assert.match(agentsRoute, /authorizeAdminCapability\(request, 'prompts\.edit'[\s\S]*?requireStepUp: true/u);
assert.match(agentsRoute, /authorizeAdminCapability\(request, 'models\.manage'[\s\S]*?requireStepUp: true/u);
assert.match(agentConfigCas, /input\.expected_revision \?\? input\.expectedRevision/u);
assert.match(agentConfigCas, /\.eq\("config_revision", options\.expectedRevision\)/u);
assert.match(agentConfigCas, /code: "AGENT_CONFIG_REVISION_CONFLICT"[\s\S]*?status: 409/u);
assert.match(agentsRoute, /code: 'AGENT_CONFIG_REVISION_MIGRATION_REQUIRED'[\s\S]*?status: 503/u);
assert.doesNotMatch(agentConfigCas, /AGENT_CONFIG_REVISION_CONFLICT[\s\S]{0,500}(?:retry|重试保存|updateQuery\s*=)/u);
assert.match(agentsRoute, /deleteAgentByRevision\([\s\S]*?expectedRevision[\s\S]*?deletedScope: 'deleted'/u);
assert.match(agentsRoute, /updateAgentByRevision\([\s\S]*?expectedRevision[\s\S]*?deletedScope: 'active'/u);

assert.match(agentConfigCas, /export function parseExpectedAgentRevision/u);
assert.match(agentConfigCas, /typeof raw === "number"[\s\S]*?Number\.isSafeInteger\(raw\)[\s\S]*?raw >= 1/u);
assert.match(agentConfigCas, /typeof raw !== "string" \|\| !\/\^\[1-9\]\\d\*\$\/u\.test\(raw\)/u);
assert.match(agentConfigCas, /\.eq\("config_revision", options\.expectedRevision\)/u);
assert.match(agentConfigCas, /code: "AGENT_CONFIG_REVISION_CONFLICT"[\s\S]*?status: 409/u);

assert.match(reorderRoute, /authorizeAdminCapability\(request, "agents\.manage"[\s\S]*?requireStepUp: true/u);
assert.match(reorderRoute, /agents 必须包含每个智能体的 id 与 expected_revision/u);
assert.match(reorderRoute, /agentRevisionConflict\(entry\.expected_revision/u);
assert.match(reorderRoute, /client\.rpc\("apply_agent_reorder_cas_v1"/u);
assert.doesNotMatch(reorderRoute, /verifyAdminToken|updateAgentByRevision|\.update\(\{ sort_order/iu);

assert.match(restoreRoute, /authorizeAdminCapability\(request, "agents\.manage"[\s\S]*?requireStepUp: true/u);
assert.match(restoreRoute, /updateAgentByRevision\([\s\S]*?deletedScope: "deleted"/u);
assert.match(restoreRoute, /deleteAgentByRevision\([\s\S]*?deletedScope: "deleted"/u);
assert.match(restoreRoute, /authorizeAdminCapability\(request, "internal_tools\.manage"/u);
assert.doesNotMatch(restoreRoute, /verifyAdminToken/u);

assert.match(importCozeRoute, /authorizeAdminCapability\(request, 'agents\.manage'[\s\S]*?requireStepUp: true/u);
assert.match(importCozeRoute, /authorizeAdminCapability\(request, 'prompts\.edit'[\s\S]*?requireStepUp: true/u);
assert.match(importCozeRoute, /expected_revisions/u);
assert.match(importCozeRoute, /client\.rpc\('apply_coze_agent_import_cas_v1'/u);
assert.match(importCozeRoute, /本批次零写入/u);
assert.match(importCozeRoute, /COZE_IMPORT_UPSTREAM_BATCH_INCOMPLETE/u);
assert.doesNotMatch(importCozeRoute, /updateAgentByRevision|\.from\('agents'\)[\s\S]{0,180}\.(?:insert|update)\(/u);

assert.match(categoriesRoute, /code: "AGENT_BATCH_CAS_TRANSACTION_REQUIRED"[\s\S]*?status: 409/u);
assert.doesNotMatch(categoriesRoute, /\.from\("agents"\)[\s\S]{0,120}\.update\(/u);

assert.match(promptVersionsRoute, /authorizeAdminCapability\(request, "prompts\.view"[\s\S]*?requireStepUp: true/u);
assert.match(promptVersionsRoute, /select: "id,prompt,created_at,agent_revision,prompt_hash"/u);
assert.match(promptVersionsRoute, /unavailable: \["actor", "reason", "source"\]/u);
assert.match(promptVersionsRoute, /authorizeAdminCapability\(request, "prompts\.edit"[\s\S]*?requireStepUp: true/u);
assert.doesNotMatch(promptVersionsRoute, /withAdminAuth/u);
const promptHistoryGet = promptVersionsRoute.slice(
  promptVersionsRoute.indexOf('export async function GET'),
  promptVersionsRoute.indexOf('export async function POST'),
);
assert.ok(
  promptHistoryGet.indexOf('authorizeAdminCapability') < promptHistoryGet.indexOf('supabaseRestApi'),
  'low-privilege prompt history requests must be rejected before any database read',
);

assert.match(adminPage, /function buildAgentMutationPayload[\s\S]*?expected_revision: revision/u);
assert.match(adminPage, /handleToggleAgentActive[\s\S]{0,500}buildAgentMutationPayload/u);
assert.match(adminPage, /handleSaveAgentSortOrders[\s\S]{0,900}buildAgentMutationPayload/u);
assert.match(adminPage, /handleMoveAgentToCategory[\s\S]{0,700}buildAgentMutationPayload/u);
assert.match(adminPage, /handleRestoreAgent[\s\S]{0,700}buildAgentMutationPayload/u);
assert.match(adminPage, /permanent=1&expected_revision=/u);
assert.match(adminPage, /user_access: e\.target\.value/u);

assert.match(marketplace, /loadAdminAgentRevisions\(auth\.token, newOrder\)/u);
assert.match(marketplace, /agents: newOrder\.map\(\(id\) => \(\{ id, expected_revision: revisions\.get\(id\) \}\)\)/u);
assert.match(marketplace, /expected_revision: revisions\.get\(agent\.id\), category: categoryName/u);
assert.doesNotMatch(marketplace, /JSON\.stringify\(\{ agentIds: newOrder \}\)/u);

assert.match(chatView, /for \(const path of \["\/api\/admin\/agents", "\/api\/admin\/agents\?include_internal=1"\]\)/u);
assert.match(chatView, /expected_revision: expectedRevision[\s\S]*?output_style: agentOutputStyle/u);
assert.match(chatView, /res\.status === 409/u);

assert.match(promptHistory, /agent_revision\?: number/u);
assert.match(promptHistory, /prompt_hash\?: string/u);

assert.match(cacheSource, /if \(sharedConfigurationEnabled\(\)\) \{[\s\S]*?cache\.clear\(\);[\s\S]*?return null;/u);
assert.match(cacheSource, /export function setBotsCache[\s\S]*?if \(sharedConfigurationEnabled\(\)\) \{[\s\S]*?cache\.clear\(\);[\s\S]*?return;/u);

assert.match(importRoute, /verifyAdminToken\(token\)/u);
assert.match(importRoute, /payload\.role !== 'admin'/u);
assert.match(importRoute, /sharedConfigurationEnabled\(\)[\s\S]*?hasOwnProperty\.call\(importData, 'agents'\)/u);
assert.match(importRoute, /code: 'SHARED_AGENT_IMPORT_FORBIDDEN'[\s\S]*?status: 409/u);
assert.ok(
  importRoute.indexOf("code: 'SHARED_AGENT_IMPORT_FORBIDDEN'") < importRoute.indexOf('for (const tableName of SYNC_TABLES)'),
  'shared agents import must be rejected before any table write loop',
);

const previousSharedMode = process.env.SHARED_CONFIGURATION_ENABLED;
try {
  delete process.env.SHARED_CONFIGURATION_ENABLED;
  invalidateBotsCache();
  setBotsCache('unit:local', { revision: 1 });
  assert.deepEqual(getBotsCache('unit:local'), { revision: 1 });

  process.env.SHARED_CONFIGURATION_ENABLED = '1';
  assert.equal(getBotsCache('unit:local'), null, 'shared mode must not return a process-local cached value');
  setBotsCache('unit:shared', { revision: 2 });

  delete process.env.SHARED_CONFIGURATION_ENABLED;
  assert.equal(getBotsCache('unit:shared'), null, 'shared-mode writes must not populate process-local cache');
  assert.equal(getBotsCache('unit:local'), null, 'entering shared mode must clear prior process-local values');
} finally {
  if (previousSharedMode === undefined) delete process.env.SHARED_CONFIGURATION_ENABLED;
  else process.env.SHARED_CONFIGURATION_ENABLED = previousSharedMode;
  invalidateBotsCache();
}

console.log(JSON.stringify({
  ok: true,
  checks: {
    migrationRevisionAndPromptHistory: true,
    dynamicTriggerFunctionOwnerReconciliation: true,
    apiCompareAndSwapAndFailClosed: true,
    allAgentMutationRoutesRequireRevision: true,
    promptHistoryCapabilityAndStepUp: true,
    promptHistorySchemaMetadata: true,
    adminAndMarketplaceAndChatCallersSendRevision: true,
    unsafeCategoryBatchMutationFailClosed: true,
    sharedBotsCacheBypass: true,
    sharedSyncImportBlocked: true,
    permissionMarkersPreserved: true,
  },
  sideEffects: {
    databaseWrites: 0,
    networkRequests: 0,
    providerCalls: 0,
    paidRequests: 0,
  },
}, null, 2));
