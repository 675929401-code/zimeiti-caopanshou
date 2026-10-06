/**
 * 生产环境端到端测试 v5 - 直接测试 zycheni9.com
 */
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const ALL_CONSOLE = [];
  page.on('console', msg => {
    const text = msg.text();
    ALL_CONSOLE.push({ type: msg.type(), text: text.substring(0, 500) });
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`[BROWSER ${msg.type().toUpperCase()}] ${text.substring(0, 500)}`);
    }
    if (text.includes('handleSend') || text.includes('sendMessage') || text.includes('sendLLM') || text.includes('NO convId') || text.includes('Error') || text.includes('FAIL')) {
      console.log(`[LOG] ${text.substring(0, 500)}`);
    }
  });
  page.on('pageerror', error => {
    console.log(`[PAGE_ERROR] ${error.message}`);
  });

  const TOKEN = process.env.E2E_AUTH_TOKEN?.trim();
  const USER = process.env.E2E_AUTH_USER_JSON?.trim();
  if (!TOKEN || !USER) {
    throw new Error('E2E_AUTH_TOKEN and E2E_AUTH_USER_JSON are required');
  }

  try {
    console.log('=== Step 1: 加载生产页面 ===');
    await page.goto('https://zycheni9.com/', { waitUntil: 'networkidle2', timeout: 60000 });

    // 注入 auth
    await page.evaluate((token, user) => {
      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_user', user);
    }, TOKEN, USER);

    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    console.log('Page reloaded with auth');
    await new Promise(r => setTimeout(r, 5000));
    await page.screenshot({ path: '/tmp/prod-step1.png' });

    // 检查页面基本状态
    const pageState = await page.evaluate(() => {
      const textarea = document.querySelector('textarea');
      const body = document.body.innerText.substring(0, 500);
      return { hasTextarea: !!textarea, bodyPreview: body };
    });
    console.log('Page state:', JSON.stringify(pageState, null, 2).substring(0, 500));

    console.log('\n=== Step 2: 点击智能体进入聊天 ===');
    // 点击侧边栏第一个对话
    const clicked = await page.evaluate(() => {
      // 尝试点击侧边栏的对话
      const convItems = document.querySelectorAll('[class*="sidebar-conv-item"], [class*="conv-item"]');
      if (convItems.length > 0) {
        convItems[0].click();
        return { type: 'conversation', count: convItems.length };
      }
      // 或者点击智能体卡片
      const cards = document.querySelectorAll('[class*="cursor-pointer"]');
      for (const card of cards) {
        const name = card.querySelector('h3, [class*="font-semibold"]');
        if (name && name.textContent?.trim().length > 2) {
          card.click();
          return { type: 'agent', name: name.textContent.trim() };
        }
      }
      return { type: 'none' };
    });
    console.log('Clicked:', JSON.stringify(clicked));
    await new Promise(r => setTimeout(r, 3000));

    // 处理预设弹窗
    await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        const buttons = dialog.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent?.includes('开始') || btn.textContent?.includes('确认')) {
            btn.click(); return;
          }
        }
        if (buttons.length > 0) buttons[buttons.length - 1].click();
      }
    });
    await new Promise(r => setTimeout(r, 2000));

    console.log('\n=== Step 3: 检查聊天界面状态 ===');
    const chatState = await page.evaluate(() => {
      const textarea = document.querySelector('textarea');
      // 查找所有按钮，寻找发送按钮
      const buttons = Array.from(document.querySelectorAll('button'));
      const sendBtns = buttons.filter(b => {
        const svg = b.querySelector('svg');
        return svg && b.closest('[class*="flex"]') && !b.textContent?.trim();
      });
      return {
        hasTextarea: !!textarea,
        placeholder: textarea?.placeholder,
        disabled: textarea?.disabled,
        readOnly: textarea?.readOnly,
        contentEditable: textarea?.contentEditable,
        parentClasses: textarea?.parentElement?.className?.substring(0, 200),
        textareaClasses: textarea?.className?.substring(0, 200),
        buttonCount: buttons.length,
        sendBtnCount: sendBtns.length,
        url: window.location.href,
      };
    });
    console.log('Chat state:', JSON.stringify(chatState, null, 2));
    await page.screenshot({ path: '/tmp/prod-step3.png' });

    if (chatState.hasTextarea) {
      console.log('\n=== Step 4: 输入消息并发送 ===');
      
      // 点击 textarea 聚焦
      await page.click('textarea');
      await new Promise(r => setTimeout(r, 500));
      
      // 输入文字
      await page.type('textarea', '你好，测试消息', { delay: 50 });
      await new Promise(r => setTimeout(r, 500));

      const afterType = await page.evaluate(() => document.querySelector('textarea')?.value);
      console.log('After typing, textarea value:', afterType);
      await page.screenshot({ path: '/tmp/prod-step4-typed.png' });

      // 按 Enter 发送
      console.log('Pressing Enter...');
      await page.keyboard.press('Enter');
      
      // 等待一下看结果
      await new Promise(r => setTimeout(r, 5000));
      
      const afterSend = await page.evaluate(() => {
        const ta = document.querySelector('textarea');
        return {
          textareaValue: ta?.value,
          textareaExists: !!ta,
          textareaDisabled: ta?.disabled,
        };
      });
      console.log('After Enter (5s):', JSON.stringify(afterSend, null, 2));
      await page.screenshot({ path: '/tmp/prod-step4-after.png' });

      // 等AI回复
      console.log('Waiting for AI response (20s)...');
      await new Promise(r => setTimeout(r, 20000));
      
      const finalState = await page.evaluate(() => {
        const ta = document.querySelector('textarea');
        // 尝试获取聊天消息
        const allText = document.body.innerText;
        const chatArea = document.querySelector('[class*="flex-1"][class*="overflow"]');
        return {
          textareaValue: ta?.value,
          textareaExists: !!ta,
          chatAreaText: chatArea?.innerText?.substring(0, 500),
          bodyEnd: allText.substring(allText.length - 500),
        };
      });
      console.log('Final state:', JSON.stringify(finalState, null, 2));
      await page.screenshot({ path: '/tmp/prod-step4-final.png' });
    } else {
      console.log('!!! NO TEXTAREA FOUND !!!');
      const html = await page.evaluate(() => document.body.innerHTML.substring(0, 2000));
      console.log('Body HTML preview:', html.substring(0, 1000));
    }

    console.log('\n=== All Console Errors/Warnings ===');
    ALL_CONSOLE.filter(c => c.type === 'error' || c.type === 'warning').forEach(c => {
      console.log(`  [${c.type}] ${c.text.substring(0, 300)}`);
    });

  } catch (error) {
    console.error('Test error:', error.message);
    await page.screenshot({ path: '/tmp/prod-error.png' });
  } finally {
    await browser.close();
  }
})();
