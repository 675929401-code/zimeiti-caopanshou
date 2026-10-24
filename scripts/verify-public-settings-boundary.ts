import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const routePath = `${root}/src/app/api/settings/route.ts`;
const routeSource = read("src/app/api/settings/route.ts");
const adminRouteSource = read("src/app/api/settings/admin/route.ts");
const platformContractSource = read("src/lib/platform-settings-contract.ts");
const themeInitSource = read("src/components/theme-init.tsx");
const appContextSource = read("src/contexts/app-context.tsx");
const homeSource = read("src/app/page.tsx");
const adminPageSource = read("src/app/admin/page.tsx");

function parse(source: string, path: string) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function exportedFunctionSource(source: string, path: string, name: string): string {
  const tree = parse(source, path);
  const handler = tree.statements.find(
    (node): node is ts.FunctionDeclaration => (
      ts.isFunctionDeclaration(node)
      && node.name?.text === name
      && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    ),
  );
  assert.ok(handler?.body, `${path} must export ${name}`);
  return handler.getText(tree);
}

function namedStatementSource(
  tree: ts.SourceFile,
  name: string,
): string {
  const statement = tree.statements.find((node) => {
    if (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      return node.name?.text === name;
    }
    if (!ts.isVariableStatement(node)) return false;
    return node.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
    );
  });
  assert.ok(statement, `missing declaration: ${name}`);
  return statement.getText(tree);
}

function stringArray(source: string, path: string, name: string): string[] {
  const tree = parse(source, path);
  const statement = tree.statements.find((node): node is ts.VariableStatement => (
    ts.isVariableStatement(node)
    && node.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
    )
  ));
  assert.ok(statement, `${path} must declare ${name}`);
  const declaration = statement.declarationList.declarations.find(
    (item) => ts.isIdentifier(item.name) && item.name.text === name,
  );
  assert.ok(declaration?.initializer, `${name} must have an initializer`);
  let initializer: ts.Expression = ts.isAsExpression(declaration.initializer)
    ? declaration.initializer.expression
    : declaration.initializer;
  if (ts.isNewExpression(initializer)) {
    assert.equal(initializer.arguments?.length, 1, `${name} Set must have one array argument`);
    initializer = initializer.arguments![0];
  }
  assert.ok(ts.isArrayLiteralExpression(initializer), `${name} must be an explicit array literal`);
  return initializer.elements.map((element) => {
    assert.ok(ts.isStringLiteral(element), `${name} may contain only string literals`);
    return element.text;
  });
}

const expectedPublicDatabaseKeys = [
  "theme",
  "theme_mode",
  "theme_primary_color",
  "theme_accent_color",
  "theme_gradient_start",
  "theme_gradient_mid",
  "theme_gradient_end",
  "page_layout",
  "card_layout",
  "video_page_config",
];
const publicDatabaseKeys = stringArray(
  routeSource,
  "src/app/api/settings/route.ts",
  "PUBLIC_DATABASE_SETTING_KEYS",
);
assert.deepEqual(
  publicDatabaseKeys,
  expectedPublicDatabaseKeys,
  "public settings DTO changed; audit every browser consumer before changing this allowlist",
);

const generalKeys = stringArray(
  platformContractSource,
  "src/lib/platform-settings-contract.ts",
  "GENERAL_PLATFORM_SETTING_KEYS",
);
const internalGeneralKeys = generalKeys.filter((key) => !publicDatabaseKeys.includes(key));
assert.ok(internalGeneralKeys.includes("global_system_prefix"), "test fixture must cover global_system_prefix");
assert.equal(
  publicDatabaseKeys.filter((key) => internalGeneralKeys.includes(key)).length,
  0,
  "the public database projection must not include internal general settings",
);
const adminKeys = stringArray(
  platformContractSource,
  "src/lib/platform-settings-contract.ts",
  "ADMIN_PLATFORM_SETTING_KEYS",
);
const missingAdminReadKeys = internalGeneralKeys.filter((key) => !adminKeys.includes(key));
assert.deepEqual(
  missingAdminReadKeys,
  [],
  "every internal general setting must remain readable through the step-up admin endpoint",
);
const globalTokenCostKeys = [
  "input_cost_per_million",
  "output_cost_per_million",
  "cached_cost_per_million",
];
for (const key of globalTokenCostKeys) {
  assert.ok(adminKeys.includes(key), `${key} must remain in the typed admin DTO`);
}
assert.match(
  platformContractSource,
  /export type AdminPlatformSettingKey = typeof ADMIN_PLATFORM_SETTING_KEYS\[number\]/u,
  "admin DTO keys must derive from the authoritative allowlist",
);
assert.match(
  platformContractSource,
  /export type AdminPlatformSettingsDto = Partial<Record<[\s\S]*?AdminPlatformSettingKey \| AdminPlatformSettingConfiguredKey,[\s\S]*?string \| boolean[\s\S]*?>>;/u,
  "admin settings response must expose a typed key/value DTO",
);
const nonNegativeNumberKeys = stringArray(
  platformContractSource,
  "src/lib/platform-settings-contract.ts",
  "NON_NEGATIVE_NUMBER_KEYS",
);
for (const key of globalTokenCostKeys) {
  assert.ok(nonNegativeNumberKeys.includes(key), `${key} must retain non-negative numeric validation`);
}

