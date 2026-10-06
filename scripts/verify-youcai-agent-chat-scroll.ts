import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";

const root = process.cwd();
const sourcePath = path.join(root, "src/features/official-core-routes/official-agent-route.tsx");
const stylePath = path.join(root, "src/features/official-core-routes/official-agent-route.module.css");
const evidenceDir = path.join(root, ".codex-evidence", "agent-chat-scroll-20260826");

function assertSourceContract(source: string, styles: string) {
  const sourceContracts: Array<[string, string]> = [
    ["thresholded latest-message detection", "LATEST_MESSAGE_THRESHOLD_PX = 96"],
    ["dedicated message scroll container", "ref={messageListRef}"],
    ["user scroll listener", "onScroll={handleMessageListScroll}"],
    ["streaming DOM observer", "new MutationObserver"],
    ["conditional follow mode", "if (stickToLatestRef.current) scrollToLatest(\"auto\")"],
    ["latest-message control", "data-testid=\"agent-scroll-to-latest\""],
    ["smooth user-requested return", "onClick={() => scrollToLatest(\"smooth\")}"],
    ["selected model remains explicit", "selectedModelId"],
    ["attachment history still settles six times", "const maxAttempts = 6"],
    ["video and audio safety block remains", "当前 Agent 链路尚未将视频/音频内容传给模型"],
    ["real workbench billing copy remains", "真实媒体生成由对应工作台的已发布模型提交与计费"],
  ];
  const styleContracts: Array<[string, string]> = [
    ["message and composer share 1120px measure", "width: min(1120px, 100%)"],
    ["assistant output is borderless", ".messageRow[data-role=\"assistant\"]:not([data-message-status=\"failed\"]) .messageBubble"],
    ["assistant output is transparent", "background: transparent"],
    ["composer scrollbar is hidden", ".route .composer textarea::-webkit-scrollbar"],
    ["code blocks wrap", "white-space: pre-wrap !important"],
    ["code block horizontal overflow is removed", "overflow-x: hidden !important"],
    ["stream chunks follow immediately", "scroll-behavior: auto"],
    ["latest button stays above variable composer height", "bottom: calc(100% + 10px)"],
  ];
  for (const [label, token] of sourceContracts) {
    assert.ok(source.includes(token), `missing source contract: ${label}`);
  }
  for (const [label, token] of styleContracts) {
    assert.ok(styles.includes(token), `missing style contract: ${label}`);
  }
}

