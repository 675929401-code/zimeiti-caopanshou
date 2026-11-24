import type { Browser } from 'playwright';

const maxBytes = 5 * 1024 * 1024;
let readers = 0;

// Read only the anonymous public share document. No script, iframe, redirect,
// cookie store or third-party request is needed to obtain its player metadata.
export async function readPublicRedNoteDocument(source: URL): Promise<string | undefined> {
  if (source.origin !== 'https://www.xiaohongshu.com' || source.username || source.password ||
      !/^\/(?:discovery\/item|explore)\/[a-f0-9]{24}\/?$/i.test(source.pathname) || readers >= 2) return;
  const url = new URL(source);
  url.hash = '';
  readers++;
  let browser: Browser | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { chromium } = await import('playwright');
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
    browser = await chromium.launch({ headless: true, ...(executablePath ? {executablePath} : {}), timeout: 8000 });
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    const document = new Promise<string | undefined>((resolve) => {
      let initialRequest = '';
      timer = setTimeout(() => resolve(undefined), 12000);
      session.on('Fetch.requestPaused', async event => {
        const requestId = event.requestId;
        try {
          if (event.request.url !== url.href || event.resourceType !== 'Document' || event.redirectedRequestId ||
              (initialRequest && initialRequest !== requestId)) {
            await session.send('Fetch.failRequest', {requestId, errorReason:'BlockedByClient'});
            return;
          }
          if (event.responseStatusCode === undefined && !event.responseErrorReason) {
            initialRequest = requestId;
            await session.send('Fetch.continueRequest', {requestId, interceptResponse: true});
            return;
          }
          const header = (name: string) => event.responseHeaders?.find(h => h.name.toLowerCase() === name)?.value || '';
          if (event.responseStatusCode !== 200 || !/^text\/html(?:;|$)/i.test(header('content-type')) ||
              Number(header('content-length')) > maxBytes) { resolve(undefined); return; }
          const {stream} = await session.send('Fetch.takeResponseBodyAsStream', {requestId});
          const chunks: Buffer[] = [];
          let size = 0;
          try {
            for (;;) {
              const part = await session.send('IO.read', {handle: stream, size: 65536});
              const bytes = Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8');
              size += bytes.length;
              if (size > maxBytes) { resolve(undefined); return; }
              chunks.push(bytes);
              if (part.eof) break;
            }
            resolve(Buffer.concat(chunks, size).toString('utf8'));
          } finally { await session.send('IO.close', {handle: stream}).catch(() => {}); }
        } catch { resolve(undefined); }
      });
    });
    await session.send('Fetch.enable', {patterns: [{urlPattern:'*', requestStage:'Request'}]});
    return await Promise.race([document, page.goto(url.href, {waitUntil:'commit', timeout:13000}).then(() => undefined, () => undefined)]);
  } catch { return undefined; }
  finally {
    if (timer) clearTimeout(timer);
    try { await browser?.close(); } catch { /* Already closed on timeout or process exit. */ }
    finally { readers--; }
  }
}
