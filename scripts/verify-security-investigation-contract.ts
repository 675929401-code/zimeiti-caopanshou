import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const page = read("src/app/admin/page.tsx");
const securityCenter = read("src/components/admin/security-center-admin-tab.tsx");
const panel = read("src/components/admin/security-event-investigation.tsx");
const route = read("src/app/api/admin/security-events/[id]/investigation/route.ts");
const service = read("src/lib/server/security-event-investigation.ts");
const loginRoute = read("src/app/api/auth/login/route.ts");
const authSessionClientIp = read("src/lib/auth-session-client-ip.ts");

// Manually audited against TypeScript-printer-normalized full-file ASTs. These
// pins are intentionally constants: updating either requires an explicit audit.
// Reviewed remember-me change: DB session, JWT and cookie share a 3/30-day TTL.
// This remains a fixed pin; executable drift still requires explicit review.
const EXPECTED_LOGIN_FULL_FILE_AST_SHA256 = "16aa97d5e5200f959938dcd25460d1b1b68220cc8ed711b2436501433b2e95bd";
const EXPECTED_AUTH_SESSION_CLIENT_IP_FULL_FILE_AST_SHA256 = "b82c161cb59c6c6b36685d34640833519f8cceeacf3504a99ae2e6186918299f";

function parseTypeScript(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function normalizedFullFileAstSha256(source: string, fileName: string): string {
  const sourceFile = parseTypeScript(source, fileName);
  const normalized = ts.createPrinter({
    removeComments: true,
    newLine: ts.NewLineKind.LineFeed,
  }).printFile(sourceFile);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function valueImportBinding(
  sourceFile: ts.SourceFile,
  moduleName: string,
  importedName: string,
  errorPrefix: string,
): string {
  let typeOnly = false;
  let binding: string | null = null;
  let localImportCount = 0;
  const recordLocalImport = (localName: string): void => {
    if (localName !== importedName) return;
    localImportCount += 1;
    assert.equal(localImportCount, 1, `${errorPrefix}_DUPLICATE_LOCAL_IMPORT_FORBIDDEN`);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isImportEqualsDeclaration(statement) && statement.name.text === importedName) {
      recordLocalImport(statement.name.text);
      assert.fail(`${errorPrefix}_MODULE_IMPORT_BINDING_SHADOWED`);
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const importClause = statement.importClause;
    if (!importClause) continue;
    const sourceModule = statement.moduleSpecifier.text;
    if (importClause.name?.text === importedName) {
      recordLocalImport(importClause.name.text);
      assert.fail(`${errorPrefix}_MODULE_IMPORT_BINDING_SHADOWED`);
    }
    const bindings = importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === importedName) {
      recordLocalImport(bindings.name.text);
      assert.fail(`${errorPrefix}_MODULE_IMPORT_BINDING_SHADOWED`);
    }
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      const local = element.name.text;
      recordLocalImport(local);
      if (local === importedName && (sourceModule !== moduleName || imported !== importedName)) {
        assert.fail(`${errorPrefix}_MODULE_IMPORT_BINDING_SHADOWED`);
      }
      if (sourceModule !== moduleName || imported !== importedName) continue;
      if (importClause.isTypeOnly || element.isTypeOnly) {
        typeOnly = true;
        continue;
      }
      assert.equal(local, importedName, `${errorPrefix}_IMPORT_ALIAS_FORBIDDEN`);
      assert.equal(binding, null, `${errorPrefix}_DUPLICATE_VALUE_IMPORT_FORBIDDEN`);
      binding = local;
    }
  }
  if (binding) return binding;
  assert.equal(typeOnly, false, `${errorPrefix}_TYPE_ONLY_IMPORT_FORBIDDEN`);
  assert.fail(`${errorPrefix}_VALUE_IMPORT_REQUIRED`);
}

function exportedFunction(sourceFile: ts.SourceFile, name: string, errorPrefix: string): ts.FunctionDeclaration {
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== name) continue;
    assert.ok(statement.body, `${errorPrefix}_FUNCTION_BODY_REQUIRED`);
    assert.ok(
      statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword),
      `${errorPrefix}_FUNCTION_EXPORT_REQUIRED`,
    );
    return statement;
  }
  assert.fail(`${errorPrefix}_FUNCTION_REQUIRED`);
}

