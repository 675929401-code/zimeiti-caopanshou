import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { parseStructuredAgentOutput, type StructuredAgentOutputResult } from "../src/lib/structured-agent-output";
import { clearStreamingCache, renderStreamingText } from "../src/lib/markdown-renderer";

const sourcePath = "src/components/chat/message-content.tsx";
const source = readFileSync(sourcePath, "utf8");
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const all: ts.Node[] = []; const visit = (node: ts.Node) => { all.push(node); ts.forEachChild(node, visit); }; visit(ast);
function declaration(name: string) { const node = all.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name); assert.ok(node, name); return node.getText(ast); }
function variable(name: string) { const node = all.find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name) as ts.VariableDeclaration; assert.ok(node?.initializer, name); return node.initializer!.getText(ast); }
function evaluate<T>(code: string, context: Record<string, unknown>): T {
  return vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { ...context, exports: {} }) as T;
}
const hidePending = evaluate<(text: string) => string>(`${declaration("hideStoryboardStreamingTransport")}\nhideStoryboardStreamingTransport;`, {});
const caret = evaluate<(html: string, id: string) => string>(`${declaration("appendStreamingCaret")}\nappendStreamingCaret;`, {});
const streamingBranch = all.find(node => ts.isIfStatement(node) && node.expression.getText(ast) === "isStreaming" && node.getText(ast).includes("renderStreamingText(streamingText, streamingRenderKey)"));
assert.ok(streamingBranch);
const streamingBranchSource = streamingBranch.getText(ast);
const publishEffect = all.find(node => ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("publishStructuredAgentOutputOnce")) as ts.CallExpression;
assert.ok(publishEffect);
function frame(text: string, key: string, options: { isUser?: boolean; isStreaming?: boolean; fallback?: boolean } = {}) {
  const context: Record<string, unknown> = {
    isUser: options.isUser === true, isStreaming: options.isStreaming !== false, processedText: text,
    parseStructuredAgentOutput, hideStoryboardStreamingTransport: hidePending,
    useMemo: (run: () => unknown) => run(), streamingRenderKey: key, streamingCaretId: `caret-${key}`, appendStreamingCaret: caret,
    renderStreamingText: options.fallback ? () => { throw new Error("SIMULATED_RENDER_FAILURE"); } : renderStreamingText,
  };
  const result = evaluate<StructuredAgentOutputResult>(`(${variable("structuredResult")});`, context);
  context.structuredResult = result;
  const visible = evaluate<string>(`(${variable("streamingText")});`, context); context.streamingText = visible;
  const html = evaluate<string>(`let streamingHtml = '';\n${streamingBranchSource}\nstreamingHtml;`, context);
  return { result, visible, html };
}
const checks: string[] = [];
function check(name: string, run: () => void) { run(); checks.push(name); }
const body = "本轮识别：普通模式。\n\n### 图生视频Prompt\n\n```text\n可见的角色动作与停留。\n```";
const markers = ["output", "assets", "plan"];
let networkRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { networkRequests++; throw new Error("NETWORK_FORBIDDEN"); }) as typeof fetch;
try {
  check("actual streaming branch hides each transport throughout one-character chunks, newlines and closure", () => {
    for (const kind of markers) {
      const key = `character-${kind}`;
      const transport = `<!-- \n storyboard_director_${kind}:v1\n{\"schema_version\":\"storyboard_director_${kind}.v1\",\"private_transport\":\"MACHINE_ONLY\"}\n-->`;
      for (let end = 1; end <= transport.length; end++) {
        const view = frame(`${body}\n\n${transport.slice(0, end)}`, key);
        assert.equal(view.visible.trim(), body); assert.ok(!view.html.includes("storyboard_director_")); assert.ok(!view.html.includes("MACHINE_ONLY")); assert.ok(!view.html.includes("&lt;!"));
      }
      assert.equal(frame(`${body}\n\n${transport}\n正常后续正文`, key).visible, `${body}\n\n\n正常后续正文`);
      clearStreamingCache(key);
    }
  });
  check("pending leading prefixes stay empty but disambiguated Chinese, math and ordinary comments recover unchanged", () => {
    for (const prefix of ["<", "<!", "<!-", "<!--", "<!--\n  ", "<!-- storyboard_director_p", "<!-- STORYBOARD_DIRECTOR_ASSETS:"]) {
      assert.equal(frame(prefix, "pending-prefix").visible, "");
    }
    for (const normal of ["普通中文继续显示。", "<普通中文继续显示。", "比较：甲 < 乙。", "<!-- 普通中文注释", "<!-- storybook is ordinary text", "正文后接<中文"]) {
      assert.equal(frame(normal, "normal-recovery").visible, normal);
    }
    clearStreamingCache("pending-prefix"); clearStreamingCache("normal-recovery");
  });
  check("a closed first package never exposes a second or repeated transport as its chunks arrive", () => {
    const first = "<!-- storyboard_director_output:v1 {} -->";
    for (const kind of markers) for (const fallback of [false, true]) {
      const second = `<!-- storyboard_director_${kind}:v1\n{\"secret\":\"MACHINE_ONLY\"} -->`;
      const key = `repeated-${kind}-${fallback}`;
      for (let end = 1; end <= second.length; end++) {
        const view = frame(`${body}\n${first}\n${second.slice(0, end)}`, key, { fallback });
        assert.equal(view.visible.trim(), body); assert.ok(!view.html.includes("storyboard_director_")); assert.ok(!view.html.includes("MACHINE_ONLY"));
      }
      const view = frame(`${body}\n${first}\n${second}\n保留后续中文`, key, { fallback });
      assert.ok(view.visible.includes("保留后续中文")); assert.ok(!view.visible.includes("storyboard_director_")); clearStreamingCache(key);
    }
  });
  check("actual renderer fallback uses the same filtered visible text for all three transports", () => {
    for (const kind of markers) {
      const view = frame(`${body}\n\n<!-- storyboard_director_${kind}:v1\n{\"machine_only\":true}`, `fallback-${kind}`, { fallback: true });
      assert.equal(view.visible, body); assert.ok(view.html.includes("可见的角色动作与停留。")); assert.ok(!view.html.includes("storyboard_director_")); assert.ok(!view.html.includes("machine_only"));
    }
    const prefix = frame("可见中文\n<!-- story", "fallback-prefix", { fallback: true }); assert.equal(prefix.visible, "可见中文"); assert.ok(!prefix.html.includes("&lt;!--"));
  });
  check("user messages bypass both parser hiding and prefix holding in the existing source memo", () => {
    const text = "用户引用原字\n<!-- storyboard_director_output:v1\n{\"quoted\":true}";
    for (const fallback of [false, true]) {
      const view = frame(text, `user-${fallback}`, { isUser: true, fallback });
      assert.equal(view.result.status, "none"); assert.equal(view.visible, text); assert.ok(view.html.includes("storyboard_director_output")); clearStreamingCache(`user-${fallback}`);
    }
    assert.equal(frame("<", "user-prefix", { isUser: true }).visible, "<"); clearStreamingCache("user-prefix");
  });
  check("interleaved message keys preserve their own visible prompts without persisting or modifying raw transport", () => {
    const first = `${body}\n\n<!-- storyboard_director_output:v1\n{\"source\":\"A\"}`;
    const second = "另一个会话的可见文本。\n\n<!-- storyboard_director_plan:v1\n{\"source\":\"B\"}";
    const original = [first, second];
    assert.equal(frame(first, "isolated-A").visible, body);
    assert.equal(frame(second, "isolated-B").visible, "另一个会话的可见文本。");
    assert.equal(frame(first + " -->", "isolated-A").visible, body);
    assert.equal(frame(second + " -->", "isolated-B").visible, "另一个会话的可见文本。");
    assert.deepEqual([first, second], original); clearStreamingCache("isolated-A"); clearStreamingCache("isolated-B");
  });
  check("a complete valid package stays uncommitted during streaming and retains the existing final parse", () => {
    const fixture = JSON.parse(readFileSync(".codex-evidence/director-refinement-20261023/narrative-followup/prompt-ordinary-example.json", "utf8"));
    const raw = `${body}\n\n<!-- storyboard_director_output:v1 ${JSON.stringify(fixture)} -->`;
    const streaming = frame(raw, "complete-still-streaming"); assert.equal(streaming.result.status, "incomplete"); assert.equal(streaming.visible, body);
    const finalized = frame(raw, "complete-finalized", { isStreaming: false }); assert.equal(finalized.result.status, "valid");
    const finalResult = parseStructuredAgentOutput(raw, true); assert.equal(JSON.stringify(finalized.result), JSON.stringify(finalResult));
    let publications = 0;
    evaluate<() => void>(`(${publishEffect.arguments[0].getText(ast)});`, {
      messageId: "still-streaming", isUser: false, isStreaming: true, structuredResult: finalResult,
      publishStructuredAgentOutputOnce: () => { publications++; },
    })();
    assert.equal(publications, 0); clearStreamingCache("complete-still-streaming");
  });
  check("stably visible code blocks stay intact while only the machine suffix grows", () => {
    const key = "stable-visible-code"; const initial = frame(body, key);
    for (const suffix of ["\n\n<", "\n\n<!-- storyboard_director_output:", "\n\n<!-- storyboard_director_output:v1\n{\"long\":\"" + "X".repeat(6000)]) {
      const view = frame(body + suffix, key); assert.equal(view.visible, body); assert.equal(view.html, initial.html);
    }
    clearStreamingCache(key);
  });
  assert.equal(networkRequests, 0);
} finally { globalThis.fetch = originalFetch; }
const report = { status: "PASS", checks, count: checks.length, networkRequests,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  testSha256: createHash("sha256").update(readFileSync("scripts/verify-storyboard-stream-transport-visibility.ts")).digest("hex"),
  limitation: "Actual source memo/stream/fallback replay and production parsers/renderers only; root owns real UI and runtime validation." };
mkdirSync(".codex-evidence/narrative-refinement-20261023", { recursive: true });
writeFileSync(".codex-evidence/narrative-refinement-20261023/stream-transport-visibility-result.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
