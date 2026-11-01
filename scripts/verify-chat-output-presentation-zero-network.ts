import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import MarkdownIt from "markdown-it";
import { chromium } from "playwright";
import { renderMarkdown, renderStreamingText, clearStreamingCache } from "../src/lib/markdown-renderer";

const file = "src/components/chat/message-content.tsx";
const source = readFileSync(file, "utf8");
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let finalRenderer: ts.Expression | undefined;
let userRenderer: ts.FunctionDeclaration | undefined;
let fenceProjection: ts.FunctionDeclaration | undefined;
let imageProjection: ts.IfStatement | undefined;
let sourceMapParser: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "finalHtml" && node.initializer && ts.isCallExpression(node.initializer)) finalRenderer = node.initializer.arguments[0];
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "codeBlockSourceMapParser" && node.initializer) sourceMapParser = node.initializer;
  if (ts.isFunctionDeclaration(node) && node.name?.text === "UserTextSegment") userRenderer = node;
  if (ts.isFunctionDeclaration(node) && node.name?.text === "transformOutsideFencedCode") fenceProjection = node;
  if (ts.isIfStatement(node) && node.expression.getText(ast) === "!isStreaming" && node.thenStatement.getText(ast).includes("transformOutsideFencedCode")) imageProjection = node;
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(finalRenderer && userRenderer && fenceProjection && imageProjection && sourceMapParser, "ACTUAL_MESSAGE_RENDERERS_AND_IMAGE_PROJECTION_REQUIRED");
const context = vm.createContext({ renderMarkdown, MarkdownIt, isStreaming: false, textWithoutImages: "", require: createRequire(`${process.cwd()}/${file}`), exports: {},
  isStructuredUserText: () => false, normalizeUserPastedText: (value: string) => value });
