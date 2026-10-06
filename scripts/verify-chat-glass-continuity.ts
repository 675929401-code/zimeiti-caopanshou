import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const css = fs.readFileSync(path.join(root, "src/app/chat-glass-continuity.css"), "utf8");
const softWhiteCss = fs.readFileSync(path.join(root, "src/app/theme-soft-white.css"), "utf8");
const view = fs.readFileSync(path.join(root, "src/components/chat-view.tsx"), "utf8");
const messageItem = fs.readFileSync(path.join(root, "src/components/chat/message-item.tsx"), "utf8");
const layout = fs.readFileSync(path.join(root, "src/app/layout.tsx"), "utf8");

assert.match(view, /data-chat-surface="unified-glass"/u);
assert.match(view, /chat-stage-header/u);
assert.match(view, /var\(--chat-sheet-strong/u);
assert.doesNotMatch(view, /conic-gradient\(from 220deg/u);
assert.match(layout, /import "\.\/chat-glass-continuity\.css";/u);

for (const theme of ["soft-white", "crystal-aurora"]) {
  assert.match(css, new RegExp(`html\\[data-theme="${theme}"\\] \\[data-chat-surface="unified-glass"\\]`, "u"));
}
for (const selector of [
  ".chat-stage-header",
  ".chat-message-bubble-user",
  ".chat-message-bubble-assistant",
  ".chat-composer-rainbow",
  ".chat-input-dock",
]) {
  assert.match(css, new RegExp(selector.replaceAll(".", "\\."), "u"));
}
assert.match(css, /radial-gradient\(760px 440px at 2% -10%/u);
assert.match(css, /radial-gradient\(720px 420px at 98% -9%/u);
assert.match(css, /html\[data-theme\] \[data-chat-surface="unified-glass"\]\.chat-stage[\s\S]*?background: var\(--chat-stage\) !important/u);
assert.match(css, /html\[data-theme\] \[data-chat-surface="unified-glass"\] \.chat-canvas,[\s\S]*?\.chat-input-dock[\s\S]*?background: transparent !important/u);
assert.doesNotMatch(softWhiteCss, /circle at 7% 108%/u);
assert.ok((softWhiteCss.match(/circle at 7% -8%/gu) || []).length >= 3, "SOFT_WHITE_TOP_LEFT_FOG_REQUIRED");
assert.match(css, /background-size: 72px 72px/u);
assert.match(css, /font-family: var\(--chat-font\)/u);
assert.match(css, /line-height: 1\.76/u);
assert.match(css, /\.chat-message-row-assistant/u);
assert.match(css, /Messages stay frameless/u);
assert.match(css, /\.chat-shared-rail[\s\S]*?width: calc\(100% - 48px\) !important/u);
assert.match(css, /\.chat-shared-rail\.max-w-6xl \{ max-width: 72rem !important; \}/u);
assert.match(css, /\.chat-content-rail[\s\S]*?width: calc\(100% - 96px\) !important/u);
assert.match(css, /\.chat-content-rail\.max-w-6xl \{ max-width: 68rem !important; \}/u);
assert.match(css, /\.chat-message-bubble-assistant \.markdown-body :where\([\s\S]*?\.render-layer-final[\s\S]*?\.render-layer-streaming[\s\S]*?\) > :where\([\s\S]*?max-width: 55rem;/u);
assert.match(css, /\.chat-message-bubble-user\.chat-message-bubble-user[\s\S]*?max-width: min\(78%, 55rem\) !important/u);
assert.match(view, /useState\(18\); \/\/ 12-22px, larger Chinese reading baseline/u);
assert.match(messageItem, /data-message-role=\{isUser \? "user" : "assistant"\}/u);
assert.match(messageItem, /data-testid="chat-message-role-label"/u);
assert.doesNotMatch(messageItem, /chat-message-identity-user/u);
assert.doesNotMatch(messageItem, /<span>你<\/span>/u);
assert.match(messageItem, /aria-label=\{isUser \? "你的消息"/u);
assert.match(messageItem, /resolveAgentAvatarUrl\(message\.agentId \|\| primaryAgentId, message\.agentName, message\.agentIconUrl\)/u);
assert.match(messageItem, /data-testid="chat-message-status"/u);
assert.match(messageItem, /结果待确认，请勿重复发送/u);
assert.match(messageItem, />\s*重新发送\s*</u);
assert.match(view, /!isChatOutcomeUnknown\(msg\)/u);
assert.match(css, /\.chat-message-bubble-assistant\.chat-message-bubble-assistant[\s\S]*?background: transparent !important;[\s\S]*?box-shadow: none !important;[\s\S]*?backdrop-filter: none !important/u);
assert.match(css, /\.chat-message-bubble-user\.chat-message-bubble-user[\s\S]*?background: transparent !important;[\s\S]*?box-shadow: none !important;[\s\S]*?backdrop-filter: none !important/u);
assert.match(css, /\.chat-canvas\.chat-scroll[\s\S]*?scrollbar-gutter: auto !important/u);
assert.match(css, /@keyframes chat-latest-wave/u);
assert.match(css, /\.chat-latest-jump\.is-streaming:hover \.chat-latest-arrow/u);
assert.match(view, /isConvStreaming\(activeConv\.id\) && "is-streaming"/u);
assert.match(css, /\.chat-latest-jump\.is-streaming \.chat-latest-dots[\s\S]*?opacity: 1/u);
assert.match(css, /\.chat-latest-jump\.is-streaming \.chat-latest-arrow[\s\S]*?opacity: 1/u);
assert.match(css, /\.chat-latest-jump \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/u);
assert.match(css, /\.chat-send-button:disabled[\s\S]*?opacity: \.54 !important/u);
assert.ok((css.match(/--chat-glass-composer:/gu) || []).length >= 3, "R598_THEME_COMPOSER_SURFACES_REQUIRED");
assert.ok((css.match(/--chat-glass-composer-shadow:/gu) || []).length >= 3, "R598_THEME_COMPOSER_SHADOWS_REQUIRED");
assert.match(css, /--chat-glass-composer: linear-gradient\(145deg, rgba\(255, 255, 255, \.80\), rgba\(247, 251, 248, \.67\)\)/u);
assert.match(css, /--chat-glass-border: rgba\(78, 126, 117, \.18\)/u);
assert.match(css, /--chat-glass-composer-shadow: 0 22px 48px -34px rgba\(52, 84, 77, \.32\), inset 0 1px 0 var\(--chat-glass-highlight\)/u);
assert.match(css, /\.chat-composer-rainbow\.chat-composer-rainbow[\s\S]*?border: 1px solid var\(--chat-glass-border\)[\s\S]*?background: var\(--chat-glass-composer\)[\s\S]*?box-shadow: var\(--chat-glass-composer-shadow\)[\s\S]*?backdrop-filter: blur\(22px\) saturate\(1\.16\)/u);
assert.match(css, /\.chat-composer-rainbow:focus-within[\s\S]*?border-color: var\(--chat-glass-border-strong\)[\s\S]*?box-shadow: var\(--chat-glass-composer-shadow\), 0 0 0 2px/u);
assert.match(css, /\.chat-composer-rail \{[\s\S]*?width: auto !important;[\s\S]*?padding-inline: 1\.25rem !important;[\s\S]*?background: transparent !important;[\s\S]*?box-shadow: none !important/u);
assert.match(css, /\.chat-input-dock \{[\s\S]*?background: transparent !important;[\s\S]*?box-shadow: none !important/u);
assert.match(css, /\.chat-latest-jump \{[\s\S]*?left: 50%;[\s\S]*?transform: translateX\(-50%\)/u);
assert.match(css, /\[data-chat-surface="unified-glass"\]::after \{[\s\S]*?mask-image: none;/u);
assert.match(css, /\.chat-input-dock::after[\s\S]*?content: none !important/u);
for (const behavior of [
  /onDragOver=\{handleDragOver\}/u,
  /onDrop=\{handleDrop\}/u,
  /multiple/u,
  /onClick=\{\(\) => fileInputRef\.current\?\.click\(\)\}/u,
  /setIsInputExpanded/u,
  /onClick=\{handleSend\}/u,
  /abortCurrentStream/u,
  /onKeyDown=\{handleKeyDown\}/u,
]) {
  assert.match(view, behavior, `CHAT_COMPOSER_BEHAVIOR_MISSING:${behavior}`);
}

process.stdout.write(`${JSON.stringify({
  passed: true,
  themes: ["lattice", "soft-white", "crystal-aurora"],
  chatSurfaceScoped: true,
  upperCornerFogOnly: true,
  lowerLeftFogRemoved: true,
  lightModeStageOpaqueToPageFog: true,
  composerRainbowRemoved: true,
  composerFunctionsPreserved: true,
  canvasDockSinglePlaneGuard: true,
  readableProseGuard: true,
  assistantRoleLabelAndAccessibleUserName: true,
  explicitRecoveryStates: true,
  networkCalls: 0,
  writes: 0,
  paidCalls: 0,
}, null, 2)}\n`);
