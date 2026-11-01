import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import Database from 'better-sqlite3';

const root = process.cwd();
const evidence = path.resolve('.codex-evidence/admin-full-acceptance-20261030-9592a6d0/voice');
const require = createRequire(import.meta.url);
const db = new Database(':memory:');
db.exec('CREATE TABLE ModelConfig (id TEXT PRIMARY KEY,name TEXT,modelId TEXT UNIQUE,resourceId TEXT,totalPrice REAL,totalChars INTEGER,costPrice REAL,unit TEXT,profitMargin REAL,isActive INTEGER,sort INTEGER,createdAt INTEGER,updatedAt INTEGER)');
const modules = new Map();
let actorAllowed = true;
const auth = async (_request, fn) => actorAllowed ? fn({ id: 'fixture-admin' }) : Response.json({ success: false }, { status: 403 });
function load(relative) {
  const absolute = path.resolve(root, relative);
  if (modules.has(absolute)) return modules.get(absolute).exports;
  const module = { exports: {} };
  modules.set(absolute, module);
  const localRequire = name => {
    if (name === 'next/server') return { NextResponse: { json: (value, options) => Response.json(value, options) } };
    if (name === '@/lib/api-middleware') return { withAdminAuth: auth };
    if (name === '@/lib/voice-studio/db') return {
      queryAll: (sql, params = []) => db.prepare(sql).all(...params),
      queryOne: (sql, params = []) => db.prepare(sql).get(...params),
      execute: (sql, params = []) => db.prepare(sql).run(...params),
      getVoiceDb: () => db,
    };
    if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
    if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(absolute), name + '.ts')));
    return require(name);
  };
  const output = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(output, { require: localRequire, module, exports: module.exports, Request, Response, URL, console, Date, Object, JSON }, { filename: relative });
  return module.exports;
}
const collection = load('src/app/api/admin/voice-studio/models/route.ts');
const item = load('src/app/api/admin/voice-studio/models/[id]/route.ts');
const base = 'http://fixture.local/api/admin/voice-studio/models';
const body = overrides => ({ name: '验收服务', modelId: 'seed-tts-2.0', resourceId: 'seed-tts-2.0', totalPrice: 28, totalChars: 100000, unit: '千字符', profitMargin: 100, isActive: false, ...overrides });
const request = (method, input, url = base) => new Request(url, { method, ...(input ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}) });
const call = async (handler, method, input, url = base, id = '') => {
  const response = await handler(request(method, input, url), { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() };
};
const cases = [];
try {
  if (process.argv.includes('--baseline')) {
    const unknown = await call(collection.POST, 'POST', body({ modelId: 'unwired-voice-service', resourceId: 'unwired-voice-service', isActive: true }));
    const known = await call(collection.POST, 'POST', body());
    const id = known.body.data.id;
    const invalidItem = await call(item.PUT, 'PUT', { costPrice: -12 }, `${base}/${id}`, id);
    const missing = await call(item.PUT, 'PUT', { name: 'missing' }, `${base}/missing`, 'missing');
    const report = { phase: 'before-fix', reproduced: true, issues: [
      { id: 'unsupported-service-activated', status: unknown.status, activeRows: db.prepare('SELECT count(*) AS count FROM ModelConfig WHERE modelId=? AND isActive=1').get('unwired-voice-service').count },
      { id: 'item-route-bypasses-cost-validation', status: invalidItem.status, storedCost: db.prepare('SELECT costPrice FROM ModelConfig WHERE id=?').get(id).costPrice },
      { id: 'item-route-acknowledges-missing-row', status: missing.status },
    ], realDatabaseWrites: 0, providerCalls: 0, inMemoryDatabaseOnly: true };
    fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'baseline-reproduction.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } else {
    const unsupported = await call(collection.POST, 'POST', body({ modelId: 'unwired-voice-service', resourceId: 'unwired-voice-service', isActive: true }));
    assert.equal(unsupported.status, 400); assert.equal(unsupported.body.code, 'VOICE_PRICING_SERVICE_UNSUPPORTED');
    assert.equal(db.prepare('SELECT count(*) AS count FROM ModelConfig').get().count, 0); cases.push('unsupported active service rejected before write');
    const specificVersion = await call(collection.POST, 'POST', body({ modelId: 'seed-tts-2.0-standard' }));
    assert.equal(specificVersion.status, 400); cases.push('provider version cannot be mistaken for pricing service');
    const known = await call(collection.POST, 'POST', body({ isActive: true }));
    assert.equal(known.status, 200); const id = known.body.data.id;
    assert.ok(Math.abs(db.prepare('SELECT costPrice FROM ModelConfig WHERE id=?').get(id).costPrice - 0.28) < 1e-12); cases.push('supported service uses unchanged derived cost formula');
    const duplicate = await call(collection.POST, 'POST', body()); assert.equal(duplicate.status, 409); cases.push('duplicate billing service cannot be added');
    const unquoted = await call(collection.POST, 'POST', { name: '无报价服务', modelId: 'seed-tts-1.0', resourceId: 'seed-tts-1.0' }); assert.equal(unquoted.status, 400); cases.push('new service cannot acquire invented default pricing');
    const invalid = await call(item.PUT, 'PUT', { totalPrice: -1 }, `${base}/${id}`, id); assert.equal(invalid.status, 400);
    assert.equal(db.prepare('SELECT totalPrice FROM ModelConfig WHERE id=?').get(id).totalPrice, 28); cases.push('item route applies collection numeric validation');
    const directCost = await call(item.PUT, 'PUT', { costPrice: -12 }, `${base}/${id}`, id); assert.equal(directCost.status, 400); cases.push('derived cost cannot be overwritten directly');
    const validItem = await call(item.PUT, 'PUT', { totalPrice: 14 }, `${base}/${id}`, id); assert.equal(validItem.status, 200);
    assert.ok(Math.abs(db.prepare('SELECT costPrice FROM ModelConfig WHERE id=?').get(id).costPrice - 0.14) < 1e-12); cases.push('item update recomputes derived cost and reads back');
    const conflictingId = await call(item.PUT, 'PUT', { id: 'another', name: 'bad' }, `${base}/${id}`, id); assert.equal(conflictingId.status, 400); cases.push('path and body identity mismatch rejected');
    const replaceService = await call(collection.PUT, 'PUT', { id, modelId: 'seed-tts-1.0' }); assert.equal(replaceService.status, 400); cases.push('stable billing identity cannot be renamed into another service');
    const missing = await call(item.PUT, 'PUT', { name: 'missing' }, `${base}/missing`, 'missing'); assert.equal(missing.status, 404); cases.push('missing item update is not acknowledged');
    const secret = await call(item.PUT, 'PUT', { apiKey: 'fixture-not-a-real-secret' }, `${base}/${id}`, id); assert.equal(secret.status, 400); assert.equal(secret.body.code, 'VOICE_PROVIDER_SECRET_MANAGED_EXTERNALLY'); cases.push('item route rejects legacy secret writes');
    const listed = await call(collection.GET, 'GET');
    assert.equal(listed.body.data[0].runtimeSupported, true); assert.ok(listed.body.data[0].serviceDescription); cases.push('listing explains supported runtime service');
    db.prepare('INSERT INTO ModelConfig (id,name,modelId,resourceId,totalPrice,totalChars,costPrice,unit,profitMargin,isActive,sort,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy','旧记录','legacy-unknown','legacy',1,1000,1,'千字符',0,0,0,0,0);
    const legacyList = await call(collection.GET, 'GET'); assert.equal(legacyList.body.data.find(row => row.id === 'legacy').runtimeSupported, false); cases.push('unknown legacy row stays visible with truthful support status');
    const legacyEdit = await call(collection.PUT, 'PUT', { id: 'legacy', name: '旧记录改名' }); assert.equal(legacyEdit.status, 200); cases.push('inactive legacy metadata remains editable');
    const legacyEnable = await call(collection.PUT, 'PUT', { id: 'legacy', isActive: true }); assert.equal(legacyEnable.status, 400); cases.push('unknown legacy service cannot be newly enabled');
    db.prepare('UPDATE ModelConfig SET totalPrice=-1,costPrice=-1,isActive=1 WHERE id=?').run('legacy');
    const legacyStop = await call(item.PUT, 'PUT', { isActive: false }, `${base}/legacy`, 'legacy'); assert.equal(legacyStop.status, 200);
    assert.equal(db.prepare('SELECT isActive FROM ModelConfig WHERE id=?').get('legacy').isActive, 0); cases.push('invalid historical pricing does not prevent explicit deactivation');
    db.prepare('INSERT INTO ModelConfig (id,name,modelId,resourceId,totalPrice,totalChars,costPrice,unit,profitMargin,isActive,sort,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('retired','历史声音设计','seed-icl-2.0-design','legacy-design',99,12,8.25,'次',3,1,7,0,0);
    const retiredBefore = db.prepare('SELECT * FROM ModelConfig WHERE id=?').get('retired');
    const retiredList = await call(collection.GET, 'GET');
    assert.equal(retiredList.body.data.find(row => row.id === 'retired').supportStatus, 'retired');
    assert.deepEqual(db.prepare('SELECT * FROM ModelConfig WHERE id=?').get('retired'), retiredBefore); cases.push('known retired design remains visible and reading preserves every historical value');
    const retiredEnable = await call(collection.PUT, 'PUT', { id: 'retired', isActive: true }); assert.equal(retiredEnable.status, 400);
    const retiredStop = await call(collection.PUT, 'PUT', { id: 'retired', isActive: false }); assert.equal(retiredStop.status, 200);
    const retiredAfter = db.prepare('SELECT * FROM ModelConfig WHERE id=?').get('retired');
    assert.equal(retiredAfter.isActive, 0); for (const key of ['totalPrice','totalChars','costPrice','resourceId','unit']) assert.equal(retiredAfter[key], retiredBefore[key]); cases.push('retired design cannot reenable but explicit stop preserves historical pricing');
    const perCall = await call(collection.POST, 'POST', body({ modelId: 'seed-audio-1.0', unit: '次', totalPrice: 10, totalChars: 100 })); assert.equal(perCall.status, 200);
    assert.equal(db.prepare('SELECT costPrice FROM ModelConfig WHERE modelId=?').get('seed-audio-1.0').costPrice, 0.1); cases.push('per-call unit uses the same API and form multiplier');
    actorAllowed = false;
    for (const [handler, method, input, url, itemId] of [[collection.POST, 'POST', body(), base, ''], [item.PUT, 'PUT', { name: 'forbidden' }, `${base}/${id}`, id], [item.DELETE, 'DELETE', null, `${base}/${id}`, id]]) {
      assert.equal((await call(handler, method, input, url, itemId)).status, 403);
    }
    actorAllowed = true; cases.push('both paths retain the admin authorization wrapper');
    const removed = await call(item.DELETE, 'DELETE', null, `${base}/${id}`, id); assert.equal(removed.status, 200);
    const removedAgain = await call(item.DELETE, 'DELETE', null, `${base}/${id}`, id); assert.equal(removedAgain.status, 404); cases.push('item delete verifies actual affected row');
    const report = { passed: true, cases, scenarioCount: cases.length, realDatabaseWrites: 0, providerCalls: 0, inMemoryDatabaseOnly: true };
    fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'contract-verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  }
} finally { db.close(); }
