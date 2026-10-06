import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';

const require = createRequire(import.meta.url);
const ffprobe = require('ffprobe-static').path;
const root = '.codex-evidence/hidden-video-real-e2e-20260902';
const output = '.codex-evidence/hosted-h3-duration-readonly-20260903'; await mkdir(output, { recursive: true });
const runtime = JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8'));
assert.ok(runtime.localOnly && runtime.ownerConnection.host === '127.0.0.1' && runtime.ownerConnection.port === 54322 && runtime.ownerConnection.database === 'zimeiti_local');
const cfgKeys = ['workflow_id','workflow_input_mode','duration_field','supports_duration','min_duration','max_duration','min_submit_duration','duration_options','duration_step','exact_duration_only','billing_unit','fps','frame_rate','num_frames','frames','supports_prompt','required_reference_images','required_reference_audios','max_reference_images','max_reference_audios','resolution_options','aspect_ratios'];
const db = new pg.Client(runtime.ownerConnection); await db.connect();
let models;
try {
  const query = `select id,model_name,protocol_type,duration_seconds,max_duration,
    (select jsonb_object_agg(key,value) from jsonb_each(coalesce(api_protocol_config,'{}'::jsonb)) where key=any($1::text[])) as api_protocol_config
    from public.video_models where id like 'minimax-h3-autodl-hosted%' order by id`;
  models = (await db.query(query, [cfgKeys])).rows;
} finally { await db.end(); }
async function load(sourcePath, extra = '') {
  const source = await readFile(sourcePath, 'utf8'); const module = { exports: {} };
  const compiled = ts.transpileModule(source + extra, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, URL, Number, String, Array, Math, Object, Set, Error, JSON,
    require(name) { if (name === './video-provider-request-audit') return { videoProviderFetch() { throw new Error('PROVIDER_SUBMISSION_FORBIDDEN'); } }; throw new Error('UNEXPECTED_MODULE'); },
  }); return module.exports;
}
const adapter = await load('src/lib/video-autodl-comfyui-workflow.ts', '\nexport { buildBody };');
const timing = await load('src/lib/video-model-capabilities.ts');
const plan = JSON.parse(await readFile(`${root}/hidden-bindings-canary-v2-20260902/plan.json`, 'utf8'));
const owned = JSON.parse(await readFile(`${root}/owned-results/summary.json`, 'utf8'));
const rows = [];
for (const item of owned) {
  const model = models.find(row => row.id === item.model); assert.ok(model);
  const requestPlan = plan.plans.find(row => row.modelId === item.model || row.validation?.model.id === item.model); assert.ok(requestPlan);
  const result = JSON.parse(await readFile(`${root}/hidden-bindings-canary-v2-20260902/${item.model}/result.json`, 'utf8'));
  const timingInput = timing.resolveVideoDuration(model, requestPlan.durationSeconds);
  const body = adapter.buildBody(model, { prompt: 'synthetic duration audit only', duration: timingInput.submit, aspectRatio: '16:9', resolution: '480p',
    imageUrl: 'https://assets.example/first.png', lastFrameUrl: 'https://assets.example/last.png', imageUrls: ['https://assets.example/reference.png'], audioUrl: 'https://assets.example/audio.wav' });
  const probe = spawnSync(ffprobe, ['-v','error','-show_entries','stream=index,codec_type,codec_name,r_frame_rate,avg_frame_rate,time_base,start_time,duration,nb_frames:format=duration','-of','json',`${root}/owned-results/${item.model}.mp4`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(probe.status, 0);
  rows.push({ modelId: item.model, workflowId: model.api_protocol_config.workflow_id, requestedSeconds: requestPlan.durationSeconds,
    originalInputAudioSeconds: result.input?.audios?.map(audio => audio.durationSeconds) || [],
    databaseRecordedSeconds: result.business?.duration, currentDurationContract: timing.getVideoDurationCapabilities(model),
    currentStep: model.api_protocol_config.duration_step, configuredExactDurationOnly: model.api_protocol_config.exact_duration_only,
    actualRequestAssembly: { duration: body.duration ?? null, audio_duration: body.audio_duration ?? null, resolution: body.resolution, explicitFps: body.fps ?? null, explicitFrames: body.num_frames ?? body.frames ?? null },
    decodedMetadata: JSON.parse(probe.stdout) });
}
const workflowIds = [...new Set(rows.map(row => row.workflowId))];
const metadata = await Promise.all(workflowIds.map(async workflowId => {
  const url = `https://www.autodl.art/api/v1/comfyui/workflows/${workflowId}`;
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000) });
    const text = await response.text(); if (text.length > 2_000_000) throw new Error('METADATA_TOO_LARGE');
    const body = JSON.parse(text); const relevant = [];
    function walk(value, path = '', depth = 0) {
      if (!value || typeof value !== 'object' || depth > 10) return;
      for (const [key, entry] of Object.entries(value)) {
        const nextPath = `${path}.${key}`;
        if (/duration|fps|frame|^input|parameter|schema|description|workflow.*name/iu.test(key)) relevant.push({ path: nextPath, value: entry });
        else if (typeof entry === 'object') walk(entry, nextPath, depth + 1);
      }
    }
    walk(body);
    return { workflowId, url, status: response.status, relevant };
  } catch (error) { return { workflowId, url, available: false, error: error instanceof Error ? error.name : 'MetadataUnavailable' }; }
}));
const report = { checkedAt: new Date().toISOString(), localDatabaseOnly: true, databaseWrites: 0, providerSubmissionCalls: 0, rows, publicWorkflowMetadata: metadata };
await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
