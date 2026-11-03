#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

// Render the actual provider/boundary and permission rules in React. Only the
// auth context, router, transport, and decorative UI are replaced in memory.
// No application server, credentials, storage, database, or provider is used.
const projectRoot = process.cwd();
const require = createRequire(path.join(projectRoot, 'package.json'));
const ts = require('typescript');
const { chromium } = require('playwright');
const expectRegression = process.argv.includes('--expect-regression');
assert.ok(process.argv.slice(2).every(value => value === '--expect-regression'), 'UNSUPPORTED_ARGUMENT');
const files = [
  'src/components/member-permission-boundary.tsx',
  'src/lib/client-account-scope.ts',
  'src/lib/member-permissions.ts',
  'src/contexts/app-context.tsx',
  'src/lib/auth-route-boundary.ts',
];
const sources = Object.fromEntries(files.map(file => [file, readFileSync(path.join(projectRoot, file), 'utf8')]));
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const virtualNames = new Set(['@/contexts/app-context', 'next/navigation', '@/components/feature-coming-soon-gate', 'lucide-react']);
const modules = {}, ids = new Map();
function collect(file) {
  if (ids.has(file)) return ids.get(file);
  const id = String(ids.size);
  ids.set(file, id);
  const raw = readFileSync(file, 'utf8');
  const code = /\.tsx?$/u.test(file) ? compile(raw) : raw;
  modules[id] = { code, map: {} };
  const localRequire = createRequire(file);
  for (const match of code.matchAll(/require\(["']([^"']+)["']\)/gu)) {
    const name = match[1];
    if (virtualNames.has(name)) { modules[id].map[name] = name; continue; }
    const target = name.startsWith('@/')
      ? path.join(projectRoot, 'src', name.slice(2)) + '.ts'
      : localRequire.resolve(name);
    modules[id].map[name] = collect(target);
  }
  return id;
}
const react = collect(require.resolve('react'));
const dom = collect(require.resolve('react-dom/client'));
const flush = collect(require.resolve('react-dom'));
const boundary = collect(path.join(projectRoot, files[0]));
const bootstrap = `
var process={env:{NODE_ENV:'development'}}, M=${JSON.stringify(modules)}, cache={}, virtual={};
function load(id){if(virtual[id])return virtual[id];if(cache[id])return cache[id].exports;var m=cache[id]={exports:{}};new Function('require','module','exports',M[id].code)(name=>load(M[id].map[name]),m,m.exports);return m.exports;}
window.React=load('${react}');window.ReactDOM=load('${dom}');window.flushSync=load('${flush}').flushSync;
window.AuthContext=React.createContext(null);window.testPath='/video';window.redirects=[];
window.testRouter={replace:path=>redirects.push(path)};
virtual['@/contexts/app-context']={useApp:()=>({state:{auth:React.useContext(AuthContext)}})};
virtual['next/navigation']={usePathname:()=>testPath,useRouter:()=>testRouter};
virtual['@/components/feature-coming-soon-gate']={FeatureComingSoonOverlay:props=>React.createElement('div',{'data-testid':'coming-soon'},props.title)};
virtual['lucide-react']={ShieldAlert:()=>null};window.ActualBoundary=load('${boundary}');
`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
let networkRequests = 0;
await context.route('**/*', route => { networkRequests++; return route.abort(); });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
let component;
try {
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bootstrap });
  component = await page.evaluate(async () => {
    const e = React.createElement;
    const sleep = () => new Promise(resolve => nativeTimeout(resolve, 30));
    const nativeTimeout = window.setTimeout.bind(window);
    const nativeClear = window.clearTimeout.bind(window);
    const timers = new Map();
    let nextTimer = 1000000;
    // Advance only the boundary's navigation timers; React still commits with
    // its actual scheduler and effects, including StrictMode cleanup/replay.
    window.setTimeout = (callback, delay, ...args) => delay === 2500
      ? (timers.set(++nextTimer, () => callback(...args)), nextTimer)
      : nativeTimeout(callback, delay, ...args);
    window.clearTimeout = id => timers.has(id) ? timers.delete(id) : nativeClear(id);
    const advanceNavigationTimers = () => {
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    };
    const anonymous = () => ({ isAuthenticated: false, user: null, token: null });
    const auth = (id = 'owner-A', token = 'ram-A') => ({ isAuthenticated: true, user: { id, role: 'member' }, token });
    const snapshot = (id = 'owner-A', keys = ['create'], integrityValid = true) => ({
      userId: id, role: 'member', featureNavigationKeys: keys, agentNavigationKeys: [], integrityValid,
    });
    const requests = [];
    window.fetch = (url, options) => new Promise(resolve => requests.push({ url, options, resolve }));
    let updateAuth, currentPermission;
    function Probe() {
      currentPermission = ActualBoundary.useMemberPermissions();
      return e(ActualBoundary.MemberFeatureBoundary, null, e('div', { 'data-testid': 'protected-content' }, 'private'));
    }
    function App({ initialAuth }) {
      const [value, setValue] = React.useState(initialAuth);
      updateAuth = setValue;
      return e(AuthContext.Provider, { value }, e(ActualBoundary.MemberPermissionProvider, null, e(Probe)));
    }
    let root;
    async function mount(initialAuth = anonymous()) {
      redirects.length = 0; requests.length = 0; timers.clear();
      root = ReactDOM.createRoot(document.getElementById('root'));
      flushSync(() => root.render(e(React.StrictMode, null, e(App, { initialAuth }))));
      await sleep();
    }
    function unmount() { root.unmount(); }
    const visible = selector => Boolean(document.querySelector(selector));
    async function finish(body, status = 200, request = requests.at(-1)) {
      request.resolve({ ok: status < 400, status, json: async () => body });
      await sleep();
    }
    await mount();
    const pendingAuth = {
      denied: visible('[data-testid="member-feature-access-denied"]'),
      loading: visible('[role="status"]'),
      protectedVisible: visible('[data-testid="protected-content"]'),
      requests: requests.length,
    };
    advanceNavigationTimers();
    pendingAuth.redirects = [...redirects];
    flushSync(() => updateAuth(auth())); await sleep();
    const pendingPermissions = !visible('[data-testid="protected-content"]') && currentPermission.status === 'loading';
    advanceNavigationTimers();
    await finish({ permission: snapshot() });
    const allowedAfterDelayedAuth = visible('[data-testid="protected-content"]') && !visible('[data-testid="member-feature-access-denied"]');
    unmount();

    const deniedCases = [];
    for (const value of [
      { name: 'missing-feature', body: { permission: snapshot('owner-A', []) }, status: 200 },
      { name: 'wrong-owner', body: { permission: snapshot('owner-B') }, status: 200 },
      { name: 'invalid-integrity', body: { permission: snapshot('owner-A', ['create'], false) }, status: 200 },
      { name: 'permission-401', body: {}, status: 401 },
      { name: 'permission-500', body: {}, status: 500 },
    ]) {
      await mount(auth()); await finish(value.body, value.status);
      const denied = visible('[data-testid="member-feature-access-denied"]') && !visible('[data-testid="protected-content"]');
      advanceNavigationTimers();
      deniedCases.push({ name: value.name, denied, redirected: redirects.length === 1 && redirects[0] === '/' });
      unmount();
    }
    await mount(auth()); await finish({ permission: snapshot() });
    flushSync(() => updateAuth(anonymous()));
    const logoutImmediatelyHidesContent = !visible('[data-testid="protected-content"]');
    flushSync(() => updateAuth(auth('owner-B', 'ram-B'))); await sleep();
    const crossAccountPendingHidesContent = !visible('[data-testid="protected-content"]');
    await finish({ permission: snapshot('owner-B', []) });
    const crossAccountDenied = !visible('[data-testid="protected-content"]') && visible('[data-testid="member-feature-access-denied"]');
    unmount();
    return { pendingAuth, pendingPermissions, allowedAfterDelayedAuth, deniedCases, logoutImmediatelyHidesContent, crossAccountPendingHidesContent, crossAccountDenied, pendingTimersAfterUnmount: timers.size };
  });
} finally {
  await browser.close();
}