const publicGetSource = exportedFunctionSource(
  routeSource,
  "src/app/api/settings/route.ts",
  "GET",
);
for (const forbidden of [
  "GENERAL_PLATFORM_SETTING_KEYS",
  "global_system_prefix",
  "verifyToken",
  "authorization",
  "isAdmin",
]) {
  assert.ok(!publicGetSource.includes(forbidden), `public GET must not branch on or expose ${forbidden}`);
}
assert.match(
  publicGetSource,
  /\.in\("setting_key", \[\.\.\.PUBLIC_DATABASE_SETTING_KEYS\]\)/u,
  "database read must be scoped to the public allowlist",
);
assert.match(
  publicGetSource,
  /NextResponse\.json\(buildPublicSettingsDto\(data, branding\)\)/u,
  "public GET must return only the typed public projection",
);

const routeTree = parse(routeSource, routePath);
const executableDeclarations = [
  "PUBLIC_DATABASE_SETTING_KEYS",
  "PublicDatabaseSettingKey",
  "RequiredPublicSettingKey",
  "PublicSettingsDto",
  "PublicBranding",
  "PublicSettingsResponseDto",
  "PUBLIC_DATABASE_SETTING_KEY_SET",
  "SENSITIVE_KEY_PATTERNS",
  "SENSITIVE_VALUE_PATTERNS",
  "isSensitiveKey",
  "sanitizeValue",
  "buildPublicSettingsDto",
].map((name) => namedStatementSource(routeTree, name)).join("\n");

