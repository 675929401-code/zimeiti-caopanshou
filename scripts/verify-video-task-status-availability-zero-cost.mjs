import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync('src/lib/video-task-status.ts', 'utf8');
const start = source.indexOf('async function readLocalVideoTaskSnapshot(');
const end = source.indexOf('// GET /api/video/status', start);
let tickets = 0;
const sandbox = { exports: {}, NextResponse: { json: (body) => body }, createVideoAccessUrl: async () => { tickets++; return '/ticket'; } };
vm.runInNewContext(ts.transpileModule(source.slice(start, end) + '\nexports.snapshot = readLocalVideoTaskSnapshot;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
const cases = [];
for (const flags of [{}, { source_expired_at: '2026-10-12' }, { history_hidden_at: '2026-10-12' }, { source_expired_at: 'x', history_hidden_at: 'x' }]) {
 const previous = tickets;
 const result = await sandbox.exports.snapshot({ task: { id: 'owned', status: 'completed', price_charged: 25, billing_state: 'settled', ...flags }, taskId: 'owned', userId: 'owner', userRole: 'student' });
 assert.equal(result.status, 'completed'); assert.equal(result.priceCharged, 25); assert.equal(result.billingState, 'settled');
 const available = !flags.source_expired_at && !flags.history_hidden_at;
 assert.equal(result.mediaAvailable, available); assert.equal(result.videoUrl, available ? '/ticket' : ''); assert.equal(tickets - previous, available ? 1 : 0);
 assert.equal(result.mediaUnavailableReason, flags.history_hidden_at ? 'history_hidden' : flags.source_expired_at ? 'source_expired' : null);
 assert.equal(result.retryable, false);
 cases.push({ flags, result: 'PASS' });
}
assert.match(source, /!advanceProvider \|\| \(existingTask.status === "completed"[\s\S]*existingTask.source_expired_at \|\| existingTask.history_hidden_at/u);
const report = { ok: true, tests: cases.length, ticketCalls: tickets, productionDatabaseCalls: 0, networkCalls: 0, realBrowserDecodeTested: false, cases };
if (process.env.VIDEO_TEST_EVIDENCE_DIR) { fs.mkdirSync(process.env.VIDEO_TEST_EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.VIDEO_TEST_EVIDENCE_DIR, 'status-availability-report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
