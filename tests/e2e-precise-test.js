/**
 * 精确 E2E 测试 — 复现"消息突然变没了"
 * 重点：注入token → 点击智能体 → 发送消息 → 切换对话 → 检查消息
 */
const TARGET_URL = process.argv[2] || 'http://localhost:5000';
const puppeteer = require('puppeteer');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--window-size=1400,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  // 收集所有console消息
  const logs = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[handleSend]') || text.includes('[sendMessage]') || 
        text.includes('SET_ACTIVE') || text.includes('SET_VIEW') ||
        text.includes('activeConversation') || text.includes('activeConv') ||
        text.includes('ADD_MESSAGE') || text.includes('ADD_CONVERSATION') ||
        text.includes('message') && text.includes('count')) {
      logs.push(`[${msg.type()}] ${text.slice(0, 200)}`);
    }
  });

  try {
    console.log('1. 打开页面...');
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    // 注入JWT token
    console.log('2. 注入管理员token...');
    const jose = require('jose');
    const secret = new TextEncoder().encode('agent-hub-secret-key-2024');
    const token = await new jose.SignJWT({ userId: 'b5cccb94-1d77-4e14-9391-fb3e6f823486', role: 'admin', username: '18685178259' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(secret);

    const meRes = await fetch(`${TARGET_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meData = await meRes.json();
    
    await page.evaluate((token, user) => {
      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_user', JSON.stringify(user));
    }, token, meData.user);
    console.log(`  注入成功: ${meData.user.displayName}`);

    // 刷新页面
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    // 获取第一个LLM智能体
    console.log('3. 获取LLM智能体列表...');
    const agent = await page.evaluate(async () => {
      const token = localStorage.getItem('auth_token');
      const res = await fetch('/api/bots', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      const llmAgent = (data.agents || []).find(a => a.source === 'llm' && a.user_access !== 'hidden');
      return llmAgent ? { id: llmAgent.id, name: llmAgent.name } : null;
    });
    console.log(`  第一个LLM智能体: ${agent?.name}`);

    if (!agent) { console.log('  没有LLM智能体，退出'); await browser.close(); return; }

    // 点击智能体
    console.log('4. 点击智能体...');
    await page.evaluate((name) => {
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        if (el.textContent?.trim() === name && el.children.length === 0) {
          const card = el.closest('[class*="card"], [role="button"]') || el;
          card.click();
          return true;
        }
      }
      return false;
    }, agent.name);
    await sleep(2000);

    // 检查对话界面
    const chatState1 = await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      return {
        hasTextarea: !!ta,
        placeholder: ta?.placeholder || '',
        convId: window.__NEXT_DATA__?.props?.pageProps?.activeConversationId || 'unknown',
      };
    });
    console.log(`  对话界面: ${JSON.stringify(chatState1)}`);

    // 处理预设弹窗
    await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        const btns = dialog.querySelectorAll('button');
        const startBtn = Array.from(btns).find(b => b.textContent?.includes('开始') || b.textContent?.includes('确认'));
        if (startBtn) startBtn.click();
        else if (btns.length > 0) btns[btns.length - 1].click();
      }
    });
    await sleep(1000);

    // 发送消息
    console.log('5. 发送消息...');
    const msg1 = `Hello测试${Date.now()}`;
    await page.evaluate((msg) => {
      const ta = document.querySelector('textarea');
      if (!ta) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, msg);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    }, msg1);
    await sleep(500);
    const ta = await page.$('textarea');
    if (ta) await ta.press('Enter');
    console.log('  已发送');

    // 等待AI回复
    console.log('6. 等待AI回复...');
    let replyReady = false;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      const check = await page.evaluate(() => {
        const ta = document.querySelector('textarea');
        const msgItems = document.querySelectorAll('.msg-animate, [class*="message-item"]');
        const textLen = document.body.innerText.length;
        const streaming = !!document.querySelector('.markdown-body-generate');
        return { hasTA: !!ta, msgItems: msgItems.length, textLen, streaming };
      });
      console.log(`  ${i+1}s: msgItems=${check.msgItems}, textLen=${check.textLen}, streaming=${check.streaming}`);
      if (check.msgItems >= 2 && !check.streaming && i > 3) {
        replyReady = true;
        break;
      }
    }
    console.log(`  AI回复: ${replyReady ? '✅ 正常' : '❌ 超时'}`);

    // 记录当前对话ID
    const convIdBefore = await page.evaluate(() => {
      // 尝试从React内部状态获取
      const sidebarItems = document.querySelectorAll('.sidebar-conv-item');
      return {
        sidebarItemCount: sidebarItems.length,
        firstItemName: sidebarItems[0]?.textContent?.trim().slice(0, 20),
      };
    });
    console.log(`  侧边栏对话列表: ${JSON.stringify(convIdBefore)}`);

    // 截图
    await page.screenshot({ path: '/tmp/e2e-step6-reply.png' });
    console.log('  截图: /tmp/e2e-step6-reply.png');

    // ===== 关键测试：切回主页再切回来 =====
    console.log('7. 切回主页...');
    const wentHome = await page.evaluate(() => {
      // 找"主页"按钮
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if (b.textContent?.includes('主页') || b.title?.includes('主页') || b.title?.includes('返回')) {
          b.click();
          return true;
        }
      }
      // 找侧边栏logo
      const logo = document.querySelector('[class*="sidebar"] [class*="logo"], [class*="sidebar-header"]');
      if (logo) { logo.click(); return true; }
      return false;
    });
    console.log(`  返回主页: ${wentHome}`);
    await sleep(2000);

    const afterHome = await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      const agentCards = document.querySelectorAll('[class*="agent-card"], [class*="card"]');
      return {
        onMarketplace: !ta,
        agentCards: agentCards.length,
        url: window.location.href,
      };
    });
    console.log(`  主页状态: ${JSON.stringify(afterHome)}`);

    // 再次点击同一个智能体
    console.log('8. 再次点击同一个智能体...');
    const clicked2 = await page.evaluate((name) => {
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        if (el.textContent?.trim() === name && el.children.length === 0) {
          const card = el.closest('[class*="card"], [role="button"]') || el;
          card.click();
          return true;
        }
      }
      return false;
    }, agent.name);
    console.log(`  点击: ${clicked2}`);
    await sleep(3000);

    // 检查消息是否还在
    console.log('9. 检查消息是否还在...');
    const afterSwitch = await page.evaluate((originalMsg) => {
      const ta = document.querySelector('textarea');
      const msgItems = document.querySelectorAll('.msg-animate, [class*="message-item"]');
      const allText = document.body.innerText;
      const hasOriginalMsg = allText.includes(originalMsg);
      return {
        hasTextarea: !!ta,
        msgItems: msgItems.length,
        hasOriginalMsg,
        textSnippet: allText.slice(0, 300),
        convCount: document.querySelectorAll('.sidebar-conv-item').length,
      };
    }, msg1);
    console.log(`  切换后状态: ${JSON.stringify(afterSwitch)}`);
    
    if (afterSwitch.hasOriginalMsg) {
      console.log('  ✅ 消息在切换后仍存在');
    } else {
      console.log('  ❌ 消息在切换后消失了！');
      // 这可能是新开了一个对话
      console.log('  → 可能是点击智能体时创建了新对话，而不是恢复旧对话');
    }

    // 尝试通过侧边栏切换回旧对话
    console.log('10. 通过侧边栏切换对话...');
    const sidebarSwitch = await page.evaluate(() => {
      const items = document.querySelectorAll('.sidebar-conv-item');
      if (items.length > 1) {
        items[1].click(); // 点击第二个（更可能是旧对话）
        return { switched: true, count: items.length };
      } else if (items.length === 1) {
        items[0].click();
        return { switched: true, count: items.length };
      }
      return { switched: false, count: items.length };
    });
    console.log(`  侧边栏切换: ${JSON.stringify(sidebarSwitch)}`);
    await sleep(2000);

    const afterSidebarSwitch = await page.evaluate((originalMsg) => {
      const allText = document.body.innerText;
      const msgItems = document.querySelectorAll('.msg-animate, [class*="message-item"]');
      return {
        hasOriginalMsg: allText.includes(originalMsg),
        msgItems: msgItems.length,
        textSnippet: allText.slice(0, 200),
      };
    }, msg1);
    console.log(`  侧边栏切换后: ${JSON.stringify(afterSidebarSwitch)}`);

    // 截图
    await page.screenshot({ path: '/tmp/e2e-step10-sidebar.png' });

    // ===== 测试：在当前对话中发送第二条消息 =====
    console.log('11. 在当前对话中发送第二条消息...');
    const msg2 = `Second test ${Date.now()}`;
    await page.evaluate((msg) => {
      const ta = document.querySelector('textarea');
      if (!ta) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, msg);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    }, msg2);
    await sleep(500);
    const ta2 = await page.$('textarea');
    if (ta2) await ta2.press('Enter');
    console.log('  已发送第二条消息');

    await sleep(3000);
    const afterSecond = await page.evaluate((msg) => {
      const ta = document.querySelector('textarea');
      const msgItems = document.querySelectorAll('.msg-animate, [class*="message-item"]');
      const allText = document.body.innerText;
      return {
        hasTextarea: !!ta,
        msgItems: msgItems.length,
        hasSecondMsg: allText.includes(msg),
        textareaValue: ta?.value || '',
      };
    }, msg2);
    console.log(`  第二条消息状态: ${JSON.stringify(afterSecond)}`);

    if (afterSecond.hasTextarea && afterSecond.textareaValue === '' && afterSecond.msgItems > 0) {
      console.log('  ✅ 第二条消息发送成功');
    } else {
      console.log('  ❌ 第二条消息发送失败');
    }

    // 刷新页面测试
    console.log('12. 刷新页面测试消息持久化...');
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(5000);

    const afterRefresh = await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      const msgItems = document.querySelectorAll('.msg-animate, [class*="message-item"]');
      const allText = document.body.innerText;
      return {
        hasTextarea: !!ta,
        msgItems: msgItems.length,
        textLen: allText.length,
        hasContent: allText.length > 500,
      };
    });
    console.log(`  刷新后状态: ${JSON.stringify(afterRefresh)}`);

    if (afterRefresh.msgItems > 0) {
      console.log('  ✅ 刷新后消息保留');
    } else {
      console.log('  ❌ 刷新后消息丢失');
    }

    // 最终截图
    await page.screenshot({ path: '/tmp/e2e-final.png' });

    // 打印关键日志
    console.log('\n📋 关键日志:');
    logs.forEach(l => console.log(l));

  } catch (e) {
    console.error('测试出错:', e.message);
    await page.screenshot({ path: '/tmp/e2e-error.png' });
  } finally {
    await browser.close();
  }
})();
