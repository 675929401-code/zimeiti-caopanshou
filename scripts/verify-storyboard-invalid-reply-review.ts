import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { buildHomepageStoryboardDraftDetail, readStoryboardIntakeSnapshotForMessage, resolveStoryboardHandoffContract } from "../src/lib/agent-workbench-handoff";
import { parseStructuredAgentOutput } from "../src/lib/structured-agent-output";
import { parseStoryboardCanvasImport } from "../src/lib/storyboard-canvas-bridge";
import { buildHistoricalStoryboardMessageDraft } from "../src/lib/storyboard-legacy-prompt-draft";
import { STORY_DIRECTOR_MOVIE_AGENT_ID, STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID } from "../src/lib/story-director-overtime-gate";

const paths = ["src/components/chat/storyboard-verified-message.tsx", "src/components/chat/message-item.tsx", "scripts/verify-storyboard-invalid-reply-review.ts"];
const source = readFileSync(paths[0], "utf8");
const itemSource = readFileSync(paths[1], "utf8");
const ast = ts.createSourceFile(paths[0], source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const itemAst = ts.createSourceFile(paths[1], itemSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes(tree: ts.SourceFile, predicate: (node: ts.Node) => boolean) {
  const found: ts.Node[] = []; const visit = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }; visit(tree); return found;
}
function declaration(name: string) { const node = nodes(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === name)[0]; assert.ok(node, name); return node.getText(ast); }
function evaluate<T>(code: string, context: Record<string, unknown>): T {
  return vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { ...context, exports: {}, require: (name: string) => { assert.equal(name, "react/jsx-runtime"); return jsxRuntime; } }) as T;
}
type Review = { content: string; errors: string[] };
type HookResult = { review: Review | null; readCurrentReview: () => Review | null; detail: unknown; preview: unknown; applies: boolean; visibleText?: string };
const copyText = evaluate<(review: Review) => string>(`${declaration("storyboardReplyReviewCopyText")}\nstoryboardReplyReviewCopyText;`, {});
const prompt = readFileSync("prompts/storyboard-narrative-unified-20261023.md", "utf8");
const packageFixture = JSON.parse(prompt.match(/^<!-- storyboard_director_output:v1 ([\s\S]*?) -->/m)![1]);
const wire = (value: unknown) => `模型正文与格式\n\n<!-- storyboard_director_output:v1 ${JSON.stringify(value)} -->`;
const card = Object.entries(packageFixture.input).filter(([key]) => !["schema_version", "director_mode"].includes(key)).map(([key, value]) => `${key}: ${value}`).join("\n");
const flags = { director_mode: "cinematic", production_contract_version: "storyboard_director_contract.v2", production_contract_activated_at: "2026-10-23T01:00:00Z", performance_contract: "storyboard_performance.v1", performance_contract_activated_at: "2026-10-23T01:00:00Z" };
const checks: string[] = [];
async function check(name: string, run: () => void | Promise<void>) { await run(); checks.push(name); }
function fixture(content: string) {
  const message = { id: "reply-A", role: "assistant" as const, content, isStreaming: false, timestamp: Date.parse("2026-10-23T03:00:01Z") };
  let state = { auth: { isAuthenticated: true, user: { id: "account-A" }, token: "token-A" }, activeConversationId: "conversation-A",
    conversations: [{ id: "conversation-A", agentId: STORY_DIRECTOR_MOVIE_AGENT_ID, messages: [{ id: "card-A", role: "user" as const, content: card, timestamp: Date.parse("2026-10-23T03:00:00Z"), isStreaming: false }, message] }],
    agents: [{ id: STORY_DIRECTOR_MOVIE_AGENT_ID, outputStyle: flags }] };
  let identity = { userId: "account-A", token: "token-A" };
  const refs: Array<{ current: unknown }> = []; let refIndex = 0;
  const parsedCalls: ReturnType<typeof parseStructuredAgentOutput>[] = [];
  const hook = evaluate<(row: typeof message, conversationId?: string, ownerUserId?: string) => HookResult>(`${declaration("useVerifiedStoryboardMessage")}\nuseVerifiedStoryboardMessage;`, {
    useApp: () => ({ state }), useRef: (value: unknown) => refs[refIndex++] ||= { current: value }, useMemo: (run: () => unknown) => run(), useState: () => [null, () => {}], useEffect: () => {},
    readStoryboardIntakeSnapshotForMessage, resolveStoryboardHandoffContract, buildHomepageStoryboardDraftDetail, parseStoryboardCanvasImport, buildHistoricalStoryboardMessageDraft,
    parseStructuredAgentOutput: (...args: Parameters<typeof parseStructuredAgentOutput>) => { const result = parseStructuredAgentOutput(...args); parsedCalls.push(result); return result; },
    readBrowserWorkbenchIdentity: () => identity, STORY_DIRECTOR_MOVIE_AGENT_ID, STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID,
  });
  const render = (owner = "account-A") => { refIndex = 0; return hook(message, "conversation-A", owner); };
  return { message, render, parsedCalls, identity: (value: typeof identity) => { identity = value; }, state: () => state, replaceState: (value: typeof state) => { state = value; } };
}
type ElementProps = { children?: ReactNode; onClick?: () => void | Promise<void>; [key: string]: unknown };
function elements(value: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const element = value as ReactElement<ElementProps>;
  return [element, ...elements(element.props.children)];
}
function reviewView(review: Review, readCurrentReview: () => Review | null, expanded = false) {
  const copied: string[] = []; const notices: string[] = []; let index = 0; let openState = expanded;
  const component = evaluate<(props: { review: Review; readCurrentReview: () => Review | null }) => ReactElement>(`${declaration("StoryboardInvalidReplyReview")}\nStoryboardInvalidReplyReview;`, {
    useState: () => index++ === 0 ? [expanded, (value: boolean) => { openState = value; }] : [false, () => {}],
    storyboardReplyReviewCopyText: copyText, copyToClipboard: async (text: string) => { copied.push(text); return true; },
    toast: { success: (text: string) => notices.push(text), error: (text: string) => notices.push(text) },
  });
  return { tree: component({ review, readCurrentReview }), copied, notices, expanded: () => openState };
}

