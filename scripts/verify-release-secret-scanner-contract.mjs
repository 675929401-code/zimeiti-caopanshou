import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const scanner = fs.readFileSync(new URL('./verify-release-secret-exposure.mjs', import.meta.url), 'utf8');
const prefix = scanner.split('const workingTreeFindings = [];')[0].replace(/^import .*;\r?$/gm, '');
const { findingsFor } = vm.runInNewContext(`${prefix}\n({ findingsFor });`, { fs, path, process });
const alias = 'secure-skill-seedance-official-token';
const mapping = `  "${alias}": "${alias}.token",`;
const fixtureSecret = ['Ab9', 'q7', '-Z4', 'k2', '_p8', 'Lm6', 'N5', 'x3'].join('');
const checks = [];
function check(name, text, file, expected) {
  const actual = findingsFor(text, file).get('named-credential-literal') || 0;
  assert.equal(actual, expected, name);
  checks.push({ name, passed: true });
}
check('exact provider filename mapping is a reference', mapping, 'src/lib/provider-secret.ts', 0);
check('same filename text elsewhere still requires review', mapping, 'src/lib/other.ts', 1);
check('a credential body in the provider map still requires review', `"${alias}": "${fixtureSecret}",`, 'src/lib/provider-secret.ts', 1);
check('a different token filename still requires review', `"${alias}": "${alias}-other.token",`, 'src/lib/provider-secret.ts', 1);
check('a named credential in the provider file still requires review', `const apiKey = "${fixtureSecret}";`, 'src/lib/provider-secret.ts', 1);
check('explicit mock fixture stays non-secret', "const deletionToken = 'fixture-admin-user-delete-reauth';", 'scripts/verify-admin-member-delete-live-mocked.mjs', 0);
assert.equal(findingsFor(['-----BEGIN ', 'RSA PRIVATE ', 'KEY-----'].join(''), 'src/lib/provider-secret.ts').get('private-key-pem'), 1);
checks.push({ name: 'high confidence private keys are still blocked', passed: true });
console.log(JSON.stringify({ verifier: 'release-secret-scanner-contract', passed: true, checks, secretValuesPrinted: false }, null, 2));