vm.runInContext(ts.transpileModule(`globalThis.renderFinal = ${finalRenderer.getText(ast)}; ${userRenderer.getText(ast)}; globalThis.UserTextSegment = UserTextSegment;
  const codeBlockSourceMapParser = ${sourceMapParser.getText(ast)};
  ${fenceProjection.getText(ast)};
  globalThis.projectImages = text => { let textWithoutImages = text; const imageUrls = [], objKeys = [], isStreaming = false;
    ${imageProjection.getText(ast)}; return { text: textWithoutImages, imageUrls, objKeys }; };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, context);
const heading = "### 选择创作模式\n\n**A模式｜同题再创作**\n\n普通正文保持正常字重。";
const code = '### code heading stays literal\n**code markers stay literal**\n\n\nconst html = "<b>&value</b>";\nconst png = "https://fixture.invalid/code-literal.png?keep=1";\n![literal image](https://fixture.invalid/literal-markdown.png)\n[img]literal-object.png[/img]';
context.textWithoutImages = `${heading}\n\n\`\`\`text\n${code}\n\`\`\``;
const finalHtml = context.renderFinal() as string;
assert.match(finalHtml, /<h3>选择创作模式<\/h3>/u);
assert.match(finalHtml, /<strong>A模式｜同题再创作<\/strong>/u);
assert.match(finalHtml, /code-block-plaintext/u);
assert.match(finalHtml, /\*\*code markers stay literal\*\*/u);
assert.match(finalHtml, /\n\n\nconst html/u, "FENCED_BLANK_LINES_MUST_REMAIN");
assert.doesNotMatch(finalHtml, /<h3>code heading/u);
assert.doesNotMatch(source, /processedText = processedText\.replace\(\/\\n\{3,\}/u);
assert.doesNotMatch(source, /textWithoutImages = textWithoutImages\.replace\(\/\\n\{3,\}/u);
assert.match(source, /if \(userContent\) return userContent/u);
const userHtml = renderToStaticMarkup(React.createElement(context.UserTextSegment, { text: '### 用户原文 **保持字面** <script>bad()</script>' }));
assert.match(userHtml, /### 用户原文 \*\*保持字面\*\*/u);
assert.doesNotMatch(userHtml, /<h3>|<strong>|<script>/u);
assert.match(userHtml, /&lt;script&gt;/u);
const codeFences = `\`\`\`text\n${code}\n\`\`\`\n\n\`\`\`js\nconst tail = "https://fixture.invalid/javascript-tail.png";\n\`\`\``;
const projected = context.projectImages(`${heading}\n\n${codeFences}\n\n![outside image](https://fixture.invalid/gallery.png)\n[img]outside-storage-key[/img]`);
assert.ok(projected.text.includes(codeFences), "FINAL_IMAGE_PROJECTION_MUST_PRESERVE_ALL_FENCE_CHARACTERS");
assert.deepEqual(Array.from(projected.imageUrls), ["https://fixture.invalid/gallery.png"], "ORDINARY_IMAGE_GALLERY_MUST_REMAIN");
assert.deepEqual(Array.from(projected.objKeys), ["outside-storage-key"]);
context.textWithoutImages = projected.text;
const projectedHtml = context.renderFinal();
assert.match(projectedHtml, /https:\/\/fixture\.invalid\/code-literal\.png\?keep=1/u);
assert.match(projectedHtml, /https:\/\/fixture\.invalid\/javascript-tail\.png/u);
assert.match(projectedHtml, /<strong>A模式｜同题再创作<\/strong>/u);
assert.doesNotMatch(projectedHtml, /<img|<script>/u);
const nestedCodeCases = [
  { id: "blockquote-fence", markdown: '> ```text\n> https://example.invalid/keep.png\n> ```', expected: 'https://example.invalid/keep.png\n' },
  { id: "list-fence", markdown: '- 内容\n\n    ```text\n    https://example.invalid/keep.png\n    ```', expected: 'https://example.invalid/keep.png\n' },
  { id: "indented-code", markdown: '    https://example.invalid/indent.png', expected: 'https://example.invalid/indent.png\n' },
];
for (const sample of nestedCodeCases) {
  const result = context.projectImages(sample.markdown);
  assert.equal(result.text, sample.markdown, `${sample.id}: source map must preserve nested code`);
  assert.equal(result.imageUrls.length, 0);
}
context.textWithoutImages = '<script>globalThis.pwned=1</script>';
assert.doesNotMatch(context.renderFinal(), /<script>/u);
context.isStreaming = true;
assert.equal(context.renderFinal(), "", "FINAL_RENDERER_MUST_NOT_REPLACE_ACTIVE_STREAM");
context.isStreaming = false;

async function main() {
const css = readFileSync("src/app/markdown-body.css", "utf8");
const moduleCss = readFileSync('src/components/chat/prompt-viewport.module.css', 'utf8');
const surfaceCss = moduleCss.replace(/:global\(([^)]+)\)/gu, '$1');
assert.match(source, /prompt-viewport\.module\.css/u);
assert.match(source, /\.surface/u);
const allCss = css + '\n' + surfaceCss;
const browser = await chromium.launch({ headless: true });
const cases: Array<Record<string, unknown>> = [];
let blockedRequests = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/*", async route => { blockedRequests++; await route.abort("blockedbyclient"); });
  for (const sample of nestedCodeCases) {
    context.textWithoutImages = context.projectImages(sample.markdown).text;
    const html = context.renderFinal();
    await page.setContent(`<style>${allCss}</style><div class="surface markdown-body">${html}</div>`);
    assert.equal(await page.locator('pre code').textContent(), sample.expected, `${sample.id}: actual code.textContent must stay complete`);
    cases.push({ id: sample.id, actualCodeTextMatched: true, preservedPngUrl: true });
  }
  const samples = [
    { id: 'short', title: '普通文档', content: '短提示词。https://fixture.invalid/short.png', tier: 'sm', cap: 240, label: '文档' },
    { id: 'short-image-prompt', title: '生图 Prompt', content: '主体和光线。', tier: 'sm', cap: 240, label: '生图提示词' },
    { id: 'short-video-prompt', title: '图生视频 Prompt', content: '镜头轻推。', tier: 'sm', cap: 240, label: '视频提示词' },
    { id: 'image-prompt', title: '生图 Prompt', content: '角色、构图、光线保持一致。'.repeat(1000), tier: 'sm', cap: 240, label: '生图提示词' },
    { id: 'video-prompt', title: '图生视频 Prompt', content: '镜头连续、动作自然。'.repeat(1000), tier: 'sm', cap: 240, label: '视频提示词' },
    { id: 'medium-document', title: '交付文档', content: Array.from({ length: 55 }, (_, i) => `第${i + 1}行：保留完整说明和原始文字，不因为展示高度截断文档内容。`).join('\n'), tier: 'md', cap: 400, label: '文档' },
    { id: 'large-document', title: '交付文档', content: Array.from({ length: 160 }, (_, i) => `第${i + 1}行：${'保留完整说明和原始文字。'.repeat(7)}`).join('\n'), tier: 'lg', cap: 560, label: '文档' },
    { id: 'single-long-line', title: '交付文档', content: '一条很长的逻辑行'.repeat(1800) + 'https://fixture.invalid/single-tail.png', tier: 'lg', cap: 560, label: '文档' },
  ];
  for (const { id, title, content, tier, cap, label } of samples) {
    const blockInput = `${heading}\n\n### ${title}\n\n\`\`\`text\n${content}`;
    const input = `${blockInput}\n\`\`\`\n\n\`\`\`js\nconst value = "**literal**";\n\`\`\``;
    const metrics: Record<string, unknown>[] = [];
    for (const phase of ["open", "streaming", "final"] as const) {
      const html = phase === "final" ? renderMarkdown(input) : renderStreamingText(phase === 'open' ? blockInput : input, `presentation-${id}`);
      await page.setContent(`<style>${allCss}</style><div class="chat-message-bubble-assistant"><div class="surface markdown-body" style="width:900px"><div class="render-layer-${phase === 'open' ? 'streaming' : phase}">${html}</div></div></div>`);
      const metric = await page.locator(".code-block-plaintext .code-block-pre").evaluate(element => {
        const code = element.querySelector("code");
        const style = getComputedStyle(element);
        const initial = element.scrollTop;
        element.scrollTop = element.scrollHeight;
        return { height: element.getBoundingClientRect().height, clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight, scrollTop: element.scrollTop, initialScrollTop: initial,
          overflowX: style.overflowX, overflowY: style.overflowY, scrollbarWidth: style.scrollbarWidth,
          prePadding: style.padding, codeOverflowX: code ? getComputedStyle(code).overflowX : null,
          horizontalOverflow: element.scrollWidth - element.clientWidth,
          code: code?.textContent, innerStrongCount: code?.querySelectorAll("strong").length || 0 };
      });
      assert.ok(metric.height <= cap, `${id}/${phase}: tier must be a ceiling`);
      assert.ok(await page.locator(`.code-block-plaintext.code-block-h-${tier}`).count() === 1, `${id}/${phase}: shared tier`);
      assert.equal(await page.locator('.code-block-plaintext .code-block-lang').textContent(), label);
      assert.equal(await page.locator('.code-block-plaintext .code-block-expand-button').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('.code-block-plaintext button.copy-code-button').getAttribute('aria-label'), '复制完整内容');
      assert.equal(metric.overflowY, "auto");
      assert.equal(metric.prePadding, '0px');
      assert.equal(metric.codeOverflowX, 'visible', 'ONLY_PRE_MAY_OWN_HORIZONTAL_SCROLL');
      assert.notEqual(metric.scrollbarWidth, "none");
      assert.ok(metric.horizontalOverflow <= 1);
      assert.equal(metric.code?.replace(/\n$/u, ""), content);
      if (id !== "short") {
        assert.equal(metric.height, cap);
        if (!id.startsWith('short-')) {
          assert.ok(metric.scrollHeight > metric.clientHeight);
          assert.ok(Math.abs(metric.scrollHeight - metric.clientHeight - metric.scrollTop) <= 1);
        }
      }
      else assert.ok(metric.height < 100, 'SHORT_BLOCK_MUST_NOT_GAIN_EMPTY_HEIGHT');
      const codeHeight = phase === 'open' ? 0 : await page.locator(".code-block-wrapper:not(.code-block-plaintext) .code-block-pre").evaluate(element => element.getBoundingClientRect().height);
      assert.ok(codeHeight < 240, "SHORT_REAL_CODE_MUST_RETAIN_COMPACT_HEIGHT");
      const weights = await page.evaluate(() => ({ strong: getComputedStyle(document.querySelector("strong")!).fontWeight,
        plain: getComputedStyle([...document.querySelectorAll("p")].find(element => element.textContent?.includes("普通正文"))!).fontWeight }));
      assert.ok(Number(weights.strong) >= 700 && Number(weights.strong) > Number(weights.plain));
      metrics.push({ phase, ...metric, code: undefined, codeHeight, weights });
    }
    assert.equal(metrics[0].height, metrics[1].height);
    assert.equal(metrics[1].height, metrics[2].height);
    cases.push({ id, metrics });
    clearStreamingCache(`presentation-${id}`);
  }
  const promptCases = cases.filter(item => String(item.id).includes('prompt'));
  assert.equal(promptCases.length, 4);
  for (const item of promptCases) for (const metric of item.metrics as Array<{height:number}>) assert.equal(metric.height, 240, 'SHORT_AND_LONG_IMAGE_VIDEO_PROMPTS_SAME_VIEWPORT');
  const horizontal = renderMarkdown('```js\n' + 'const literal = "' + 'wide'.repeat(1000) + '";\n```');
  await page.setContent(`<style>${allCss}</style><div class="surface markdown-body" style="width:900px">${horizontal}</div>`);
  const horizontalMetrics = await page.locator('.code-block-pre').evaluate(pre => {
    const code = pre.querySelector('code')!; pre.scrollLeft = pre.scrollWidth; pre.scrollTop = pre.scrollHeight;
    return { preOverflowX:getComputedStyle(pre).overflowX, codeOverflowX:getComputedStyle(code).overflowX, padding:getComputedStyle(pre).padding, horizontalOverflow:pre.scrollWidth-pre.clientWidth, scrollLeft:pre.scrollLeft, codeBottom:code.getBoundingClientRect().bottom, preBottom:pre.getBoundingClientRect().bottom };
  });
  assert.equal(horizontalMetrics.preOverflowX, 'auto'); assert.equal(horizontalMetrics.codeOverflowX, 'visible'); assert.equal(horizontalMetrics.padding, '0px');
  assert.ok(horizontalMetrics.horizontalOverflow > 100 && horizontalMetrics.scrollLeft > 100, 'LONG_REAL_CODE_SCROLLS_ON_PRE');
  assert.ok(Math.abs(horizontalMetrics.preBottom-horizontalMetrics.codeBottom) <= 18, 'HORIZONTAL_SCROLL_OWNER_REACHES_CARD_BOTTOM');
  cases.push({id:'horizontal-owner',...horizontalMetrics});
  // Reused literal content must not reuse a prior title's cached purpose/tier.
  const cached = '镜头和光线保持一致。'.repeat(1000);
  for (const [title, expected] of [['生图 Prompt', 'sm'], ['普通文档', 'lg'], ['图生视频 Prompt', 'sm']] as const) {
    const html = renderStreamingText(`### ${title}\n\n\`\`\`text\n${cached}\n\`\`\``, `cache-${title}`);
    assert.match(html, new RegExp(`code-block-h-${expected}`));
  }
  for (const language of ['prompt', 'image-prompt', 'video-prompt']) {
    const markdown = `\`\`\`${language}\n${cached}\n\`\`\``;
    for (const html of [renderMarkdown(markdown), renderStreamingText(markdown, `alias-${language}`)]) {
      assert.match(html, /code-block-plaintext code-block-h-sm|code-block-h-sm code-block-plaintext/u);
      assert.match(html, new RegExp(`data-code-purpose="${language === 'prompt' ? 'generic-prompt' : language}"`));
    }
  }
  for (const [label, body, expected] of [['第1段', '视频提示词：镜头和动作保持连续。', 'video-prompt'], ['第1段', '普通提示词内容。', 'generic-prompt']] as const) {
    const markdown = `### ${label}\n\n\`\`\`${expected === 'generic-prompt' ? 'prompt' : 'text'}\n${body}\n\`\`\``;
    for (const html of [renderMarkdown(markdown), renderStreamingText(markdown, `purpose-${expected}`)]) assert.match(html, new RegExp(`data-code-purpose="${expected}"`));
  }
  const copyContainer = renderMarkdown(':::article 文档\n\n```js\nconst literal = "<tag>";\n```\n\n:::');
  assert.match(copyContainer, /copyable-inner-pre/u);
  assert.doesNotMatch(copyContainer, /code-block-wrapper/u, 'DOCUMENT_CONTAINER_MUST_NOT_NEST_A_SECOND_CARD');
} finally { await browser.close(); }
console.log(JSON.stringify({ passed: true, productionFinalCallback: true, literalUserRendering: true, safeEscaping: true,
  cases, blockedRequests, networkCalls: 0, databaseWrites: 0, providerCalls: 0 }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
