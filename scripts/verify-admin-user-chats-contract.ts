import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

type ScopeCall = {
  method: "in" | "eq";
  column: string;
  value: readonly string[] | string;
};

type AdminUserChatHelpers = {
  escapeAdminUserSearchLiteral: (value: string) => string;
  buildAdminUserSearchFilter: (value: string) => string;
  applyAdminConversationScope: <T>(query: T, userIds: readonly string[], agentId: string) => T;
  createAdminAgentUsageBuckets: (
    conversations: ReadonlyArray<{ id: string; agent_id: string | null; updated_at: string | null }>,
    agentNameMap: Readonly<Record<string, string>>,
  ) => Record<string, {
    agentId: string;
    agentName: string;
    conversationCount: number;
    messageCount: number;
    lastUsed: string;
    conversationIds: string[];
  }>;
  finalizeAdminAgentUsage: (
    buckets: Record<string, {
      agentId: string;
      agentName: string;
      conversationCount: number;
      messageCount: number;
      lastUsed: string;
      conversationIds: string[];
    }>,
    messageCountMap: Readonly<Record<string, number>>,
  ) => Array<{
    agentId: string;
    agentName: string;
    conversationCount: number;
    messageCount: number;
    lastUsed: string;
  }>;
};

const routePath = resolve(process.cwd(), "src/app/api/admin/user-chats/route.ts");
const routeSource = readFileSync(routePath, "utf8");
const helperStart = routeSource.indexOf("const ADMIN_USER_SEARCH_COLUMNS");
const helperEnd = routeSource.indexOf("/** 管理员查看学员聊天记录");

assert.notEqual(helperStart, -1, "admin user search helpers must exist");
assert.notEqual(helperEnd, -1, "admin user chat route marker must exist");

