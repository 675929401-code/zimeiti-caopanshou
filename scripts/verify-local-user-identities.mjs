import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';

const runtimePath = process.argv[2];
assert.ok(runtimePath, 'Explicit protected local runtime config required');
const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
assert.equal(runtime.localOnly, true);
assert.equal(new URL(runtime.databaseUrl).hostname, '127.0.0.1');
const ids = [crypto.randomUUID(), crypto.randomUUID()];
const marker = `local_e2e_identity_${crypto.randomBytes(6).toString('hex')}`;
const phone = `199${crypto.randomInt(10000000, 99999999)}`;
const clients = [0, 1, 2].map(() => new pg.Client({ connectionString: runtime.databaseUrl }));
await Promise.all(clients.map(client => client.connect()));
const admin = clients[0];
try {
  for (let i = 0; i < ids.length; i++) {
    await admin.query("insert into users(id,username,display_name,email,password_hash,role,credits,is_active,status) values($1,$2,$3,$4,'!disabled-local-fixture','student',0,false,'blocked')", [ids[i], `${marker}_${i}`, marker, `${marker}_${i}@example.invalid`]);
  }
  const attempts = await Promise.allSettled(ids.map((id, i) => clients[i + 1].query('update users set phone=$1 where id=$2', [phone, id])));
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  const failure = attempts.find(item => item.status === 'rejected');
  assert.equal(failure.reason.code, '23505');
  assert.equal(Number((await admin.query('select count(*) from users where phone=$1', [phone])).rows[0].count), 1);
  await assert.rejects(admin.query('update users set username=$1 where id=$2', [`${marker}_0@EXAMPLE.INVALID`, ids[1]]), error => error.code === '23505');
  const owner = (await admin.query('select user_id from user_login_identifiers where identifier=$1', [phone])).rows[0].user_id;
  await admin.query('update users set phone=null where id=$1', [owner]);
  await admin.query('update users set phone=$1 where id=$2', [phone, ids.find(id => id !== owner)]);
  const checks = await admin.query('select count(*) from user_login_identifiers where user_id = any($1::varchar[])', [ids]);
  assert.ok(Number(checks.rows[0].count) >= 4);
  console.log(JSON.stringify({ localOnly: true, concurrentAttempts: 2, committed: 1, conflictingAttemptRejected: true, crossFieldCaseCollisionRejected: true, releasedIdentifierReusable: true }));
} finally {
  await admin.query('delete from users where id=any($1::varchar[])', [ids]);
  assert.equal(Number((await admin.query('select count(*) from user_login_identifiers where user_id=any($1::varchar[])', [ids])).rows[0].count), 0);
  await Promise.all(clients.map(client => client.end()));
}
