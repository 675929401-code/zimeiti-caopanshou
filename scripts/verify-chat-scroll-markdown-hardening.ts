import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { chromium } from "playwright";
import {
  clearStreamingCache,
  renderMarkdown,
  renderStreamingText,
} from "../src/lib/markdown-renderer";

const root = process.cwd();
const chatViewPath = path.join(root, "src/components/chat-view.tsx");
const messageContentPath = path.join(root, "src/components/chat/message-content.tsx");
const appContextPath = path.join(root, "src/contexts/app-context.tsx");
const rendererPath = path.join(root, "src/lib/markdown-renderer.ts");
const chatGlassPath = path.join(root, "src/app/chat-glass-continuity.css");

function occurrenceCount(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

async function verifySourceContracts(): Promise<void> {
  const [chatView, messageContent, appContext, renderer, chatGlass] = await Promise.all([
    readFile(chatViewPath, "utf8"),
    readFile(messageContentPath, "utf8"),
    readFile(appContextPath, "utf8"),
    readFile(rendererPath, "utf8"),
    readFile(chatGlassPath, "utf8"),
  ]);

  assert.equal(
    occurrenceCount(chatView, 'data-testid="chat-scroll-to-latest"'),
    1,
    "chat view must expose exactly one scroll-to-latest control",
  );
  const inputDockIndex = chatView.indexOf('className="chat-input-dock');
  const buttonIndex = chatView.indexOf('data-testid="chat-scroll-to-latest"');
  assert(inputDockIndex >= 0 && buttonIndex > inputDockIndex, "scroll control must be anchored inside the input dock");
  assert.match(chatView, /bottom-full z-40/u, "scroll control rail must sit completely above the input dock");
  assert.match(chatView, /aria-label=\{isConvStreaming/u, "scroll control needs a streaming-aware accessible label");
  assert.match(chatView, /data-testid="chat-streaming-latest-indicator"/u, "streaming control needs a three-dot status marker");
  assert.match(chatView, /isConvStreaming\(activeConv\.id\) && "is-streaming"/u, "three-dot wave must be tied to actual streaming state");
  assert.match(chatGlass, /\.chat-latest-jump\.is-streaming \.chat-latest-dots[\s\S]*?opacity: 1/u, "streaming must show the three-dot wave");
  assert.match(chatGlass, /\.chat-latest-arrow[\s\S]*?opacity: 1/u, "idle history scrolling must show the arrow directly");
  assert.equal(occurrenceCount(chatView, "chat-shared-rail"), 3, "messages, latest control and composer must share one centered rail");
  assert.match(chatGlass, /@keyframes chat-latest-wave/u, "three-dot locator needs a wave animation");
  assert.match(chatGlass, /\.chat-latest-jump\.is-streaming \.chat-latest-arrow[\s\S]*?opacity: 1/u, "streaming must keep the down arrow visible beside the live badge");
  assert.match(chatGlass, /\.chat-latest-jump \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/u, "latest locator needs a 44px keyboard and pointer target");
  assert.match(chatGlass, /\.chat-latest-jump \{[\s\S]*?left: 50%;[\s\S]*?transform: translateX\(-50%\)/u, "latest locator must be centered over the composer");
  assert.match(chatGlass, /\[data-chat-surface="unified-glass"\]::after \{[\s\S]*?mask-image: none;/u, "theme grid must continue behind the composer without a bottom fade band");
  assert.match(chatGlass, /\.chat-canvas\.chat-scroll[\s\S]*?scrollbar-gutter: auto !important/u, "hidden transcript scrollbar must not reserve a side gutter");
  assert.match(chatGlass, /\.chat-shared-rail[\s\S]*?width: calc\(100% - 48px\) !important/u, "shared rails need desktop edge breathing room");
  assert.match(chatGlass, /\.chat-content-rail[\s\S]*?width: calc\(100% - 96px\) !important/u, "transcript should be slightly narrower than the composer");
  assert.match(chatGlass, /\.chat-content-rail\.max-w-6xl \{ max-width: 68rem !important; \}/u, "structured blocks need a bounded wide transcript rail");
  assert.match(chatGlass, /\.chat-message-bubble-assistant \.markdown-body :where\([\s\S]*?\.render-layer-final[\s\S]*?\.render-layer-streaming[\s\S]*?\) > :where\([\s\S]*?max-width: 55rem;/u, "prose needs a 55rem Chinese reading measure");

  assert.match(renderer, /html:\s*false/u, "raw Markdown HTML must stay disabled");
  assert.doesNotMatch(renderer, /html:\s*true/u, "raw Markdown HTML must never be enabled");
  assert.match(renderer, /streamingRenderStates\s*=\s*new Map/u, "stream state must be keyed per message");
  assert.match(messageContent, /fallbackStreamingRenderKey\s*=\s*React\.useId\(\)/u, "message renderer needs a per-mount stream identity");
  assert.match(
    messageContent,
    /streamingRenderKey\s*=\s*`\$\{messageId\s*\|\|\s*"anonymous-message"\}:\$\{fallbackStreamingRenderKey\}`/u,
    "message stream keys must combine the message ID with a per-mount identity",
  );
  assert.match(messageContent, /renderStreamingText\(processedText, streamingRenderKey\)/u, "message renderer must pass a stable stream key");
  assert.match(messageContent, /clearStreamingCache\(streamingRenderKey\)/u, "message renderer must clear only its own stream state");
  assert.match(messageContent, /STREAM_MORPH_INTERVAL_MS\s*=\s*16/u, "streaming DOM morphs must be capped to one paint frame");
  assert.match(messageContent, /streaming-typewriter-caret/u, "streaming output needs a stable keyed caret");

  assert.match(
    appContext,
    /if \(!instantlyPaintedStreamKeysRef\.current\.has\(key\)\)[\s\S]*?if \(streamingRafRef\.current === null\) flushStreamingUpdate\(\);[\s\S]*?return;/u,
    "a second stream must join an already scheduled RAF instead of orphaning its handle",
  );
  assert.match(
    appContext,
    /if \(streamingRafRef\.current === null\) \{\s*streamingRafRef\.current = requestAnimationFrame\(flushStreamingUpdate\);\s*\}/u,
    "stream updates must maintain at most one scheduled RAF chain",
  );
  assert.match(appContext, /const cancelStreamingFrameIfIdle = useCallback/u, "idle RAF cleanup must be explicit");
  assert.match(
    appContext,
    /useEffect\(\(\) => \(\) => resetTypewriterState\(\), \[resetTypewriterState\]\)/u,
    "provider unmount must clear streaming queues and scheduled frames",
  );

  for (const finalizer of ["sendLLMMessage finally", "sendCozeMessage finally", "sendCozeCodingMessage finally"]) {
    const start = appContext.indexOf(finalizer);
    const controllerCleanup = appContext.indexOf("finalizeAbortController(convId, controller);", start);
    assert(start >= 0 && controllerCleanup > start, `${finalizer} cleanup block is missing`);
    const finalizerSlice = appContext.slice(start, controllerCleanup);
    assert.match(
      finalizerSlice,
      /resetTypewriterState\(\{ conversationId: convId, messageId: assistantMsgId \}\);/u,
      `${finalizer} must invalidate queued text before releasing its controller`,
    );
  }

  const nonStreamingStart = appContext.indexOf("// Non-streaming JSON response");
  const finalUpdateStart = appContext.indexOf("// Final update", nonStreamingStart);
  assert(nonStreamingStart >= 0 && finalUpdateStart > nonStreamingStart, "non-streaming JSON branch is missing");
  const nonStreamingSlice = appContext.slice(nonStreamingStart, finalUpdateStart);
  assert.match(nonStreamingSlice, /fullContent = rawContent;/u, "non-streaming JSON must retain the complete response");
  assert.doesNotMatch(
    nonStreamingSlice,
    /dispatch\(\{/u,
    "non-streaming JSON must not paint the full response before the shared typewriter settle path",
  );
}

function verifyMarkdownContracts(): void {
  const formatted = renderMarkdown([
    "# 标题",
    "",
    "- 条目一",
    "- 条目二",
    "",
    "| 字段 | 内容 |",
    "| --- | --- |",
    "| A | B |",
    "",
    "```js",
    "const safe = true;",
    "```",
  ].join("\n"));

  assert.match(formatted, /<h1>/u, "heading rendering regressed");
  assert.match(formatted, /<ul>/u, "list rendering regressed");
  assert.match(formatted, /class="table-wrapper"/u, "table rendering regressed");
  assert.match(formatted, /class="code-block-wrapper/u, "code block rendering regressed");

  const hostile = '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=2</script><svg onload="globalThis.pwned=3"></svg>';
  const hostileFinal = renderMarkdown(hostile);
  const hostileStreaming = renderStreamingText(hostile, "xss-stream");
  for (const [phase, html] of [["final", hostileFinal], ["streaming", hostileStreaming]] as const) {
    assert.doesNotMatch(html, /<(?:img|script|svg)\b/iu, `${phase} renderer allowed executable raw HTML`);
    assert.match(html, /&lt;img/u, `${phase} renderer did not visibly escape raw HTML`);
  }
  clearStreamingCache("xss-stream");

  clearStreamingCache();
  renderStreamingText("甲消息", "message-a");
  renderStreamingText("乙消息", "message-b");
  const messageA = renderStreamingText("甲消息继续生成", "message-a");
  const messageB = renderStreamingText("乙消息保持独立", "message-b");
  assert.match(messageA, /甲消息继续生成/u);
  assert.doesNotMatch(messageA, /乙消息/u);
  assert.match(messageB, /乙消息保持独立/u);
  assert.doesNotMatch(messageB, /甲消息/u);

  clearStreamingCache("message-a");
  const messageBAfterSelectiveClear = renderStreamingText("乙消息保持独立并继续", "message-b");
  assert.match(messageBAfterSelectiveClear, /乙消息保持独立并继续/u, "clearing one message corrupted another stream");
  clearStreamingCache();
}

function measureStreamingRenderer(): { incrementalMs: number; cumulativeFullMs: number; ratio: number } {
  const stableStructuredPrefix = Array.from({ length: 48 }, (_, index) => [
    `## 已完成模块 ${index + 1}`,
    "",
    "- 结论清晰",
    "- 证据可核验",
    "",
    "| 指标 | 状态 |",
    "| --- | --- |",
    `| 模块 ${index + 1} | 通过 |`,
    "",
  ].join("\n")).join("\n");
  const chunks = Array.from({ length: 360 }, (_, index) => `第${index.toString(36)}段商业内容清晰稳定，`);
  const prefixes: string[] = [];
  let text = `${stableStructuredPrefix}\n最终说明：`;
  for (const chunk of chunks) {
    text += chunk;
    prefixes.push(text);
  }

  clearStreamingCache();
  const incrementalStart = performance.now();
  for (const prefix of prefixes) renderStreamingText(prefix, "performance-stream");
  const incrementalMs = performance.now() - incrementalStart;
  clearStreamingCache("performance-stream");

  const fullStart = performance.now();
  for (const prefix of prefixes) renderMarkdown(prefix);
  const cumulativeFullMs = performance.now() - fullStart;
  const ratio = cumulativeFullMs > 0 ? incrementalMs / cumulativeFullMs : 0;

  assert(
    incrementalMs < cumulativeFullMs,
    `incremental renderer (${incrementalMs.toFixed(1)}ms) must beat cumulative full rendering (${cumulativeFullMs.toFixed(1)}ms)`,
  );
  return { incrementalMs, cumulativeFullMs, ratio };
}

async function verifyScrollCoordinates(): Promise<{
  buttonTop: number;
  dockTop: number;
  centerDelta: number;
  distanceAfterClick: number;
}> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(`<!doctype html>
      <html><head><style>
        * { box-sizing: border-box; }
        html, body { margin: 0; width: 100%; height: 100%; }
        .chat-stage { position: relative; display: flex; flex-direction: column; width: 100vw; height: 100vh; background: #f7f8fb; }
        .header { flex: 0 0 60px; border-bottom: 1px solid #ddd; }
        .chat-scroll { position: relative; flex: 1 1 auto; overflow-y: auto; }
        .transcript { height: 2600px; padding: 24px; }
        .chat-input-dock { position: relative; z-index: 20; flex: 0 0 132px; padding: 24px 0 4px; background: #f7f8fb; }
        .latest-rail { pointer-events: none; position: absolute; left: 0; right: 0; bottom: 100%; z-index: 40; width: 1024px; max-width: 100%; height: 0; margin: auto; }
        #latest { pointer-events: auto; position: absolute; left: 50%; bottom: 8px; z-index: 40; height: 40px; width: 40px; transform: translateX(-50%); border-radius: 999px; border: 1px solid #d6dae3; background: rgba(255,255,255,.96); }
        .composer { position: relative; width: 1024px; max-width: 100%; height: 104px; margin: auto; padding: 16px 20px; border: 1px solid #ddd; background: white; }
      </style></head><body>
        <main class="chat-stage">
          <header class="header"></header>
          <section id="scroll" class="chat-scroll"><div class="transcript">long transcript</div></section>
          <section id="dock" class="chat-input-dock">
            <div class="latest-rail"><button id="latest" data-testid="chat-scroll-to-latest" aria-label="有新内容，回到最新消息"><span>•••</span>⌄</button></div>
            <div class="composer">composer</div>
          </section>
        </main>
        <script>
          const scroll = document.querySelector('#scroll');
          const latest = document.querySelector('#latest');
          const threshold = 80;
          function syncLatest() {
            const distance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
            latest.hidden = distance <= threshold;
          }
          scroll.addEventListener('scroll', syncLatest);
          latest.addEventListener('click', () => {
            scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight;
            syncLatest();
          });
          window.fixture = { scroll, latest, syncLatest };
        </script>
      </body></html>`);

    await page.evaluate(() => {
      const fixture = (window as unknown as { fixture: { scroll: HTMLElement; syncLatest: () => void } }).fixture;
      fixture.scroll.scrollTop = fixture.scroll.scrollHeight - fixture.scroll.clientHeight - 520;
      fixture.syncLatest();
    });

    const button = page.getByTestId("chat-scroll-to-latest");
    await button.waitFor({ state: "visible" });
    const firstBox = await button.boundingBox();
    const dockBox = await page.locator("#dock").boundingBox();
    const composerBox = await page.locator(".composer").boundingBox();
    assert(firstBox && dockBox && composerBox, "scroll button, input dock and composer must have measurable boxes");
    assert(firstBox.x >= 0 && firstBox.y >= 0, "scroll button escaped the viewport");
    assert(firstBox.x + firstBox.width <= 1440 && firstBox.y + firstBox.height <= 900, "scroll button is clipped by the viewport");
    assert(firstBox.y + firstBox.height <= dockBox.y, "input dock overlaps the scroll button");
    assert(Math.abs((firstBox.x + firstBox.width / 2) - (composerBox.x + composerBox.width / 2)) <= 0.5, "scroll button is not centered over the composer");

    const topElementTestId = await page.evaluate(({ x, y }) => {
      return document.elementFromPoint(x, y)?.closest("button")?.getAttribute("data-testid") ?? null;
    }, { x: firstBox.x + firstBox.width / 2, y: firstBox.y + firstBox.height / 2 });
    assert.equal(topElementTestId, "chat-scroll-to-latest", "another layer covers the scroll button");

    await page.evaluate(() => {
      const fixture = (window as unknown as { fixture: { scroll: HTMLElement } }).fixture;
      fixture.scroll.scrollTop -= 300;
    });
    const secondBox = await button.boundingBox();
    assert(secondBox, "scroll button disappeared after further upward scrolling");
    assert(Math.abs(secondBox.y - firstBox.y) <= 0.5, "scroll button moved with the transcript container");

    await button.click();
    const distanceAfterClick = await page.evaluate(() => {
      const scroll = (window as unknown as { fixture: { scroll: HTMLElement } }).fixture.scroll;
      return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    });
    assert(distanceAfterClick <= 80, `scroll-to-latest click stopped ${distanceAfterClick}px from the bottom`);

    return { buttonTop: firstBox.y, dockTop: dockBox.y, centerDelta: Math.abs((firstBox.x + firstBox.width / 2) - (composerBox.x + composerBox.width / 2)), distanceAfterClick };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  await verifySourceContracts();
  verifyMarkdownContracts();
  const performanceResult = measureStreamingRenderer();
  const coordinates = await verifyScrollCoordinates();
  console.log(JSON.stringify({ ok: true, performance: performanceResult, coordinates }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