const helperSource = `${routeSource.slice(helperStart, helperEnd)}
globalThis.__adminUserChatHelpers = {
  escapeAdminUserSearchLiteral,
  buildAdminUserSearchFilter,
  applyAdminConversationScope,
  createAdminAgentUsageBuckets,
  finalizeAdminAgentUsage,
};`;
const compiledHelpers = ts.transpileModule(helperSource, {
  compilerOptions: {
    module: ts.ModuleKind.None,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const sandbox: { __adminUserChatHelpers?: AdminUserChatHelpers } = {};
vm.runInNewContext(compiledHelpers, sandbox, { filename: routePath });
const helpers = sandbox.__adminUserChatHelpers;
assert.ok(helpers, "admin user chat helpers must be executable");

assert.equal(
  helpers.escapeAdminUserSearchLiteral(String.raw`a\b"c%_`),
  String.raw`a\\\\b\"c\\%\\_`,
  "backslash, quote, percent and underscore must be escaped as literals",
);

const searchValue = "alpha,beta_(ops)%";
const quotedPattern = String.raw`"%alpha,beta\\_(ops)\\%%"`;
const expectedFilter = ["display_name", "username", "phone", "email"]
  .map((column) => `${column}.ilike.${quotedPattern}`)
  .join(",");
assert.equal(
  helpers.buildAdminUserSearchFilter(searchValue),
  expectedFilter,
  "reserved grammar characters must remain inside a quoted PostgREST value",
);

const makeScopeQuery = (calls: ScopeCall[]) => ({
  in(column: string, values: readonly string[]) {
    calls.push({ method: "in", column, value: values });
    return this;
  },
  eq(column: string, value: string) {
    calls.push({ method: "eq", column, value });
    return this;
  },
});

const filteredCalls: ScopeCall[] = [];
const filteredQuery = makeScopeQuery(filteredCalls);
assert.equal(
  helpers.applyAdminConversationScope(filteredQuery, ["student-1", "student-2"], "agent-7"),
  filteredQuery,
);
assert.deepEqual(filteredCalls, [
  { method: "in", column: "user_id", value: ["student-1", "student-2"] },
  { method: "eq", column: "agent_id", value: "agent-7" },
]);

const unfilteredCalls: ScopeCall[] = [];
helpers.applyAdminConversationScope(makeScopeQuery(unfilteredCalls), ["student-1"], "");
assert.deepEqual(unfilteredCalls, [
  { method: "in", column: "user_id", value: ["student-1"] },
]);

const usageBuckets = helpers.createAdminAgentUsageBuckets([
  { id: "conversation-a1", agent_id: "agent-a", updated_at: "2026-09-28T08:00:00.000Z" },
  { id: "conversation-b1", agent_id: "agent-b", updated_at: "2026-09-29T07:00:00.000Z" },
  { id: "conversation-a2", agent_id: "agent-a", updated_at: "2026-09-29T09:00:00.000Z" },
  { id: "conversation-without-agent", agent_id: null, updated_at: "2026-09-29T10:00:00.000Z" },
], {
  "agent-a": "甲智能体",
  "agent-b": "乙智能体",
});
const plainUsageBuckets = JSON.parse(JSON.stringify(usageBuckets));
assert.deepEqual(plainUsageBuckets["agent-a"], {
  agentId: "agent-a",
  agentName: "甲智能体",
  conversationCount: 2,
  messageCount: 0,
  lastUsed: "2026-09-29T09:00:00.000Z",
  conversationIds: ["conversation-a1", "conversation-a2"],
});

const finalizedUsage = JSON.parse(JSON.stringify(helpers.finalizeAdminAgentUsage(usageBuckets, {
  "agent-a": 17,
  "agent-b": 5,
})));
assert.deepEqual(finalizedUsage, [
  {
    agentId: "agent-a",
    agentName: "甲智能体",
    conversationCount: 2,
    messageCount: 17,
    lastUsed: "2026-09-29T09:00:00.000Z",
  },
  {
    agentId: "agent-b",
    agentName: "乙智能体",
    conversationCount: 1,
    messageCount: 5,
    lastUsed: "2026-09-29T07:00:00.000Z",
  },
]);

const routeBody = routeSource.slice(helperEnd);
assert.match(routeBody, /userQuery = userQuery\.or\(buildAdminUserSearchFilter\(userName\)\)/);
assert.equal(
  routeBody.match(/applyAdminConversationScope\(/gu)?.length,
  2,
  "conversation list and agent usage queries must share the same scope helper",
);
assert.match(routeBody, /\.range\(statsOffset, statsOffset \+ ADMIN_CONVERSATION_STATS_BATCH_SIZE - 1\)/);
assert.match(routeBody, /\.select\("id", \{ count: "exact", head: true \}\)/);
assert.match(routeBody, /\.in\("conversation_id", conversationIdBatch\)/);
assert.match(routeBody, /finalizeAdminAgentUsage\(agentUsageBuckets, agentMessageCountMap\)/);
assert.match(routeBody, /agentUsage,/);
assert.match(
  routeBody,
  /\.select\("id, role, content, created_at"\)\s*\.eq\("conversation_id", conversationId\)/u,
  "message drill-down must only select columns guaranteed by the conversation_messages schema",
);
assert.doesNotMatch(
  routeBody,
  /\.select\("[^"]*metadata[^"]*"\)\s*\.eq\("conversation_id", conversationId\)/u,
  "message drill-down must not require the nonexistent legacy metadata column",
);

const adminPageSource = readFileSync(resolve(process.cwd(), "src/app/admin/page.tsx"), "utf8");
assert.match(
  adminPageSource,
  /agentId: string; agentName: string; conversationCount: number; messageCount: number; lastUsed: string;/,
);
assert.match(adminPageSource, /\{stat\.agentName\}/);
assert.match(adminPageSource, /\{stat\.conversationCount\}次/);
assert.match(adminPageSource, /\{stat\.messageCount\}条/);

console.log("admin user chats contract: PASS");
