#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const migration = read("supabase/migrations/20260923223000_agent_favorites.sql");
const api = read("src/app/api/agent-favorites/route.ts");
const hook = read("src/hooks/use-agent-favorites.ts");
const marketplace = read("src/components/agent-marketplace.tsx");
const snapshot = read("scripts/cos-data-snapshot.mjs");
const contract = JSON.parse(read("deploy/policies/database-contract.v1.json"));

assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.agent_favorites/u);
assert.match(migration, /UNIQUE \(user_id, agent_id\)/u);
assert.match(migration, /REFERENCES public\.users\(id\) ON DELETE CASCADE/u);
assert.match(migration, /REFERENCES public\.agents\(id\) ON DELETE CASCADE/u);
assert.match(migration, /ENABLE ROW LEVEL SECURITY/u);
assert.match(migration, /REVOKE ALL ON TABLE public\.agent_favorites FROM PUBLIC, anon, authenticated/u);
assert.match(migration, /Persistent business data/u);

for (const marker of [
  "withAuth", ".eq(\"user_id\", user.id)", "readMemberPermissionSnapshot", "permission.agentNavigationKeys",
  "visibility === \"private\"", "user_access === \"hidden\"", "Cache-Control",
]) assert.ok(api.includes(marker), `API missing ${marker}`);
assert.match(api, /onConflict: "user_id,agent_id"/u);
assert.doesNotMatch(hook, /localStorage|sessionStorage/u);
assert.ok(hook.includes("/api/agent-favorites") && hook.includes("Authorization"));

for (const marker of [
  "我的收藏", "data-agent-favorite-toggle", "data-agent-category", "favoriteAgentIds.has(agent.id)",
  "data-agent-display-category", "favoritesLoaded && activeCategory === FAVORITES_CATEGORY",
]) assert.ok(marketplace.includes(marker), `marketplace missing ${marker}`);
assert.doesNotMatch(
  marketplace,
  /filtered\.filter\(\(agent\) => !favoriteAgentIds\.has\(agent\.id\)\)/u,
  "normal categories must not exclude favorited agents",
);
assert.ok(snapshot.includes('"agent_favorites"'), "business snapshot excludes agent_favorites");
const table = contract.tables.find((item) => item.name === "agent_favorites");
assert.deepEqual(table?.columns, ["id", "user_id", "agent_id", "created_at"]);

console.log(JSON.stringify({
  passed: true,
  accountScoped: true,
  sourceOrBuildStorage: false,
  backupExportIncluded: true,
  favoritesPreservedInNormalCategories: true,
}, null, 2));
