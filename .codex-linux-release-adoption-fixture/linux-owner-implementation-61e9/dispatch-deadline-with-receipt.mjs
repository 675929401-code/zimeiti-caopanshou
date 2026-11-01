// Internal transport control only. No command, host, credential, marker or
// production entry is provided here. The caller must already authenticate the
// plan/capture, consume its permission token and claim its durable marker.
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';

const windows = new WeakMap();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const unknown = (reason, wireSubmitted, childStopRequested = false) => Object.freeze({
  outcome:'COMMIT_OUTCOME_UNKNOWN_NO_RETRY', reason, wireSubmitted,
  childStopRequested, serverRollbackProven:false, automaticRetry:false,
  recoveryRequired:true, markerMustBeRetained:true,
});

// This token is a time/byte binding, NOT an authorization token. In particular,
// minting it must never substitute for the existing authenticated gates.
export function createDispatchDeadline({batchId,wireSha256,latestSendAt,receiptBy}) {
  const wall = Date.now(), mono = performance.now();
  if (!uuid(batchId) || !hash(wireSha256) || !Number.isSafeInteger(latestSendAt)
      || !Number.isSafeInteger(receiptBy) || latestSendAt <= wall || receiptBy < latestSendAt
      || receiptBy - wall > 900000) throw Error('DISPATCH_DEADLINE_INVALID');
  const token = Object.freeze(Object.create(null));
  windows.set(token,{batchId,wireSha256,latestSendAt,receiptBy,
    sendMono:mono + latestSendAt-wall, receiptMono:mono + receiptBy-wall});
  return token;
}

// Only the already fixed SSH factory should be supplied by the private caller.
// Tests use real, owned local child processes. A deadline kills only that child;
// it never asserts the remote backend stopped or rolled back.
export async function sendWithinDeadline({deadline,wire,batchId,spawnFixed}) {
  const bound = windows.get(deadline); windows.delete(deadline);
  if (!bound || !Buffer.isBuffer(wire) || wire.length > 24*1024*1024
      || bound.batchId !== batchId || sha(wire) !== bound.wireSha256
      || typeof spawnFixed !== 'function') return unknown('DEADLINE_OR_WIRE_INVALID',false);
  const expiredSend = () => Date.now() >= bound.latestSendAt || performance.now() >= bound.sendMono;
  const expiredReceipt = () => Date.now() >= bound.receiptBy || performance.now() >= bound.receiptMono;
  if (expiredSend()) return unknown('DEADLINE_BEFORE_SPAWN',false);
  // Own a copy; mutation of the caller's buffer after validation cannot alter
  // the bytes sent while a subprocess is starting.
  const bytes = Buffer.from(wire);
  return new Promise(resolve => {
    let child, timer, done=false, submitted=false, stopped=false, stdout=Buffer.alloc(0);
    const stop = () => { if (child && !stopped) {stopped=true;try {child.kill();} catch {}} };
    const finish = value => {if(done)return;done=true;clearTimeout(timer);resolve(value);};
    const fail = reason => {if(done)return;stop();finish(unknown(reason,submitted,stopped));};
    const tick = () => {
      if (done) return;
      if (expiredReceipt()) {fail('RECEIPT_DEADLINE');return;}
      timer=setTimeout(tick,Math.max(1,Math.min(100,bound.receiptMono-performance.now(),bound.receiptBy-Date.now())));
    };
    try {
      child=spawnFixed();
      if (!child?.stdin || !child?.stdout || !child?.stderr || typeof child.on!=='function') {
        fail('CHILD_INVALID');return;
      }
      child.on('error',()=>fail('CHILD_ERROR'));
      child.stdin.on('error',()=>fail('STDIN_ERROR'));
      child.stdout.on('error',()=>fail('STDOUT_ERROR'));
      child.stderr.on('error',()=>fail('STDERR_ERROR'));
      child.stderr.on('data',()=>{});
      child.stdout.on('data',chunk=>{
        if(done)return;
        if (!Buffer.isBuffer(chunk) || stdout.length+chunk.length>256) {fail('RECEIPT_OVERFLOW');return;}
        stdout=Buffer.concat([stdout,chunk]);
      });
      child.on('close',(code,signal)=>{
        if(done)return;
        if(expiredReceipt()){fail('RECEIPT_DEADLINE');return;}
        const text=stdout.toString('utf8'),marker='COMMIT_CONFIRMED_'+batchId;
        if (submitted && code===0 && signal===null && (text===marker+'\n'||text===marker+'\r\n'))
          finish(Object.freeze({outcome:'COMMITTED',reason:'EXACT_RECEIPT',wireSubmitted:true,receiptText:text,
            childStopRequested:false,serverRollbackProven:false,automaticRetry:false,
            recoveryRequired:false,markerMustBeRetained:true}));
        else finish(unknown('RECEIPT_NOT_CONFIRMED',submitted));
      });
      // Recheck after spawn and immediately before handing any bytes to stdin.
      if(expiredSend()){fail('DEADLINE_BEFORE_STDIN');return;}
      tick();
      if(done)return;
      submitted=true; // Conservative even if end() throws or only partially writes.
      child.stdin.end(bytes);
    } catch {fail('SPAWN_OR_WRITE_ERROR');}
  });
}

export const dispatchDeadlineState=Object.freeze({productionEntry:false,authorizesSubmission:false,
  stopsRemoteBackend:false,provesTransactionTimeout:false,automaticRetry:false});
