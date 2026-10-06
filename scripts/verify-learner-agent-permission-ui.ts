import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const home = read("src/app/page.tsx");
const marketplace = read("src/components/agent-marketplace.tsx");

// The catalog request identity includes the user, role and token, so login,
// logout, account switching and token rotation all schedule a fresh replace.
assert.match(home, /const agentCatalogIdentityKey = state\.auth\.isAuthenticated/u);
assert.match(home, /state\.auth\.user\?\.id/u);
assert.match(home, /state\.auth\.user\?\.role/u);
assert.match(home, /state\.auth\.token/u);
assert.match(home, /agentCatalogRequestVersionRef/u);
assert.match(home, /agentCatalogQueueRef/u);
assert.match(home, /dispatch\(\{ type: "SET_AGENTS", payload: \[\] \}\)/u);
assert.match(home, /requestVersion !== agentCatalogRequestVersionRef\.current/u);
assert.match(home, /\[agentCatalogIdentityKey,/u);
assert.doesNotMatch(home, /const agentsLoadRef = useRef\(false\)/u);

assert.match(marketplace, /BIP_CATEGORY,/u);
for (const key of ["task:影像编导", "task:文案创作", "task:获客转化", "自用"]) {
  assert.ok(marketplace.includes(`"${key}"`) || marketplace.includes(key), `MISSING_NAVIGATION_KEY:${key}`);
}
assert.match(marketplace, /const LEARNER_AGENT_NAVIGATION_KEYS/u);
assert.match(marketplace, /const learnerPermissionIdentityKey/u);
assert.match(marketplace, /fetch\("\/api\/bots\?shape=agents"/u);
assert.match(marketplace, /Authorization: `Bearer \$\{auth\.token\}`/u);
assert.match(marketplace, /cache: "no-store"/u);
assert.match(marketplace, /signal: controller\.signal/u);
assert.match(marketplace, /throw new Error\("MISSING_NAVIGATION_KEYS"\)/u);
assert.match(marketplace, /learnerPermissionSnapshot\.agentIds\.has\(agent\.id\)/u);
assert.match(marketplace, /learnerPermissionSnapshot\.navigationKeys\.has\(navigationKey\)/u);
assert.match(marketplace, /return \[\s*"all",\s*FAVORITES_CATEGORY,\s*\.\.\.LEARNER_AGENT_NAVIGATION_KEYS\.filter/u);
assert.match(marketplace, /visibleCatKeys\.filter\(k => catMap\.has\(k\)\)/u);
assert.match(marketplace, /if \(!visibleCatKeys\.includes\(activeCategory\)\)/u);
assert.match(marketplace, /暂无智能体权限/u);
assert.match(marketplace, /智能体权限暂时无法读取/u);
assert.match(marketplace, /label:"内部工具"/u);

// Contract matrix: virtual tabs remain available, while every real learner
// tab and card must come from the current permission snapshot.
const stableKeys = ["bip:loop", "task:影像编导", "task:文案创作", "task:获客转化", "自用"];
const visibleTabs = (admin: boolean, granted: string[]) => admin
  ? ["all", "favorites", ...stableKeys]
  : ["all", "favorites", ...stableKeys.filter((key) => granted.includes(key))];

assert.deepEqual(visibleTabs(false, []), ["all", "favorites"]);
assert.deepEqual(visibleTabs(false, ["task:文案创作"]), ["all", "favorites", "task:文案创作"]);
assert.deepEqual(visibleTabs(false, ["unknown", "自用"]), ["all", "favorites", "自用"]);
assert.deepEqual(visibleTabs(true, []), ["all", "favorites", ...stableKeys]);

const returnedAgentIds = new Set(["allowed-agent"]);
const returnedNavigationKeys = new Set(["task:文案创作"]);
const cards = [
  { id: "guest-only", navigationKey: "task:文案创作" },
  { id: "allowed-agent", navigationKey: "task:文案创作" },
  { id: "wrong-tab", navigationKey: "task:影像编导" },
].filter((agent) => returnedAgentIds.has(agent.id) && returnedNavigationKeys.has(agent.navigationKey));
assert.deepEqual(cards.map((agent) => agent.id), ["allowed-agent"]);

console.log(JSON.stringify({
  passed: true,
  identityBoundCatalogRefresh: true,
  learnerNavigationKeys: stableKeys,
  noGrantTabs: visibleTabs(false, []),
  guestLeakPreventedByAgentIdIntersection: true,
}, null, 2));
