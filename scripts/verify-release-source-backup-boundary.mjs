#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const policy = JSON.parse(fs.readFileSync('deploy/policies/release-policy.json', 'utf8'));
const source = fs.readFileSync('scripts/release-workflow.mjs', 'utf8');
const ast = ts.createSourceFile('release-workflow.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const definition = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'globToRegExp');
assert.ok(definition);
const matcher = vm.runInNewContext(`(${definition.getText(ast)})`);
const patterns = policy.source.excludeGlobs.map(matcher);
const excluded = path => patterns.some(pattern => pattern.test(path));
assert.equal(excluded('src/components/storyboard-workbench.tsx.bak-batchvideo'), true);
assert.equal(excluded('src/components/sample.ts.bak'), true);
assert.equal(excluded('src/components/sample.ts.bak-20261030'), true);
assert.equal(excluded('src/components/storyboard-workbench.tsx'), false);
assert.equal(excluded('src/lib/backup-policy.ts'), false);
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
assert.equal(parsed.errors.length, 0);
assert.equal(parsed.fileNames.some(name => /[\\/]research[\\/]/u.test(name)), false);
assert.ok(parsed.fileNames.some(name => /src[\\/]components[\\/]storyboard-workbench\.tsx$/u.test(name)));
assert.ok(parsed.fileNames.some(name => /scripts[\\/]verify-admin-permission-coverage\.ts$/u.test(name)));
console.log(JSON.stringify({ passed: true, backupPatternsChecked: 5,
  researchExcludedFromProductTypecheck: true, productAndVerifierSourcesRetained: true, networkCalls: 0 }));