// Exercise the owning AppProvider callback unchanged, so waiting in the feature
// boundary cannot silently remove no-session/expired-session home navigation.
const tree = ts.createSourceFile(files[3], sources[files[3]], ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let authCallback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'runAuthCheck') authCallback = node.initializer.arguments[0].getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(authCallback, 'ACTUAL_APP_PROVIDER_AUTH_CALLBACK_REQUIRED');
const authOwnerCases = [];
for (const { name, token, status, pathname } of [
  { name: 'no-token-private', token: null, status: 0, pathname: '/video' },
  { name: 'expired-token', token: 'ram-expired', status: 401, pathname: '/video' },
  { name: 'revoked-token', token: 'ram-revoked', status: 403, pathname: '/video' },
  { name: 'deleted-owner', token: 'ram-deleted', status: 404, pathname: '/video' },
  { name: 'public-home', token: null, status: 0, pathname: '/' },
]) {
  const stored = new Map(token ? [['AUTH_TOKEN', token]] : []);
  const redirects = [], actions = [];
  const sandbox = vm.createContext({
    exports: {}, window: { location: { pathname } },
    STORAGE_KEYS: { AUTH_TOKEN: 'AUTH_TOKEN', AUTH_USER: 'AUTH_USER' },
    safeGet: key => stored.get(key) || null,
    safeRemove: key => stored.delete(key), safeSet: (key, value) => stored.set(key, value),
    invalidateClientBootstrapAuthMe() {},
    getClientBootstrapAuthMe: async actualToken => { assert.equal(actualToken, token); return new Response('{}', { status }); },
    clearStoredAuthSession: () => stored.clear(),
    dispatch: action => actions.push(action),
    replaceWithPublicHome: reason => redirects.push({ pathname: '/', hasReason: Boolean(reason) }),
  });
  vm.runInContext(compile(sources[files[4]]), sandbox);
  sandbox.shouldReturnUnauthenticatedVisitorHome = sandbox.exports.shouldReturnUnauthenticatedVisitorHome;
  vm.runInContext(compile(`globalThis.runAuth=${authCallback};`), sandbox);
  await sandbox.runAuth(false);
  const publicHome = pathname === '/';
  assert.equal(redirects.length, publicHome ? 0 : 1, name);
  assert.equal(stored.has('AUTH_TOKEN'), false, name);
  assert.ok(actions.some(action => action.type === (token ? 'FORCED_LOGOUT' : 'SET_AUTH')), name);
  authOwnerCases.push({ name, passed: true, redirected: redirects.length === 1, completed: true });
}

