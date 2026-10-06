import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

function inlineScripts(file) {
  const parsed = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const scripts = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === '__html' && ts.isNoSubstitutionTemplateLiteral(node.initializer)) scripts.push(node.initializer.text);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(scripts.length >= 4, 'actual layout inline scripts must be exercised');
  return scripts;
}
function run(scripts, { ready = 'loading', css = 'missing', delayed = false } = {}) {
  const initialUrl = 'http://127.0.0.1:5000/admin?tab=plugins&keep=fixture#draft';
  const navigation = [];
  const storage = new Map();
  const timers = [];
  const listeners = new Map();
  let loaded = css === 'ready';
  const location = { href: initialUrl, origin: 'http://127.0.0.1:5000', hostname: '127.0.0.1', pathname: '/admin', search: '?tab=plugins&keep=fixture', replace(value) { navigation.push(['replace', value]); this.href = value; }, assign(value) { navigation.push(['assign', value]); this.href = value; }, reload() { navigation.push(['reload']); } };
  const styleSheets = css === 'cross-origin' ? [{ get cssRules() { throw new Error('SecurityError'); } }] : [];
  const document = { referrer: '', readyState: ready, body: { style: {} }, documentElement: { getAttribute: () => 'lattice', setAttribute() {} }, styleSheets, querySelector: selector => selector === '.flex' && loaded ? {} : null, querySelectorAll: () => [], addEventListener: (event, callback) => listeners.set('document:' + event, callback), removeEventListener() {} };
  const localStorage = { getItem: name => storage.get(name) || null, setItem: (name, value) => storage.set(name, value) };
  const window = { location, document, localStorage, sessionStorage: localStorage, innerWidth: 1280, innerHeight: 800, addEventListener: (event, callback) => listeners.set(event, callback), removeEventListener() {}, setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {}, getComputedStyle: () => ({ backgroundColor: loaded ? 'rgb(12, 12, 12)' : 'rgba(0, 0, 0, 0)', display: loaded ? 'flex' : 'block' }) };
  window.self = window; window.top = window;
  const context = { window, document, location, localStorage, sessionStorage: localStorage, URL, Date, console: { warn() {}, log() {}, error() {} }, setTimeout: window.setTimeout, clearTimeout() {}, setInterval() { throw new Error('UNEXPECTED_POLLING'); } };
  for (const script of scripts) vm.runInNewContext(script, context);
  if (delayed) { loaded = true; document.styleSheets = [{ cssRules: Array.from({ length: 120 }, () => ({})) }]; }
  listeners.get('load')?.();
  while (timers.length) timers.shift()();
  return { navigation, url: location.href, storage, initialUrl };
}

if (process.argv[2]) {
  const old = run(inlineScripts(process.argv[2]));
  assert.equal(old.navigation.length, 1);
  assert.equal(old.navigation[0][0], 'replace');
  assert.ok(!old.url.includes('tab=plugins'));
  console.log('PASS original snapshot reproduces early CSS navigation and lost tab query');
}
const scripts = inlineScripts('src/app/layout.tsx');
let passed = 0;
for (const scenario of [
  { ready: 'loading', css: 'missing' },
  { ready: 'loading', css: 'missing', delayed: true },
  { ready: 'complete', css: 'missing' },
  { ready: 'complete', css: 'cross-origin' },
  { ready: 'complete', css: 'ready' },
]) {
  const result = run(scripts, scenario);
  assert.deepEqual(result.navigation, []);
  assert.equal(result.url, result.initialUrl);
  assert.equal(result.storage.has('_css_reloaded'), false);
  passed++;
  console.log(`PASS ${scenario.ready}/${scenario.css}/delayed=${Boolean(scenario.delayed)} preserves route, query and draft`);
}
console.log(JSON.stringify({ passed, failed: 0, actualLayoutScripts: scripts.length, networkRequests: 0, databaseWrites: 0 }));
