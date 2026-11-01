import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const EXTRACTION_LOCK_MANIFEST = '.engineering/extraction-feature-lock.v1.json';
export const REQUIRED_EXTRACTION_LOCK_PATHS = Object.freeze([
  'AGENTS.md',
  'src/app/extract/page.tsx',
  'src/hooks/use-extraction-attempt-status.ts',
  'src/hooks/use-extraction-history.ts',
  'src/app/api/extract/route.ts',
  'src/app/api/extract/status/route.ts',
  'src/app/api/extract/history/route.ts',
  'src/lib/extraction-exactly-once.ts',
  'src/lib/extract-client-attempt.ts',
  'src/lib/extraction-history.ts',
  'src/lib/coze-workflow-client.ts',
  'src/lib/coze-source-identity.ts',
  'src/lib/coze-extraction-result.ts',
  'src/lib/extract-pricing.ts',
  'src/lib/extraction-feature-lock.ts',
  'src/app/api/admin/plugins/route.ts',
  'scripts/verify-extraction-feature-lock.mjs',
  'scripts/run-build.mjs',
  'scripts/release-preflight.mjs',
  'scripts/build-release-vnext.mjs',
  'docs/文案提取保护合同.md',
  'src/app/api/extract/batch/route.ts',
  'src/app/api/extract/search/route.ts',
  'src/app/api/extract/coze/route.ts',
  'src/lib/coze-extraction-handler.ts',
  'src/lib/extraction-auth.ts',
  'src/lib/extraction-provider-error.ts',
  'src/app/api/tools/runtime-catalog/route.ts',
  'scripts/verify-extraction-feature-config-lock-zero-network.mjs',
  'scripts/verify-extraction-source-lock-zero-network.mjs',
  'scripts/verify-extraction-status-recovery-browser.mjs',
]);

const fail = message => { throw new Error(`EXTRACTION_SOURCE_LOCKED: ${message}。须先取得用户本人对具体变更的明确授权，审查和验证后重新封存；禁止自动刷新基线`); };
export function verifyExtractionFeatureLock(projectRoot) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const manifestPath = path.join(root, EXTRACTION_LOCK_MANIFEST);
  if (!fs.existsSync(manifestPath)) fail('保护清单缺失');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { fail('保护清单无法解析'); }
  if (manifest.schema !== 'extraction-feature-lock.v1' || manifest.locked !== true
    || !manifest.approval?.reference || !Array.isArray(manifest.files)) fail('保护清单合同无效');
  const seen = new Set();
  for (const row of manifest.files) {
    const relative = row?.path;
    if (typeof relative !== 'string' || !relative || /[\\:]/u.test(relative)
      || path.posix.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')
      || !/^[a-f0-9]{64}$/u.test(row.sha256 || '')) fail('保护路径或摘要无效');
    const key = relative.toLowerCase();
    if (seen.has(key)) fail(`重复保护路径 ${relative}`);
    seen.add(key);
    const candidate = path.join(root, ...relative.split('/'));
    if (!fs.existsSync(candidate)) fail(`受保护文件缺失 ${relative}`);
    const resolved = fs.realpathSync(candidate);
    const inside = path.relative(root, resolved);
    if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)
      || !fs.statSync(resolved).isFile()) fail(`保护路径逃逸或不是文件 ${relative}`);
    const bytes = fs.readFileSync(resolved);
    // Match the repository's LF text contract and canonical release snapshot.
    // A CRLF baseline must not pass locally and then fail on Linux.
    if (bytes.includes(13)) fail(`受保护文本不符合 LF 换行合同 ${relative}`);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== row.sha256) fail(`受保护文件已变更 ${relative}`);
  }
  for (const required of REQUIRED_EXTRACTION_LOCK_PATHS) {
    if (!seen.has(required.toLowerCase())) fail(`保护范围被缩减 ${required}`);
  }
  return {
    passed: true, locked: true, protectedFiles: seen.size,
    manifestSha256: createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const rootFlag = process.argv.indexOf('--root');
  try {
    console.log(JSON.stringify(verifyExtractionFeatureLock(rootFlag >= 0 ? process.argv[rootFlag + 1] : process.cwd()), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
