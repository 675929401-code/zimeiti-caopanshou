import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/components/video-history-gallery.tsx", "utf8");
const videoPageSource = readFileSync("src/app/video/page.tsx", "utf8");

assert.match(source, /activePreviewTaskId/,
  "视频历史必须记录当前唯一激活的预览");
assert.match(source, /playable && previewActive && previewSource \? <video[\s\S]*?: playable \? <button/,
  "未点击的历史记录不得挂载 video 元素");
assert.match(source, /onClick=\{\(\) => \{ void openPreview\(task, playbackUrl\); \}\}/,
  "用户点击后才可请求并激活对应视频");
assert.match(source, /fetch\(`\/api\/video\/access-ticket\?\$\{new URLSearchParams\(\{ taskId, scope: 'playback' \}\)\.toString\(\)\}`/,
  "历史预览必须在点击时按任务换取新的播放凭据");
assert.match(source, /headers: \{ Authorization: `Bearer \$\{authToken\}` \}[\s\S]*?cache: 'no-store'/,
  "播放凭据请求必须携带当前登录身份且禁止缓存");
assert.match(source, /ticketPath !== '\/api\/video\/proxy'/,
  "历史预览只能接受本站播放代理凭据");
assert.match(source, /setActivePlayback\(null\); setPlaybackErrorTaskId\(task\.id\)/,
  "播放失败必须撤销旧地址，允许再次点击换新");
assert.match(videoPageSource, /<VideoHistoryGallery[\s\S]*?authToken=\{auth\?\.token\}/,
  "视频制作页必须把当前访问凭据传给历史预览");
assert.match(source, /candidate\.startsWith\('\/'\) && !candidate\.startsWith\('\/\/'\)/,
  "历史海报只能自动读取本站受保护地址");
assert.equal((source.match(/<video\b/g) || []).length, 1,
  "画廊只能保留一个受激活状态控制的视频入口");
assert.match(source, /<video key=\{previewSource\} controls playsInline preload="metadata"/,
  "激活后的播放器仍应使用原生 metadata 播放");

console.log("video history lazy preview contract passed: fresh ticket per click; no eager video mount; one active player at a time");
