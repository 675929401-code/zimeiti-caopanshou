#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFile(path.resolve(root, relativePath), "utf8");

const [page, component, css, authBoundary] = await Promise.all([
  read("src/app/demo/popup-styles/page.tsx"),
  read("src/components/demo/popup-style-lab.tsx"),
  read("src/components/demo/popup-style-lab.module.css"),
  read("src/lib/auth-route-boundary.ts"),
]);

assert.match(authBoundary, /"\/demo\/popup-styles"/u, "Demo 路由必须允许匿名本地访问");
assert.match(page, /host !== "127\.0\.0\.1".*host !== "localhost".*host !== "\[::1\]"/su, "Demo 页面必须限制在本机主机名");

const styleIds = [...component.matchAll(/\bid: "(ivory|mist|sand|editorial|coral)"/gu)].map((match) => match[1]);
assert.deepEqual(styleIds, ["ivory", "mist", "sand", "editorial", "coral"], "必须提供五套且顺序稳定的风格");
const previewKinds = [...component.matchAll(/data-popup-preview="(compact|reader)"/gu)].map((match) => match[1]);
assert.deepEqual(previewKinds, ["compact", "reader"], "每套风格必须同时提供紧凑卡与阅读窗");
assert.equal(styleIds.length * previewKinds.length, 10, "页面必须形成十个实物预览");
const messageIds = [...component.matchAll(/\bid: "(growth-gift|task-reward|monthly-bonus)"/gu)].map((match) => match[1]);
assert.deepEqual(messageIds, ["growth-gift", "task-reward", "monthly-bonus"], "每套大阅读窗必须提供三条稳定消息");

const toneClasses = ["toneIvory", "toneMist", "toneSand", "toneEditorial", "toneCoral"];
const hexToRgb = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};
const luminance = (hex) => {
  const values = hexToRgb(hex).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
};
const contrast = (left, right) => {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
};

const contrastRatios = {};
for (const className of toneClasses) {
  const block = css.match(new RegExp(`\\.${className}\\s*\\{([\\s\\S]*?)\\n\\}`, "u"))?.[1] || "";
  const surface = block.match(/--popup-surface:\s*(#[0-9a-f]{6})/iu)?.[1];
  const ink = block.match(/--popup-ink:\s*(#[0-9a-f]{6})/iu)?.[1];
  assert.ok(surface && ink, `${className} 缺少实色正文对比变量`);
  const ratio = contrast(surface, ink);
  contrastRatios[className] = Number(ratio.toFixed(2));
  assert.ok(ratio >= 7, `${className} 正文对比度不足 7:1，当前 ${ratio.toFixed(2)}:1`);
}

assert.match(css, /\.lead\s*\{[^}]*font-size:\s*17px[^}]*line-height:\s*1\.75/su, "导语正文必须为 17px 且行高 1.75");
assert.match(css, /\.noticeSection p\s*\{[^}]*font-size:\s*17px[^}]*line-height:\s*1\.75/su, "长文正文必须为 17px 且行高 1.75");
assert.match(css, /\.popupBody\s*\{[^}]*overflow-y:\s*auto/su, "大阅读窗必须具备独立纵向滚动区");
assert.match(component, /const READER_MESSAGES = \[/u, "大阅读窗必须使用多消息数据源");
assert.match(component, /data-reader-page-indicator/u, "大阅读窗必须显示消息页码");
assert.match(component, /data-reader-unread-count/u, "大阅读窗必须显示未读消息数");
assert.match(component, /data-reader-action="previous"/u, "大阅读窗必须提供上一条操作");
assert.match(component, /data-reader-action="next"/u, "大阅读窗必须提供下一条操作");
assert.match(component, /data-reader-action="acknowledge"/u, "大阅读窗必须提供知道了操作");
assert.match(component, /小卡 · 在线轻提醒/u, "必须明确小卡用于在线轻提醒");
assert.match(component, /大窗 · 登录积压 \/ 详情/u, "必须明确大窗用于登录积压与详情");
assert.match(component, /data-ambient-decoration/u, "越界氛围装饰必须具备独立标识");
assert.match(component, /window\.localStorage\.setItem\(STORAGE_KEY, id\)/u, "选择只能保存在浏览器 localStorage");
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u, "必须尊重减少动态效果偏好");
assert.match(css, /:focus-visible/u, "键盘操作必须具备清晰焦点态");

const executableSource = `${page}\n${component}`;
assert.doesNotMatch(executableSource, /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|["'`]\/api\//u, "Demo 不得包含网络或 API 调用");

process.stdout.write(`${JSON.stringify({
  ok: true,
  route: "/demo/popup-styles",
  styles: styleIds.length,
  previews: styleIds.length * previewKinds.length,
  messagesPerReader: messageIds.length,
  contrastRatios,
  bodyFontSize: "17px",
  scrollRegion: true,
  messagePagination: true,
  networkCalls: 0,
  databaseWrites: 0,
  billingCalls: 0,
}, null, 2)}\n`);
