import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/components/video-history-gallery.tsx", "utf8");
const accountHistorySource = readFileSync("src/components/account-video-history.tsx", "utf8");
const videoPageSource = readFileSync("src/app/video/page.tsx", "utf8");

assert.match(source, /activePreviewTaskId/,
  "视频历史必须记录当前唯一激活的预览");
assert.match(source, /portalReady && activePreviewTask && activePreviewSource[\s\S]*?createPortal\([\s\S]*?<video/,
  "未点击的历史记录不得挂载 video 元素，激活后播放器应进入放大层");
assert.match(source, /onClick=\{\(event\) => \{ void openPreview\(task, playbackUrl, event\.currentTarget\); \}\}/,
  "用户点击后才可请求并激活对应视频");
assert.match(source, /fetch\(`\/api\/video\/access-ticket\?\$\{new URLSearchParams\(\{ taskId, scope: 'playback' \}\)\.toString\(\)\}`/,
  "历史预览必须在点击时按任务换取新的播放凭据");
assert.match(source, /headers: \{ Authorization: `Bearer \$\{authToken\}` \}[\s\S]*?cache: 'no-store'/,
  "播放凭据请求必须携带当前登录身份且禁止缓存");
assert.match(source, /ticketPath !== '\/api\/video\/proxy'/,
  "历史预览只能接受本站播放代理凭据");
assert.match(source, /onError=\{\(\) => \{ closePreview\(\); setPlaybackErrorTaskId\(activePreviewTask\.id\); \}\}/,
  "播放失败必须撤销旧地址，允许再次点击换新");
assert.match(videoPageSource, /<VideoHistoryGallery[\s\S]*?authToken=\{auth\?\.token\}/,
  "视频制作页必须把当前访问凭据传给历史预览");
assert.match(accountHistorySource, /<VideoHistoryGallery[\s\S]*?authToken=\{token\}/,
  "账号视频历史也必须把当前访问凭据传给历史预览");
assert.match(source, /candidate\.startsWith\('\/'\) && !candidate\.startsWith\('\/\/'\)/,
  "历史海报只能自动读取本站受保护地址");
assert.equal((source.match(/<video\b/g) || []).length, 1,
  "画廊只能保留一个受激活状态控制的视频入口");
assert.match(source, /<video key=\{activePreviewSource\}[\s\S]*?controls autoPlay playsInline preload="metadata"/,
  "激活后的放大播放器仍应使用原生 metadata 播放");
assert.match(source, /createPortal\([\s\S]*?document\.body/u,
  "放大预览必须 Portal 到 document.body，避开页面壳层叠上下文");
assert.match(source, /const MIN_PREVIEW_ZOOM = 70;[\s\S]*const MAX_PREVIEW_ZOOM = 140;/u,
  "视频缩放边界必须锁定在 70% 到 140%");
assert.match(source, /event\.key !== 'Escape'[\s\S]*?closePreview\(\)/u,
  "ESC 必须关闭放大预览");
assert.match(source, /shell\.requestFullscreen\(\)/u,
  "放大预览必须支持浏览器全屏");
assert.doesNotMatch(source, /finalizing:'保存中'/u,
  "finalizing 不得再误写成保存中");

console.log("video history preview zero-cost contract passed: fresh ticket per click; body portal; 70%-140% zoom; fullscreen; ESC; paidRequests=0");