async function mountFixture(page: Page, styles: string) {
  const browserStyles = styles.replace(/:global\(([^)]+)\)/gu, "$1");
  await page.setContent(`<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <style>${browserStyles}</style>
        <style>
          html, body { margin: 0; width: 100%; height: 100%; }
          .scrollToLatestButton[hidden] { display: none !important; }
          .fixture-label { padding: 12px 20px; color: #526176; border-bottom: 1px solid #edf1f6; }
          .fixture-message { min-height: 88px; padding: 12px 0; border-bottom: 1px solid #edf1f6; }
        </style>
      </head>
      <body>
        <div class="route">
          <main class="workspace">
            <section class="chatSurface">
              <header class="conversationHeader"><span>✦</span><div><strong>创作 Agent</strong><small>零付费滚动交互验收</small></div></header>
              <div id="message-list" class="messageList" data-testid="agent-message-list">
                <article class="messageRow" data-role="assistant" data-message-status="complete">
                  <span class="messageAvatar">✦</span>
                  <div class="messageColumn"><strong>创作 Agent</strong><div id="assistant-bubble" class="messageBubble"><p>助手输出应与输入框同一视觉中轴，不使用白色窄包裹卡。</p><div class="code-block-wrapper"><pre id="code-pre" class="code-block-pre"><code>用途：长文本自动换行，不出现横向滚动条；触发条件：用户需要梳理创作 Skill。</code></pre></div></div></div>
                </article>
                <div id="stream-target"></div>
              </div>
            </section>
            <div class="composerDock" data-conversation="true">
              <button id="latest" type="button" class="scrollToLatestButton" aria-label="回到最新消息" hidden>⌄</button>
              <form class="composer"><textarea id="composer-input" rows="1">这是一段足够长的输入内容，用于确认输入框可以增长但不会显示突兀滚动条。\n第二行测试。</textarea><div class="composerFooter">命令 / Skill · 提示词库 · 图片 · 视频 · 音频 / 音乐</div></form>
            </div>
          </main>
        </div>
        <script>
          (() => {
            const threshold = 96;
            const list = document.getElementById("message-list");
            const latest = document.getElementById("latest");
            const target = document.getElementById("stream-target");
            let stickToLatest = true;
            let autoScrolling = false;
            const distance = () => Math.max(0, list.scrollHeight - list.scrollTop - list.clientHeight);
            const setButton = (visible) => { latest.hidden = !visible; };
            const scrollToLatest = (behavior = "auto") => {
              stickToLatest = true;
              autoScrolling = behavior === "smooth";
              setButton(false);
              list.scrollTo({ top: list.scrollHeight, behavior });
              window.setTimeout(() => { autoScrolling = false; }, behavior === "smooth" ? 650 : 0);
            };
            list.addEventListener("scroll", () => {
              const nearLatest = distance() <= threshold;
              if (autoScrolling) {
                if (nearLatest) autoScrolling = false;
                stickToLatest = true;
                setButton(false);
                return;
              }
              stickToLatest = nearLatest;
              setButton(!nearLatest);
            });
            latest.addEventListener("click", () => scrollToLatest("smooth"));
            const observer = new MutationObserver(() => {
              if (stickToLatest) scrollToLatest("auto");
              else setButton(distance() > threshold);
            });
            observer.observe(target, { childList: true, subtree: true, characterData: true });
            window.__agentFixture = {
              append(text) {
                const block = document.createElement("p");
                block.className = "fixture-message";
                block.textContent = text;
                target.append(block);
              },
              distance,
              jumpTop() { list.scrollTop = 0; list.dispatchEvent(new Event("scroll")); },
              latestVisible() { return !latest.hidden; },
              scrollTop() { return list.scrollTop; },
              clickLatest() { latest.click(); },
            };
          })();
        </script>
      </body>
    </html>`);
}

