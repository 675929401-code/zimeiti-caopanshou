import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

if (!process.argv.includes('--execute-readonly')) { console.log(JSON.stringify({ mode: 'plan', networkRequests: 0, databaseWrites: 0 })); process.exit(0); }
const runtime = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const evidence = '.codex-evidence/manju-admin-e2e-20260902/prompt-5.json';
const prior = JSON.parse(await fs.readFile(evidence, 'utf8'));
const ownKey = prior.promptCleanupRequired?.ownEntryKey;
assert.match(ownKey || '', /^e2e_manju_\d+_[a-z0-9]+$/u);
assert.equal(prior.promptCleanupRequired.environment, 'development');
const cfg = JSON.parse((await fs.readFile(runtime, 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(new URL(cfg.supabaseUrl).toString(), 'http://127.0.0.1:54321/');
const url = new URL('/rest/v1/platform_settings', cfg.supabaseUrl);
url.searchParams.set('select', 'setting_value'); url.searchParams.set('setting_key', 'eq.manju.config.v1.development.prompt'); url.searchParams.set('limit', '1');
const response = await fetch(url, { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` }, signal: AbortSignal.timeout(20000) });
assert.ok(response.ok, `Local config read failed: ${response.status}`);
const rows = await response.json(); assert.equal(rows.length, 1);
const envelope = JSON.parse(rows[0].setting_value);
assert.equal(envelope.environment, 'development'); assert.equal(envelope.domain, 'prompt');
const active = envelope.active?.revision;
const edited = envelope.history.find(record => record.revision.payload?.runtime_prompts?.[ownKey]?.version === 'test-v2')?.revision;
assert.ok(active?.payload && edited?.payload, 'Expected original development test history');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const expected = structuredClone(edited.payload); delete expected.runtime_prompts[ownKey];
const baselinePrompt = expected.runtime_prompts.manga_virtual_agent_prompt;
const originalRunnerInsertionOrder = { version: expected.version, policy: expected.policy, verification_scope: expected.verification_scope, verification_run: expected.verification_run,
  runtime_prompts: { manga_virtual_agent_prompt: { version: baselinePrompt.version, content: baselinePrompt.content } } };
const report = { at: new Date().toISOString(), priorEvidence: evidence, databaseWrites: 0, generationRequests: 0, credentialsOrPromptBodyPersisted: false,
  environment: 'development', domain: 'prompt', ownEntryKey: ownKey, activeRevisionId: active.id, activeReleaseId: envelope.active.release.id,
  ownEntryAbsentFromActive: !Object.hasOwn(active.payload.runtime_prompts, ownKey), ownEntryAbsentFromDrafts: envelope.drafts.every(record => !Object.hasOwn(record.payload?.runtime_prompts || {}, ownKey)),
  originalEditedHistoryRetained: !!edited, canonicalBaselineMatched: hash(canonical(active.payload)) === hash(canonical(expected)),
  actualHashMatchesStored: hash(canonical(active.payload)) === active.payload_hash,
  runnerRawOrderComparisonMatched: hash(active.payload) === hash(originalRunnerInsertionOrder),
  originalRunnerCanonicalComparisonMatched: hash(canonical(active.payload)) === hash(canonical(originalRunnerInsertionOrder)),
  activeKeys: Object.keys(active.payload), originalRunnerKeys: Object.keys(originalRunnerInsertionOrder),
  conclusion: 'Only the expected development test entry is absent; canonical payload equality determines whether removal succeeded.' };
report.passed = report.ownEntryAbsentFromActive && report.ownEntryAbsentFromDrafts && report.canonicalBaselineMatched && report.actualHashMatchesStored && report.originalRunnerCanonicalComparisonMatched;
await fs.writeFile('.codex-evidence/manju-admin-e2e-20260902/prompt-5-remove-readonly.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
