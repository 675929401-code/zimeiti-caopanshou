#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const acceptanceScripts = [
  "scripts/audit-navigation-models-readonly.ts",
  "scripts/verify-primary-navigation-zero-cost.mjs",
  "scripts/verify-core-pages-live-readonly.mjs",
  "scripts/verify-secondary-media-pages-readonly.mjs",
  "scripts/verify-youcai-navigation-live.mjs",
  "scripts/verify-youcai-navigation-zero-cost.ts",
  "scripts/diagnose-youcai-navigation.mjs",
  "scripts/verify-toolbox-draft-refresh-readonly.mjs",
  "scripts/verify-media-history-retry-readonly.mjs",
  "scripts/verify-image-workbench-live-e2e.mjs",
  "scripts/verify-video-page-chain-safety.ts",
  "scripts/verify-video-paper-history-ui.mjs",
  "scripts/verify-video-storyboard-readonly.mjs",
  "scripts/verify-storyboard-prompt-contract.mjs",
  "scripts/verify-chat-admin-model-policy.mjs",
];

for (const file of acceptanceScripts) {
  const source = await readFile(file, "utf8");
  const envIndex = source.indexOf("process.env.BASE_URL");
  const defaultIndex = source.indexOf("http://127.0.0.1:5000");
  assert.ok(envIndex >= 0, `${file} does not read BASE_URL`);
  assert.ok(defaultIndex > envIndex, `${file} must prefer BASE_URL before the default origin`);
  assert.doesNotMatch(source, /(?:goto|fetch)\(\s*["'`]http:\/\/127\.0\.0\.1:5000/gu, `${file} still targets port 5000 directly`);
}

console.log(JSON.stringify({
  verifier: "acceptance-base-url-zero-network",
  checkedScripts: acceptanceScripts.length,
  defaultBaseUrl: "http://127.0.0.1:5000",
  overrideExample: "BASE_URL=http://127.0.0.1:5002",
  networkCalls: 0,
  databaseReads: 0,
  databaseWrites: 0,
  modelCalls: 0,
}, null, 2));