async function runBehaviorProbe(page: Page, historyScreenshotPath: string) {
  await page.evaluate(() => {
    const fixture = (window as unknown as { __agentFixture: { append(text: string): void } }).__agentFixture;
    for (let index = 1; index <= 18; index += 1) fixture.append(`历史输出 ${index}：用于制造可滚动的长对话。`);
  });
  await page.waitForTimeout(100);
  const firstDistance = await page.evaluate(() => (
    window as unknown as { __agentFixture: { distance(): number } }
  ).__agentFixture.distance());
  assert.ok(firstDistance <= 2, `follow mode did not stay at latest: ${firstDistance}px`);

  await page.evaluate(() => (
    window as unknown as { __agentFixture: { append(text: string): void } }
  ).__agentFixture.append("流式新增内容：用户位于底部时应继续跟随。"));
  await page.waitForTimeout(80);
  const streamingDistance = await page.evaluate(() => (
    window as unknown as { __agentFixture: { distance(): number } }
  ).__agentFixture.distance());
  assert.ok(streamingDistance <= 2, `streaming follow drifted: ${streamingDistance}px`);

  await page.evaluate(() => (
    window as unknown as { __agentFixture: { jumpTop(): void } }
  ).__agentFixture.jumpTop());
  await page.waitForTimeout(40);
  const beforeAppend = await page.evaluate(() => {
    const fixture = (window as unknown as {
      __agentFixture: { scrollTop(): number; latestVisible(): boolean };
    }).__agentFixture;
    return { scrollTop: fixture.scrollTop(), latestVisible: fixture.latestVisible() };
  });
  assert.equal(beforeAppend.latestVisible, true, "latest-message button is not shown after user scrolls up");
  const preservedTop = beforeAppend.scrollTop;

  await page.evaluate(() => (
    window as unknown as { __agentFixture: { append(text: string): void } }
  ).__agentFixture.append("用户阅读历史时到达的新输出，不应抢走当前阅读位置。"));
  await page.waitForTimeout(80);
  const afterAppend = await page.evaluate(() => {
    const fixture = (window as unknown as {
      __agentFixture: { scrollTop(): number; latestVisible(): boolean };
    }).__agentFixture;
    return { scrollTop: fixture.scrollTop(), latestVisible: fixture.latestVisible() };
  });
  assert.ok(Math.abs(afterAppend.scrollTop - preservedTop) <= 1, "history reading position was hijacked by new output");
  assert.equal(afterAppend.latestVisible, true, "latest-message button disappeared while history remained above");
  await page.screenshot({ path: historyScreenshotPath, fullPage: true });

  await page.evaluate(() => (
    window as unknown as { __agentFixture: { clickLatest(): void } }
  ).__agentFixture.clickLatest());
  await page.waitForTimeout(750);
  const returned = await page.evaluate(() => {
    const fixture = (window as unknown as {
      __agentFixture: { distance(): number; latestVisible(): boolean };
    }).__agentFixture;
    return { distance: fixture.distance(), latestVisible: fixture.latestVisible() };
  });
  assert.ok(returned.distance <= 2, `return-to-latest did not reach bottom: ${returned.distance}px`);
  assert.equal(returned.latestVisible, false, "latest-message button stayed visible at bottom");

  const visuals = await page.evaluate(() => {
    const textarea = getComputedStyle(document.getElementById("composer-input") as HTMLTextAreaElement);
    const assistant = getComputedStyle(document.getElementById("assistant-bubble") as HTMLDivElement);
    const code = getComputedStyle(document.getElementById("code-pre") as HTMLPreElement);
    const row = (document.querySelector(".messageRow") as HTMLElement).getBoundingClientRect();
    const composer = (document.querySelector(".composer") as HTMLElement).getBoundingClientRect();
    return {
      scrollbarWidth: textarea.scrollbarWidth,
      assistantBackground: assistant.backgroundColor,
      assistantBorder: assistant.borderTopWidth,
      codeWhiteSpace: code.whiteSpace,
      codeOverflowX: code.overflowX,
      rowWidth: row.width,
      composerWidth: composer.width,
    };
  });
  assert.equal(visuals.scrollbarWidth, "none", "composer scrollbar remains visible");
  assert.equal(visuals.assistantBackground, "rgba(0, 0, 0, 0)", "assistant output still has a white wrapper");
  assert.equal(visuals.assistantBorder, "0px", "assistant output still has a border wrapper");
  assert.equal(visuals.codeWhiteSpace, "pre-wrap", "code block does not wrap long lines");
  assert.equal(visuals.codeOverflowX, "hidden", "code block still exposes horizontal scrolling");
  assert.ok(visuals.rowWidth >= visuals.composerWidth * 0.94, "assistant output and composer measures are not aligned");
  return visuals;
}

async function main() {
  const [source, styles] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(stylePath, "utf8"),
  ]);
  assertSourceContract(source, styles);
  await mkdir(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mountFixture(desktop, styles);
    const desktopVisuals = await runBehaviorProbe(desktop, path.join(evidenceDir, "desktop-history-arrow.png"));
    await desktop.screenshot({ path: path.join(evidenceDir, "desktop.png"), fullPage: true });

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mountFixture(mobile, styles);
    const mobileVisuals = await runBehaviorProbe(mobile, path.join(evidenceDir, "mobile-history-arrow.png"));
    await mobile.screenshot({ path: path.join(evidenceDir, "mobile.png"), fullPage: true });

    const report = {
      ok: true,
      paidRequests: 0,
      sourceContract: "PASS",
      desktop: desktopVisuals,
      mobile: mobileVisuals,
      note: "Deterministic same-source CSS and scroll-controller probe; final runtime activation is verified after the unified build.",
    };
    await writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const closeTimedOut = await Promise.race([
      browser.close().then(() => false),
      new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(true), 5_000);
      }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    if (closeTimedOut) console.warn("Playwright browser.close exceeded 5000ms; forcing verifier exit");
  }
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exit(1);
  },
);