const executableSource = `
const DEFAULT_THEME = "lattice";
const DEFAULT_MODE_PREFERENCE = "dark";
const normalizeTheme = (value) => value === "lattice" ? value : DEFAULT_THEME;
const normalizeThemeModePreference = (value) => ["dark", "light", "system"].includes(value) ? value : null;
const platformBrandingLegacyCompatibilitySettings = (branding) => ({
  platform_name: branding.brand.name,
  platform_cover: branding.logo,
  welcome_message: branding.brand.welcomeMessage,
});
${executableDeclarations}
globalThis.__publicSettingsContract = { PUBLIC_DATABASE_SETTING_KEYS, buildPublicSettingsDto };
`;
const compiled = ts.transpileModule(executableSource, {
  compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sandbox: {
  __publicSettingsContract?: {
    PUBLIC_DATABASE_SETTING_KEYS: readonly string[];
    buildPublicSettingsDto: (
      rows: Array<{ setting_key: string; setting_value: string }>,
      branding: Record<string, unknown>,
    ) => { settings: Record<string, string> };
  };
} = {};
vm.runInNewContext(compiled, sandbox, { filename: routePath });
const runtimeContract = sandbox.__publicSettingsContract;
assert.ok(runtimeContract, "public DTO projector must be executable in isolation");

const dto = runtimeContract.buildPublicSettingsDto([
  { setting_key: "theme", setting_value: "lattice" },
  { setting_key: "theme_mode", setting_value: "dark" },
  { setting_key: "theme_primary_color", setting_value: "#2F80FF" },
  { setting_key: "page_layout", setting_value: '{"card":{"globalTitleSize":18}}' },
  { setting_key: "card_layout", setting_value: '{"globalBodySize":15}' },
  { setting_key: "video_page_config", setting_value: '{"columns":3}' },
  { setting_key: "global_system_prefix", setting_value: "PRIVATE SYSTEM PROMPT" },
  { setting_key: "profit_margin", setting_value: "0.2" },
  { setting_key: "coze_api_token", setting_value: "sk-private" },
], {
  source: "published",
  generation: 4,
  revisionId: "revision",
  revisionVersion: 7,
  publishedAt: "2026-10-03T00:00:00.000Z",
  brand: { name: "公开品牌", welcomeMessage: "欢迎" },
  logo: "/logo.png",
});
assert.deepEqual(
  Object.keys(dto.settings).sort(),
  [
    "card_layout",
    "page_layout",
    "platform_cover",
    "platform_name",
    "theme",
    "theme_mode",
    "theme_primary_color",
    "video_page_config",
    "welcome_message",
  ],
  "rogue database rows must not survive the public DTO projection",
);
for (const forbidden of ["global_system_prefix", "profit_margin", "coze_api_token"]) {
  assert.equal(dto.settings[forbidden], undefined, `${forbidden} leaked through the public DTO`);
}
assert.equal(dto.settings.page_layout, '{"card":{"globalTitleSize":18}}');
assert.equal(dto.settings.card_layout, '{"globalBodySize":15}');
assert.equal(dto.settings.video_page_config, '{"columns":3}');

const adminGetSource = exportedFunctionSource(
  adminRouteSource,
  "src/app/api/settings/admin/route.ts",
  "GET",
);
assert.match(
  adminGetSource,
  /requestedScope\(request\)[\s\S]*?authorizeScope\(request, scope, "read"\)/u,
  "admin settings GET must require an explicit capability scope",
);
assert.match(adminRouteSource, /authorizeAdminCapability\(request, adminPlatformSettingPermission\(scope, mode\), \{[\s\S]*?requireStepUp: true/u);
assert.match(adminGetSource, /adminPlatformSettingKeysForScope\(scope\)/u);
assert.match(adminGetSource, /redactPlatformSettings\(data \|\| \[\]\)/u);
const adminPostSource = exportedFunctionSource(
  adminRouteSource,
  "src/app/api/settings/admin/route.ts",
  "POST",
);
assert.match(
  adminPostSource,
  /parsePlatformSettingPatch\(body, "admin"\)/u,
  "admin writes must use the same typed admin allowlist as reads",
);
assert.match(adminPostSource, /adminPlatformSettingScopesForKeys\(keys\)/u);
assert.match(adminPostSource, /authorizeScope\(request, scope, "write"\)/u);
assert.match(adminPostSource, /PLATFORM_SETTING_SCOPE_MISMATCH/u);

assert.match(themeInitSource, /applyThemeColorSettings\(data\.settings \|\| \{\}\)/u);
assert.match(themeInitSource, /data\.settings\?\.theme/u);
assert.match(themeInitSource, /data\.settings\?\.theme_mode/u);
assert.match(appContextSource, /settingsData\.settings\?\.theme/u);
assert.match(appContextSource, /settingsData\.settings\?\.theme_mode/u);
assert.match(homeSource, /d\.settings\?\.page_layout/u);
assert.match(homeSource, /d\.settings\?\.card_layout/u);
assert.match(
  adminPageSource,
  /if \(!sensitiveUnlocked \|\| !sensitiveUnlockedRef\.current \|\| readableSettingScopes\.length === 0\) return;[\s\S]*?readableSettingScopes\.map[\s\S]*?fetch\(`\/api\/settings\/admin\?scope=\$\{scope\}`/u,
  "admin page must read only granted scopes after step-up is ready",
);
assert.match(adminPageSource, /if \(!sensitiveUnlockedRef\.current\) return;[\s\S]*?setSettings\(\(prev\)/u, "relocking during a settings read must discard its sensitive response");

console.log(JSON.stringify({
  status: "PASS",
  publicDatabaseKeys,
  rejectedInternalGeneralKeyCount: internalGeneralKeys.length,
  rejectedFixtures: ["global_system_prefix", "profit_margin", "coze_api_token"],
  consumerCompatibility: ["theme", "theme colors", "page_layout", "card_layout", "video_page_config"],
  adminInternalKeyCoverage: `${internalGeneralKeys.length}/${internalGeneralKeys.length}`,
  preservedAdminTokenCosts: globalTokenCostKeys,
  adminSensitiveRead: "field scope capability + step-up + redaction + typed DTO",
  databaseReads: 0,
  databaseWrites: 0,
  paidRequests: 0,
}, null, 2));
