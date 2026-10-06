#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync("src/lib/image-output-contract.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
vm.runInNewContext(compiled, {
  module: loaded,
  exports: loaded.exports,
  Object,
  Array,
  String,
  Number,
  Math,
  RegExp,
  Error,
});
const { configuredImagePixelSizeFor } = loaded.exports;
assert.equal(typeof configuredImagePixelSizeFor, "function");

const configured = {
  request_pixel_size_by_resolution: {
    "1K": { "16:9": "1280x720", "1:1": "1024x1024" },
    "4K": { "16:9": "3840x2160", "1:1": "2880x2880" },
  },
};
assert.equal(configuredImagePixelSizeFor(configured, "1K", "16:9"), "1280x720");
assert.equal(configuredImagePixelSizeFor(configured, "4K", "16:9"), "3840x2160");
assert.equal(configuredImagePixelSizeFor(configured, "4K", "1:1"), "2880x2880");
assert.equal(configuredImagePixelSizeFor({}, "1K", "16:9"), "1024x576");
assert.equal(configuredImagePixelSizeFor({
  request_pixel_size_by_resolution: { "1K": { "16:9": "1024x1024" } },
}, "1K", "16:9"), "1024x576", "invalid configured ratio must fail closed to generic map");

const route = fs.readFileSync("src/app/api/image/generate/route.ts", "utf8");
assert.match(route, /configuredImagePixelSizeFor\(model\.api_protocol_config, effectiveResolution, ratio\)/u);
assert.match(route, /expectedImagePixelSize\(modelConfig, effectiveResolution, ratio\)/u);
assert.doesNotMatch(route, /RESOLUTION_SIZE_MAPS/u);

console.log(JSON.stringify({
  passed: true,
  assertions: [
    "configured model pixel map overrides generic dimensions",
    "invalid ratio mapping fails closed",
    "unconfigured models preserve their existing dimensions",
    "request and delivery validation share the same model-specific dimensions",
  ],
  providerCalls: 0,
  databaseWrites: 0,
}));