async function main() {
  const previousFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = (() => { requests++; throw new Error("NETWORK_FORBIDDEN"); }) as typeof fetch;
  try {
    await check("real semantic validation errors are retained from the same host-aware parse and never become a handoff", () => {
      const broken = structuredClone(packageFixture); broken.segments[0].narration = "不同原文";
      const f = fixture(wire(broken)); const result = f.render();
      const parsed = f.parsedCalls[0]; assert.equal(parsed.status, "invalid"); assert.ok(parsed.status === "invalid" && parsed.errors.length);
      assert.ok(result.review); assert.equal(result.review.content, f.message.content);
      assert.equal(JSON.stringify(result.review.errors), JSON.stringify(parsed.status === "invalid" ? parsed.errors : []));
      assert.equal(result.detail, null); assert.equal(result.preview, null); assert.equal(result.applies, true);
      assert.ok(!result.visibleText?.includes("模型正文与格式")); assert.equal(f.parsedCalls.length, 1);
    });
    await check("schema failure keeps its actual reason and performance omission stays strictly blocked", () => {
      const malformed = structuredClone(packageFixture); malformed.segments[0].performance_plan = { schema_version: "invalid" };
      const schema = fixture(wire(malformed)).render(); assert.ok(schema.review?.errors[0].includes("字段缺失或类型不合法")); assert.equal(schema.detail, null);
      const missing = structuredClone(packageFixture); delete missing.segments[0].performance_plan;
      const result = fixture(wire(missing)).render(); assert.ok(result.review?.errors.some(error => error.includes("performance"))); assert.equal(result.detail, null);
    });
    await check("valid ordinary output and streaming output have no diagnostic original-copy escape", () => {
      const f = fixture(wire(packageFixture)); const valid = f.render(); assert.equal(valid.review, null); assert.ok(valid.detail); assert.equal(valid.readCurrentReview(), null);
      f.message.isStreaming = true; assert.equal(f.render().review, null);
    });
    await check("ownership, active conversation, membership and current bytes gate original review", () => {
      const f = fixture(wire({ ...packageFixture, segments: [] })); assert.ok(f.render().review);
      assert.equal(f.render("account-B").review, null);
      f.replaceState({ ...f.state(), auth: { isAuthenticated: true, user: { id: "account-B" }, token: "token-B" } });
      f.identity({ userId: "account-B", token: "token-B" }); assert.equal(f.render("account-B").review, null);
      f.replaceState({ ...f.state(), auth: { isAuthenticated: true, user: { id: "account-A" }, token: "token-A" } }); f.identity({ userId: "account-A", token: "token-A" });
      f.state().activeConversationId = "conversation-B"; assert.equal(f.render().review, null); f.state().activeConversationId = "conversation-A";
      f.state().conversations[0].messages = f.state().conversations[0].messages.filter(message => message.id !== f.message.id); assert.equal(f.render().review, null);
    });
    await check("stale review click after token rotation, account switch, deletion or replacement returns no original", () => {
      for (const mutate of [
        (f: ReturnType<typeof fixture>) => f.identity({ userId: "account-B", token: "token-B" }),
        (f: ReturnType<typeof fixture>) => f.identity({ userId: "account-A", token: "rotated-token" }),
        (f: ReturnType<typeof fixture>) => { f.state().conversations[0].messages = []; },
        (f: ReturnType<typeof fixture>) => { f.state().conversations[0].messages = [{ ...f.message, content: "new reply" }]; },
        (f: ReturnType<typeof fixture>) => { f.replaceState({ ...f.state(), auth: { isAuthenticated: true, user: { id: "account-B" }, token: "token-B" } }); f.render(); },
      ]) {
        const f = fixture(wire({ ...packageFixture, segments: [] })); const previous = f.render(); assert.ok(previous.readCurrentReview()); mutate(f); assert.equal(previous.readCurrentReview(), null);
      }
    });
    await check("original is mounted only after manual expansion and rendered as escaped plain text", async () => {
      const review = { content: '<img src="https://private.invalid/x" onerror="alert(1)">\n<!-- machine marker -->\n**原文**', errors: ["segment_001:source_narration_mismatch", "第二条原因"] };
      const collapsed = reviewView(review, () => review); const collapsedHtml = renderToStaticMarkup(collapsed.tree);
      assert.ok(collapsedHtml.includes(review.errors[0]) && collapsedHtml.includes(review.errors[1])); assert.ok(!collapsedHtml.includes("private.invalid"));
      const buttons = elements(collapsed.tree).filter(element => element.type === "button"); await buttons[0].props.onClick?.(); assert.equal(collapsed.expanded(), true);
      const html = renderToStaticMarkup(reviewView(review, () => review, true).tree); assert.ok(html.includes("&lt;img")); assert.ok(html.includes("&lt;!-- machine marker --&gt;")); assert.ok(!html.includes('<img src="https://private.invalid'));
    });
    await check("explicit original-copy includes a rejection label and exact current message, without adjacent or reasoning data", async () => {
      const review = { content: "  :::copy\n**正文**\n```json\n{\"original\":true}\n```\n:::  ", errors: ["exact_validation_code"] };
      const view = reviewView(review, () => review); const buttons = elements(view.tree).filter(element => element.type === "button"); await buttons[1].props.onClick?.();
      assert.equal(view.copied.length, 1); assert.ok(view.copied[0].startsWith("【未通过校验")); assert.ok(view.copied[0].endsWith(review.content)); assert.ok(view.copied[0].includes(review.errors[0]));
      const denied = reviewView(review, () => null); const deniedButtons = elements(denied.tree).filter(element => element.type === "button"); await deniedButtons[0].props.onClick?.(); await deniedButtons[1].props.onClick?.();
      assert.equal(denied.expanded(), false); assert.equal(denied.copied.length, 0);
    });
    await check("the existing Markdown button copies labelled current raw reply and bypasses format stripping only for invalid review", async () => {
      const node = nodes(itemAst, node => ts.isVariableDeclaration(node) && node.name.getText(itemAst) === "handleCopyMarkdown")[0] as ts.VariableDeclaration;
      const copied: string[] = []; const review = { content: ":::copy\n**RAW**\n:::<!-- hidden original -->", errors: ["validation_failed"] };
      const execute = (current: Review | null, enabled = true) => evaluate<() => Promise<void>>(`(${node.initializer!.getText(itemAst)});`, {
        verifiedStoryboard: { review: enabled ? review : null, readCurrentReview: () => current }, storyboardReplyReviewCopyText: copyText,
        visibleText: "**NORMAL**", copyToClipboard: async (text: string) => { copied.push(text); return true; },
        setCopied() {}, setTimeout() {}, toast: { success() {}, error() {} },
      })();
      await execute(review); assert.equal(copied[0], copyText(review)); await execute(null); assert.equal(copied.length, 1);
      await execute(null, false); assert.equal(copied[1], "**NORMAL**");
    });
    await check("generic push remains blocked before any fallback, and the director handoff retains its existing null-detail guard", () => {
      const handler = nodes(itemAst, node => ts.isJsxAttribute(node) && node.name.getText(itemAst) === "onClick" && Boolean(node.initializer?.getText(itemAst).includes("verifiedStoryboard.applies && !verifiedStoryboard.detail")))[0] as ts.JsxAttribute;
      const expression = (handler.initializer as ts.JsxExpression).expression!;
      let dispatches = 0;
      evaluate<() => void>(`(${expression.getText(itemAst)});`, { verifiedStoryboard: { applies: true, detail: null }, toast: { error() {} }, dispatchVideoTaskTransfer: () => { dispatches++; throw new Error("FORBIDDEN_PUSH"); } })();
      assert.equal(dispatches, 0);
      const handoff = readFileSync("src/components/chat/structured-storyboard-handoff.tsx", "utf8");
      assert.ok(handoff.includes("busyRef.current || unavailable || !detail")); assert.ok(handoff.includes("disabled={Boolean(unavailable)}"));
      assert.ok(!source.includes("dangerouslySetInnerHTML")); assert.ok(!source.includes("publishStructuredAgentOutput"));
    });
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previousFetch; }
  const evidence = { status: "PASS", checks, count: checks.length, networkRequests: 0, files: Object.fromEntries(paths.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])), limitation: "Offline production-parser and actual source callback/component checks; runtime and desktop review belong to the root owner." };
  mkdirSync(".codex-evidence/narrative-refinement-20261023", { recursive: true });
  writeFileSync(".codex-evidence/narrative-refinement-20261023/invalid-reply-review-result.json", JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
