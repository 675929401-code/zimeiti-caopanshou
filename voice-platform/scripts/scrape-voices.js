const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: false,
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // 拦截音色API
  const voiceData = [];
  let apiCount = 0;
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('ListSpeakers') || url.includes('ListBigModelTTSTimbres') || url.includes('timbre')) {
      try {
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const text = await response.text();
          if (text.startsWith('{')) {
            const data = JSON.parse(text);
            const speakers = data.Result?.Speakers || data.Result?.Timbres || data.data?.speakers;
            if (speakers && Array.isArray(speakers) && speakers.length > 0) {
              apiCount++;
              console.log(`[API #${apiCount}] +${speakers.length} speakers (total: ${voiceData.length + speakers.length})`);
              voiceData.push(...speakers);
            }
          }
        }
      } catch {}
    }
  });

  // 1. 打开子用户登录页
  console.log('1. Opening sub-user login...');
  await page.goto('https://console.volcengine.com/auth/login/user/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(5000);

  // 2. 精确填入：Identity（主账号ID）和 子用户名/密码
  console.log('2. Filling login form...');
  
  // Identity = 主账号ID (2103598608) - 用placeholder定位
  const identityInput = page.locator('input[placeholder*="账号"]').first();
  await identityInput.waitFor({ state: 'visible', timeout: 15000 });
  await identityInput.fill('2103598608');
  console.log('  Identity: 2103598608');

  // 密码
  const passwordInput = page.locator('input[placeholder*="密码"], input[type="password"]').first();
  await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
  await passwordInput.fill('#dE@@&*6%)lWfGq87En(');
  console.log('  Password: filled');

  await page.waitForTimeout(1000);

  // 3. 点击登录
  console.log('3. Clicking login...');
  const loginBtn = page.locator('button:has-text("登录"), button[type="submit"]').first();
  await loginBtn.click();

  // 4. 等待登录结果
  console.log('4. Waiting for login result...');
  try {
    await page.waitForURL('**/console/**', { timeout: 30000 });
    console.log('  ✅ Login successful! URL:', page.url());
  } catch {
    await page.waitForTimeout(3000);
    const currentUrl = page.url();
    console.log('  Current URL:', currentUrl);
    
    // 检查是否有验证码
    const captchaVisible = await page.locator('#VerificatonCodeInput:visible').count();
    if (captchaVisible > 0) {
      console.log('  ⚠️ Captcha required! Please complete it in the browser window...');
      try {
        await page.waitForURL('**/console/**', { timeout: 180000 });
        console.log('  ✅ Captcha passed! URL:', page.url());
      } catch {
        console.log('  ❌ Captcha timeout');
        await page.screenshot({ path: 'scripts/login-captcha.png' });
        await browser.close();
        return;
      }
    }
  }

  // 5. 导航到音色页面
  console.log('5. Navigating to voices page...');
  await page.goto('https://console.volcengine.com/speech/new/voices?projectName=default', {
    waitUntil: 'networkidle', timeout: 30000,
  });
  await page.waitForTimeout(8000);
  console.log('  Title:', await page.title());

  // 6. 滚动加载
  console.log('6. Scrolling to load all voices...');
  let lastCount = 0;
  let stableCount = 0;
  
  for (let i = 0; i < 100; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForTimeout(1000);
    
    if (i % 10 === 0) console.log(`  Scroll ${i + 1}, captured ${voiceData.length} voices`);
    
    if (voiceData.length === lastCount) {
      stableCount++;
      if (stableCount > 5 && i > 10) {
        console.log('  No new data for 5 scrolls, stopping');
        break;
      }
    } else {
      stableCount = 0;
    }
    lastCount = voiceData.length;
  }

  // 7. 保存结果
  if (voiceData.length > 0) {
    console.log(`\n✅ Total captured: ${voiceData.length} voices`);
    const unique = new Map();
    voiceData.forEach(v => {
      const id = v.VoiceType || v.voice_type || v.SpeakerID;
      if (id && !unique.has(id)) unique.set(id, v);
    });
    console.log(`  Unique: ${unique.size}`);
    fs.writeFileSync('scripts/voices-from-console.json', JSON.stringify([...unique.values()], null, 2));
    console.log('  Saved to scripts/voices-from-console.json');
    console.log('\nFirst 15:');
    [...unique.values()].slice(0, 15).forEach((v, i) => {
      console.log(`  ${i + 1}. ${v.VoiceType || v.voice_type || '?'} | ${v.Name || v.name || '?'}`);
    });
  } else {
    console.log('\n⚠️ No API data captured');
    await page.screenshot({ path: 'scripts/console-voices.png', fullPage: true });
    console.log('  Screenshot: scripts/console-voices.png');
  }

  console.log('\nClosing in 5s...');
  await page.waitForTimeout(5000);
  await browser.close();
})();
