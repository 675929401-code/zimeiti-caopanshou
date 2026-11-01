// Prototype only. No filesystem, network, PM2, SQL, or application side effects.
// The host controller must exclusively create/store an ephemeral signing key and
// signed receipts, authenticate their producer, protect files, check clock/boot
// and feed values from independently observed production state.
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const sort = x => Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])) : x;
const canonical = x => JSON.stringify(sort(x));
const digest = x => crypto.createHash('sha256').update(canonical(x)).digest('hex');
export const hashValue=digest;
export function sign(body,key) {
  assert.ok(Buffer.isBuffer(key) && key.length >= 32);
  return {body, mac:crypto.createHmac('sha256',key).update(canonical(body)).digest('hex')};
}
function verify(envelope,key,kind,now) {
  assert.ok(envelope && envelope.body && /^[0-9a-f]{64}$/.test(envelope.mac||''));
  const expected=Buffer.from(sign(envelope.body,key).mac,'hex'),received=Buffer.from(envelope.mac,'hex');
  assert.ok(crypto.timingSafeEqual(expected,received));
  assert.equal(envelope.body.kind,kind);
  assert.ok(Number.isSafeInteger(envelope.body.createdAt) && Number.isSafeInteger(envelope.body.expiresAt));
  assert.ok(envelope.body.createdAt<=now && now<envelope.body.expiresAt);
  return envelope.body;
}
function binding(actual,expected) {for (const k of ['session','bootId','releaseId','artifactSha256','hookSha256','configSha256']) assert.equal(actual[k],expected[k],`binding:${k}`);}
export function adoptPrepared({snapshotEnvelope,drainEnvelopes,migrationEnvelope,key,expected,now,live,previous}) {
  const s=verify(snapshotEnvelope,key,'online-snapshot-v1',now); binding(s,expected);
  assert.equal(s.originalPreviousDigest,digest(previous));
  assert.equal(s.workers.length,2);
  assert.deepEqual(s.workers.map(w=>w.port).sort((a,b)=>a-b),[5102,5103]);
  assert.equal(new Set(s.workers.map(w=>w.id)).size,2);
  assert.equal(new Set(s.workers.map(w=>w.pid)).size,2);
  assert.equal(new Set(s.workers.map(w=>w.pm2UniqueId)).size,2);
  assert.ok(s.workers.every(w=>Number.isInteger(w.id)&&w.pid>0&&w.startTicks>0&&typeof w.pm2UniqueId==='string'&&w.pm2UniqueId.length>0&&w.online===true&&w.shutdownWithMessage===true));
  assert.equal(drainEnvelopes.length,2);
  const verified=drainEnvelopes.map(x=>verify(x,key,'drain-v1',now));
  for(const d of verified) {
    binding(d,expected); assert.equal(d.snapshotDigest,digest(s));
    const w=s.workers.find(x=>x.id===d.id);
    assert.ok(w); assert.equal(d.pid,w.pid); assert.equal(d.startTicks,w.startTicks);
    assert.equal(d.reason,'pm2-shutdown'); assert.equal(d.drained,true); assert.equal(d.freshBusEvent,true);
    assert.equal(d.identifiedStopped,true); assert.equal(d.replacementAbsent,true);
    assert.ok(d.stopRequestedAt>=s.createdAt && d.eventAt>=d.stopRequestedAt && d.verifiedAt>=d.eventAt && d.verifiedAt<=now);
  }
  assert.equal(new Set(verified.map(x=>x.id)).size,2);
  const m=verify(migrationEnvelope,key,'migration-v1',now);binding(m,expected);
  assert.equal(m.snapshotDigest,digest(s));
  assert.deepEqual(m.drainDigests,[...verified].sort((a,b)=>a.id-b.id).map(digest));
  assert.equal(m.outcome,'committed'); assert.equal(m.dbIdentity,expected.dbIdentity);
  assert.equal(m.migrationSqlSha256,expected.migrationSqlSha256);
  assert.ok(m.commitObservedAt>=Math.max(...verified.map(d=>d.verifiedAt)) && m.commitObservedAt<=now);
  assert.ok(live.holdStillValid && live.busBound && live.workerPidsAbsent && live.replacementsAbsent && live.portsFree);
  assert.equal(live.bootId,expected.bootId); assert.equal(live.currentReleaseId,expected.previousReleaseId);
  assert.equal(live.configSha256,expected.configSha256); assert.equal(live.hookSha256,expected.hookSha256);
  assert.deepEqual(live.stoppedIds.slice().sort((a,b)=>a-b),s.workers.map(w=>w.id).sort((a,b)=>a-b));
  return {schemaVersion:'zimeiti-media-worker-transaction.v1',workerName:'agent-hub-media-worker',
    preparedAt:new Date(now).toISOString(),configPath:expected.configPath,configSha256:expected.configSha256,
    previous,status:'preparing',slotJournal:{phase:'initial',pendingId:null,deletedIds:[]},adoptedWindow:{snapshotDigest:digest(s),migrationDigest:digest(m),
      originalWorkers:s.workers.map(({id,port,pid,startTicks,pm2UniqueId})=>({id,port,pid,startTicks,pm2UniqueId})).sort((a,b)=>a.port-b.port)}};
}




