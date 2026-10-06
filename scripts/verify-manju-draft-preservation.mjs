import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Run the actual component state, handlers and JSX against synthetic responses.
// Only the final return is instrumented so test code can await event handlers;
// no database, local server, credential or upstream service is used.
const clone = (value) => JSON.parse(JSON.stringify(value));
function transpile(source, filename) {
  return ts.transpileModule(source, { fileName: filename, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
}
const draftModule = { exports: {} };
runInNewContext(transpile(readFileSync('src/lib/manju-admin-draft-state.ts', 'utf8'), 'draft.ts'), draftModule);
const { manjuDraftFingerprint, manjuJsonEditorChanged } = draftModule.exports;

function loadComponent(name, exposed, fixtureFetch) {
  const filename = `src/components/admin/${name}.tsx`;
  const source = readFileSync(filename, 'utf8');
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(component?.body, `actual ${name} component is present`);
  const returned = component.body.statements.findLast((node) => ts.isReturnStatement(node));
  assert.ok(returned?.expression, 'component JSX return is present');
  const instrumented = source.slice(0, returned.getStart(tree))
    + `return { ${exposed.join(', ')}, view: ${returned.expression.getText(tree)} };`
    + source.slice(returned.end);
  const state = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
    useEffect() {},
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const sandbox = {
    exports: {}, URLSearchParams, TextEncoder, FormData, File, Error,
    fetch: fixtureFetch, window: { confirm: () => true },
    require(module) {
      if (module === 'react') return hooks;
      if (module === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (module === 'lucide-react') return new Proxy({}, { get: (_target, property) => String(property) });
      if (module === '@/lib/manju-admin-draft-state') return draftModule.exports;
      throw new Error(`Unexpected component dependency: ${module}`);
    },
  };
  runInNewContext(transpile(instrumented, filename), sandbox);
  return () => { cursor = 0; return sandbox.exports[name]({ token: 'offline-fixture-only' }); };
}

function nodes(view) {
  if (Array.isArray(view)) return view.flatMap(nodes);
  if (!view || typeof view !== 'object') return [];
  return [view, ...nodes(view.props?.children)];
}
function text(view) {
  if (Array.isArray(view)) return view.map(text).join('');
  if (view && typeof view === 'object') return text(view.props?.children);
  return typeof view === 'string' || typeof view === 'number' ? String(view) : '';
}
function button(view, label) {
  const found = nodes(view).filter((node) => node.type === 'button' && text(node) === label);
  assert.equal(found.length, 1, `one ${label} button`);
  return found[0];
}

function createFixture(domain) {
  const payload = domain === 'prompt'
    ? { prompts: { example: '原提示词' }, metadata: { locale: 'zh-CN' } }
    : { retain_existing_media_policy: { enabled: true }, showcase_catalog: { v1: {
      inspiration: { overrides: {} }, canvas_examples: { overrides: {} }, banners: { overrides: {} }, hero: {},
    } } };
  const fixture = {
    domain,
    draft: { id: `${domain}-synthetic-draft`, version: 2, schema_version: '1.1.0', payload, updated_at: '2026-09-02T00:00:00.000Z' },
    active: { release_id: `${domain}-synthetic-release`, revision: { id: `${domain}-active`, version: 1, payload: clone(payload), schema_version: '1.1.0' } },
    writes: [], reads: [], rejectWrites: false, missingSchema: false, otherDraftFirst: false, hideSavedDraft: false,
    async fetch(input, init = {}) {
      const url = new URL(String(input), 'http://fixture.invalid');
      const method = init.method || 'GET';
      const respond = (body, status = 200) => Response.json(clone(body), { status });
      if (method !== 'GET') {
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
        fixture.writes.push({ path: url.pathname, method, body });
        if (url.pathname === '/api/admin/manju-workbench/assets') return respond({ ok: true });
        assert.equal(url.pathname, '/api/admin/manju-config');
        if (fixture.missingSchema) return respond({ ok: false, code: 'MIGRATION_NOT_READY' }, 503);
        if (body.action === 'save-draft') {
          if (body.expected_updated_at !== fixture.draft.updated_at || fixture.rejectWrites) {
            return respond({ ok: false, error: '草稿已被其他管理员更新，请重新加载后处理。', code: 'REVISION_CONFLICT' }, 409);
          }
          fixture.draft = { ...fixture.draft, payload: clone(body.payload), updated_at: '2026-09-02T00:01:00.000Z' };
          return respond({ ok: true, revision: fixture.draft });
        }
        if (body.action === 'publish') {
          assert.equal(body.revision_id, fixture.draft.id);
          fixture.active = { release_id: `${domain}-new-release`, revision: clone(fixture.draft) };
          return respond({ ok: true });
        }
        throw new Error(`Unexpected fixture action: ${body.action}`);
      }
      fixture.reads.push(url.pathname);
      if (url.pathname === '/api/admin/manju-config') {
        if (fixture.missingSchema) return respond({ ok: false, code: 'MIGRATION_NOT_READY' }, 503);
        const otherDraft = { ...clone(fixture.draft), id: `${domain}-different-draft`, version: 9 };
        const drafts = fixture.hideSavedDraft ? [otherDraft] : fixture.otherDraftFirst ? [otherDraft, fixture.draft] : [fixture.draft];
        return respond({ ok: true, storage_mode: 'compat', storage_generation: 7, active: fixture.active, drafts, history: [] });
      }
      if (url.pathname === '/api/inspiration') return respond({ success: true, data: [{
        id: 'synthetic-image', url: '/fixtures/image.png', type: 'image', category: 'image', prompt: '合成素材',
        metadata: { title: '原素材标题', summary: '', previewUrl: '/fixtures/image.png', posterUrl: null },
      }], pagination: { totalPages: 1, total: 1 } });
      if (url.pathname === '/api/site-config') return respond({ success: true, data: {
        banners: {}, heroVideo: { url: '/fixtures/video.mp4', type: 'video' }, backgroundVideos: [],
        canvasExamples: [{ canvasId: 'synthetic-canvas', title: '原示例', coverImage: '/fixtures/image.png' }],
      } });
      if (url.pathname === '/api/admin/manju-workbench/assets') return respond({ ok: true, assets: [] });
      throw new Error(`Unexpected fixture read: ${url.pathname}`);
    },
  };
  return fixture;
}

async function verifyPrompt() {
  const fixture = createFixture('prompt');
  const render = loadComponent('ManjuConfigCenter', [
    'loadConfig', 'saveDraft', 'publishDraft', 'rollbackRelease', 'setEditor', 'setSchemaVersion',
    'editor', 'editorBase', 'selectedDraftId', 'hasUnsavedChanges', 'error', 'notice',
  ], fixture.fetch);
  await render().loadConfig();
  assert.equal(render().hasUnsavedChanges, false);
  assert.equal(button(render().view, '发布所选草稿').props.disabled, false);
  const edited = { ...clone(fixture.draft.payload), prompts: { example: '这次修改后的提示词' } };
  render().setEditor(JSON.stringify(edited));
  assert.equal(render().hasUnsavedChanges, true);
  assert.equal(button(render().view, '发布所选草稿').props.disabled, true);
  assert.equal(button(render().view, '发布').props.disabled, true);
  await render().publishDraft();
  await render().rollbackRelease({ release_id: 'synthetic-history' });
  assert.equal(fixture.writes.length, 0, 'unsaved Prompt cannot publish old data or trigger rollback');
  assert.match(render().error, /尚未保存/);
  fixture.otherDraftFirst = true;
  await render().saveDraft();
  assert.equal(fixture.writes[0].body.expected_updated_at, '2026-09-02T00:00:00.000Z');
  assert.deepEqual(fixture.writes[0].body.payload, edited);
  assert.equal(render().hasUnsavedChanges, false);
  assert.equal(render().selectedDraftId, fixture.draft.id, 'save refresh keeps the exact saved Prompt even when a different draft sorts first');
  assert.equal(button(render().view, '发布所选草稿').props.disabled, false);
  await render().publishDraft();
  assert.equal(fixture.writes.at(-1).body.action, 'publish');
  assert.deepEqual(fixture.active.revision.payload, edited, 'publish uses the saved current Prompt');

  render().setEditor(JSON.stringify({ ...edited, addition: '待保存的修改' }));
  fixture.draft.updated_at = '2026-09-02T00:02:00.000Z';
  await render().loadConfig({ preserveEditor: true });
  assert.equal(render().editorBase.updatedAt, '2026-09-02T00:01:00.000Z');
  await render().saveDraft();
  assert.equal(fixture.writes.at(-1).body.expected_updated_at, '2026-09-02T00:01:00.000Z');
  assert.match(render().error, /其他管理员/);
  assert.equal(render().hasUnsavedChanges, true, 'conflict retains local edits');
  assert.equal(fixture.draft.payload.addition, undefined, 'conflict does not overwrite server draft');

  fixture.missingSchema = true;
  await render().saveDraft();
  assert.match(render().error, /MIGRATION_NOT_READY/);
  assert.equal(render().hasUnsavedChanges, true);
  assert.equal(render().notice, '', 'a failed save must not show a persisted success notice');
}

async function verifyShowcase() {
  const fixture = createFixture('media');
  const render = loadComponent('ManjuShowcaseCatalogManager', [
    'loadAll', 'saveDraft', 'publishDraft', 'rollbackRelease', 'patchInspiration', 'patchCanvas',
    'uploadAdminAsset', 'updateAdminAsset', 'deleteAdminAsset', 'setUploadFile',
    'v1', 'editorBase', 'basePayload', 'selectedDraftId', 'hasUnsavedChanges', 'error', 'notice',
  ], fixture.fetch);
  await render().loadAll();
  assert.equal(render().hasUnsavedChanges, false);
  render().patchInspiration('synthetic-image', { title: '编辑中的素材展示标题' });
  render().patchCanvas('synthetic-canvas', { title: '编辑中的画布示例' });
  const editedFingerprint = manjuDraftFingerprint(render().v1);
  const baseTime = render().editorBase.updatedAt;
  assert.equal(render().hasUnsavedChanges, true);
  assert.equal(button(render().view, '发布所选草稿').props.disabled, true);
  await render().publishDraft();
  await render().rollbackRelease({ release_id: 'synthetic-history' });
  assert.equal(fixture.writes.length, 0);
  render().setUploadFile(new File(['synthetic-file-content'], 'fixture.png', { type: 'image/png' }));
  await render().uploadAdminAsset();
  assert.equal(fixture.writes.at(-1).method, 'POST');
  assert.equal(manjuDraftFingerprint(render().v1), editedFingerprint, 'upload refresh preserves unsaved mappings');
  await render().updateAdminAsset('synthetic-upload', { title: '资产元数据' });
  assert.equal(fixture.writes.at(-1).method, 'PATCH');
  assert.equal(manjuDraftFingerprint(render().v1), editedFingerprint, 'asset edit refresh preserves unsaved mappings');
  await render().deleteAdminAsset('synthetic-upload');
  assert.equal(fixture.writes.at(-1).method, 'DELETE');
  assert.equal(manjuDraftFingerprint(render().v1), editedFingerprint, 'asset deletion refresh preserves unsaved mappings');
  await render().loadAll({ preserveEditor: true });
  assert.equal(manjuDraftFingerprint(render().v1), editedFingerprint, 'manual catalogue refresh preserves unsaved mappings');
  assert.equal(render().editorBase.updatedAt, baseTime);
  assert.equal(render().selectedDraftId, fixture.draft.id);
  fixture.otherDraftFirst = true;
  await render().saveDraft();
  const saved = fixture.writes.at(-1).body;
  assert.equal(saved.action, 'save-draft');
  assert.equal(saved.expected_updated_at, baseTime);
  assert.equal(saved.payload.showcase_catalog.v1.inspiration.overrides['synthetic-image'].title, '编辑中的素材展示标题');
  assert.equal(saved.payload.showcase_catalog.v1.canvas_examples.overrides['synthetic-canvas'].title, '编辑中的画布示例');
  assert.deepEqual(saved.payload.retain_existing_media_policy, { enabled: true }, 'save preserves unrelated media policy');
  assert.equal(render().hasUnsavedChanges, false);
  assert.equal(render().selectedDraftId, fixture.draft.id, 'save refresh keeps the exact saved media draft');
  await render().publishDraft();
  assert.deepEqual(fixture.active.revision.payload, saved.payload);

  render().patchCanvas('synthetic-canvas', { title: '本地尚未保存的第二次修改' });
  fixture.draft.updated_at = '2026-09-02T00:03:00.000Z';
  await render().updateAdminAsset('synthetic-upload', { title: '另一个素材元数据修改' });
  await render().saveDraft();
  assert.equal(fixture.writes.at(-1).body.expected_updated_at, '2026-09-02T00:01:00.000Z');
  assert.match(render().error, /其他管理员/);
  assert.equal(render().v1.canvas_examples.overrides['synthetic-canvas'].title, '本地尚未保存的第二次修改');
  assert.equal(render().hasUnsavedChanges, true);
  fixture.missingSchema = true;
  await render().saveDraft();
  assert.match(render().error, /MIGRATION_NOT_READY/);
  assert.equal(render().notice, '');
}

async function verifySavedDraftMissingFromRefresh() {
  for (const domain of ['prompt', 'media']) {
    const fixture = createFixture(domain);
    const name = domain === 'prompt' ? 'ManjuConfigCenter' : 'ManjuShowcaseCatalogManager';
    const render = loadComponent(name, domain === 'prompt'
      ? ['loadConfig', 'setEditor', 'saveDraft', 'publishDraft', 'editor', 'selectedDraftId', 'hasUnsavedChanges', 'error']
      : ['loadAll', 'patchCanvas', 'saveDraft', 'publishDraft', 'v1', 'selectedDraftId', 'hasUnsavedChanges', 'error'], fixture.fetch);
    if (domain === 'prompt') {
      await render().loadConfig();
      render().setEditor(JSON.stringify({ prompts: { example: '等待刷新确认的合成修改' } }));
    } else {
      await render().loadAll();
      render().patchCanvas('synthetic-canvas', { title: '等待刷新确认的合成修改' });
    }
    fixture.hideSavedDraft = true;
    await render().saveDraft();
    assert.match(render().error, /草稿暂未出现在刷新结果/);
    assert.equal(render().selectedDraftId, fixture.draft.id, 'do not silently switch to another draft after an incomplete refresh');
    assert.equal(render().hasUnsavedChanges, true);
    const writesBeforePublish = fixture.writes.length;
    await render().publishDraft();
    assert.equal(fixture.writes.length, writesBeforePublish);
    const currentText = domain === 'prompt' ? render().editor : render().v1.canvas_examples.overrides['synthetic-canvas'].title;
    assert.match(currentText, /等待刷新确认的合成修改/);
  }
}

async function main() {
  assert.equal(manjuJsonEditorChanged('{ "b": {"d":4,"c":3}, "a":1 }', { a: 1, b: { c: 3, d: 4 } }), false);
  assert.equal(manjuJsonEditorChanged('{"a":2}', { a: 1 }), true);
  assert.equal(manjuJsonEditorChanged('{', {}), true);
  assert.notEqual(manjuDraftFingerprint({ order: ['a', 'b'] }), manjuDraftFingerprint({ order: ['b', 'a'] }));
  await verifyPrompt();
  await verifyShowcase();
  await verifySavedDraftMissingFromRefresh();
  console.log('PASS: actual Manju component handlers/JSX; unsaved publish guards; edited payload save/publish; upload/PATCH/DELETE/manual-refresh preservation; original CAS timestamp; conflict retention; migration failure remains visible; exact saved draft selection; incomplete refresh retains edits (12 groups). No real network or data writes.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
