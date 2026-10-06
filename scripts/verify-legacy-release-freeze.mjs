import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-close-loop.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-release-freeze-'));
try {
  // An empty working directory has no policy or repository. The old push must
  // stop before reading them, independent of PATH, Git, credentials or network.
  for (const args of [['--push-git'], ['--human', '--push-git'], ['--push-git=true']]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, PATH: '' },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /LEGACY_GIT_PUSH_DISABLED/);
    assert.doesNotMatch(result.stderr, /ENOENT|policy\.json/);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(fs.readdirSync(root), []);
  console.log('PASS legacy push aliases exit before configuration, subprocesses and remote writes');
} finally {
  const resolved = fs.realpathSync(root);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('legacy-release-freeze-')) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(resolved, {recursive:true,force:true});
}
