#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import { canonicalJson, sha256, getJson, validateOrigin, versionIdentity, projectCatalog, projectModels, compareModelSections, projectOwnerDiagnostics, compareOwnerDiagnostics, compareRows, compareSection, evaluateReport } from './lib/public-configuration-parity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `Read-only public configuration comparison (Node + existing project tsx dependency).
Usage: node scripts/compare-public-configuration-readonly.mjs --left http://127.0.0.1:5000 --right https://your-domain --mode informational --out <report.json>

--mode informational|strict         informational exits 0; strict requires owner diagnostics and exits 1 on drift/unverified evidence.
--public-only                       explicitly restrict strict mode to the public GET scope (owner parity remains unverified).
--out <path>                        machine JSON (otherwise prints JSON to stdout).
--left-connect-address <IP>         optional DNS override; original Host, SNI and certificate verification retained.
--right-connect-address <IP>        same for right target; redirects and retries are always refused.
--expect-left-source <sourceVersion> / --expect-right-source <sourceVersion>
--audience guest|authenticated      default guest; authenticated requires both token env options and verifies /api/auth/me role.
--left-token-env <NAME> / --right-token-env <NAME>  env names only; no raw credential arguments.
--include-owner-diagnostics          GET /api/admin/configuration-identity only with explicit credentials.
--require-owner-diagnostics          additionally makes unavailable/different owner evidence block strict mode.
--left-step-up-env <NAME> / --right-step-up-env <NAME>  owner step-up token environment names.
--left-cookie-env <NAME> / --right-cookie-env <NAME>    existing owner cookies, from controlled process env only.
--timeout-ms <100..120000>           default 15000 per GET; response limit 8 MiB; bounded concurrency.

