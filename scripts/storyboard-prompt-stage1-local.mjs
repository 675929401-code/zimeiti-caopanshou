import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// This entry only captures a fresh, explicitly local baseline. Credentials stay
// in memory; the allowlisted snapshot never contains model keys or sessions.
const source = process.cwd();
const targetId = 'agent-1786843330392-emdjv2';
const settingKey = 'storyboard_workbench_agent_v2_6_0';
const runtime = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(new URL(runtime.supabaseUrl).origin, 'http://127.0.0.1:54321');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function read(table, query) {
  const url = new URL(`/rest/v1/${table}`, runtime.supabaseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` }, signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, `LOCAL_READ_FAILED_${table}_${response.status}`);
  return response.json();
}
const [agents, settings] = await Promise.all([
  read('agents', { select: 'id,name,config_revision,system_prompt,preset_fields,output_style,model,model_id,updated_at,enable_knowledge_base,knowledge_base_id,deep_thinking_type,max_reply_tokens,temperature,token_billing_enabled,input_cost_per_million,output_cost_per_million', id: `eq.${targetId}` }),
  read('platform_settings', { select: 'setting_key,setting_value,updated_at', setting_key: `eq.${settingKey}` }),
]);
assert.equal(agents.length, 1);
assert.equal(agents[0].name, '3D故事导演｜高能版');
assert.equal(settings.length, 1);
const agent = agents[0];
const compiler = typeof settings[0].setting_value === 'string' ? JSON.parse(settings[0].setting_value) : settings[0].setting_value;
assert.ok(agent.system_prompt?.length > 100 && compiler.prompt?.length > 100);
const destination = path.join(source, '.codex-backups/storyboard-prompt-stage1-7526/baseline');
await fs.mkdir(destination, { recursive: true });
const documents = {
  'high-energy-agent.json': JSON.stringify(agent, null, 2) + '\n',
  'high-energy-prompt.md': agent.system_prompt,
  'compiler-config.json': JSON.stringify(compiler, null, 2) + '\n',
  'compiler-prompt.md': compiler.prompt,
};
const entries = [];
for (const [file, content] of Object.entries(documents)) {
  await fs.writeFile(path.join(destination, file), content, { flag: 'wx' });
  entries.push({ path: file, sha256: sha(content), bytes: Buffer.byteLength(content) });
}
const report = { schemaVersion: 'storyboard_prompt_baseline.v1', observedAt: new Date().toISOString(), environment: 'local-acceptance', agent: { id: agent.id, name: agent.name, revision: agent.config_revision, chars: agent.system_prompt.length, sha256: sha(agent.system_prompt), presetFieldsSha256: sha(JSON.stringify(agent.preset_fields)), outputStyle: agent.output_style, model: agent.model, modelId: agent.model_id, tokenBillingEnabled: agent.token_billing_enabled, inputCostPerMillion: agent.input_cost_per_million, outputCostPerMillion: agent.output_cost_per_million }, compiler: { key: settingKey, version: compiler.version, chars: compiler.prompt.length, sha256: sha(compiler.prompt) }, entries, businessWrites: 0, providerCalls: 0 };
await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ...report, snapshotPath: destination }, null, 2));
