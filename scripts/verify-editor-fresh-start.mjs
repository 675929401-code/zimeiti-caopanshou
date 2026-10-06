import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const evaluate = (file, modules = {}) => {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, require(id) { assert.ok(id in modules); return modules[id]; } });
  return module.exports;
};
const scoped = evaluate('src/lib/workbench-user-storage.ts');
const { clearRetiredPageDrafts } = evaluate('src/lib/retired-page-drafts.ts', { './workbench-user-storage': scoped });
function storage(values) { const data = new Map(Object.entries(values)); return { data, get length() { return data.size; }, key: i => [...data.keys()][i], removeItem: key => data.delete(key), setItem() { throw new Error('Cleanup must never write drafts'); } }; }
const preserved = { 'auth_token': 'untouched', 'extract_account_history:user:alice': 'owned history', 'production-client-attempt:v1:extract:alice:single': 'original request id', 'video-task-checkpoint:v1:bob:request': 'other owner', 'extract_page_state:user:bob': 'other owner', 'app_state_storyboard:alice': 'different feature' };
for (const area of ['extract', 'video']) {
  const retired = area === 'extract' ? { extract_page_state: 'legacy', 'extract_page_state:user:alice': 'old URLs', extract_state: 'old draft' } : { 'app_state_video_selected_model:user:alice': 'old model', 'app_state_video_tasks': 'old cards', 'video-task-checkpoint:v1:alice:request': 'old pending card' };
  for (const location of ['local', 'session']) {
    const local = storage({ ...preserved, ...(location === 'local' ? retired : {}) });
    const session = storage({ ...preserved, ...(location === 'session' ? retired : {}) });
    clearRetiredPageDrafts(area, 'alice', local, session);
    for (const store of [local, session]) { for (const key of Object.keys(retired)) assert.equal(store.data.has(key), false); for (const [key,value] of Object.entries(preserved)) assert.equal(store.data.get(key), value); }
  }
}
const unavailable = { get length() { throw new Error('restricted'); }, removeItem() { throw new Error('restricted'); } };
assert.doesNotThrow(() => clearRetiredPageDrafts('video', 'alice', unavailable, unavailable));
const video = fs.readFileSync('src/app/video/page.tsx', 'utf8');
const extract = fs.readFileSync('src/app/extract/page.tsx', 'utf8');
const tools = fs.readFileSync('src/app/tools/page.tsx', 'utf8');
assert.ok(video.includes('useState<TaskCard[]>(createDefaultCards)'));
assert.ok(!/readVideoTaskCheckpoints|persistVideoTaskCheckpoint|usePersistedState|status=active/.test(video));
assert.ok(video.includes('consumedUrl.searchParams.delete("workflow")'));
assert.ok(
  video.includes('/api/video/history?surface=video-page&limit=100&offset='),
  'ordinary video history must remain explicitly accessible and scoped away from storyboard/digital-human tasks',
);
assert.ok(!/loadPersistState|savePersistState|loadScopedExtractState/.test(extract));
assert.ok(extract.includes('useState<ExtractResult | null>(null)'));
assert.ok(extract.includes('useState<ExtractResult[]>([])'));
assert.ok(extract.includes('useExtractionHistory<ExtractResult>'));
assert.ok(!tools.includes('localStorage.getItem("toolbox_active_tab")'));
assert.ok(!tools.includes('localStorage.setItem("toolbox_active_tab")'));
console.log(JSON.stringify({ passed: true, browserStorageCases: 5, editorContracts: 10, backendWrites: 0 }));