function requiredRequestParameter(
  declaration: ts.FunctionDeclaration,
  errorPrefix: string,
): string {
  assert.equal(declaration.parameters.length, 1, `${errorPrefix}_SINGLE_REQUEST_PARAMETER_REQUIRED`);
  const parameter = declaration.parameters[0];
  assert.equal(parameter.questionToken, undefined, `${errorPrefix}_OPTIONAL_REQUEST_FORBIDDEN`);
  assert.equal(parameter.dotDotDotToken, undefined, `${errorPrefix}_REST_REQUEST_FORBIDDEN`);
  assert.ok(ts.isIdentifier(parameter.name), `${errorPrefix}_IDENTIFIER_REQUEST_REQUIRED`);
  return parameter.name.text;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap(element => (
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  ));
}

function assertNoFunctionBindingShadow(
  declaration: ts.FunctionDeclaration,
  protectedBinding: string,
  errorPrefix: string,
): void {
  assert.ok(declaration.body, `${errorPrefix}_FUNCTION_BODY_REQUIRED`);
  const checkBinding = (name: ts.BindingName): void => {
    if (bindingNames(name).includes(protectedBinding)) {
      assert.fail(`${errorPrefix}_IMPORTED_BINDING_SHADOWED`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) checkBinding(node.name);
    if ((ts.isFunctionDeclaration(node)
        || ts.isFunctionExpression(node)
        || ts.isClassDeclaration(node)
        || ts.isClassExpression(node))
      && node.name?.text === protectedBinding) {
      assert.fail(`${errorPrefix}_IMPORTED_BINDING_SHADOWED`);
    }
    ts.forEachChild(node, visit);
  };
  for (const parameter of declaration.parameters) visit(parameter);
  visit(declaration.body);
}

type TopLevelConst = {
  declaration: ts.VariableDeclaration;
  statementIndex: number;
};

function requiredTopLevelConst(
  declaration: ts.FunctionDeclaration,
  variableName: string,
  errorPrefix: string,
): TopLevelConst {
  assert.ok(declaration.body, `${errorPrefix}_FUNCTION_BODY_REQUIRED`);
  const matches: TopLevelConst[] = [];
  let controlFlowTerminated = false;
  declaration.body.statements.forEach((statement, statementIndex) => {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      controlFlowTerminated = true;
      return;
    }
    if (!ts.isVariableStatement(statement)) return;
    for (const candidate of statement.declarationList.declarations) {
      if (!ts.isIdentifier(candidate.name) || candidate.name.text !== variableName) continue;
      assert.equal(controlFlowTerminated, false, `${errorPrefix}_${variableName.toUpperCase()}_UNREACHABLE`);
      assert.equal(
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
        true,
        `${errorPrefix}_${variableName.toUpperCase()}_CONST_REQUIRED`,
      );
      assert.equal(
        statement.declarationList.declarations.length,
        1,
        `${errorPrefix}_${variableName.toUpperCase()}_SINGLE_DECLARATION_REQUIRED`,
      );
      assert.ok(candidate.initializer, `${errorPrefix}_${variableName.toUpperCase()}_INITIALIZER_REQUIRED`);
      matches.push({ declaration: candidate, statementIndex });
    }
  });
  assert.equal(matches.length, 1, `${errorPrefix}_${variableName.toUpperCase()}_EXACT_TOP_LEVEL_DECLARATION_REQUIRED`);
  return matches[0];
}

function assertDirectBoundCall(
  expression: ts.Expression,
  bindingName: string,
  argumentName: string,
  errorPrefix: string,
): void {
  assert.ok(ts.isCallExpression(expression), `${errorPrefix}_DIRECT_CALL_REQUIRED`);
  assert.equal(expression.questionDotToken, undefined, `${errorPrefix}_OPTIONAL_CALL_FORBIDDEN`);
  assert.ok(ts.isIdentifier(expression.expression), `${errorPrefix}_IDENTIFIER_CALLEE_REQUIRED`);
  assert.equal(expression.expression.text, bindingName, `${errorPrefix}_IMPORTED_BINDING_CALL_REQUIRED`);
  assert.equal(expression.arguments.length, 1, `${errorPrefix}_SINGLE_REQUEST_ARGUMENT_REQUIRED`);
  assert.ok(ts.isIdentifier(expression.arguments[0]), `${errorPrefix}_REQUEST_ARGUMENT_IDENTIFIER_REQUIRED`);
  assert.equal(expression.arguments[0].text, argumentName, `${errorPrefix}_SAME_REQUEST_ARGUMENT_REQUIRED`);
}

