import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Decode the original downloaded result. No HTTP, generation, or replacement.
const run = promisify(execFile);
const dir = '.codex-evidence/toolbox-local-media-real-e2e-20260903/toolbox-local-media-ui-20260903-02';
const file = path.resolve(dir, 'gif.gif');
const priorReport = await readFile(path.join(dir, 'execute.json'));
const prior = JSON.parse(priorReport);
const result = prior.mutations.find(item => item.action === 'gif');
const bytes = await readFile(file);
const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(result.status, 200); assert.equal(bytes.length, result.bytes); assert.equal(sha(bytes), result.sha256);
const { stdout } = await run(path.resolve('node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe'), ['-v', 'error', '-show_frames', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 30000, windowsHide: true });
const metadata = JSON.parse(stdout);
const durations = metadata.frames.map(frame => Number(frame.pkt_duration_time));
assert.ok(durations.length > 1 && durations.every(value => Number.isFinite(value) && value > 0));
const duration = durations.reduce((a, b) => a + b, 0);
assert.ok(duration >= 0.85 && duration <= 1.25);
assert.equal(metadata.streams[0].codec_name, 'gif'); assert.equal(metadata.streams[0].width, 480); assert.equal(metadata.streams[0].height, 360);
await run(path.resolve('node_modules/ffmpeg-static/ffmpeg.exe'), ['-v', 'error', '-i', file, '-f', 'null', '-'], { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 });
const report = { passed: true, originalRun: prior.runId, originalReportSha256: sha(priorReport), originalFailurePreserved: true, fileSha256: sha(bytes), bytes: bytes.length, frameCount: durations.length, frameDurations: durations, durationSeconds: duration, width: 480, height: 360, fullyDecoded: true, originalFormatDurationAbsent: !metadata.format.duration, realHttpRequests: 0, generatedNewFiles: 0, explanation: 'Animated GIF duration comes from frame timings; this FFprobe build omits format.duration. Original HTTP/download bytes and original failed report were not changed.' };
await writeFile(path.join(dir, 'gif-readonly-reconciliation.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report));
