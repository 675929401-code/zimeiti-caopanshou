import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const layout = fs.readFileSync('src/app/layout.tsx', 'utf8');
const start = layout.indexOf("document.addEventListener('submit', function(e)");
const end = layout.indexOf('}, true);', start) + '}, true);'.length;
assert.ok(start >= 0 && end > start, 'Actual root submit guard must be present');
const script = layout.slice(start, end);
async function submit({ fields = {}, managed = false, reactHandled = false, authPassword = null, genericPassword = null } = {}) {
  const timers = []; const requests = []; let listener; let reloads = 0; let preventCount = 0;
  const button = { textContent: '保存', disabled: false };
  const form = { tagName: 'FORM', hasAttribute: (name) => name === 'data-react-managed' && managed, querySelector(selector) {
    if (selector === 'button[type="submit"]') return button;
    if (selector === 'input[type="password"]') return genericPassword === null ? null : { value: genericPassword };
    const name = selector.match(/^input\[name="([^"]+)"\]$/u)?.[1];
    return name && Object.hasOwn(fields, name) ? { value: fields[name] } : null;
  } };
  const location = { reload() { reloads++; }, href: '' };
  const window = { __reactSubmitHandled: false, location };
  vm.runInNewContext(script, {
    document: {
      addEventListener(name, callback) { assert.equal(name, 'submit'); listener = callback; },
      querySelector(selector) { assert.equal(selector, 'form[data-react-managed] input[name="password"]'); return authPassword === null ? null : { value: authPassword }; },
      querySelectorAll() { throw new Error('BROAD_PASSWORD_LOOKUP_FORBIDDEN'); },
    },
    window, location,
    setTimeout(callback, delay) { timers.push({ callback, delay }); },
    localStorage: { getItem() { return 'fixture-account'; }, setItem() {} },
    fetch(url, options) { requests.push({ url, body: JSON.parse(options.body) }); return Promise.resolve({ json: () => Promise.resolve({ success: false, error: 'Fixture rejection' }) }); },
    alert() {}, console: { warn() {} },
  });
  listener({ target: form, preventDefault() { preventCount++; } });
  if (reactHandled) window.__reactSubmitHandled = true;
  let rounds = 0;
  while (timers.length) { assert.ok(++rounds < 10); timers.shift().callback(); }
  await new Promise((resolve) => setImmediate(resolve));
  return { requests, reloads, preventCount, button, window };
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
await test('plugin API password controls never trigger login or reload', async () => {
  const result = await submit({ genericPassword: 'FIXTURE_PLUGIN_CREDENTIAL' });
  assert.equal(result.requests.length, 0); assert.equal(result.reloads, 0); assert.equal(result.button.textContent, '保存'); assert.equal(result.button.disabled, false);
});
await test('unmanaged forms remain business forms even with account and password field names', async () => {
  const result = await submit({ fields: { account: 'fixture-account', password: 'FIXTURE_BUSINESS_PASSWORD' } }); assert.equal(result.requests.length, 0); assert.equal(result.reloads, 0);
});
await test('ordinary script Prompt and image upload forms never trigger reload', async () => {
  for (const fields of [{ prompt: 'fixture-prompt' }, { title: 'fixture-image' }, { script: 'fixture-script' }]) { const result = await submit({ fields }); assert.equal(result.requests.length, 0); assert.equal(result.reloads, 0); }
});
await test('partial named authentication fields cannot trigger the fallback', async () => {
  for (const fields of [{ account: 'fixture' }, { password: 'fixture' }, { emailCode: '000000' }, { email: 'fixture@example.test' }]) { const result = await submit({ fields, managed: true }); assert.equal(result.requests.length, 0); assert.equal(result.reloads, 0); }
});
await test('a hydrated login remains owned by its existing React submit handler', async () => {
  const result = await submit({ managed: true, reactHandled: true, fields: { account: 'fixture-account', password: 'fixture-password' } }); assert.equal(result.requests.length, 0); assert.equal(result.reloads, 0);
});
await test('unhydrated named account login retains the existing API fallback', async () => {
  const result = await submit({ managed: true, fields: { account: 'fixture-account', password: 'fixture-password' } }); assert.equal(result.requests.length, 1); assert.equal(result.requests[0].url, '/api/auth/login'); assert.equal(result.requests[0].body.phone, 'fixture-account'); assert.equal(result.requests[0].body.password, 'fixture-password'); assert.equal(result.reloads, 0);
});
await test('unhydrated named email login retains the existing API fallback', async () => {
  const result = await submit({ managed: true, fields: { email: 'fixture@example.test', emailCode: '000000' } }); assert.equal(result.requests.length, 1); assert.equal(result.requests[0].url, '/api/auth/login-email'); assert.equal(result.reloads, 0);
});
await test('security verification reads only a named authentication password field', async () => {
  const result = await submit({ managed: true, fields: { securityAnswer: 'fixture-answer' }, genericPassword: 'FIXTURE_PLUGIN_CREDENTIAL', authPassword: 'fixture-login-password' });
  assert.equal(result.requests.length, 1); assert.equal(result.requests[0].body.password, 'fixture-login-password'); assert.doesNotMatch(JSON.stringify(result.requests), /FIXTURE_PLUGIN_CREDENTIAL/u); assert.equal(result.reloads, 0);
});
console.log(JSON.stringify({ passed, failed: 0, actualRootScript: true, realLoginRequests: 0, realDatabaseWrites: 0 }));
