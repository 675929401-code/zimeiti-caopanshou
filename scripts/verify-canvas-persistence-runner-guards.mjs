import assert from 'node:assert/strict';
import { makeTextDocument, safeCanvasMutation } from './verify-canvas-persistence-local-e2e.mjs';

const own = 'canvas:11111111-1111-4111-8111-111111111111';
const foreign = 'canvas:22222222-2222-4222-8222-222222222222';
const ids = new Set([own]);
const save = (id, name = '隔离文本') => ({ action: 'save', canvasId: id, expectedRevision: 0,
  document: makeTextDocument(id, name, '只手动保存文本，不生成') });
let cases = 0;
function check(name, expected, callback) { assert.equal(callback(), expected, name); cases++; console.log(`PASS ${name}`); }
check('own text document may be persisted', true, () => safeCanvasMutation('POST', save(own), ids));
check('existing foreign canvas may never be persisted', false, () => safeCanvasMutation('POST', save(foreign), ids));
check('foreign deletion is rejected', false, () => safeCanvasMutation('DELETE', { canvasId: foreign }, ids));
check('foreign copy is rejected', false, () => safeCanvasMutation('POST', { action: 'copy', sourceCanvasId: foreign }, ids));
check('own copy is permitted', true, () => safeCanvasMutation('POST', { action: 'copy', sourceCanvasId: own }, ids));
check('a fresh canvas needs an explicit creation window', false, () => safeCanvasMutation('POST', save(foreign, '新会话'), ids));
check('creation window allows only the real UI new-canvas payload', true, () => safeCanvasMutation('POST', save(foreign, '新会话'), ids, true));
check('creation window cannot edit an existing revision', false, () => safeCanvasMutation('POST', { ...save(foreign, '新会话'), expectedRevision: 1 }, ids, true));
check('media nodes cannot be saved by this text-only runner', false, () => { const body = save(own); body.document.session.nodes[0].data.kind = 'video'; return safeCanvasMutation('POST', body, ids); });
check('generation history cannot be imported', false, () => { const body = save(own); body.document.runHistory.push({ status: 'succeeded' }); return safeCanvasMutation('POST', body, ids); });
check('body and document canvas identities must match', false, () => { const body = save(own); body.document.session.id = foreign; return safeCanvasMutation('POST', body, ids); });
check('unrelated mutation verb is rejected', false, () => safeCanvasMutation('PUT', save(own), ids));
console.log(JSON.stringify({ cases, realNetwork: 0, realDatabaseWrites: 0, realProviderSubmissions: 0 }));
