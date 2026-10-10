import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseThinkTags } from "../src/lib/think-instruction";

const root = process.cwd();
const appContext = fs.readFileSync(path.join(root, "src/contexts/app-context.tsx"), "utf8");
const messageItem = fs.readFileSync(path.join(root, "src/components/chat/message-item.tsx"), "utf8");
const messageContent = fs.readFileSync(path.join(root, "src/components/chat/message-content.tsx"), "utf8");
const chatCss = fs.readFileSync(path.join(root, "src/app/chat-glass-continuity.css"), "utf8");

function assertMonotonicVisible(source: string, expected: string) {
  let previous = "";
  for (let end = 1; end <= source.length; end += 1) {
    const visible = parseThinkTags(source.slice(0, end)).displayContent;
    assert.ok(
      visible.startsWith(previous),
      `visible answer retracted at ${end}: ${JSON.stringify(previous)} -> ${JSON.stringify(visible)}`,
    );
    assert.doesNotMatch(visible, /<thi(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?$/iu, "partial think tag leaked into public text");
    previous = visible;
  }
  assert.equal(previous, expected);
}

assertMonotonicVisible("<think🌍>私有推理</think🌍>公开正文逐字增长", "公开正文逐字增长");
assertMonotonicVisible("前言<think compatible>私有推理</think compatible>后文", "前言后文");
assertMonotonicVisible("<thinking>私有推理</thinking>最终答案", "最终答案");
assertMonotonicVisible("普通文本 <thing 不是标签", "普通文本 <thing 不是标签");

assert.match(messageItem, /\[skipEntryAnimation\] = useState\(\(\) => !isUser && !!message\.isStreaming\)/u);
assert.match(messageItem, /data-stream-entry-animation=\{skipEntryAnimation \? "off" : "on"\}/u);
assert.match(chatCss, /\.chat-message-row-assistant\[data-stream-entry-animation="off"\][\s\S]*?animation: none !important;[\s\S]*?opacity: 1 !important;[\s\S]*?transform: none !important;/u);

assert.match(messageContent, /const renderedHtml = isStreaming \? streamingHtml : finalHtml;/u);
assert.match(messageContent, /pendingMorphHtmlRef\.current = renderedHtml;/u);
assert.match(messageContent, /isStreaming \? "render-layer-streaming render-layer-streaming-typewriter" : "render-layer-final"/u);
assert.doesNotMatch(messageContent, /key="(?:streaming-content|final-content)"/u);
assert.match(messageContent, /chat-stream:\$\{messageId\}:firstPaint/u);

for (const phase of ["submittedAt", "requestStart", "firstContentDelta", "done"]) {
  assert.match(appContext, new RegExp(`markChatStreamLifecycle\\(assistantMsgId, "${phase}"|"${phase}"`, "u"));
}
assert.match(appContext, /\["submittedAt", "requestStart", "firstContentDelta", "firstPaint", "done"\]/u);
assert.match(appContext, /Observational client timing only/u);

process.stdout.write(`${JSON.stringify({
  passed: true,
  thinkChunkCases: 4,
  stableStreamingRoot: true,
  streamingRowEntranceDisabled: true,
  lifecycleMarks: ["submittedAt", "requestStart", "firstContentDelta", "firstPaint", "done"],
  networkCalls: 0,
  writes: 0,
  paidCalls: 0,
}, null, 2)}\n`);