function requiredZeroArgumentMethodCall(
  expression: ts.Expression,
  methodName: string,
  errorPrefix: string,
): ts.Expression {
  assert.ok(ts.isCallExpression(expression), `${errorPrefix}_${methodName.toUpperCase()}_CALL_REQUIRED`);
  assert.equal(expression.questionDotToken, undefined, `${errorPrefix}_${methodName.toUpperCase()}_OPTIONAL_FORBIDDEN`);
  assert.equal(expression.arguments.length, 0, `${errorPrefix}_${methodName.toUpperCase()}_ZERO_ARGUMENTS_REQUIRED`);
  assert.ok(ts.isPropertyAccessExpression(expression.expression), `${errorPrefix}_${methodName.toUpperCase()}_PROPERTY_REQUIRED`);
  assert.equal(expression.expression.questionDotToken, undefined, `${errorPrefix}_${methodName.toUpperCase()}_OPTIONAL_PROPERTY_FORBIDDEN`);
  assert.equal(expression.expression.name.text, methodName, `${errorPrefix}_${methodName.toUpperCase()}_METHOD_REQUIRED`);
  return expression.expression.expression;
}

function assertTrustedBusinessUse(
  wrapper: ts.FunctionDeclaration,
  trustedStatementIndex: number,
): void {
  assert.ok(wrapper.body, "HELPER_WRAPPER_FUNCTION_BODY_REQUIRED");
  const statement = wrapper.body.statements[trustedStatementIndex + 1];
  assert.ok(statement && ts.isIfStatement(statement), "HELPER_TRUSTED_IMMEDIATE_IF_REQUIRED");
  assert.equal(statement.elseStatement, undefined, "HELPER_TRUSTED_IF_ELSE_FORBIDDEN");
  const condition = statement.expression;
  assert.ok(ts.isBinaryExpression(condition), "HELPER_TRUSTED_AND_CONDITION_REQUIRED");
  assert.equal(condition.operatorToken.kind, ts.SyntaxKind.AmpersandAmpersandToken, "HELPER_TRUSTED_AND_CONDITION_REQUIRED");
  assert.ok(ts.isIdentifier(condition.left), "HELPER_TRUSTED_LEFT_IDENTIFIER_REQUIRED");
  assert.equal(condition.left.text, "trusted", "HELPER_TRUSTED_LEFT_BINDING_REQUIRED");
  assert.ok(ts.isBinaryExpression(condition.right), "HELPER_TRUSTED_UNKNOWN_COMPARISON_REQUIRED");
  assert.equal(condition.right.operatorToken.kind, ts.SyntaxKind.ExclamationEqualsEqualsToken, "HELPER_TRUSTED_STRICT_UNKNOWN_COMPARISON_REQUIRED");
  assert.ok(ts.isIdentifier(condition.right.left), "HELPER_TRUSTED_COMPARISON_IDENTIFIER_REQUIRED");
  assert.equal(condition.right.left.text, "trusted", "HELPER_TRUSTED_COMPARISON_BINDING_REQUIRED");
  assert.ok(ts.isStringLiteral(condition.right.right), "HELPER_TRUSTED_UNKNOWN_LITERAL_REQUIRED");
  assert.equal(condition.right.right.text, "unknown", "HELPER_TRUSTED_UNKNOWN_LITERAL_REQUIRED");
  assert.ok(ts.isReturnStatement(statement.thenStatement), "HELPER_TRUSTED_DIRECT_RETURN_REQUIRED");
  assert.ok(statement.thenStatement.expression && ts.isIdentifier(statement.thenStatement.expression), "HELPER_TRUSTED_RETURN_IDENTIFIER_REQUIRED");
  assert.equal(statement.thenStatement.expression.text, "trusted", "HELPER_TRUSTED_RETURN_BINDING_REQUIRED");
}

function assertStructuralSharedClientIpDelegation(loginSource: string, helperSource: string): void {
  const loginAst = parseTypeScript(loginSource, "login-route.ts");
  const helperAst = parseTypeScript(helperSource, "auth-session-client-ip.ts");
  const loginBinding = valueImportBinding(
    loginAst,
    "@/lib/auth-session-client-ip",
    "getAuthSessionClientIP",
    "LOGIN_SHARED_PARSER",
  );
  const post = exportedFunction(loginAst, "POST", "LOGIN_POST");
  const postRequest = requiredRequestParameter(post, "LOGIN_POST");
  assertNoFunctionBindingShadow(post, loginBinding, "LOGIN_SHARED_PARSER");
  const clientIp = requiredTopLevelConst(post, "clientIP", "LOGIN_SHARED_PARSER");
  assertDirectBoundCall(clientIp.declaration.initializer!, loginBinding, postRequest, "LOGIN_SHARED_PARSER");

  const trustedParserBinding = valueImportBinding(
    helperAst,
    "@/lib/security",
    "getClientIP",
    "HELPER_TRUSTED_PARSER",
  );
  const wrapper = exportedFunction(helperAst, "getAuthSessionClientIP", "HELPER_WRAPPER");
  const wrapperRequest = requiredRequestParameter(wrapper, "HELPER_WRAPPER");
  assertNoFunctionBindingShadow(wrapper, trustedParserBinding, "HELPER_TRUSTED_PARSER");
  const trusted = requiredTopLevelConst(wrapper, "trusted", "HELPER_TRUSTED_PARSER");
  const trimCall = requiredZeroArgumentMethodCall(
    trusted.declaration.initializer!,
    "toLowerCase",
    "HELPER_TRUSTED_SHAPE",
  );
  const parserCall = requiredZeroArgumentMethodCall(trimCall, "trim", "HELPER_TRUSTED_SHAPE");
  assertDirectBoundCall(parserCall, trustedParserBinding, wrapperRequest, "HELPER_TRUSTED_PARSER");
  assertTrustedBusinessUse(wrapper, trusted.statementIndex);
}

