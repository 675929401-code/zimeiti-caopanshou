import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readDatabaseTargetIdentity } from './database-target-identity.mjs';

const loopback = host => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(String(host).toLowerCase());
const actualLoopback = address => loopback(address) || ['local', '127.0.0.1/32', '::1/128'].includes(String(address).toLowerCase());
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function checkedBytes(file, expectedSha, maxBytes = 1024 * 1024) {
  assert.match(String(expectedSha), /^[a-f0-9]{64}$/u, 'EXPECTED_FILE_SHA_REQUIRED');
  const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes, 'BACKUP_EVIDENCE_FILE_UNSAFE');
  const bytes = fs.readFileSync(file); assert.equal(sha(bytes), expectedSha, 'BACKUP_EVIDENCE_SHA_MISMATCH'); return bytes;
}
function archiveDigest(file) {
  const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 5, 'BACKUP_ARCHIVE_UNSAFE');
  const descriptor = fs.openSync(file, 'r'), hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  let bytes = 0, header = '';
  try { let count; while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) { if (bytes === 0) header = buffer.subarray(0, Math.min(5, count)).toString('ascii'); hash.update(buffer.subarray(0, count)); bytes += count; } }
  finally { fs.closeSync(descriptor); }
  return { sha256: hash.digest('hex'), bytes, header };
}

/** Reuse the project's canonical identity and ORIGINAL verified backup evidence.
 * This helper does not create/adapt backups and has no writes or CLI effects.
 */
export async function confirmLocalModelPendingDatabase(client, databaseUrl, options) {
  const target = new URL(databaseUrl);
  const database = decodeURIComponent(target.pathname.slice(1));
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol) && loopback(target.hostname) && database === 'zimeiti_local', 'LOCAL_ZIMEITI_DATABASE_ENDPOINT_REQUIRED');
  const identity = await readDatabaseTargetIdentity(client, target.hostname);
  assert.equal(identity.databaseName, 'zimeiti_local', 'LOCAL_DATABASE_NAME_REQUIRED');
  assert.ok(actualLoopback(identity.serverAddress), 'ACTUAL_DATABASE_LOOPBACK_REQUIRED');
  assert.match(String(options.expectedFingerprint), /^[a-f0-9]{64}$/u, 'CANONICAL_TARGET_FINGERPRINT_REQUIRED');
  assert.equal(identity.fingerprint, options.expectedFingerprint, 'CANONICAL_DATABASE_FINGERPRINT_MISMATCH');
  let receiptPath = path.resolve(options.backupReceiptPath);
  const inputBytes = checkedBytes(receiptPath, options.backupReceiptSha256);
  let receipt = JSON.parse(inputBytes.toString('utf8')), wrapperArchive = null;
  // local-backup-result.json is an existing pointer receipt, not a new backup.
  if (receipt.kind !== 'pre-migration-database-backup-receipt.v1') {
    assert.equal(receipt.mode, 'execute', 'EXISTING_BACKUP_RESULT_REQUIRED'); assert.equal(receipt.verified, true, 'EXISTING_BACKUP_RESULT_NOT_VERIFIED');
    assert.ok(typeof receipt.receiptPath === 'string' && receipt.receiptPath, 'ORIGINAL_BACKUP_RECEIPT_PATH_REQUIRED');
    wrapperArchive = receipt.archiveSha256;
    receiptPath = path.resolve(path.dirname(receiptPath), receipt.receiptPath);
    receipt = JSON.parse(checkedBytes(receiptPath, receipt.receiptSha256).toString('utf8'));
  }
  assert.equal(receipt.kind, 'pre-migration-database-backup-receipt.v1', 'ORIGINAL_BACKUP_SCHEMA_REQUIRED');
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.targetClass, 'local-loopback-only');
  assert.equal(receipt.database, identity.databaseName); assert.equal(receipt.targetFingerprint, identity.fingerprint);
  assert.equal(receipt.targetHost, target.hostname); assert.equal(Number(receipt.targetPort), Number(target.port || 5432));
  assert.equal(receipt.format, 'postgres-custom'); assert.equal(receipt.restore?.status, 'verified', 'ORIGINAL_RESTORE_VERIFICATION_REQUIRED');
  const archive = archiveDigest(path.resolve(path.dirname(receiptPath), receipt.archivePath));
  assert.equal(archive.sha256, receipt.archiveSha256, 'ACTUAL_ARCHIVE_SHA_MISMATCH');
  if (wrapperArchive) assert.equal(archive.sha256, wrapperArchive, 'EXISTING_BACKUP_RESULT_ARCHIVE_MISMATCH');
  if (options.backupArchiveSha256) assert.equal(archive.sha256, options.backupArchiveSha256, 'CONFIRMED_ARCHIVE_SHA_MISMATCH');
  assert.equal(archive.header, 'PGDMP'); assert.equal(archive.bytes, receipt.archiveBytes);
  assert.equal(receipt.readability?.exitCode, 0); assert.ok(receipt.readability.entryCount > 0);
  checkedBytes(path.resolve(path.dirname(receiptPath), receipt.readability.evidencePath), receipt.readability.evidenceSha256, 16 * 1024 * 1024);
  const restore = JSON.parse(checkedBytes(path.resolve(path.dirname(receiptPath), receipt.restore.evidencePath), receipt.restore.evidenceSha256).toString('utf8'));
  assert.equal(restore.kind, 'database-isolated-restore-report.v1'); assert.equal(restore.archiveSha256, archive.sha256); assert.equal(restore.sourceTargetFingerprint, identity.fingerprint);
  assert.equal(restore.exitCode, 0); assert.equal(restore.targetIsolated, true); assert.equal(restore.checks?.schema, true); assert.equal(restore.checks?.data, true);
  assert.ok(loopback(restore.target?.host) && typeof restore.target?.database === 'string' && restore.target.database && Number.isInteger(restore.target?.port) && !(Number(restore.target.port) === Number(target.port || 5432) && restore.target.database === database), 'ISOLATED_RESTORE_TARGET_REQUIRED');
  return { identity, backupInputSha256: options.backupReceiptSha256, archiveSha256: archive.sha256 };
}
