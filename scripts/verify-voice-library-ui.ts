import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

export async function main() {
  const base = process.env.VERIFY_BASE_URL || 'http://127.0.0.1:5000';
  assert.equal(new URL(base).hostname, '127.0.0.1');
  const out = path.resolve(process.env.VERIFY_OUTPUT_DIR || '.codex-evidence/voice-library-ui');
  await mkdir(out, { recursive: true });
  const localToken = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
  let session: { token: string; user: Record<string, unknown> };
  if (localToken) {
    const identity = await fetch(base + '/api/auth/me', { headers: { Authorization: `Bearer ${localToken}` } });
    assert.equal(identity.status, 200, 'Local administrator session verification failed');
    const body = await identity.json();
    assert.ok(body.user?.id);
    session = { token: localToken, user: body.user };
  } else {
    assert.ok(process.env.VERIFY_USERNAME && process.env.VERIFY_PASSWORD);
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.VERIFY_USERNAME, password: process.env.VERIFY_PASSWORD }) });
    assert.equal(login.status, 200);
    session = await login.json();
  }
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--autoplay-policy=no-user-gesture-required'] });
  const played: { id: string; name: string; duration: number; currentTime: number; readyState: number; stopped: boolean }[] = [];
  const previews: { id: string; status: number; cacheHit: boolean }[] = [];
  const errors: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user));
      // Observe real browser audio, without replacing playback or transport.
      const scope = window as typeof window & { __observedAudio?: HTMLAudioElement[] };
      scope.__observedAudio = [];
      window.Audio = new Proxy(window.Audio, { construct(Target, args) { const audio = new Target(...args); scope.__observedAudio!.push(audio); return audio; } });
    }, { token: session.token, user: session.user });
    const p = await context.newPage(); p.setDefaultTimeout(15000);
    p.on('pageerror', error => errors.push(error.message));
    p.on('response', async response => {
      if (!response.url().endsWith('/api/voice/preview')) return;
      const data = await response.json();
      previews.push({ id: response.request().postDataJSON()?.speakerId, status: response.status(), cacheHit: data.cacheHit === true });
    });
    await p.goto(base + '/voice-studio/voices', { waitUntil: 'domcontentloaded' });
    await p.getByRole('status', { name: '音色列表加载中' }).waitFor({ state: 'hidden' });
    const catalogResponse = await context.request.get(base + '/api/voice/list?limit=500');
    assert.equal(catalogResponse.status(), 200);
    const all = (await catalogResponse.json()).data.voices as { speakerId: string; name: string }[];
    assert.ok(all.length > 0);
    const pageSize = 60;
    for (let pageNumber = 1; pageNumber <= Math.ceil(all.length / pageSize); pageNumber++) {
      if (pageNumber > 1) {
        const loaded = p.waitForResponse(r => new URL(r.url()).pathname === '/api/voice/list' && new URL(r.url()).searchParams.get('page') === String(pageNumber));
        await p.getByRole('button', { name: String(pageNumber), exact: true }).click(); await loaded;
        await p.getByRole('status', { name: '音色列表加载中' }).waitFor({ state: 'hidden' });
      }
      for (const voice of all.slice((pageNumber - 1) * pageSize, pageNumber * pageSize)) {
        const card = p.locator('[data-voice-id="' + voice.speakerId + '"]').last();
        await card.waitFor();
        const portraitElement = card.getByRole('img', { name: voice.name + '音色示意头像', exact: true });
        await p.waitForFunction(id => { const cards = document.querySelectorAll('[data-voice-id="' + id + '"]'); const e = cards[cards.length - 1]?.querySelector('span[role="img"]'); return e && getComputedStyle(e).backgroundImage.includes('/avatars/voice-studio/portraits.webp'); }, voice.speakerId);
        const portrait = await portraitElement.evaluate(e => getComputedStyle(e).backgroundImage);
        assert.ok(portrait.includes('/avatars/voice-studio/portraits.webp'), voice.name + ': ' + portrait);
        await card.getByRole('button', { name: '试听 ' + voice.name, exact: true }).click();
        await p.waitForFunction(() => { const audios = (window as typeof window & { __observedAudio?: HTMLAudioElement[] }).__observedAudio; const a = audios?.at(-1); return a && !a.paused && a.currentTime > .03 && !a.error; });
        const media = await p.evaluate(() => { const a = (window as typeof window & { __observedAudio: HTMLAudioElement[] }).__observedAudio.at(-1)!; return { duration: a.duration, currentTime: a.currentTime, readyState: a.readyState }; });
        assert.ok(media.duration > 0 && media.readyState >= 2);
        await card.getByRole('button', { name: '停止试听 ' + voice.name, exact: true }).click();
        const stopped = await p.evaluate(() => (window as typeof window & { __observedAudio: HTMLAudioElement[] }).__observedAudio.every(a => a.paused));
        assert.equal(stopped, true);
        played.push({ id: voice.speakerId, name: voice.name, ...media, stopped });
        await writeFile(path.join(out, 'voice-buttons-progress.json'), JSON.stringify({ complete: false, count: played.length, played }, null, 2));
      }
    }
    assert.equal(new Set(played.map(v => v.id)).size, all.length);
    assert.equal(previews.length, all.length);
    assert.ok(previews.every(r => r.status === 200 && r.cacheHit), 'Every fresh-browser preview must reuse a prepared server sample');
    // An actual cached sample also remains playable after a full page reload.
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.getByRole('status', { name: '音色列表加载中' }).waitFor({ state: 'hidden' });
    await p.getByRole('button', { name: '试听 ' + all[0].name, exact: true }).last().click();
    await p.waitForFunction(() => { const a = (window as typeof window & { __observedAudio: HTMLAudioElement[] }).__observedAudio.at(-1); return a && a.currentTime > .03 && !a.paused; });
    await p.getByRole('button', { name: '停止试听 ' + all[0].name, exact: true }).click();
    await p.setViewportSize({ width: 390, height: 844 });
    const mobileCard = p.locator('[data-voice-id="' + all[0].speakerId + '"]').last();
    await mobileCard.scrollIntoViewIfNeeded();
    const use = mobileCard.getByRole('button', { name: '合成', exact: true });
    assert.equal(await use.isVisible(), true, 'Phone users must be able to use the selected voice');
    await p.screenshot({ path: path.join(out, 'mobile-voice-actions.png'), fullPage: false });
    await use.click();
    await p.waitForURL(url => url.pathname === '/voice-studio/workspace' && url.searchParams.get('speaker') === all[0].speakerId);
    assert.deepEqual(errors, []);
    await writeFile(path.join(out, 'voice-buttons.json'), JSON.stringify({ complete: true, checkedAt: new Date().toISOString(), count: played.length, played, previews, mobileUsePassed: true, reloadPlaybackPassed: true }, null, 2));
    console.log(JSON.stringify({ status: 'passed', voiceButtons: played.length, serverCacheHits: previews.filter(r => r.cacheHit).length, mobileUsePassed: true }));
  } finally { await browser.close(); }
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.stack : 'Voice UI verification failed'); process.exitCode = 1; });
}