function assertPinnedSharedClientIpDelegation(loginSource: string, helperSource: string): void {
  assert.equal(
    normalizedFullFileAstSha256(loginSource, "login-route.ts"),
    EXPECTED_LOGIN_FULL_FILE_AST_SHA256,
    "LOGIN_FULL_FILE_AST_DRIFT",
  );
  assert.equal(
    normalizedFullFileAstSha256(helperSource, "auth-session-client-ip.ts"),
    EXPECTED_AUTH_SESSION_CLIENT_IP_FULL_FILE_AST_SHA256,
    "HELPER_FULL_FILE_AST_DRIFT",
  );
  assertStructuralSharedClientIpDelegation(loginSource, helperSource);
}

assert.match(page, /import\("@\/components\/admin\/security-center-admin-tab"\)/u, "管理员页必须加载独立安全中心组件");
assert.match(page, /<SecurityCenterAdminTab[\s\S]*?sensitiveUnlocked=\{sensitiveUnlocked\}/u, "安全中心入口必须传递再次验证状态");
assert.match(securityCenter, /高\/严重风险关联账号 Top10/u, "风险榜必须表达为关联账号，不能直接归因账号本人");
assert.match(securityCenter, /不等于账号持有人实施攻击/u, "列表必须声明账号关联的证据边界");
assert.doesNotMatch(securityCenter, /高\/严重风险用户 Top10/u, "风险榜不得退回到直接归因账号本人的旧文案");
assert.match(securityCenter, /<SecurityEventInvestigation/u, "安全事件展开区必须接入调查组件");
assert.match(securityCenter, /sensitiveUnlocked=\{sensitiveUnlocked\}/u, "调查入口必须绑定再次验证状态");

assert.match(panel, /normalizedReason\.length < 8/u, "调查揭示必须要求具体原因");
assert.match(panel, /ADMIN_STEP_UP_REQUIRED/u, "调查揭示必须处理再次验证门禁");
assert.match(panel, /cache: "no-store"/u, "调查请求不得使用浏览器缓存");
assert.match(panel, /if \(sensitiveUnlocked\) return;\s*setInvestigation\(null\)/u, "解锁失效时必须从 DOM 移除调查结果");
assert.doesNotMatch(panel, /localStorage|sessionStorage/u, "完整 IP 调查组件不得把证据写入浏览器存储");
for (const label of ["主体归因", "网络线索", "地区与网络情报", "设备与自动化特征", "同网络关联", "同账号关联", "证据缺口与口径"]) {
  assert.ok(panel.includes(label), `调查面板缺少 ${label}`);
}
for (const field of ["province", "city", "county", "precision", "statement", "proxyChainStatus", "rawIpStored"]) {
  assert.ok(panel.includes(field), `调查面板缺少 ${field} 证据字段`);
}

