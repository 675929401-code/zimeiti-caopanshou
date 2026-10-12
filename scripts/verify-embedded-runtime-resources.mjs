#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const shouldWrite = process.argv.includes("--write");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function expectedDatabaseModule() {
  const source = readJson("deploy/policies/database-contract.v1.json");
  return `// Generated from deploy/policies/database-contract.v1.json.\n// Verify with scripts/verify-embedded-runtime-resources.mjs before production builds.\nconst DATABASE_CONTRACT_SOURCE = ${JSON.stringify(source, null, 2)} as const;\n\nexport default DATABASE_CONTRACT_SOURCE;\n`;
}

function expectedPromptModule() {
  const sources = [
    ["GENERAL_SCRIPT_PROFILE_SOURCE", "prompts/short-drama/general-script.v1.json"],
    ["DRAMA_SCRIPT_PROFILE_SOURCE", "prompts/short-drama/drama-script.v1.json"],
    ["PET_SILENT_NARRATION_PROFILE_SOURCE", "prompts/short-drama/pet-silent-narration.v1.json"],
  ];
  let output = "// Generated from prompts/short-drama/*.v1.json.\n// Verify with scripts/verify-embedded-runtime-resources.mjs before production builds.\n";
  for (const [name, relativePath] of sources) {
    output += `\nexport const ${name} = ${JSON.stringify(readJson(relativePath), null, 2)} as const;\n`;
  }
  return output;
}

const expected = new Map([
  ["src/lib/generated/database-contract.ts", expectedDatabaseModule()],
  ["src/lib/short-drama/general-script-profile-data.ts", expectedPromptModule()],
]);

const selected = new Map([...expected].filter(([relativePath]) => !process.argv.includes("--database-only") || relativePath === "src/lib/generated/database-contract.ts"));
for (const [relativePath, content] of selected) {
  if (shouldWrite) {
    fs.writeFileSync(path.join(root, relativePath), content, "utf8");
  }
  const actual = fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/gu, "\n");
  assert.equal(actual, content, `${relativePath} is stale; regenerate it from the reviewed source resource`);
}

console.log(JSON.stringify({ status: "PASS", mode: shouldWrite ? "write-and-verify" : "verify", embeddedRuntimeResources: selected.size }, null, 2));