GETs only. No DB queries/writes, token minting, model/provider calls, browser fixtures or mutations.
Owner governance may append its existing security access audit; the report states that boundary.
Server-declared admission is distinct from real UI selection, membership grant and paid generation.
Model parity uses complete visible semantic multisets with duplicate counts and API order. Public IDs are provenance only; cross-environment physical model bindings remain unverified.
Exit 2 = invalid invocation or local report/initialization failure. No secrets/raw diagnostic payloads are written.`;

export function parseArgs(args, env = process.env) {
  const options = { mode: 'informational', audience: 'guest', timeoutMs: 15_000, includeOwnerDiagnostics: false, requireOwnerDiagnostics: false };
  const values = { '--left': 'left', '--right': 'right', '--mode': 'mode', '--audience': 'audience', '--out': 'out', '--left-connect-address': 'leftConnectAddress', '--right-connect-address': 'rightConnectAddress', '--expect-left-source': 'expectLeftSource', '--expect-right-source': 'expectRightSource', '--left-token-env': 'leftTokenEnv', '--right-token-env': 'rightTokenEnv', '--left-step-up-env': 'leftStepUpEnv', '--right-step-up-env': 'rightStepUpEnv', '--left-cookie-env': 'leftCookieEnv', '--right-cookie-env': 'rightCookieEnv', '--timeout-ms': 'timeoutMs' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return { help: true };
    if (seen.has(arg)) throw new Error('DUPLICATE_OPTION');
    seen.add(arg);
    if (arg === '--public-only') options.publicOnly = true;
    else if (arg === '--include-owner-diagnostics') options.includeOwnerDiagnostics = true;
    else if (arg === '--require-owner-diagnostics') options.requireOwnerDiagnostics = options.includeOwnerDiagnostics = true;
    else if (values[arg]) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('OPTION_VALUE_REQUIRED');
      options[values[arg]] = args[++i];
    } else throw new Error('UNKNOWN_OPTION');
  }
  options.left = validateOrigin(options.left);
  options.right = validateOrigin(options.right);
  if (!['informational', 'strict'].includes(options.mode) || !['guest', 'authenticated'].includes(options.audience)) throw new Error('INVALID_MODE_OR_AUDIENCE');
  if (options.publicOnly && options.requireOwnerDiagnostics) throw new Error('CONFLICTING_COVERAGE_OPTIONS');
  if (options.mode === 'strict' && !options.publicOnly) options.requireOwnerDiagnostics = options.includeOwnerDiagnostics = true;
  options.timeoutMs = Number(options.timeoutMs);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 120_000) throw new Error('INVALID_TIMEOUT');
  for (const side of ['left', 'right']) {
    if (options[`${side}ConnectAddress`] && !isIP(options[`${side}ConnectAddress`])) throw new Error('CONNECT_ADDRESS_MUST_BE_IP');
    for (const kind of ['Token', 'StepUp', 'Cookie']) {
      const name = options[`${side}${kind}Env`];
      if (name && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error('ENV_NAME_REQUIRED');
      options[`${side}${kind}`] = name ? String(env[name] || '').trim() : '';
      if (/[\r\n]/u.test(options[`${side}${kind}`])) throw new Error('INVALID_CREDENTIAL_ENV');
    }
    if (options.audience === 'authenticated' && !options[`${side}Token`]) throw new Error('AUTHENTICATED_AUDIENCE_REQUIRES_BOTH_TOKENS');
  }
  return options;
}

export function loadSourceContract() {
  const require = createRequire(path.join(root, 'package.json'));
  require('tsx/cjs/api').register({ tsconfig: path.join(root, 'tsconfig.json') });
  const { displayCategory } = require(path.join(root, 'src/lib/business-ip/catalog.ts'));
  const { getAgentNavigationKey } = require(path.join(root, 'src/lib/agent-category-access.ts'));
  const { WORKSPACE_MODEL_SURFACES, imageWorkspaceSurfaceFromRequest, videoWorkspaceSurfaceFromRequest } = require(path.join(root, 'src/lib/workspace-model-policy.ts'));
  const surfaces = WORKSPACE_MODEL_SURFACES.map(surface => {
    const requestSurface = surface.storageValue;
    const resolveSurface = surface.kind === 'image' ? imageWorkspaceSurfaceFromRequest : videoWorkspaceSurfaceFromRequest;
    if (resolveSurface(requestSurface) !== surface.id) throw new Error('WORKSPACE_SURFACE_CONTRACT_DRIFT');
    return { id: surface.id, kind: surface.kind, route: `/api/${surface.kind === 'image' ? 'cover-models' : 'video/models'}?surface=${encodeURIComponent(requestSurface)}` };
  });
  return { displayCategory, getAgentNavigationKey, surfaces: [{ id: 'chat', kind: 'text', route: '/api/chat-models' }, ...surfaces] };
}

const errorCode = error => /^[-A-Za-z_0-9:]+$/u.test(String(error?.message)) ? error.message : 'PROJECTION_FAILED';
function project(result, mapper) {
  if (!result?.ok) return { status: 'UNVERIFIED', error: result?.error || 'READ_FAILED' };
  try { return mapper(result.body); } catch (error) { return { status: 'UNVERIFIED', error: errorCode(error) }; }
}

export async function captureTarget(side, options, contract, request = getJson) {
  const origin = options[side];
  const token = options[`${side}Token`];
  const transports = [];
  const get = async (route, authenticated = options.audience === 'authenticated', owner = false) => {
    const diagnosticHeaders = owner ? { ...(options[`${side}StepUp`] ? { 'x-admin-step-up': options[`${side}StepUp`] } : {}), ...(options[`${side}Cookie`] ? { cookie: options[`${side}Cookie`] } : {}) } : {};
    const result = await request(origin, route, { token: authenticated ? token : undefined, diagnosticHeaders, connectAddress: options[`${side}ConnectAddress`], timeoutMs: options.timeoutMs });
    const { body: _body, ...metadata } = result;
    transports.push(metadata);
    return result;
  };
  const before = project(await get('/api/version', false), versionIdentity);
  const principal = options.audience === 'guest' ? { status: 'VERIFIED', audience: 'guest', role: 'guest' }
    : project(await get('/api/auth/me', true), body => {
      if (!body.user?.id || typeof body.user.role !== 'string') throw new Error('AUTHENTICATED_IDENTITY_REQUIRED');
      return { status: 'VERIFIED', audience: 'authenticated', role: body.user.role, userIdSha256: sha256(body.user.id), scope: 'Role checked; cross-environment grant equivalence remains unverified.' };
    });
  const [agents, categories] = await Promise.all([get('/api/bots?shape=agents'), get('/api/categories')]);
  const catalog = project(agents, body => {
    if (!categories.ok) throw new Error('CATEGORIES_UNAVAILABLE');
    return projectCatalog(body, categories.body, contract);
  });
  const models = {};
  for (let start = 0; start < contract.surfaces.length; start += 3) {
    await Promise.all(contract.surfaces.slice(start, start + 3).map(async surface => {
      models[surface.id] = project(await get(surface.route), body => projectModels(body, surface.kind));
    }));
  }
  let ownerDiagnostics = { status: 'UNVERIFIED', error: options.includeOwnerDiagnostics ? 'EXPLICIT_OWNER_CREDENTIALS_UNAVAILABLE' : 'NOT_REQUESTED' };
  if (options.includeOwnerDiagnostics && token) ownerDiagnostics = project(await get('/api/admin/configuration-identity', true, true), projectOwnerDiagnostics);
  const after = project(await get('/api/version', false), versionIdentity);
  const identityOk = typeof before.sourceVersion === 'string' && typeof after.sourceVersion === 'string';
  const expectedSource = options[side === 'left' ? 'expectLeftSource' : 'expectRightSource'];
  return {
    origin, principal, identity: { before, after }, identityStable: identityOk && canonicalJson(before) === canonicalJson(after),
    expectedSource: expectedSource || null, expectedSourceMatches: expectedSource ? before.sourceVersion === expectedSource && after.sourceVersion === expectedSource : null,
    catalog, models, ownerDiagnostics, transports,
  };
}

export async function buildReport(options, contract = loadSourceContract(), request = getJson) {
  const startedAt = new Date().toISOString();
  const [left, right] = await Promise.all(['left', 'right'].map(side => captureTarget(side, options, contract, request)));
  const sourceKnown = Boolean(left.identity.before.sourceVersion && right.identity.before.sourceVersion);
  const sameRole = left.principal.status === 'VERIFIED' && right.principal.status === 'VERIFIED' && left.principal.role === right.principal.role;
  const report = {
    schemaVersion: 'public-configuration-parity.v1', startedAt, completedAt: new Date().toISOString(),
    scope: { audience: options.audience, operations: 'bounded GET only', businessWrites: 0, databaseDirectQueries: 0, modelCalls: 0, providerCalls: 0, securityAccessAudit: options.includeOwnerDiagnostics ? 'Owner endpoint may append its existing governance audit.' : 'Owner diagnostics not requested.', uiSelection: 'UNVERIFIED', memberGrantEquivalence: 'UNVERIFIED', providerGeneration: 'UNVERIFIED' },
    targets: { left, right },
    comparison: {
      source: { status: !sourceKnown ? 'UNVERIFIED' : left.identity.before.sourceVersion === right.identity.before.sourceVersion ? 'EQUAL' : 'DIFFERENT', left: left.identity.before.sourceVersion ?? null, right: right.identity.before.sourceVersion ?? null },
      audience: { status: sameRole ? 'EQUAL' : left.principal.status !== 'VERIFIED' || right.principal.status !== 'VERIFIED' ? 'UNVERIFIED' : 'DIFFERENT', leftRole: left.principal.role ?? null, rightRole: right.principal.role ?? null },
      catalog: compareSection(left.catalog, right.catalog),
      categories: left.catalog.status === 'VERIFIED' && right.catalog.status === 'VERIFIED' ? compareRows(left.catalog.categories, right.catalog.categories) : { status: 'UNVERIFIED' },
      opaqueAgentModelIds: left.catalog.status === 'VERIFIED' && right.catalog.status === 'VERIFIED' ? { ...compareRows(left.catalog.opaquePublicModelBindings, right.catalog.opaquePublicModelBindings), scope: 'Opaque cross-environment IDs; excluded from semantic parity gate.' } : { status: 'UNVERIFIED' },
      models: Object.fromEntries(contract.surfaces.map(surface => [surface.id, compareModelSections(left.models[surface.id], right.models[surface.id])])),
      ownerDiagnostics: compareOwnerDiagnostics(left.ownerDiagnostics, right.ownerDiagnostics),
    },
  };
  report.evaluation = evaluateReport(report, options);
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return 0; }
  const report = await buildReport(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    const output = path.resolve(options.out);
    await fs.mkdir(path.dirname(output), { recursive: true });
    // Refuse overwriting any existing file, including source or past evidence.
    await fs.writeFile(output, json, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ report: output, ...report.evaluation }));
  } else process.stdout.write(json);
  return report.evaluation.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(JSON.stringify({ status: 'FAILED', error: errorCode(error), exitCode: 2 }));
    process.exitCode = 2;
  });
}
