import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/app/api/image-workbench/history/route.ts", "utf8");
const validateAt = source.indexOf("const documents = loaded.slice(0, PAGE_SIZE).flatMap");
const itemReadAt = source.indexOf("documents.flatMap(row => row.document.items.map");
assert.ok(validateAt > 0 && itemReadAt > validateAt,
  "legacy documents must be validated before document.items is read");
assert.match(source, /const document = recordInput\(row\.document\);[\s\S]*?if \(!document\)[\s\S]*?return \[\];/u,
  "a malformed row must be isolated instead of throwing the whole page");
assert.doesNotMatch(source, /console\.warn\([^\n]*row\.document/u,
  "malformed prompts must not be written to logs");

console.log(JSON.stringify({
  ok: true,
  malformedRowIsolation: true,
  promptLogged: false,
  realNetworkCalls: 0,
  realDatabaseWrites: 0,
}, null, 2));
