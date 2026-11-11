/** SDK library failures are confined to this worker; only the host owns tools and durable events. */
export const NATIVE_AGENT_SDK_WORKER = String.raw`
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
require(workerData.guardPath);
const sdk = await import(workerData.sdkUrl);
const sdkZod = await import(workerData.zodUrl);
const controller = new AbortController();
const pending = new Map();
let requestId = 0;
let cliClosed = Promise.resolve();
function rpc(type, payload) {
  const id = ++requestId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); parentPort.postMessage({ type, id, ...payload }); });
}
parentPort.on('message', message => {
  if (message.type === 'abort') { controller.abort(); return; }
  if (message.type !== 'reply') return;
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.ok) item.resolve(message.value); else item.reject(new Error('NATIVE_AGENT_HOST_OPERATION_UNCONFIRMED'));
});
const names = ['mcp__native_drafts__read_draft', 'mcp__native_drafts__save_draft'];
const readSchema = sdkZod.fromJSONSchema(workerData.toolSchemas.read_draft);
const saveSchema = sdkZod.fromJSONSchema(workerData.toolSchemas.save_draft);
if (!(readSchema instanceof sdkZod.ZodObject) || !(saveSchema instanceof sdkZod.ZodObject)) throw new Error('NATIVE_AGENT_TOOL_SCHEMA_INVALID');
const invoke = async (kind, args) => {
  const result = await rpc('tool', { kind, args });
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
};
const mcp = sdk.createSdkMcpServer({ name: 'native_drafts', version: '1.0.0', tools: [
  sdk.tool('read_draft', 'Read a draft owned by the current member and use its returned fields and revisions.', readSchema.shape, args => invoke('read_draft', args)),
  sdk.tool('save_draft', 'Save a member draft through host ownership, revision and idempotency checks. Never publish.', saveSchema.shape, args => invoke('save_draft', args)),
] });
const options = {
  abortController: controller, cwd: workerData.workingDirectory, settingSources: [], additionalDirectories: [],
  tools: [], allowedTools: names, agents: {}, plugins: [], mcpServers: { native_drafts: mcp }, strictMcpConfig: true,
  permissionMode: 'default', model: workerData.modelName, maxTurns: workerData.maxTurns, maxThinkingTokens: 0,
  systemPrompt: 'You assist the authenticated member with their own content drafts. Read actual draft tool results before editing, preserve required revision fields, and save through the provided host draft tool. Describe only completed tool results. This first capability does not generate media, authorize channels, publish posts, access files or browse the web.',
  persistSession: true, includePartialMessages: true, enableFileCheckpointing: false,
  resume: workerData.resumeSessionId, executable: 'node', env: workerData.safeEnvironment,
  canUseTool: async (name, args) => names.includes(name) ? { behavior: 'allow', updatedInput: args } : { behavior: 'deny', message: 'Only member draft tools are enabled.' },
  hooks: { PreToolUse: [{ hooks: [async hook => {
    if (hook.hook_event_name !== 'PreToolUse' || !names.includes(hook.tool_name)) return { continue: false, stopReason: 'NATIVE_AGENT_RUNTIME_TOOL_DENIED' };
    const valid = await rpc('validate_tool', { kind: hook.tool_name.replace('mcp__native_drafts__', ''), args: hook.tool_input });
    return valid ? { continue: true } : { continue: false, stopReason: 'NATIVE_AGENT_RUNTIME_TOOL_INPUT_INVALID' };
  }] }] },
  spawnClaudeCodeProcess(spawnOptions) {
    const child = spawn(workerData.nodeExecutable, spawnOptions.args, { cwd: workerData.workingDirectory, env: workerData.safeEnvironment, signal: controller.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    parentPort.postMessage({ type: 'child_pid', pid: child.pid });
    cliClosed = new Promise(resolve => child.once('close', () => { parentPort.postMessage({ type: 'child_closed', pid: child.pid }); resolve(); }));
    child.stderr.on('data', data => parentPort.postMessage({ type: 'diagnostic', message: String(data).split(workerData.safeEnvironment.ANTHROPIC_API_KEY).join('[internal-capability]') }));
    return child;
  },
};
try {
  const query = sdk.query({ prompt: (async function* () { yield { type: 'user', session_id: workerData.resumeSessionId || '', parent_tool_use_id: null, message: { role: 'user', content: workerData.prompt } }; })(), options });
  for await (const message of query) await rpc('sdk_message', { message });
  controller.abort();
  await cliClosed;
  parentPort.postMessage({ type: 'done' });
} catch (error) {
  parentPort.postMessage({ type: 'failed', code: 'NATIVE_AGENT_SDK_WORKER_FAILED' });
  controller.abort();
} finally {
  controller.abort();
  parentPort.close();
}
`;
