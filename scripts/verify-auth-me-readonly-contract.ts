import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const routePath = fileURLToPath(new URL("../src/app/api/auth/me/route.ts", import.meta.url));
const routeSource = readFileSync(routePath, "utf8");
const syntaxTree = ts.createSourceFile(routePath, routeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const getHandler = syntaxTree.statements.find(
  (node): node is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(node)
    && node.name?.text === "GET"
    && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  ),
);
assert.ok(getHandler?.body, "auth/me 必须导出 GET");
const getSource = getHandler.getText(syntaxTree);

assert.doesNotMatch(
  routeSource,
  /(?:import|require)[\s\S]*?recoverLlmCreditReservations/,
  "auth/me 不得加载会执行信用预留恢复写入的函数",
);
assert.doesNotMatch(getSource, /\brecoverLlmCreditReservations\b/, "GET 不得触发信用预留恢复");

const forbiddenCalls = new Set([
  "rpc",
  "update",
  "insert",
  "upsert",
  "delete",
  "recoverLlmCreditReservations",
]);
const writeCalls: string[] = [];

function visit(node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const callName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee)
          && callee.argumentExpression
          && ts.isStringLiteral(callee.argumentExpression)
          ? callee.argumentExpression.text
          : "";
    if (forbiddenCalls.has(callName)) writeCalls.push(callName);
  }
  ts.forEachChild(node, visit);
}
visit(getHandler.body);
assert.deepEqual(writeCalls, [], `GET 不得调用数据库写操作或恢复函数：${writeCalls.join(", ")}`);

assert.match(
  getSource,
  /let effectiveMemberStatus = user\.member_status \|\| "inactive";/,
  "GET 必须保留响应层会员状态计算",
);
assert.match(
  getSource,
  /if \(effectiveMemberStatus === "active" && user\.member_expires_at && new Date\(user\.member_expires_at\) < new Date\(\)\) \{\s*effectiveMemberStatus = "expired";\s*\}/,
  "GET 必须把已过期的 active 会员在响应层计算为 expired",
);
assert.match(
  getSource,
  /memberStatus: effectiveMemberStatus/,
  "GET 响应必须返回计算后的会员状态",
);

console.log(JSON.stringify({
  status: "PASS",
  route: "src/app/api/auth/me/route.ts",
  getDatabaseWrites: 0,
  creditReservationRecoveryCalls: 0,
  expiredMembershipResponseProjection: true,
}, null, 2));