assert.match(route, /authorizeAdminCapability\([\s\S]*?"security\.manage"/u, "调查接口必须使用 security.manage");
assert.match(route, /requireStepUp:\s*true/u, "调查接口必须要求再次验证");
assert.match(route, /privateResponse\(authorizationResult\.response\)/u, "鉴权拒绝响应也必须按会话隔离且禁止缓存");
assert.match(route, /appendAdminGovernanceAudit/u, "调查接口必须记录单条揭示审计");
assert.match(route, /SECURITY_INVESTIGATION_AUDIT_UNAVAILABLE/u, "审计失败时必须拒绝返回原始证据");
assert.match(route, /reason[^\n]{0,120}(?:length|trim)/u, "调查接口必须校验调查原因");
assert.match(route, /Cache-Control["']?:?\s*["'][^"']*private[^"']*no-store[^"']*max-age=0/iu, "敏感响应必须 private/no-store/max-age=0");
assert.match(service, /targeting_registered_student/u, "失败登录命中学员账号必须与本人攻击分类分离");
assert.match(service, /provider_not_configured/u, "未配置地理数据源时必须显式报告，不能伪造地区");
assert.match(service, /privacy_preserving_hash_only/u, "仅保存哈希时必须显式报告不可逆证据状态");
assert.doesNotMatch(service, /whois\.pconline|ip-api\.com|fetch\s*\(\s*["'`]https?:/iu, "调查读取不得把原始 IP 临时发送给未审核第三方");

assertPinnedSharedClientIpDelegation(loginRoute, authSessionClientIp);

function replaceRequired(source: string, before: string, after: string, label: string): string {
  assert.ok(source.includes(before), `${label}_FIXTURE_SOURCE_MISSING`);
  return source.replace(before, after);
}

function expectDelegationFailure(
  label: string,
  loginSource: string,
  helperSource: string,
  expected: RegExp,
): void {
  assert.throws(
    () => assertStructuralSharedClientIpDelegation(loginSource, helperSource),
    expected,
    `${label} fixture must fail for the expected binding or reachability reason`,
  );
}

function expectFullFileAstDrift(
  label: string,
  loginSource: string,
  helperSource: string,
  expected: RegExp,
): void {
  assert.throws(
    () => assertPinnedSharedClientIpDelegation(loginSource, helperSource),
    expected,
    `${label} fixture must fail at the full-file AST pin before structural checks`,
  );
}

const loginImport = 'import { getAuthSessionClientIP } from "@/lib/auth-session-client-ip";';
const loginCall = "  const clientIP = getAuthSessionClientIP(request);";
const helperImport = 'import { getClientIP } from "@/lib/security";';
const helperCall = "  const trusted = getClientIP(request).trim().toLowerCase();";

const maliciousFixtures = [
  {
    label: "login-import-type",
    login: replaceRequired(loginRoute, loginImport, loginImport.replace("import {", "import type {"), "LOGIN_IMPORT_TYPE"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_TYPE_ONLY_IMPORT_FORBIDDEN/u,
  },
  {
    label: "login-duplicate-type-import",
    login: `${loginRoute}\nimport type { getAuthSessionClientIP } from "@/lib/auth-session-client-ip";`,
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_DUPLICATE_LOCAL_IMPORT_FORBIDDEN/u,
  },
  {
    label: "login-second-import-shadow",
    login: `${loginRoute}\nimport { fakeParser as getAuthSessionClientIP } from "@/lib/fake";`,
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_DUPLICATE_LOCAL_IMPORT_FORBIDDEN/u,
  },
  {
    label: "login-import-equals-shadow",
    login: `${loginRoute}\nimport getAuthSessionClientIP = require("@/lib/fake");`,
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_DUPLICATE_LOCAL_IMPORT_FORBIDDEN/u,
  },
  {
    label: "login-shadow",
    login: replaceRequired(loginRoute, loginCall, `  const getAuthSessionClientIP = (_request: Request) => "fake";\n${loginCall}`, "LOGIN_SHADOW"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_IMPORTED_BINDING_SHADOWED/u,
  },
  {
    label: "login-fake-receiver",
    login: replaceRequired(loginRoute, loginCall, "  const clientIP = fake.getAuthSessionClientIP(request);", "LOGIN_RECEIVER"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_IDENTIFIER_CALLEE_REQUIRED/u,
  },
  {
    label: "login-alias",
    login: replaceRequired(loginRoute, loginCall, "  const parser = getAuthSessionClientIP;\n  const clientIP = parser(request);", "LOGIN_ALIAS"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_IMPORTED_BINDING_CALL_REQUIRED/u,
  },
  {
    label: "login-optional-call",
    login: replaceRequired(loginRoute, loginCall, "  const clientIP = getAuthSessionClientIP?.(request);", "LOGIN_OPTIONAL"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_OPTIONAL_CALL_FORBIDDEN/u,
  },
  {
    label: "login-if-false",
    login: replaceRequired(loginRoute, loginCall, `  if (false) {\n${loginCall}\n  }`, "LOGIN_IF_FALSE"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_CLIENTIP_EXACT_TOP_LEVEL_DECLARATION_REQUIRED/u,
  },
  {
    label: "login-nested-function",
    login: replaceRequired(loginRoute, loginCall, `  function hiddenParser() {\n${loginCall}\n    return clientIP;\n  }`, "LOGIN_NESTED"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_CLIENTIP_EXACT_TOP_LEVEL_DECLARATION_REQUIRED/u,
  },
  {
    label: "login-nested-class",
    login: replaceRequired(loginRoute, loginCall, `  class HiddenParser {\n    parse() {\n${loginCall}\n      return clientIP;\n    }\n  }`, "LOGIN_NESTED_CLASS"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_CLIENTIP_EXACT_TOP_LEVEL_DECLARATION_REQUIRED/u,
  },
  {
    label: "login-after-return",
    login: replaceRequired(loginRoute, loginCall, `  return NextResponse.json({ blocked: true });\n${loginCall}`, "LOGIN_AFTER_RETURN"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_CLIENTIP_UNREACHABLE/u,
  },
  {
    label: "login-destructure-shadow-before",
    login: replaceRequired(loginRoute, loginCall, `  const { nested: { getAuthSessionClientIP = fallback } = {} } = fixture;\n${loginCall}`, "LOGIN_DESTRUCTURE_BEFORE"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_IMPORTED_BINDING_SHADOWED/u,
  },
  {
    label: "login-destructure-shadow-after",
    login: replaceRequired(loginRoute, loginCall, `${loginCall}\n  const [head, ...getAuthSessionClientIP] = fixture;`, "LOGIN_DESTRUCTURE_AFTER"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_IMPORTED_BINDING_SHADOWED/u,
  },
  {
    label: "login-nested-binding-shadow",
    login: replaceRequired(loginRoute, loginCall, `${loginCall}\n  function nested({ deep: [getAuthSessionClientIP] }: any) { return getAuthSessionClientIP; }`, "LOGIN_NESTED_BINDING"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_IMPORTED_BINDING_SHADOWED/u,
  },
  {
    label: "login-true-ternary",
    login: replaceRequired(loginRoute, loginCall, "  const clientIP = true ? getAuthSessionClientIP(request) : null;", "LOGIN_TRUE_TERNARY"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_DIRECT_CALL_REQUIRED/u,
  },
  {
    label: "login-unknown-ternary",
    login: replaceRequired(loginRoute, loginCall, "  const clientIP = condition ? getAuthSessionClientIP(request) : null;", "LOGIN_UNKNOWN_TERNARY"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_DIRECT_CALL_REQUIRED/u,
  },
  {
    label: "login-comma-expression",
    login: replaceRequired(loginRoute, loginCall, "  const clientIP = (audit(), getAuthSessionClientIP(request));", "LOGIN_COMMA"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_DIRECT_CALL_REQUIRED/u,
  },
  {
    label: "login-call-result-discarded",
    login: replaceRequired(loginRoute, loginCall, "  getAuthSessionClientIP(request);\n  const clientIP = null;", "LOGIN_DISCARDED"),
    helper: authSessionClientIp,
    expected: /LOGIN_SHARED_PARSER_DIRECT_CALL_REQUIRED/u,
  },
  {
    label: "helper-import-type",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperImport, helperImport.replace("import {", "import type {"), "HELPER_IMPORT_TYPE"),
    expected: /HELPER_TRUSTED_PARSER_TYPE_ONLY_IMPORT_FORBIDDEN/u,
  },
  {
    label: "helper-duplicate-type-import",
    login: loginRoute,
    helper: `${authSessionClientIp}\nimport type { getClientIP } from "@/lib/security";`,
    expected: /HELPER_TRUSTED_PARSER_DUPLICATE_LOCAL_IMPORT_FORBIDDEN/u,
  },
  {
    label: "helper-second-import-shadow",
    login: loginRoute,
    helper: `${authSessionClientIp}\nimport { fakeParser as getClientIP } from "@/lib/fake";`,
    expected: /HELPER_TRUSTED_PARSER_DUPLICATE_LOCAL_IMPORT_FORBIDDEN/u,
  },
  {
    label: "helper-import-equals-shadow",
    login: loginRoute,
    helper: `${authSessionClientIp}\nimport getClientIP = require("@/lib/fake");`,
    expected: /HELPER_TRUSTED_PARSER_DUPLICATE_LOCAL_IMPORT_FORBIDDEN/u,
  },
  {
    label: "helper-shadow",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, `  const getClientIP = (_request: Request) => "fake";\n${helperCall}`, "HELPER_SHADOW"),
    expected: /HELPER_TRUSTED_PARSER_IMPORTED_BINDING_SHADOWED/u,
  },
  {
    label: "helper-fake-receiver",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, "  const trusted = fake.getClientIP(request).trim().toLowerCase();", "HELPER_RECEIVER"),
    expected: /HELPER_TRUSTED_PARSER_IDENTIFIER_CALLEE_REQUIRED/u,
  },
  {
    label: "helper-alias",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, "  const parser = getClientIP;\n  const trusted = parser(request).trim().toLowerCase();", "HELPER_ALIAS"),
    expected: /HELPER_TRUSTED_PARSER_IMPORTED_BINDING_CALL_REQUIRED/u,
  },
  {
    label: "helper-optional-call",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, "  const trusted = getClientIP?.(request).trim().toLowerCase();", "HELPER_OPTIONAL"),
    expected: /HELPER_TRUSTED_PARSER_OPTIONAL_CALL_FORBIDDEN/u,
  },
  {
    label: "helper-if-false",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, `  if (false) {\n${helperCall}\n  }`, "HELPER_IF_FALSE"),
    expected: /HELPER_TRUSTED_PARSER_TRUSTED_EXACT_TOP_LEVEL_DECLARATION_REQUIRED/u,
  },
  {
    label: "helper-static-false-expression",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, '  const trusted = false ? getClientIP(request) : "unknown";', "HELPER_STATIC_FALSE"),
    expected: /HELPER_TRUSTED_SHAPE_TOLOWERCASE_CALL_REQUIRED/u,
  },
  {
    label: "helper-static-false-and",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, '  const trusted = false && getClientIP(request);', "HELPER_STATIC_FALSE_AND"),
    expected: /HELPER_TRUSTED_SHAPE_TOLOWERCASE_CALL_REQUIRED/u,
  },
  {
    label: "helper-nested-function",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, "  const trusted = (() => getClientIP(request))();", "HELPER_NESTED"),
    expected: /HELPER_TRUSTED_SHAPE_TOLOWERCASE_PROPERTY_REQUIRED/u,
  },
  {
    label: "helper-nested-class",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, "  const trusted = class HiddenParser { parse() { return getClientIP(request); } };", "HELPER_NESTED_CLASS"),
    expected: /HELPER_TRUSTED_SHAPE_TOLOWERCASE_CALL_REQUIRED/u,
  },
  {
    label: "helper-after-return",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, `  return null;\n${helperCall}`, "HELPER_AFTER_RETURN"),
    expected: /HELPER_TRUSTED_PARSER_TRUSTED_UNREACHABLE/u,
  },
  {
    label: "helper-string-comment-only",
    login: loginRoute,
    helper: `${replaceRequired(authSessionClientIp, helperCall, '  const trusted = "getClientIP(request)";', "HELPER_STRING")}\n// getClientIP(request)`,
    expected: /HELPER_TRUSTED_SHAPE_TOLOWERCASE_CALL_REQUIRED/u,
  },
  {
    label: "helper-destructure-shadow-before",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, `  const { nested: { getClientIP = fallback } = {} } = fixture;\n${helperCall}`, "HELPER_DESTRUCTURE_BEFORE"),
    expected: /HELPER_TRUSTED_PARSER_IMPORTED_BINDING_SHADOWED/u,
  },
  {
    label: "helper-destructure-shadow-after",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, `${helperCall}\n  const [head, ...getClientIP] = fixture;`, "HELPER_DESTRUCTURE_AFTER"),
    expected: /HELPER_TRUSTED_PARSER_IMPORTED_BINDING_SHADOWED/u,
  },
  {
    label: "helper-nested-binding-shadow",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, `${helperCall}\n  try {} catch ({ reason: { getClientIP } }) { void getClientIP; }`, "HELPER_NESTED_BINDING"),
    expected: /HELPER_TRUSTED_PARSER_IMPORTED_BINDING_SHADOWED/u,
  },
  {
    label: "helper-true-ternary",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, '  const trusted = (true ? getClientIP(request) : "unknown").trim().toLowerCase();', "HELPER_TRUE_TERNARY"),
    expected: /HELPER_TRUSTED_PARSER_DIRECT_CALL_REQUIRED/u,
  },
  {
    label: "helper-unknown-ternary",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, '  const trusted = (condition ? getClientIP(request) : "unknown").trim().toLowerCase();', "HELPER_UNKNOWN_TERNARY"),
    expected: /HELPER_TRUSTED_PARSER_DIRECT_CALL_REQUIRED/u,
  },
  {
    label: "helper-comma-expression",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, "  const trusted = (audit(), getClientIP(request)).trim().toLowerCase();", "HELPER_COMMA"),
    expected: /HELPER_TRUSTED_PARSER_DIRECT_CALL_REQUIRED/u,
  },
  {
    label: "helper-call-result-discarded",
    login: loginRoute,
    helper: replaceRequired(authSessionClientIp, helperCall, '  getClientIP(request);\n  const trusted = "unknown";', "HELPER_DISCARDED"),
    expected: /HELPER_TRUSTED_SHAPE_TOLOWERCASE_CALL_REQUIRED/u,
  },
];

for (const fixture of maliciousFixtures) {
  expectDelegationFailure(fixture.label, fixture.login, fixture.helper, fixture.expected);
}

const fullFileAstDriftFixtures = [
  {
    label: "login-appended-executable",
    login: `${loginRoute}\nvoid "round4-appended-executable";`,
    helper: authSessionClientIp,
    expected: /LOGIN_FULL_FILE_AST_DRIFT/u,
  },
  {
    label: "login-insert-if-true-return",
    login: replaceRequired(
      loginRoute,
      loginCall,
      `  if (true) return NextResponse.json({ error: "fixture" });\n${loginCall}`,
      "LOGIN_FULL_AST_IF_TRUE",
    ),
    helper: authSessionClientIp,
    expected: /LOGIN_FULL_FILE_AST_DRIFT/u,
  },
  {
    label: "login-insert-switch-return",
    login: replaceRequired(
      loginRoute,
      loginCall,
      `  switch ("fixture") { case "fixture": return NextResponse.json({ error: "fixture" }); }\n${loginCall}`,
      "LOGIN_FULL_AST_SWITCH",
    ),
    helper: authSessionClientIp,
    expected: /LOGIN_FULL_FILE_AST_DRIFT/u,
  },
  {
    label: "helper-insert-try-return",
    login: loginRoute,
    helper: replaceRequired(
      authSessionClientIp,
      helperCall,
      `  try { return "fixture"; } finally {}\n${helperCall}`,
      "HELPER_FULL_AST_TRY",
    ),
    expected: /HELPER_FULL_FILE_AST_DRIFT/u,
  },
  {
    label: "helper-insert-while-true",
    login: loginRoute,
    helper: replaceRequired(
      authSessionClientIp,
      helperCall,
      `  while (true) { return "fixture"; }\n${helperCall}`,
      "HELPER_FULL_AST_WHILE",
    ),
    expected: /HELPER_FULL_FILE_AST_DRIFT/u,
  },
  {
    label: "login-duplicate-type-import-before-structure",
    login: `${loginRoute}\nimport type { getAuthSessionClientIP } from "@/lib/auth-session-client-ip";`,
    helper: authSessionClientIp,
    expected: /LOGIN_FULL_FILE_AST_DRIFT/u,
  },
  {
    label: "helper-duplicate-type-import-before-structure",
    login: loginRoute,
    helper: `${authSessionClientIp}\nimport type { getClientIP } from "@/lib/security";`,
    expected: /HELPER_FULL_FILE_AST_DRIFT/u,
  },
];

for (const fixture of fullFileAstDriftFixtures) {
  expectFullFileAstDrift(fixture.label, fixture.login, fixture.helper, fixture.expected);
}

assertPinnedSharedClientIpDelegation(
  `// round4 trivia-only login comment\n\n${loginRoute}\n/* trailing trivia */\n`,
  `\n/* round4 trivia-only helper comment */\n${authSessionClientIp}\n// trailing trivia\n`,
);
assert.doesNotMatch(loginRoute, /function getClientIP/u, "登录接口不得继续维护重复且可漂移的 IP 解析器");

console.log(JSON.stringify({
  status: "passed",
  scope: "security-investigation-attribution",
  fullFileAstPins: {
    loginRoute: EXPECTED_LOGIN_FULL_FILE_AST_SHA256,
    authSessionClientIp: EXPECTED_AUTH_SESSION_CLIENT_IP_FULL_FILE_AST_SHA256,
    normalization: "TypeScript printer removeComments=true LF",
  },
  guarantees: [
    "account association is not presented as attacker identity",
    "raw IP reveal requires reason, permission and step-up",
    "sensitive evidence is not persisted in browser storage",
    "missing raw IP, proxy chain and geolocation are explicit",
    "login imports and calls getAuthSessionClientIP",
    "full recursive BindingName expansion rejects import, parameter, TDZ, destructuring, catch, function and class shadows",
    "only the exact reachable top-level const clientIP direct-call shape is accepted in POST",
    "getAuthSessionClientIP preserves the exact trim/lowercase and trusted-return business shape around getClientIP(request)",
    "full-file AST pins reject executable, string, import and control-flow drift before structural checks while permitting trivia-only changes",
    "duplicate local import names are rejected across value, type, default, namespace and import-equals forms",
    `${maliciousFixtures.length} type-only, shadow, receiver, alias, optional, conditional, comma, discarded, unreachable and nested fixtures are rejected`,
    `${fullFileAstDriftFixtures.length} real-file mutations are rejected specifically by the full-file AST drift gate`,
  ],
}, null, 2));
