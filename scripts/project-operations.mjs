import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const operationsDirectory = (root) => path.join(path.dirname(path.resolve(root)), `${path.basename(path.resolve(root))}.执行日志`);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const allowed = new Set(['task','stage','status','summary','nextAction','sourceVersion','buildId','gitCommit','evidence']);

export function readLatestOperation(root) {
  const journal = path.join(operationsDirectory(root), 'events.jsonl');
  if (!fs.existsSync(journal)) return null;
  const fd = fs.openSync(journal, 'r');
  let tail;
  try {
    const size = fs.fstatSync(fd).size;
    const bytes = Math.min(size, 65536);
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, size - bytes);
    tail = buffer.toString('utf8');
  } finally { fs.closeSync(fd); }
  if (!tail.trim()) return null;
  if (!tail.endsWith('\n')) throw new Error('OPERATION_LOG_INCOMPLETE: preserve journal and recover its last write');
  const line = tail.trimEnd().split('\n').at(-1);
  const { event, sha256: checksum } = JSON.parse(line);
  if (checksum !== sha256(JSON.stringify(event))) throw new Error('OPERATION_LOG_CHECKSUM_MISMATCH');
  return event;
}

export function recordOperation(rootInput, input) {
  const root = path.resolve(rootInput);
  const directory = operationsDirectory(root);
  fs.mkdirSync(directory, {recursive:true});
  const lock = path.join(directory, '.write.lock');
  const fd = fs.openSync(lock, 'wx');
  try {
    const patch = {};
    for (const [key, value] of Object.entries(input)) {
      if (!allowed.has(key) || typeof value !== 'string' || value.length > 1200 || /[\r\n\0]/.test(value)) throw new Error(`INVALID_OPERATION_FIELD: ${key}`);
      // Accept summaries/IDs only, never command lines, credentials or signed URLs.
      if (/(?:bearer\s+|(?:password|secret|token|api[_ -]?key|access[_ -]?key|密码|密钥)\s*[:=：]|https?:\/\/[^\s]*[?]|sk-[A-Za-z0-9]{12,})/i.test(value)) throw new Error(`SENSITIVE_OPERATION_FIELD: ${key}`);
      patch[key] = value;
    }
    if (!['pending','running','passed','failed'].includes(patch.status) || !patch.stage || !patch.summary) throw new Error('OPERATION_STATUS_REQUIRED');
    const previous = readLatestOperation(root);
    const event = {
      schemaVersion:1, id:crypto.randomUUID(), at:new Date().toISOString(), previousId:previous?.id || null,
      task:previous?.task || '自媒体操盘手本地优化与验收', nextAction:previous?.nextAction || '核对当前任务清单',
      sourceVersion:previous?.sourceVersion || '', buildId:previous?.buildId || '', gitCommit:previous?.gitCommit || '',
      ...patch,
    };
    const journalFd = fs.openSync(path.join(directory,'events.jsonl'), 'a');
    try { fs.writeFileSync(journalFd, JSON.stringify({event,sha256:sha256(JSON.stringify(event))})+'\n'); fs.fsyncSync(journalFd); }
    finally { fs.closeSync(journalFd); }
    // The journal is authoritative. current.json is a convenient recoverable projection.
    const temporary = path.join(directory, `.current-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(event,null,2)+'\n', {flag:'wx'});
    try { fs.renameSync(temporary,path.join(directory,'current.json')); }
    finally { if(fs.existsSync(temporary))fs.unlinkSync(temporary); }
    return event;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const action=process.argv[2] || 'status';
    const root=path.resolve(process.argv[3] || process.cwd());
    if (action==='status') console.log(JSON.stringify(readLatestOperation(root),null,2));
    else if (action==='record' && process.argv[4]) console.log(JSON.stringify(recordOperation(root,JSON.parse(fs.readFileSync(process.argv[4],'utf8'))),null,2));
    else throw new Error('Expected status [root] or record <root> <structured-json-file>');
  } catch(error){console.error(error.message);process.exitCode=1;}
}
