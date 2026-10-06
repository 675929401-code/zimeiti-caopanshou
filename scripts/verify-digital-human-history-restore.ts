import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), 'utf8');

async function main() {
  const [page, clientState, videoHistory, longHistory, longRepository, migration] = await Promise.all([
    read('src/app/digital-human/page.tsx'),
    read('src/features/digital-human/client-state.ts'),
    read('src/app/api/video/history/route.ts'),
    read('src/app/api/digital-human/long-history/route.ts'),
    read('src/lib/digital-human-long-repository.ts'),
    read('supabase/migrations/20260915233000_digital_human_long_history_visibility.sql'),
  ]);

  assert.match(clientState, /retrySource\?: HumanRetrySource/u, 'history DTO must carry only a bounded retry source');
  assert.match(videoHistory, /from\("digital_video_dispatch_jobs"\)[\s\S]*select\("task_id,inputs"\)[\s\S]*\.eq\("user_id", userId\)/u,
    'ordinary retry snapshots must be scoped to the current account');
  assert.match(videoHistory, /personAssetId: snapshot\.personAssetId[\s\S]*audioAssetId: snapshot\.audioAssetId[\s\S]*durationChoice: snapshot\.durationChoice/u,
    'ordinary history must expose only owned asset IDs and the duration choice');
  assert.doesNotMatch(videoHistory, /retrySource:\s*\{[\s\S]{0,300}(provider_result_url|image_url|source_video_url|audio_url)/u,
    'retry source must not expose provider or stale signed URLs');

  assert.match(longRepository, /parent\.source_video_asset_id[\s\S]*parent\.source_audio_asset_id/u,
    'long retry must come from the immutable parent asset snapshot');
  assert.match(longRepository, /parent\.state === 'failed'[\s\S]*parent\.billing_state === 'voided'[\s\S]*Number\(parent\.charged_yuan\) === 0/u,
    'long retry must be limited to failed, voided and uncharged tasks');
  assert.match(longRepository, /\.order\('created_at', \{ ascending: false \}\)[\s\S]*\.order\('id', \{ ascending: false \}\)[\s\S]*\.range\(safeOffset, safeOffset \+ safeLimit - 1\)/u,
    'long history must have stable offset pagination');
  assert.match(longRepository, /historyHidingReady = false[\s\S]*\.select\('id', \{ count: 'exact' \}\)/u,
    'old databases must retain read-only history when the visibility migration is absent');
  assert.match(longHistory, /searchParams\.get\('offset'\)[\s\S]*listLongJobsForUser\(auth\.user\.userId, limit, offset\)/u,
    'long history route must forward offset pagination');
  assert.match(longHistory, /export async function DELETE[\s\S]*hideLongJobHistory/u,
    'long history removal must use the guarded server operation');

  const restoreStart = page.indexOf('async function restoreFromHistory');
  const restoreEnd = page.indexOf('async function download', restoreStart);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart, 'restore handler must exist');
  const restoreHandler = page.slice(restoreStart, restoreEnd);
  assert.match(restoreHandler, /\/api\/digital-human\/assets\?/u, 'restore must recheck both assets through the owned-asset API');
  assert.match(restoreHandler, /\/api\/video\/models\?surface=digital-human/u, 'restore must refresh the public model catalog');
  assert.match(restoreHandler, /capabilities\.available !== true/u, 'an unavailable model must fail closed');
  assert.match(restoreHandler, /modelMode !== job\.mode/u, 'model mode drift must fail closed');
  assert.match(restoreHandler, /resolutionOptions\.includes\(job\.resolution\)/u, 'resolution drift must fail closed');
  assert.match(restoreHandler, /setPerson\(restoredPerson\); setAudio\(restoredAudio\)/u, 'both current-account assets must be restored');
  assert.match(restoreHandler, /audioSource: 'upload'/u, 'restored audio must use the already-owned asset without replaying voice generation');
  assert.doesNotMatch(restoreHandler, /method:\s*'POST'|\/generate|submit\(/u, 'loading parameters must never submit a generation request');
  assert.match(page, /旧任务编号不会复用[^]*主动点击“生成数字人视频”/u, 'the user must be told to check the new quote and submit explicitly');
  assert.match(page, /requestId: `\$\{longRequested \? 'digital-long' : 'digital'\}-\$\{crypto\.randomUUID\(\)\}`/u,
    'an explicit retry submit must create a new request identity');
  assert.match(page, /data\.nextOffset != null \|\| longData\.nextOffset != null/u, 'both paginated histories must drive the load-more state');
  assert.match(page, /Date\.parse\(right\.createdAt\)[\s\S]*localeCompare/u, 'merged ordinary and long history must have a stable newest-first order');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS history_hidden_at timestamptz/u);
  assert.match(migration, /WHERE history_hidden_at IS NULL/u);
  assert.match(migration, /state NOT IN \('completed', 'failed', 'cancelled'\)/u, 'active long tasks must never be hidden');
  assert.match(migration, /billing_state IN \('quote_locked', 'ready_to_settle'\)/u, 'unsettled long tasks must never be hidden');
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO service_role/u, 'history mutation must remain backend-only');

  console.log('Digital-human history restore: PASS (owned assets, current model gate, explicit submit, paging, compatible soft hide)');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
