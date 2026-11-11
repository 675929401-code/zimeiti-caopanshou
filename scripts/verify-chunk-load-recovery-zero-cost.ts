import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeatureErrorBoundary } from "../src/components/feature-error-boundary";
import { isChunkLoadError } from "../src/lib/chunk-load-error";

const chunkErrors = [
  Object.assign(new Error("Resource unavailable"), { name: "ChunkLoadError" }),
  new Error("Loading chunk 83520 failed.\n(error: /_next/static/chunks/83520.js)"),
  new Error("Loading CSS chunk 868 failed.\n(/_next/static/css/868.css)"),
  new TypeError("Failed to fetch dynamically imported module: https://example.invalid/module.js"),
  new TypeError("error loading dynamically imported module: https://example.invalid/module.js"),
  new TypeError("Importing a module script failed."),
];
const ordinaryErrors = [
  new Error("Unexpected render failure"),
  new TypeError("Cannot read properties of undefined (reading 'title')"),
  new TypeError("Failed to fetch"),
  new Error("NetworkError when attempting to fetch resource."),
  new Error("Loading data failed"),
  new Error("Could not process text: Loading chunk 83520 failed."),
];
for (const error of chunkErrors) assert.equal(isChunkLoadError(error), true, error.message);
for (const error of ordinaryErrors) assert.equal(isChunkLoadError(error), false, error.message);
for (const error of [null, undefined, "Loading chunk 83520 failed.", {}, { message: 123 }]) {
  assert.equal(isChunkLoadError(error), false);
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
let reloadCount = 0;
let localRetryCount = 0;
let networkRequests = 0;
let storageWrites = 0;
function rejectStorageWrite() {
  storageWrites += 1;
  throw new Error("Recovery must not modify stored user data");
}
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    location: { reload: () => { reloadCount += 1; } },
    localStorage: {
      setItem: rejectStorageWrite,
      removeItem: rejectStorageWrite,
      clear: rejectStorageWrite,
    },
  },
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: () => {
    networkRequests += 1;
    throw new Error("Zero-cost recovery test must not make network requests");
  },
});

function makeBoundary(error: Error, customFallback = false) {
  let customRetry: (() => void) | undefined;
  const boundary = new FeatureErrorBoundary({
    moduleName: "测试模块",
    children: createElement("div", null, "recovered"),
    fallback: customFallback
      ? (props) => {
        assert.equal(props.error, error);
        customRetry = props.onRetry;
        return createElement("button", { onClick: props.onRetry }, "自定义恢复");
      }
      : undefined,
  });
  boundary.state = FeatureErrorBoundary.getDerivedStateFromError(error);
  boundary.setState = (update) => {
    const patch = typeof update === "function" ? update(boundary.state, boundary.props) : update;
    boundary.state = { ...boundary.state, ...patch };
    localRetryCount += 1;
  };
  return { boundary, getCustomRetry: () => customRetry };
}

function render(node: ReactNode) {
  return renderToStaticMarkup(createElement("div", null, node));
}

try {
  for (const error of [...chunkErrors, ...ordinaryErrors]) {
    for (const customFallback of [false, true]) {
      const { boundary, getCustomRetry } = makeBoundary(error, customFallback);
      const reloadsBefore = reloadCount;
      const retriesBefore = localRetryCount;
      const markup = render(boundary.render());
      assert.equal(reloadCount, reloadsBefore, "render must never auto-refresh");
      assert.equal(localRetryCount, retriesBefore, "render must never auto-retry");
      if (!customFallback) {
        assert.match(markup, isChunkLoadError(error) ? /刷新页面恢复/u : /重试模块/u);
        if (isChunkLoadError(error)) assert.match(markup, /请先保存其他未提交内容/u);
      }
      const retry = customFallback ? getCustomRetry() : boundary.handleRetry;
      assert.ok(retry, "custom fallback must receive its recovery callback");
      retry();
      if (isChunkLoadError(error)) {
        assert.equal(reloadCount, reloadsBefore + 1, "module-resource retry reloads once");
        assert.equal(localRetryCount, retriesBefore, "cached import must not receive local retry");
        assert.equal(boundary.state.error, error);
      } else {
        assert.equal(reloadCount, reloadsBefore, "ordinary errors must not reload");
        assert.equal(localRetryCount, retriesBefore + 1);
        assert.equal(boundary.state.error, null);
        assert.equal(boundary.state.key, 1);
        assert.match(render(boundary.render()), /recovered/u);
      }
    }
  }
} finally {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
  else Reflect.deleteProperty(globalThis, "fetch");
}

assert.equal(networkRequests, 0);
assert.equal(storageWrites, 0);
console.log(JSON.stringify({
  result: "PASS",
  detectionCases: chunkErrors.length + ordinaryErrors.length + 5,
  recoveryCases: (chunkErrors.length + ordinaryErrors.length) * 2,
  reloadCount,
  localRetryCount,
  networkRequests,
  storageWrites,
}));
