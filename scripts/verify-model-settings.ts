import assert from "node:assert/strict";
import { autoDetectVideoProtocol } from "../src/lib/video-protocol-detector";
import { modelEndpointError, resolveVideoDetectionDraft } from "../src/lib/model-endpoint";
import { SafeFetchError } from "../src/lib/safe-fetch";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

function nodes(tree: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); };
  visit(tree);
  return matches;
}

function evaluate<T>(expression: string, bindings: Record<string, unknown> = {}): T {
  const sandbox = { exports: {} as { subject?: T }, require: (name: string) => {
    if (name === "react/jsx-runtime") return jsxRuntime;
    throw new Error(`UNEXPECTED_DIALOG_DEPENDENCY:${name}`);
  }, ...bindings };
  runInNewContext(ts.transpileModule(`exports.subject = (${expression});`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, sandbox);
  return sandbox.exports.subject as T;
}

function actualDeclaration(tree: ts.SourceFile, name: string): ts.VariableDeclaration {
  const matches = nodes(tree, node => ts.isVariableDeclaration(node) && node.name.getText(tree) === name);
  assert.equal(matches.length, 1, `unique actual declaration ${name}`);
  return matches[0] as ts.VariableDeclaration;
}

async function verifyActualDialogConsumers() {
  const paths = ["src/components/video-model-dialog.tsx", "src/components/unified-model-dialog.tsx"];
  let headerCases = 0;
  let draftCases = 0;
  for (const file of paths) {
    const source = readFileSync(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const header = nodes(tree, node => ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === "className" && attribute.initializer
      && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression
      && attribute.initializer.expression.getText(tree).includes("px-4 py-3 flex items-center gap-3")));
    assert.equal(header.length, 1, "actual detection header");
    const confirmed = actualDeclaration(tree, "detectConfirmed").initializer!.getText(tree);
    const rejected = actualDeclaration(tree, "detectRejected").initializer!.getText(tree);
    const cases = [
      { value: { success: false, keyValid: null, modelExists: null }, state: "unknown" },
      { value: { success: false }, state: "unknown" },
      { value: { success: true }, state: "unknown" },
      { value: { success: true, keyValid: true, modelExists: null }, state: "unknown" },
      { value: { success: false, keyValid: true, modelExists: true }, state: "unknown" },
      { value: { success: false, keyValid: false, modelExists: null }, state: "rejected" },
      { value: { success: false, keyValid: true, modelExists: false }, state: "rejected" },
      { value: { success: false, keyValid: false, modelExists: false }, state: "rejected" },
      { value: { success: true, keyValid: true, modelExists: true }, state: "confirmed" },
    ];
    for (const item of cases) {
      const detectResult = { protocolType: "suggested_protocol", protocolName: "测试协议", modelName: "suggested_model", apiEndpoint: "https://suggested.example/v1", features: [], ...item.value };
      const bindings = { detectResult, liveTest: undefined, setForm: () => undefined };
      const scope = { ...bindings, detectConfirmed: evaluate<boolean>(confirmed, bindings), detectRejected: evaluate<boolean>(rejected, bindings) };
      const markup = renderToStaticMarkup(evaluate<() => React.ReactNode>(`() => (${header[0].getText(tree)})`, scope)());
      assert.equal(scope.detectConfirmed, item.state === "confirmed");
      assert.equal(scope.detectRejected, item.state === "rejected");
      assert.match(markup, item.state === "unknown" ? /配置未确认/ : item.state === "rejected" ? /配置检查未通过/ : /配置检查通过/);
      assert.equal(markup.includes("bg-red-500"), item.state === "rejected");
      assert.equal(markup.includes("全部达标"), false);
      headerCases++;

      if (file.endsWith("/video-model-dialog.tsx")) {
        const initializer = actualDeclaration(tree, "handleAutoDetect").initializer;
        assert(initializer && ts.isCallExpression(initializer));
        let changes = 0;
        const original = { api_endpoint: "https://original.example/v1", api_key: "", model_name: "original_model", protocol_type: "original_protocol", name: "original display name" };
        let current = { ...original };
        const callback = evaluate<() => Promise<void>>(initializer.arguments[0].getText(tree), {
          form: original, isEdit: true, model: { id: "original-model" }, token: undefined,
          alert: () => { throw new Error("UNEXPECTED_ALERT"); },
          setDetecting: () => undefined, setDetectResult: () => undefined,
          setForm: (update: (old: typeof original) => typeof original) => { changes++; current = update(current); },
          fetch: async () => ({ ok: true, json: async () => detectResult }),
        });
        await callback();
        assert.equal(changes, item.state === "confirmed" ? 1 : 0);
        if (item.state !== "confirmed") assert.deepEqual(current, original, "unknown, failed and legacy detection must preserve all draft fields");
        draftCases++;
      } else {
        const apply = nodes(tree, node => ts.isJsxExpression(node) && Boolean(node.expression)
          && node.expression!.getText(tree).startsWith("detectConfirmed && detectResult &&")
          && node.expression!.getText(tree).includes("使用协议建议（保存后生效）"));
        assert.equal(apply.length, 1);
        const expression = (apply[0] as ts.JsxExpression).expression!;
        const applyMarkup = renderToStaticMarkup(evaluate<() => React.ReactNode>(`() => (${expression.getText(tree)})`, scope)());
        assert.equal(applyMarkup.includes("使用协议建议"), item.state === "confirmed");
        draftCases++;
      }
    }
  }
  return { actualDialogHeaders: headerCases, actualApplyGuards: draftCases, actualSources: true };
}

async function main() {
  assert.ok(modelEndpointError("admin@example.com"));
  const invalidUrl = new URL("https://example.com/v1");
  invalidUrl.username = "fixture-user";
  invalidUrl.password = "fixture-password";
  assert.ok(modelEndpointError(invalidUrl.href));
  invalidUrl.username = "";
  invalidUrl.password = "";
  invalidUrl.searchParams.set("key", "fixture-value");
  assert.ok(modelEndpointError(invalidUrl.href));
  assert.equal(modelEndpointError("https://gaorui.cc/v1"), null);
  const stored = { api_endpoint: "https://gaorui.cc/v1", api_key: "fixture-only", model_name: "old", protocol_type: "gaorui_video" };
  assert.equal(resolveVideoDetectionDraft({ model_name: "new", api_endpoint: stored.api_endpoint, api_key: "" }, stored).modelName, "new");
  assert.equal(resolveVideoDetectionDraft({ api_endpoint: stored.api_endpoint, api_key: "replacement", model_name: "new" }, stored).apiKey, "replacement");
  assert.throws(() => resolveVideoDetectionDraft({ api_endpoint: "https://another.example/v1", model_name: "new" }, stored), /站点已改变/);
  assert.equal(resolveVideoDetectionDraft({ api_endpoint: "https://another.example/v1", model_name: "new", api_key: "new-fixture" }, stored).apiEndpoint, "https://another.example/v1");
  let calls = 0;
  const reader = async (url: string) => { calls++; assert.equal(url, "https://gaorui.cc/v1/models"); return { data: [{ id: "omni_flash_10s" }] }; };
  const request = { apiEndpoint: "https://gaorui.cc/v1", apiKey: "fixture-only", modelName: "omni_flash_10s" };
  const match = await autoDetectVideoProtocol(request, reader);
  assert.equal(match.success, true); assert.equal(match.keyValid, true); assert.equal(match.modelExists, true); assert.equal(match.protocolType, "gaorui_video"); assert.equal(match.liveTest?.tested, false);
  const typo = await autoDetectVideoProtocol({ ...request, modelName: "omni_flash" }, reader);
  assert.equal(typo.success, false); assert.equal(typo.keyValid, true); assert.equal(typo.modelExists, false); assert.equal(typo.modelName, "omni_flash"); assert.equal(typo.candidateModels[0], "omni_flash_10s");
  const before = calls;
  assert.equal((await autoDetectVideoProtocol({ ...request, apiEndpoint: "https://unknown.example/v1" }, reader)).success, false);
  assert.equal((await autoDetectVideoProtocol({ ...request, apiEndpoint: "https://gaorui.cc.attacker.example/v1" }, reader)).success, false);
  assert.equal((await autoDetectVideoProtocol({ ...request, apiEndpoint: "admin@example.com" }, reader)).success, false);
  assert.equal(calls, before);
  const denied = await autoDetectVideoProtocol(request, async () => { throw new SafeFetchError("private upstream text", "UPSTREAM_STATUS", 502, { upstreamStatus: 403 }); });
  assert.match(denied.error || "", /无访问权限/); assert.equal(denied.keyValid, null); assert.equal(denied.modelExists, null); assert.ok(!JSON.stringify(denied).includes("private upstream text"));
  const html = await autoDetectVideoProtocol(request, async () => "login page");
  assert.equal(html.success, false); assert.equal(html.keyValid, null); assert.equal(html.modelExists, null);
  for (const status of [401, 403, 404, 408, 429, 500, 502, 503]) {
    const result = await autoDetectVideoProtocol(request, async () => { throw new SafeFetchError("private upstream details", "UPSTREAM_STATUS", 502, { upstreamStatus: status }); });
    assert.equal(result.success, false); assert.equal(result.keyValid, status === 401 ? false : null); assert.equal(result.modelExists, null);
    assert.equal(JSON.stringify(result).includes("private upstream details"), false);
  }
  for (const code of ["IP_FORBIDDEN", "DNS_LOOKUP_FAILED", "FETCH_ABORTED", "FETCH_FAILED"]) {
    const result = await autoDetectVideoProtocol(request, async () => { throw new SafeFetchError("private transport details", code); });
    assert.equal(result.keyValid, null); assert.equal(result.modelExists, null); assert.equal(result.success, false);
  }
  for (const data of [{}, { data: null }, { data: [null] }, { data: [{}] }, { data: [{ id: 1 }] }, { data: [{ id: " " }] }, { data: [{ id: request.modelName }, {}] }]) {
    const result = await autoDetectVideoProtocol(request, async () => data);
    assert.equal(result.keyValid, null); assert.equal(result.modelExists, null); assert.equal(result.success, false);
  }
  const empty = await autoDetectVideoProtocol(request, async () => ({ data: [] }));
  assert.equal(empty.keyValid, true); assert.equal(empty.modelExists, false); assert.equal(empty.success, false);
  const malformedJson = await autoDetectVideoProtocol(request, async () => { throw new SyntaxError("private response text"); });
  assert.equal(malformedJson.keyValid, null); assert.equal(malformedJson.modelExists, null);
  let nativeAliasReads = 0;
  for (const modelName of ["muse-video", "seedance2.0"]) {
    const nativeRequest = { ...request, apiEndpoint: "https://token.secure-skill.com/v1", modelName };
    const native = await autoDetectVideoProtocol(nativeRequest, async url => {
      nativeAliasReads++; assert.equal(url, "https://token.secure-skill.com/v1/models");
      return { data: [{ id: modelName }] };
    });
    assert.equal(native.success, true); assert.equal(native.keyValid, true); assert.equal(native.modelExists, true);
    assert.equal(native.protocolType, "secure_skill_video"); assert.equal(native.protocolName, "渠道A · 原生视频");
    assert.equal(native.modelName, modelName); assert.equal(native.liveTest?.tested, false);
    for (const status of [401, 403]) {
      const rejected = await autoDetectVideoProtocol(nativeRequest, async () => { throw new SafeFetchError("private alias rejection", "UPSTREAM_STATUS", 502, { upstreamStatus: status }); });
      assert.equal(rejected.success, false); assert.equal(rejected.keyValid, status === 401 ? false : null); assert.equal(rejected.modelExists, null);
      assert.equal(JSON.stringify(rejected).includes("private alias rejection"), false);
    }
  }
  assert.equal(nativeAliasReads, 2);
  let unexpectedAliasReads = 0;
  for (const modelName of ["muse-video-fake", "seedance2.0-preview", "MUSE-VIDEO", "seedance2.0 "]) {
    const unknown = await autoDetectVideoProtocol({ ...request, apiEndpoint: "https://token.secure-skill.com/v1", modelName }, async () => { unexpectedAliasReads++; return { data: [] }; });
    assert.equal(unknown.success, false); assert.equal(unknown.keyValid, null); assert.equal(unknown.modelExists, null);
  }
  for (const host of ["token.secure-skill.com.attacker.example", "attacker.token.secure-skill.com", "token-secure-skill.example"]) {
    for (const modelName of ["muse-video", "seedance2.0"]) {
      const unknown = await autoDetectVideoProtocol({ ...request, apiEndpoint: `https://${host}/v1`, modelName }, async () => { unexpectedAliasReads++; return { data: [] }; });
      assert.equal(unknown.success, false); assert.equal(unknown.keyValid, null); assert.equal(unknown.modelExists, null);
    }
  }
  assert.equal(unexpectedAliasReads, 0, "nearby IDs and non-exact station hosts cannot trigger credential-bearing catalogue reads");
  const ui = await verifyActualDialogConsumers();
  console.log(JSON.stringify({ passed: true, ...ui, triStateTransportAndHttpCases: 12, malformedCatalogCases: 8, exactNativeAliasCases: 2, nativeAliasAuthCases: 4, nearbyAliasAndHostDenials: 10, realNetworkRequests: 0, generationRequests: 0, databaseWrites: 0 }));
}
void main();
