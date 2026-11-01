#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

const sharedSurfaceFiles = [
  "src/components/chat-view.tsx",
  "src/components/sub-page-header.tsx",
  "src/components/cover-studio.tsx",
];

const [sidebar, switcher, ...targets] = await Promise.all([
  read("src/components/app-sidebar.tsx"),
  read("src/components/user-theme-switcher.tsx"),
  ...sharedSurfaceFiles.map(read),
]);

assert.match(sidebar, /<UserThemeSwitcher\s+menuSide="top"\s*\/>/u,
  "左下侧栏必须保留唯一的工作台主题入口");
assert.match(switcher, /data-theme-switcher-trigger="true"/u,
  "主题切换系统本身不得删除");

for (let index = 0; index < sharedSurfaceFiles.length; index += 1) {
  const source = targets[index];
  const relativePath = sharedSurfaceFiles[index];
  assert.doesNotMatch(source, /from ["']@\/components\/user-theme-switcher["']/u,
    `${relativePath}: 页头不得导入主题入口`);
  assert.doesNotMatch(source, /<UserThemeSwitcher\b/u,
    `${relativePath}: 页头不得渲染重复主题入口`);
}

// Voice Studio is a protected, self-contained workbench. Its header owns the
// theme control so users can change the shared visual system without leaving
// that workbench; it is not part of the public marketplace shell.
const voiceHeader = await read("src/components/vs/Header.tsx");
assert.match(voiceHeader, /from ["']@\/components\/user-theme-switcher["']/u,
  "智音工坊页头必须保留受保护工作台主题入口");
assert.match(voiceHeader, /<UserThemeSwitcher\s*\/>/u,
  "智音工坊页头必须渲染受保护工作台主题入口");

console.log(JSON.stringify({
  status: "PASS",
  retainedEntry: "src/components/app-sidebar.tsx",
  removedDuplicateSurfaces: sharedSurfaceFiles,
  protectedWorkbenchEntries: ["src/components/vs/Header.tsx"],
  runtimeAssertion: "verify-main-theme-suite-readonly-live.mjs checks one left-sidebar trigger on marketplace and no duplicate trigger on /tools or /video; protected Voice Studio keeps its local header control",
}, null, 2));
