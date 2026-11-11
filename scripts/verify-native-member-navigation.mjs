import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Execute the actual TSX components with an in-memory member projection only.
// No browser, credentials, server, network, provider call or data write is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeRoot = path.join(root, 'integrations/aitoearn-native-app');
const require = createRequire(path.join(nativeRoot, 'package.json'));
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const sidebar = 'src/app/layout/LayoutSidebar';
const checks = [];
const check = (name, run) => { run(); checks.push(name); };
const source = relative => fs.readFileSync(path.join(nativeRoot, relative), 'utf8');
const icon = props => React.createElement('svg', props);
let member = {};

function load(relative, mocks = {}) {
  const filename = path.join(nativeRoot, relative);
  const module = { exports: {} };
  const compiled = ts.transpileModule(source(relative), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      throw new Error(`Unexpected dependency in zero-network verification: ${name}`);
    },
    Headers,
    window: {},
  }, { filename });
  return module.exports;
}

const sharedMocks = {
  'lucide-react': { PanelLeftClose: icon, PanelLeftOpen: icon, Wallet: icon },
  '@/utils/className': { cn: (...values) => values.filter(Boolean).join(' ') },
  '@/store/user': { useUserStore: Object.assign(selector => selector(member), { getState: () => member }) },
};
const { LogoSection } = load(`${sidebar}/components/LogoSection.tsx`, {
  ...sharedMocks,
  'next/image': { default: props => React.createElement('img', { ...props, src: '/logo.png' }) },
  '@/assets/images/logo.png': { default: '/logo.png' },
  '@/app/layout/shared': { BRAND_TITLE: 'AiToEarn', BrandWordmark: () => React.createElement('span', null, 'AiToEarn') },
});
const { BottomSection } = load(`${sidebar}/components/BottomSection/index.tsx`, {
  ...sharedMocks,
  './PluginEntry': { PluginEntry: () => React.createElement('button', { 'data-testid': 'sidebar-plugin' }, '浏览器插件') },
});

function find(element, predicate, result = []) {
  if (!React.isValidElement(element)) return result;
  if (predicate(element)) result.push(element);
  for (const child of React.Children.toArray(element.props.children)) find(child, predicate, result);
  return result;
}

for (const collapsed of [false, true]) {
  check(`Logo ${collapsed ? 'collapsed' : 'expanded'} returns to host root and retains separate toggle`, () => {
    let toggles = 0;
    const element = LogoSection({ collapsed, onToggle: () => { toggles++; } });
    const links = find(element, item => item.type === 'a');
    const buttons = find(element, item => item.type === 'button');
    assert.equal(links.length, 1);
    assert.equal(links[0].props.href, '/');
    assert.equal(links[0].props['aria-label'], '返回主站应用广场');
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].props.type, 'button');
    assert.match(buttons[0].props['aria-label'], collapsed ? /展开/ : /收起/);
    buttons[0].props.onClick();
    assert.equal(toggles, 1);
    if (collapsed) {
      assert.doesNotMatch(buttons[0].props.className, /inset-0/);
      assert.match(buttons[0].props.className, /h-4 w-4/);
      assert.doesNotMatch(links[0].props.className, /opacity-0/);
    }
    assert.match(renderToStaticMarkup(element), /href="\/"/);
  });
}

for (const role of ['student', 'admin']) {
  for (const collapsed of [false, true]) {
    check(`${role} wallet ${collapsed ? 'collapsed' : 'expanded'} exposes only cash and credits`, () => {
      member = { userInfo: { role }, cashCents: 12345, creditsBalance: 78, creditsInitialized: true, creditsLoading: false };
      const html = renderToStaticMarkup(BottomSection({ collapsed }));
      assert.match(html, /现金 ¥123\.45 · 积分 78/);
      assert.match(html, /data-testid="sidebar-plugin"/);
      assert.doesNotMatch(html, /<a\b|充值|套餐|会员账号|配置管理|\/admin/);
    });
  }
}

for (const state of [
  { creditsInitialized: false, creditsLoading: false },
  { creditsInitialized: true, creditsLoading: true },
]) {
  check(`Wallet loading ${JSON.stringify(state)} does not claim initial zero balance`, () => {
    member = { cashCents: 0, creditsBalance: 0, ...state };
    const html = renderToStaticMarkup(BottomSection({ collapsed: false }));
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /现金 加载中… · 积分 加载中…/);
    assert.doesNotMatch(html, /¥0\.00|积分 0/);
  });
}
check('Initialized zero balance is represented faithfully', () => {
  member = { cashCents: 0, creditsBalance: 0, creditsInitialized: true, creditsLoading: false };
  const html = renderToStaticMarkup(BottomSection({ collapsed: false }));
  assert.match(html, /现金 ¥0\.00 · 积分 0/);
  assert.match(html, /aria-busy="false"/);
});

check('Original sidebar geometry, channel entry and five main routes remain', () => {
  const layout = source(`${sidebar}/index.tsx`);
  assert.match(layout, /w-\[68px\] min-w-\[68px\]/);
  assert.match(layout, /w-\[240px\] min-w-\[240px\]/);
  assert.match(layout, /<MyChannelsEntry collapsed=\{collapsed\}/);
  assert.doesNotMatch(layout, /ConfigManagerEntry/);
  const routes = [...source('src/app/layout/routerData.tsx').matchAll(/path: '([^']+)'/g)].map(item => item[1]);
  assert.deepEqual(routes, ['/', '/ai-social', '/tasks-history', '/accounts', '/agent-assets']);
  assert.match(source(`${sidebar}/components/BottomSection/PluginEntry.tsx`), /<PluginModal visible=\{pluginModalVisible\}/);
  assert.match(source(`${sidebar}/components/BottomSection/MyChannelsEntry.tsx`), /openModal\(\)/);
});

const notifications = [];
const { request } = load('src/utils/request/client.ts', {
  ...sharedMocks,
  '@/integration/host-session': { assertHostSession: () => ({ user: { id: 'fixture-owner' } }), getHostSessionRevision: () => 1 },
  '@/integration/native-revisions': { observeNativeRevisions() {} },
  '@/app/i18n/client': { directTrans: (_namespace, key) => key },
  '@/utils/ui/notification': { notification: { warning: value => notifications.push(value), error: value => notifications.push(value) } },
  './FetchService': { default: class {
    async request() {
      return { json: async () => ({ code: 500, message: '平台授权已失效', data: { platform: 'douyin', issues: [{ path: ['account'], message: '请重新授权频道' }] } }) };
    }
  } },
});
member = { isAuthenticated: true };
await assert.rejects(request({ url: 'fixture', method: 'GET' }), /平台授权已失效/);
check('API failures retain their message and details without a configuration action', () => {
  const html = notifications.map(value => renderToStaticMarkup(value.content)).join('');
  assert.match(html, /平台授权已失效/);
  assert.match(html, /douyin \/ account: 请重新授权频道/);
  assert.doesNotMatch(html, /<button\b|<a\b|apiErrorConfig|\/admin/);
});

console.log(JSON.stringify({ ok: true, checks: checks.length, cases: checks, scope: 'zero-network component and source contracts only', browserAcceptance: false, realNetworkRequests: 0 }, null, 2));
