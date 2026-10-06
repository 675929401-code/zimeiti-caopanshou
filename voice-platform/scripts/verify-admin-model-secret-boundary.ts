import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const routePath = resolve(process.cwd(), 'src/app/api/admin/models/route.ts');
const source = readFileSync(routePath, 'utf8');

type Check = {
  name: string;
  passed: boolean;
};

const publicSelect = source.match(
  /const MODEL_CONFIG_PUBLIC_SELECT = \{([\s\S]*?)\} as const;/,
);
const environmentReads = [...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)]
  .map(match => match[1]);
const publicSelectUseCount = (
  source.match(/select:\s*MODEL_CONFIG_PUBLIC_SELECT/g) || []
).length;
const databaseKeyClearCount = (source.match(/apiKey:\s*null/g) || []).length;

const checks: Check[] = [
  {
    name: 'no UUID-shaped credential literals',
    passed: !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(source),
  },
  {
    name: 'no legacy hard-coded credential map',
    passed: !source.includes('DEFAULT_API_KEYS'),
  },
  {
    name: 'no non-empty literal fallback after environment lookup',
    passed: !/process\.env\.[A-Z0-9_]+\s*(?:\|\||\?\?)\s*['"][^'"]+['"]/i.test(source),
  },
  {
    name: 'credential configuration reads only the approved server environment variable',
    passed: environmentReads.length > 0
      && environmentReads.every(name => name === 'VOLCENGINE_API_KEY_1'),
  },
  {
    name: 'public Prisma projection exists and excludes apiKey',
    passed: Boolean(publicSelect)
      && !/\bapiKey\s*:/.test(publicSelect?.[1] || ''),
  },
  {
    name: 'all model-returning operations use the public projection',
    passed: publicSelectUseCount >= 6,
  },
  {
    name: 'GET-compatible apiKey field is a fixed mask and exposes a boolean',
    passed: source.includes("const API_KEY_MASK = '********'")
      && source.includes('apiKey: credentialConfigured ? API_KEY_MASK')
      && source.includes('hasApiKey: credentialConfigured'),
  },
  {
    name: 'missing server credential forces effective inactive state',
    passed: source.includes('isActive: Boolean(model.isActive && credentialConfigured)')
      && source.includes('updateData.isActive = false')
      && source.includes('MODEL_SECRET_NOT_CONFIGURED'),
  },
  {
    name: 'client-supplied credentials are rejected',
    passed: source.includes('isApiKeyPlaceholder(apiKey)')
      && source.includes('MODEL_SECRET_ENV_ONLY'),
  },
  {
    name: 'create and update paths do not persist a supplied credential',
    passed: databaseKeyClearCount >= 3
      && !/updateData\.apiKey\s*=\s*apiKey/.test(source)
      && !/apiKey:\s*apiKey/.test(source),
  },
  {
    name: 'raw exception messages and console logs are absent',
    passed: !/error\.message|console\.|JSON\.stringify\(body\)/.test(source),
  },
  {
    name: 'create and update responses pass through the safe DTO',
    passed: source.includes('toSafeModel(updated, credentialConfigured)')
      && source.includes('toSafeModel(created, credentialConfigured)')
      && !/successResponse\(\s*(?:updated|created)\b/.test(source),
  },
];

const failed = checks.filter(check => !check.passed);

if (failed.length > 0) {
  for (const check of failed) {
    process.stderr.write(`FAIL: ${check.name}\n`);
  }
  process.exit(1);
}

process.stdout.write(`PASS: admin model secret boundary ${checks.length}/${checks.length}\n`);
