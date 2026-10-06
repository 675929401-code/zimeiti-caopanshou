import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const sourcePath = "src/lib/short-drama/permissions.ts";
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
}).outputText;

function harness(user) {
  let categoryReads = 0;
  const database = {
    from(table) {
      if (table === "users") {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() { return { data: user, error: null }; },
        };
      }
      if (table === "categories") {
        categoryReads += 1;
        return {
          select() { return this; },
          async in() { return { data: [], error: null }; },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    module: mod,
    exports: mod.exports,
    require(name) {
      if (name === "@/lib/auth") return {
        getTokenFromHeaders: (headers) => headers.get("authorization")?.slice(7) || null,
        verifyToken: async (token) => token === "valid" ? { userId: user.id, role: user.role, displayName: "Fixture" } : null,
      };
      if (name === "@/storage/database/supabase-client") return { getSupabaseClient: () => database };
      throw new Error(`unexpected import ${name}`);
    },
  });
  return { authorize: mod.exports.authorizeShortDramaRequest, categoryReads: () => categoryReads };
}

function request(token = "valid") {
  return new Request("http://127.0.0.1:5000/api/short-drama/projects", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function rejection(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

const activeMember = {
  id: "ordinary-member",
  role: "student",
  display_name: "普通用户",
  status: "active",
  is_active: true,
  member_status: "active",
  member_expires_at: null,
  allowed_categories: ["unrelated-agent-category"],
};

const defaultBoundary = harness(activeMember);
const context = await defaultBoundary.authorize(request());
assert.equal(context.userId, activeMember.id);
assert.equal(context.memberStatus, "active");
assert.equal(defaultBoundary.categoryReads(), 0, "independent Film Studio must not read marketplace categories by default");

const categoryScoped = harness(activeMember);
await rejection(categoryScoped.authorize(request(), { requireCategory: true }), "CATEGORY_ACCESS_DENIED");
assert.equal(categoryScoped.categoryReads(), 1, "explicit category-scoped access must retain the category gate");

const inactive = harness({ ...activeMember, member_status: "inactive" });
await rejection(inactive.authorize(request()), "MEMBERSHIP_REQUIRED");

const blocked = harness({ ...activeMember, status: "suspended" });
await rejection(blocked.authorize(request()), "USER_BLOCKED");

const anonymous = harness(activeMember);
await rejection(anonymous.authorize(request("")), "UNAUTHORIZED");

console.log(JSON.stringify({
  passed: true,
  checks: [
    "active member Film Studio access is independent of marketplace category grants",
    "explicit category-scoped callers retain CATEGORY_ACCESS_DENIED",
    "membership, suspended-account and authentication gates remain enforced",
  ],
  providerCalls: 0,
  databaseWrites: 0,
}));
