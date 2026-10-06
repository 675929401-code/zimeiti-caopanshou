#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const componentPath = "src/components/storyboard-workbench.tsx";
const source = readFileSync(componentPath, "utf8");
const tree = ts.createSourceFile(componentPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

let effectSource = "";
function visit(node) {
  if (!effectSource
    && ts.isCallExpression(node)
    && node.expression.getText(tree) === "useEffect"
    && node.arguments[0]?.getText(tree).includes("hydratedStoredImageKeysRef")) {
    effectSource = node.arguments[0].getText(tree);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(effectSource, "stored-image re-sign effect must exist");
assert.doesNotMatch(effectSource, /!storageKey\s*\|\|\s*card\.imageUrl/u,
  "an old non-empty signed URL must not suppress storage-key re-signing");

const compiled = ts.transpileModule(`module.exports = ${effectSource};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function effectFixture({ fail = false } = {}) {
  const card = {
    id: "shot-a",
    imageStatus: "done",
    imageUrl: "https://expired.invalid/shot-a.png?expired=1",
    imageAssetId: "11111111-1111-4111-8111-111111111111",
    imageStorageKey: "images/storyboard/shot-a.png",
    imageValidatedAt: 1,
    imageRequestSnapshot: { aspectRatio: "16:9" },
  };
  const requests = [];
  const patches = [];
  const hydratingStoredImagesRef = { current: new Set() };
  const hydratedStoredImageKeysRef = { current: new Set() };
  const globals = {
    module: { exports: {} },
    exports: {},
    storageReady: true,
    token: "offline-token",
    run: { cards: [card] },
    runRef: { current: { ratio: "16:9" } },
    hydratingStoredImagesRef,
    hydratedStoredImageKeysRef,
    URLSearchParams,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      assert.equal(init.method, undefined);
      assert.equal(init.cache, "no-store");
      assert.equal(init.headers.Authorization, "Bearer offline-token");
      return fail
        ? { ok: false, json: async () => ({ error: "temporary signing failure" }) }
        : { ok: true, json: async () => ({ url: "https://fresh.invalid/shot-a.png?expires=900" }) };
    },
    browserImageReady: async () => ({ width: 1920, height: 1080 }),
    imageDimensionsMatchAspectRatio: () => true,
    patchCard: (cardId, patch) => {
      assert.equal(cardId, card.id);
      Object.assign(card, patch);
      patches.push(patch);
    },
  };
  vm.runInNewContext(compiled, globals, { filename: componentPath });
  return { effect: globals.module.exports, card, requests, patches, hydratedStoredImageKeysRef };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

const success = effectFixture();
success.effect();
await settle();
assert.equal(success.requests.length, 1, "expired URL must trigger exactly one storage-key re-sign request");
assert.match(success.requests[0].url, /^\/api\/storyboard\/image\?/u);
assert.match(success.requests[0].url, /storageKey=images%2Fstoryboard%2Fshot-a\.png/u);
assert.match(success.requests[0].url, /assetId=11111111-1111-4111-8111-111111111111/u);
assert.equal(success.card.imageUrl, "https://fresh.invalid/shot-a.png?expires=900");
assert.equal(success.card.imageStatus, "done");
assert.ok(success.card.imageValidatedAt > 1);
assert.equal(success.hydratedStoredImageKeysRef.current.size, 1);

success.effect();
await settle();
assert.equal(success.requests.length, 1, "the same mounted storage key must not be re-signed twice");

const failure = effectFixture({ fail: true });
failure.effect();
await settle();
assert.equal(failure.requests.length, 1);
assert.equal(failure.card.imageStatus, "running");
assert.equal(failure.card.imageUrl, undefined);
assert.equal(failure.card.imageRecoveryReady, true);
assert.equal(failure.card.imageRetryBlocked, false);
assert.equal(failure.hydratedStoredImageKeysRef.current.size, 0,
  "failed signing must remain eligible for a later retry or remount");
assert.equal(failure.requests.some(request => request.url.includes("/api/image/generate")), false);

console.log(JSON.stringify({
  passed: true,
  cases: ["expired-url-resigned", "single-flight-per-mount", "failure-remains-retryable"],
  providerRequests: 0,
  generationRequests: 0,
  databaseWrites: 0,
}));
