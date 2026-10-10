#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

const targetFiles = [
  "src/components/chat-view.tsx",
  "src/components/sub-page-header.tsx",
  "src/components/cover-studio.tsx",
  "src/components/vs/Header.tsx",
];

const [sidebar, switcher, ...targets] = await Promise.all([
  read("src/components/app-sidebar.tsx"),
  read("src/components/user-theme-switcher.tsx"),
  ...targetFiles.map(read),
]);

assert.match(sidebar, /<UserThemeSwitcher\s+menuSide="top"\s*\/>/u,
  "左下侧栏必须保留唯一的工作台主题入口");
assert.match(switcher, /data-theme-switcher-trigger="true"/u,
  "主题切换系统本身不得删除");

for (let index = 0; index < targetFiles.length; index += 1) {
  const source = targets[index];
  const relativePath = targetFiles[index];
  assert.doesNotMatch(source, /from ["']@\/components\/user-theme-switcher["']/u,
    `${relativePath}: 页头不得导入主题入口`);
  assert.doesNotMatch(source, /<UserThemeSwitcher\b/u,
    `${relativePath}: 页头不得渲染重复主题入口`);
}

console.log(JSON.stringify({
  status: "PASS",
  retainedEntry: "src/components/app-sidebar.tsx",
  removedDuplicateSurfaces: targetFiles,
  runtimeAssertion: "verify-main-theme-suite-readonly-live.mjs checks one left-sidebar trigger on marketplace and no duplicate trigger on /tools or /video",
}, null, 2));
