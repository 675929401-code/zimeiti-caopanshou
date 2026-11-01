import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { confirmLocalModelPendingDatabase } from './lib/model-pending-local-verification-guard.mjs';
import { readDatabaseTargetIdentity } from './lib/database-target-identity.mjs';

const root = path.resolve('.codex-evidence/admin-full-acceptance-20261030-9592a6d0/model-pending-credentials/guard-fixture'); fs.mkdirSync(root, { recursive: true });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const databaseUrl = 'postgresql://fixture:fixture@127.0.0.1:54322/zimeiti_local';
let address = '127.0.0.1/32', queries = 0;
const client = { async query() { queries++; return { rows: [{ database_name: 'zimeiti_local', server_version: '170006', server_address: address, server_port: '54322' }] }; } };
function write(name, value) { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); fs.writeFileSync(path.join(root, name), bytes); return sha(bytes); }
async function fixture() {
  const identity = await readDatabaseTargetIdentity(client, '127.0.0.1');
  const archive = Buffer.from('PGDMP fixture only not a real backup'); const archiveSha256 = write('database.dump', archive);
  const listSha = write('list.txt', '1; fixture entry');
  const restoreSha = write('restore.json', { kind: 'database-isolated-restore-report.v1', archiveSha256, sourceTargetFingerprint: identity.fingerprint, exitCode: 0, targetIsolated: true, checks: { schema: true, data: true }, target: { host: '127.0.0.1', port: 54322, database: 'fixture_restore_only' } });
  const receipt = { kind: 'pre-migration-database-backup-receipt.v1', schemaVersion: 1, targetClass: 'local-loopback-only', targetHost: '127.0.0.1', targetPort: 54322, database: 'zimeiti_local', targetFingerprint: identity.fingerprint, archivePath: 'database.dump', archiveSha256, archiveBytes: archive.length, format: 'postgres-custom', readability: { exitCode: 0, entryCount: 1, evidencePath: 'list.txt', evidenceSha256: listSha }, restore: { status: 'verified', evidencePath: 'restore.json', evidenceSha256: restoreSha } };
  const receiptSha = write('backup-receipt.json', receipt);
  const wrapperSha = write('local-backup-result.json', { mode: 'execute', verified: true, receiptPath: path.join(root, 'backup-receipt.json'), receiptSha256: receiptSha, archiveSha256 });
  return { expectedFingerprint: identity.fingerprint, backupReceiptPath: path.join(root, 'local-backup-result.json'), backupReceiptSha256: wrapperSha, backupArchiveSha256: archiveSha256 };
}
const cases = [];
for (const actual of ['127.0.0.1/32', '::1/128']) { address = actual; const options = await fixture(); const result = await confirmLocalModelPendingDatabase(client, databaseUrl, options); assert.equal(result.identity.fingerprint, options.expectedFingerprint); cases.push(`exact loopback address ${actual} preserves canonical fingerprint`); }
for (const url of ['postgresql://fixture@production.example.test:5432/zimeiti_local', 'postgresql://fixture@127.0.0.1:54322/production', 'postgresql://fixture@local:54322/zimeiti_local']) { const before = queries; await assert.rejects(() => confirmLocalModelPendingDatabase(client, url, {})); assert.equal(queries, before); }
cases.push('non-loopback configured host wrong database and local pseudo-host rejected before identity query');
for (const actual of ['10.0.0.1', '127.0.0.1/8', '::1/64']) { address = actual; const options = await fixture(); await assert.rejects(() => confirmLocalModelPendingDatabase(client, databaseUrl, options)); }
cases.push('remote physical address and broader IPv4 IPv6 CIDR rejected');
address = '127.0.0.1/32'; const options = await fixture();
await assert.rejects(() => confirmLocalModelPendingDatabase(client, databaseUrl, { ...options, expectedFingerprint: '0'.repeat(64) })); cases.push('incorrect canonical target fingerprint rejected');
await assert.rejects(() => confirmLocalModelPendingDatabase(client, databaseUrl, { ...options, backupReceiptSha256: '0'.repeat(64) })); cases.push('changed original backup pointer bytes rejected');
fs.appendFileSync(path.join(root, 'database.dump'), 'changed'); await assert.rejects(() => confirmLocalModelPendingDatabase(client, databaseUrl, options)); cases.push('changed actual archive bytes rejected');
const report = { passed: true, cases, realDatabaseConnections: 0, realProviderCalls: 0, evidenceType: 'guard fixture only; fixture archive is never represented as a real backup' };
fs.writeFileSync(path.join(root, '..', 'guard-zero-network-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
