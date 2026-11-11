import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { nativeEnvironment, projectRoot } from './native-publishing-local-utils.mjs';

const execute = promisify(execFile);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export async function ensureNativePublishingReady({ cwd = projectRoot, executable = process.execPath, runCommand, sleep = pause } = {}) {
  if (path.resolve(cwd) !== projectRoot) throw new Error('NATIVE_CANONICAL_SOURCE_REQUIRED');
  const command = runCommand ?? (async mode => {
    const result = await execute(executable, [path.join(projectRoot, 'scripts/native-publishing-local.mjs'), mode], { cwd: projectRoot, env: nativeEnvironment(), windowsHide: true, timeout: 25000, maxBuffer: 128 * 1024 });
    return JSON.parse(result.stdout.trim());
  });
  let firstFailure;
  try { const result = await command('--check'); if (result.runningNativeLatest !== true) throw new Error('NATIVE_READY_PROOF_MISSING'); return result; }
  catch (error) { firstFailure = error; }
  const detail = `${firstFailure?.message ?? ''}\n${firstFailure?.stderr ?? ''}`;
  // A stale build, failed identity or occupied unknown port needs an explicit
  // owner/build decision. Only a verified missing process can be started here.
  if (!detail.includes('NATIVE_PROCESS_NOT_VERIFIED')) throw firstFailure;
  await command('--start');
  for (let attempt = 0; attempt < 8; attempt++) {
    try { const result = await command('--check'); if (result.runningNativeLatest !== true) throw new Error('NATIVE_READY_PROOF_MISSING'); return result; }
    catch (error) {
      const message = `${error?.message ?? ''}\n${error?.stderr ?? ''}`;
      if (!/fetch failed|ECONNREFUSED|TimeoutError|AbortError|UND_ERR_CONNECT_TIMEOUT/u.test(message) || attempt === 7) throw error;
      await sleep(750);
    }
  }
  throw new Error('NATIVE_READY_TIMEOUT');
}
