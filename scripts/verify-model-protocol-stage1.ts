import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { SseEventStreamDecoder, type DecodedSseEvent } from "../src/lib/sse-stream-decoder";
import { buildMangaAgentModelCatalog } from "../src/lib/manga-agent-model-policy";
import { PENDING_TEXT_USER_ACCESS } from "../src/lib/model-activation-gate";
import { isPublishedTextBillingModel, isPublishedTextModelEligible } from "../src/lib/text-model-eligibility";

// Exercise the real DTO expression without importing an authenticated route,
// loading credentials, or making a database request.
function videoAdminDtoMapper(): (row: Record<string, unknown>) => Record<string, unknown> {
  const filename = resolve("src/app/api/admin/models/route.ts");
  const source = readFileSync(filename, "utf8");
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const candidates: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.getText(tree) === "models.push") {
      const object = node.arguments[0];
      if (object && ts.isObjectLiteralExpression(object) && object.properties.some((property) => (
        ts.isPropertyAssignment(property)
        && property.name.getText(tree) === "model_type"
        && ts.isStringLiteral(property.initializer)
        && property.initializer.text === "video"
      ))) candidates.push(object);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(candidates.length, 1, "expected one video model GET mapping");
  return runInNewContext(`(m) => (${candidates[0].getText(tree)})`, Object.create(null));
}

function decode(chunks: Uint8Array[]): DecodedSseEvent[] {
  const decoder = new SseEventStreamDecoder();
  return chunks.flatMap((chunk) => decoder.push(chunk)).concat(decoder.finish());
}