const report = {
  passed: false, expectedRegression: expectRegression, component, authOwnerCases, networkRequests, pageErrors,
  sourceSha256: Object.fromEntries(files.map(file => [file, createHash('sha256').update(sources[file]).digest('hex')])),
};
try {
  assert.equal(networkRequests, 0);
  assert.deepEqual(pageErrors, []);
  assert.equal(component.pendingAuth.requests, 0, 'UNVERIFIED_AUTH_MUST_NOT_REQUEST_PERMISSIONS');
  assert.equal(component.pendingAuth.protectedVisible, false, 'UNVERIFIED_AUTH_MUST_NOT_EXPOSE_CONTENT');
  if (expectRegression) {
    assert.equal(component.pendingAuth.denied, true, 'BASELINE_MUST_REPRODUCE_PREMATURE_DENIAL');
    assert.deepEqual(component.pendingAuth.redirects, ['/'], 'BASELINE_MUST_REPRODUCE_PREMATURE_REDIRECT');
  } else {
    assert.equal(component.pendingAuth.denied, false, 'AUTH_RESTORATION_IS_NOT_PERMISSION_DENIAL');
    assert.equal(component.pendingAuth.loading, true, 'AUTH_RESTORATION_MUST_RENDER_PENDING');
    assert.deepEqual(component.pendingAuth.redirects, [], 'DELAYED_AUTH_MUST_NOT_REDIRECT');
  }
  for (const key of ['pendingPermissions', 'allowedAfterDelayedAuth', 'logoutImmediatelyHidesContent', 'crossAccountPendingHidesContent', 'crossAccountDenied']) assert.equal(component[key], true, key);
  for (const item of component.deniedCases) { assert.equal(item.denied, true, item.name); assert.equal(item.redirected, true, item.name); }
  assert.equal(component.pendingTimersAfterUnmount, 0);
  report.passed = true;
} finally {
  console.log(JSON.stringify(report, null, 2));
}
