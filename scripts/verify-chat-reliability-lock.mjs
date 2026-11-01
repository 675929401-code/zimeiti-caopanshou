import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const CHAT_LOCK_MANIFEST = '.engineering/chat-reliability-lock.v1.json';
export const REQUIRED_CHAT_LOCK_PATHS = Object.freeze([
  'package.json',
  'scripts/run-build.mjs',
  'docs/公共聊天链路保护合同.md',
  'scripts/verify-chat-reliability-lock.mjs',
  'scripts/verify-chat-reliability-lock-zero-network.mjs',
  'scripts/verify-chat-reliability-browser.mjs',
  'scripts/verify-chat-thinking-experience-browser.mjs',
  'scripts/verify-chat-output-presentation-zero-network.ts',
  'scripts/verify-chat-output-presentation-browser.mjs',
  'scripts/verify-agent-identity-runtime-contract.ts',
  'scripts/verify-llm-standard-request-preflight-zero-network.mjs',
  'scripts/verify-chat-thinking-lifecycle-zero-network.ts',
  'scripts/verify-chat-typewriter-premium-lock.mjs',
  'src/lib/llm-proxy/stream-error.ts',
  'src/lib/llm-proxy/proxy.ts',
  'src/lib/llm-request-idempotency.ts',
  'src/app/api/llm/handle-stream.ts',
  'src/lib/chat-pipeline.ts',
  'src/lib/chat-customer-failure.ts',
  'src/contexts/chat-recovery-policy.ts',
  'src/contexts/app-context.tsx',
  'src/contexts/chat-utils.ts',
  'src/contexts/chat-reducer.ts',
  'scripts/verify-chat-submitted-outcome-zero-network.ts',
  'scripts/verify-llm-provider-stream.mjs',
  'scripts/verify-llm-durable-exactly-once.ts',
  'src/components/chat-view.tsx',
  'src/components/chat/message-item.tsx',
  'src/components/chat/reasoning-block.tsx',
  'src/components/chat/message-content.tsx',
  'src/app/markdown-body.css',
  'src/lib/agent-identity-envelope.ts',
  'src/lib/server/llm-standard-request-preparation.ts',
  'src/lib/chat-prompt-delivery-state.ts',
  'src/lib/storyboard-prompt-push-capability.ts',
  'src/lib/chat-video-prompt-transfer.ts',
  'src/lib/chat-storyboard-prompt-draft.ts',
  'src/lib/agent-storyboard-prompt-draft.ts',
  'src/lib/code-block-presentation.ts',
  'src/components/chat/video-prompt-handoff.tsx',
  'src/components/chat/structured-storyboard-handoff.tsx',
  'src/components/chat/storyboard-verified-message.tsx',
  'src/components/chat/use-code-block-controls.ts',
  'src/components/chat/prompt-viewport.module.css',
  'src/components/chat/chat-scroll-behavior.module.css',
  'scripts/verify-chat-prompt-destination.ts',
  'scripts/verify-agent-storyboard-prompt-draft.ts',
  'scripts/verify-agent-prompt-destination-browser.mjs',
  'scripts/verify-chat-wheel-scroll-browser.mjs',
  'scripts/lib/chat-prompt-destination-fixtures.mjs',
  'src/lib/storyboard-prompt-draft.ts',
  'scripts/verify-storyboard-visible-mode-draft.ts',
]);
const fail = message => { throw new Error(`CHAT_RELIABILITY_LOCKED: ${message}。先说明具体聊天变更及影响，经用户授权、回归与审阅后手工封存；禁止自动更新基线`); };

/** Read only: never repairs source, rewrites a baseline, or reads runtime secrets. */
export function verifyChatReliabilityLock(projectRoot) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const manifestPath = path.join(root, CHAT_LOCK_MANIFEST);
  for (const candidate of [path.join(root, '.engineering'), manifestPath]) {
    if (!fs.existsSync(candidate) || fs.lstatSync(candidate).isSymbolicLink()) fail('保护清单缺失或使用链接');
  }
  if (!fs.statSync(manifestPath).isFile()) fail('保护清单不是文件');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { fail('保护清单缺失或无法解析'); }
  if (manifest.schema !== 'chat-reliability-lock.v1' || manifest.locked !== true
    || !manifest.approval?.reference || !Array.isArray(manifest.files)) fail('保护清单合同无效');
  const seen = new Set();
  for (const row of manifest.files) {
    const relative = row?.path;
    if (typeof relative !== 'string' || !relative || /[\\:]/u.test(relative)
      || path.posix.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')
      || !/^[a-f0-9]{64}$/u.test(row.sha256 || '')) fail('保护路径或摘要无效');
    const key = relative.toLowerCase();
    if (seen.has(key)) fail(`重复保护路径 ${relative}`);
    seen.add(key);
    const candidate = path.join(root, ...relative.split('/'));
    // Refuse links at every level; the baseline must cover the physical source.
    let ancestor = root;
    for (const part of relative.split('/')) {
      ancestor = path.join(ancestor, part);
      if (!fs.existsSync(ancestor) || fs.lstatSync(ancestor).isSymbolicLink()) fail(`文件缺失或链接 ${relative}`);
    }
    const resolved = fs.realpathSync(candidate);
    const inside = path.relative(root, resolved);
    if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)
      || !fs.statSync(resolved).isFile()) fail(`路径逃逸或不是文件 ${relative}`);
    const bytes = fs.readFileSync(resolved);
    if (bytes.includes(13)) fail(`受保护文本不符合 LF 换行合同 ${relative}`);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== row.sha256) fail(`受保护文件已变更 ${relative}`);
  }
  for (const required of REQUIRED_CHAT_LOCK_PATHS) {
    if (!seen.has(required.toLowerCase())) fail(`保护范围被缩减 ${required}`);
  }
  return { passed: true, locked: true, protectedFiles: seen.size,
    manifestSha256: createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex') };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) fail('不接受更新、跳过或其他参数');
    console.log(JSON.stringify(verifyChatReliabilityLock(process.cwd()), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