function textBillingEligibilityPredicate(): (row: Record<string, unknown> | null) => boolean {
  const filename = resolve("src/app/api/llm/route.ts");
  const source = readFileSync(filename, "utf8");
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let eligibilityImportCount = 0;
  let catalogFilterCount = 0;
  let defaultGuardCount = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === "@/lib/text-model-eligibility") {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        eligibilityImportCount += bindings.elements.filter((element) => (
          (element.propertyName || element.name).text === "isPublishedTextBillingModel"
        )).length;
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const argument = node.arguments[0];
      if (ts.isIdentifier(argument)
        && argument.text === "isPublishedTextBillingModel"
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "filter") {
        catalogFilterCount += 1;
      }
      if (ts.isIdentifier(node.expression)
        && node.expression.text === "isPublishedTextBillingModel"
        && argument.getText(tree) === "defaultTextModelRow") {
        defaultGuardCount += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(eligibilityImportCount, 1, "LLM route must import the shared billing eligibility helper exactly once");
  assert.ok(catalogFilterCount >= 1, "LLM route catalog query must filter with the shared billing eligibility helper");
  assert.ok(defaultGuardCount >= 1, "LLM route default-model guard must use the shared billing eligibility helper");
  return isPublishedTextBillingModel;
}

function chatCapabilitiesMapper(): (row: Record<string, unknown>) => Record<string, unknown> {
  const filename = resolve("src/app/api/chat-models/route.ts");
  const source = readFileSync(filename, "utf8");
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let helper = "";
  const mappings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "isChatCapabilityEnabled") helper = node.getText(tree);
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "toPublicModelDto"
      && node.arguments[3] && ts.isObjectLiteralExpression(node.arguments[3])) {
      mappings.push(node.arguments[3].getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(mappings.length, 1, "one public chat capability mapping must exist");
  return runInNewContext(ts.transpileModule(`${helper}\n(model) => (${mappings[0]});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { publicTextModelBillingCapabilities: () => ({}) });
}

const failures: string[] = [];
const checks: string[] = [];
let partitionCases = 0;
function check(name: string, run: () => void): void {
  try {
    run();
    checks.push(name);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

check("required reference flag survives admin GET and edit initialization", () => {
  const map = videoAdminDtoMapper();
  for (const requiresImage of [true, false]) {
    const row = { id: "fixture-video", supports_image_input: true, requires_image: requiresImage };
    const dto = map(row);
    assert.equal(dto.requires_image, requiresImage, "admin DTO must preserve the stored reference requirement");
    assert.equal(dto.requires_image === true, requiresImage, "editing must not reset a required image to optional");
  }
  assert.equal(map({ id: "legacy-video" }).requires_image, false, "missing legacy flag stays optional");
});

const textFixtures = [
  { model_name: "glm-image", eligible: false },
  { model_name: "gpt-image-1.5", eligible: false },
  { model_name: "glm-5v-turbo", eligible: true, image_parsing: "auto" },
  { model_name: "gpt-4o", eligible: true, image_parsing: "auto" },
  { model_name: "suno-v4", eligible: false },
  { model_name: "gpt-4o-hidden", eligible: false, is_hidden: true },
  { model_name: "gpt-4o-inactive", eligible: false, is_active: false },
  { model_name: "gpt-4o-pending", eligible: false, user_access: PENDING_TEXT_USER_ACCESS },
].map((fixture, index) => ({
  id: `text-fixture-${index}`,
  name: fixture.model_name,
  category: "text",
  description: "catalog fixture",
  is_active: true,
  is_hidden: false,
  user_access: "available",
  sort_order: index,
  token_billing_enabled: true,
  input_cost_per_million: 1,
  output_cost_per_million: 4,
  cached_cost_per_million: 0,
  profit_margin: 30,
  ...fixture,
}));

check("manga catalog excludes image generators and preserves multimodal chat and publication gates", () => {
  const catalog = buildMangaAgentModelCatalog(textFixtures);
  assert.deepEqual(catalog.models.map((model) => model.displayName), ["glm-5v-turbo", "gpt-4o"]);
  assert.equal(catalog.policy.defaultModelId, catalog.models[0].id);
  assert.ok(catalog.models.every((model) => model.capabilities.imageParsing === true));
});

check("all user-facing text catalogs share the pending publication gate", () => {
  for (const fixture of textFixtures) {
    assert.equal(isPublishedTextModelEligible(fixture), fixture.eligible, fixture.model_name);
  }
});

check("server text selection uses the same eligibility and keeps publication gates", () => {
  const eligible = textBillingEligibilityPredicate();
  for (const fixture of textFixtures) assert.equal(eligible(fixture), fixture.eligible, fixture.model_name);
  assert.equal(eligible(null), false);
});

check("public chat flags preserve stored disabled values and enabled parsing modes", () => {
  const map = chatCapabilitiesMapper();
  for (const [value, enabled] of [
    ["none", false], ["false", false], ["off", false], ["0", false], ["", false],
    [null, false], [undefined, false], [false, false], [0, false], [-1, false],
    ["auto", true], ["true", true], [true, true], [1, true],
  ] as const) {
    const flags = map({ image_parsing: value, file_parsing: value, enable_web_search: value });
    for (const key of ["imageParsing", "fileParsing", "webSearch"]) {
      assert.equal(flags[key], enabled, `${key}: ${String(value)}`);
    }
  }
});

const data = '{"choices":[\n{"delta":{"content":"首字🙂"}}]}';
const expected: DecodedSseEvent[] = [
  { event: "delta", data, id: "first", retry: 1200 },
  { event: "message", data: "[DONE]", id: "done" },
];
const fields = [
  ": heartbeat",
  'data: {"choices":[',
  'data: {"delta":{"content":"首字🙂"}}]}',
  "event: delta",
  "id: first",
  "retry: 1200",
  "",
  "id: first",
  "data: replay must not duplicate the first output",
  "",
  "id: done",
  "data: [DONE]",
  "",
  "",
];

for (const [label, endings] of [
  ["LF", ["\n"]],
  ["CRLF", ["\r\n"]],
  ["CR", ["\r"]],
  ["mixed", ["\r\n", "\n", "\r"]],
] as const) {
  check(`${label}: every byte boundary preserves multiline data, metadata and first Unicode output`, () => {
    const fixture = fields.map((field, index) => field + (index < fields.length - 1 ? endings[index % endings.length] : "")).join("");
    const bytes = new TextEncoder().encode(fixture);
    for (let split = 0; split <= bytes.length; split++) {
      const events = decode([bytes.slice(0, split), new Uint8Array(), bytes.slice(split)]);
      assert.deepEqual(events, expected, `${label}: split at byte ${split}`);
      assert.equal(JSON.parse(events[0].data).choices[0].delta.content, "首字🙂");
      partitionCases++;
    }
    const oneByteChunks = Array.from(bytes, (_, index) => bytes.slice(index, index + 1));
    assert.deepEqual(decode(oneByteChunks), expected, `${label}: one byte per network chunk`);
    partitionCases++;
  });
}

check("a completed first event is delivered before stream closure", () => {
  const decoder = new SseEventStreamDecoder();
  assert.deepEqual(decoder.push(new TextEncoder().encode("data: first\r\r")), [
    { event: "message", data: "first" },
  ]);
  assert.deepEqual(decoder.push(new TextEncoder().encode("\ndata: second\r\n\r\n")), [
    { event: "message", data: "second" },
  ]);
  assert.deepEqual(decoder.finish(), []);
});

check("unterminated final event and replay reset preserve existing behavior", () => {
  const decoder = new SseEventStreamDecoder();
  const event = new TextEncoder().encode("id: reused\ndata: 首条\n\n");
  assert.equal(decoder.push(event).length, 1);
  assert.equal(decoder.push(event).length, 0);
  decoder.resetReplayWindow();
  assert.equal(decoder.push(event).length, 1);
  assert.deepEqual(decode([new TextEncoder().encode("data: 最后一条🙂")]), [
    { event: "message", data: "最后一条🙂" },
  ]);
});

console.log(JSON.stringify({
  verifier: "model-protocol-stage1",
  status: failures.length === 0 ? "passed" : "failed",
  providerCalls: 0,
  databaseCalls: 0,
  checks,
  partitionCases,
  failures,
}, null, 2));
if (failures.length > 0) process.exitCode = 1;
