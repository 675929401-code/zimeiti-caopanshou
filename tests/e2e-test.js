/**
 * 端到端浏览器测试 v3 - 注入 token 直接测试聊天
 */
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
    } else if (msg.type() === 'log') {
      // 只打印关键日志
      const text = msg.text();
      if (text.includes('sendMessage') || text.includes('handleSend') || text.includes('NO convId') || text.includes('SSE') || text.includes('error') || text.includes('Error')) {
        console.log(`[CONSOLE LOG] ${text.substring(0, 200)}`);
      }
    }
  });
  page.on('pageerror', error => { pageErrors.push(error.message); });

  const TOKEN = process.env.E2E_AUTH_TOKEN?.trim();
  const USER = process.env.E2E_AUTH_USER_JSON?.trim();
  if (!TOKEN || !USER) {
    throw new Error('E2E_AUTH_TOKEN and E2E_AUTH_USER_JSON are required');
  }

  try {
    console.log('=== Step 1: 加载页面并注入 token ===');
    await page.goto('http://localhost:5000/', { waitUntil: 'networkidle2', timeout: 30000 });
    
    // 注入 auth token 和 user 信息到 localStorage
    await page.evaluate((token, user) => {
      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_user', user);
    }, TOKEN, USER);

    // 刷新页面让 token 生效
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    await page.screenshot({ path: '/tmp/test3-step1.png' });
    console.log('Page reloaded with auth token');

    // 检查是否已登录
    const loginState = await page.evaluate(() => {
      const loginForm = document.querySelector('[class*="login-form"], [class*="LoginForm"]');
      const sidebar = document.querySelector('[class*="sidebar"]');
      return {
        hasLoginForm: !!loginForm,
        hasSidebar: !!sidebar,
        bodyText: document.body.innerText?.substring(0, 200)
      };
    });
    console.log('Login state:', JSON.stringify(loginState));

    console.log('\n=== Step 2: 等待智能体列表加载 ===');
    await new Promise(r => setTimeout(r, 3000));

    // 查找并点击第一个智能体
    const clickedAgent = await page.evaluate(() => {
      // 查找智能体卡片
      const cards = document.querySelectorAll('[class*="agent-card"], [class*="bot-card"]');
      if (cards.length > 0) {
        const firstCard = cards[0];
        const name = firstCard.querySelector('[class*="title"], [class*="name"]');
        firstCard.click();
        return { name: name?.textContent?.trim(), total: cards.length };
      }

      // 如果没有明确class，尝试找可点击的卡片
      const allCards = document.querySelectorAll('[class*="cursor-pointer"]');
      for (const card of allCards) {
        const name = card.querySelector('h3, [class*="font-semibold"], [class*="font-medium"]');
        if (name && name.textContent?.trim().length > 2) {
          card.click();
          return { name: name.textContent?.trim(), total: allCards.length, method: 'cursor-pointer' };
        }
      }

      return { name: null, total: 0 };
    });
    console.log('Clicked agent:', JSON.stringify(clickedAgent));
    await page.screenshot({ path: '/tmp/test3-step2-agent.png' });

    // 等待对话界面加载
    await new Promise(r => setTimeout(r, 3000));

    // 检查是否有预设弹窗
    const dialogResult = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"], [class*="dialog-content"], [class*="preset"]');
      if (dialog) {
        const buttons = dialog.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent?.includes('开始') || btn.textContent?.includes('确认') || btn.textContent?.includes('确定')) {
            btn.click();
            return { found: true, clickedButton: btn.textContent?.trim() };
          }
        }
        // 点击最后一个按钮（通常是确认）
        if (buttons.length > 0) {
          buttons[buttons.length - 1].click();
          return { found: true, clickedLastButton: true };
        }
        return { found: true, noButton: true };
      }
      return { found: false };
    });
    console.log('Dialog:', JSON.stringify(dialogResult));

    if (dialogResult.found) {
      await new Promise(r => setTimeout(r, 2000));
    }

    await page.screenshot({ path: '/tmp/test3-step2-after-dialog.png' });

    console.log('\n=== Step 3: 检查聊天界面 ===');
    const chatState = await page.evaluate(() => {
      const textarea = document.querySelector('textarea');
      const sendBtns = document.querySelectorAll('button');
      let sendBtn = null;
      for (const btn of sendBtns) {
        const cls = btn.className || '';
        if (cls.includes('send') || (btn.querySelector('svg') && btn.closest('[class*="chat"]') && btn.parentElement?.querySelector('textarea') === null)) {
          sendBtn = { class: cls.substring(0, 60), disabled: btn.disabled };
        }
      }

      return {
        hasTextarea: !!textarea,
        textareaPlaceholder: textarea?.placeholder,
        textareaDisabled: textarea?.disabled,
        textareaDisplay: textarea ? getComputedStyle(textarea).display : null,
        sendBtn: sendBtn,
        url: window.location.href,
        bodyTextPreview: document.body.innerText?.substring(0, 300)
      };
    });
    console.log('Chat state:', JSON.stringify(chatState, null, 2));

    if (!chatState.hasTextarea) {
      console.log('\n!!! NO TEXTAREA FOUND - Debugging !!!');
      // 打印更多调试信息
      const debugInfo = await page.evaluate(() => {
        const allTextareas = document.querySelectorAll('textarea');
        const allContentEditable = document.querySelectorAll('[contenteditable="true"]');
        const chatViews = document.querySelectorAll('[class*="chat"]');
        const mainArea = document.querySelector('main, [role="main"]');
        return {
          textareaCount: allTextareas.length,
          contentEditableCount: allContentEditable.length,
          chatViewCount: chatViews.length,
          mainArea: mainArea ? mainArea.innerHTML?.substring(0, 300) : null,
          // 查找可能隐藏的textarea
          hiddenTextareas: Array.from(allTextareas).map(ta => ({
            display: getComputedStyle(ta).display,
            visibility: getComputedStyle(ta).visibility,
            height: getComputedStyle(ta).height,
            parentDisplay: getComputedStyle(ta.parentElement).display
          }))
        };
      });
      console.log('Debug info:', JSON.stringify(debugInfo, null, 2));
    }

    console.log('\n=== Step 4: 输入消息并发送 ===');
    if (chatState.hasTextarea) {
      // 输入消息
      await page.focus('textarea');
      await page.keyboard.type('你好，这是一条测试消息');
      await page.screenshot({ path: '/tmp/test3-step4-typed.png' });

      // 检查输入是否成功
      const inputValue = await page.evaluate(() => document.querySelector('textarea')?.value);
      console.log('Input value:', inputValue);

      // 按 Enter 发送
      console.log('Pressing Enter...');
      await page.keyboard.press('Enter');

      // 等待一下看是否有反应
      await new Promise(r => setTimeout(r, 2000));
      await page.screenshot({ path: '/tmp/test3-step4-after-enter.png' });

      // 检查输入框是否被清空（说明发送成功）
      const afterSendValue = await page.evaluate(() => document.querySelector('textarea')?.value);
      console.log('Input value after Enter:', afterSendValue);

      // 检查是否有新的用户消息出现在聊天区域
      const chatMessages = await page.evaluate(() => {
        const msgs = document.querySelectorAll('[class*="message"]');
        return Array.from(msgs).map(m => m.textContent?.substring(0, 50)).slice(-5);
      });
      console.log('Chat messages:', JSON.stringify(chatMessages));

      // 等待AI回复
      console.log('Waiting for AI response...');
      await new Promise(r => setTimeout(r, 15000));
      await page.screenshot({ path: '/tmp/test3-step4-after-response.png' });

      // 最终检查
      const finalState = await page.evaluate(() => {
        const msgs = document.querySelectorAll('[class*="message"]');
        const ta = document.querySelector('textarea');
        return {
          messageCount: msgs.length,
          lastMessagePreview: msgs.length > 0 ? msgs[msgs.length - 1].textContent?.substring(0, 100) : null,
          textareaValue: ta?.value,
          textareaExists: !!ta
        };
      });
      console.log('Final state:', JSON.stringify(finalState, null, 2));
    } else {
      console.log('SKIPPED: No textarea available for testing');
    }

    console.log('\n=== Console Errors ===');
    consoleErrors.slice(0, 20).forEach(e => console.log(e));

    console.log('\n=== Page Errors ===');
    pageErrors.forEach(e => console.log('PAGE ERROR:', e));

  } catch (error) {
    console.error('Test error:', error.message);
    console.error(error.stack);
    await page.screenshot({ path: '/tmp/test3-error.png' });
  } finally {
    await browser.close();
  }
})();
