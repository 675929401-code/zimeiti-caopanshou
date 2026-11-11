import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SignJWT } from "jose";

const ORIGIN = "http://127.0.0.1:5000";
const RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.resolve(".codex-evidence", `model-history-user-isolation-${stamp}`);
const endpoints = [
  ["conversation", "/api/conversations/history", ["conversations", "history", "items"]],
  ["video", "/api/video/history?limit=100", ["tasks", "history", "items"]],
  ["digitalHuman", "/api/video/history?surface=digital-human&limit=100", ["tasks", "history", "items"]],
  ["cover", "/api/cover/history?page=1", ["records", "items"]],
  ["voice", "/api/voice/history?page=1&pageSize=100", ["records", "tasks", "items", "history"]],
  ["storyboard", "/api/storyboard/projects?offset=0", ["projects", "items"]],
  ["media", "/api/media-history?limit=100&includeTotal=1", ["items", "history"]],
];

function rowsFrom(payload, keys) {
  for (const candidate of [payload, payload?.data]) {
    if (Array.isArray(candidate)) return candidate;
    for (const key of keys) if (Array.isArray(candidate?.[key])) return candidate[key];
  }
  return [];
}

function rowId(row) {
  if (!row || typeof row !== "object") return "";
  for (const key of ["id", "taskId", "assetId", "historyRecordId", "conversationId", "clientRequestId"]) {
    if (typeof row[key] === "string" && row[key]) return `${key}:${row[key]}`;
  }
  return "";
}

async function fetchUsers(runtime) {
  const url = new URL("/rest/v1/users", runtime.supabaseUrl);
  url.searchParams.set("select", "id,username,display_name,role");
  url.searchParams.set("is_active", "eq.true");
  url.searchParams.set("role", "in.(admin,student)");
  url.searchParams.set("limit", "20");
  const response = await fetch(url, {
    headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  const rows = await response.json();
  assert.ok(response.ok && Array.isArray(rows), "active local users could not be read");
  const admin = rows.find((row) => row.role === "admin");
  const students = rows.filter((row) => row.role === "student").slice(0, 3);
  assert.ok(admin && students.length > 0, "one administrator and one student are required");
  return [admin, ...students];
}

async function tokenFor(user, secret) {
  return new SignJWT({
    userId: user.id,
    username: user.username || "local-acceptance",
    displayName: user.display_name || "本地验收",
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(secret));
}

async function request(pathname, token) {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `${pathname} returned ${response.status}`);
  return body;
}

const runtime = JSON.parse((await readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(new URL(runtime.supabaseUrl).origin, "http://127.0.0.1:54321", "only the local database may be inspected");
assert.ok(String(runtime.jwtSecret || "").length >= 16, "local runtime JWT secret is unavailable");
const users = await fetchUsers(runtime);
const actors = [];

for (const [actorIndex, user] of users.entries()) {
  const token = await tokenFor(user, runtime.jwtSecret);
  const me = await request("/api/auth/me", token);
  assert.equal(me?.user?.id, user.id, `actor ${actorIndex + 1} identity mismatch`);
  assert.equal(me?.user?.role, user.role, `actor ${actorIndex + 1} role mismatch`);
  const payloads = await Promise.all(endpoints.map(([, pathname]) => request(pathname, token)));
  const surfaces = {};
  for (const [index, [surface, , keys]] of endpoints.entries()) {
    const rows = rowsFrom(payloads[index], keys);
    const ids = rows.map(rowId).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, `${surface}: actor ${actorIndex + 1} returned duplicate row ids`);
    for (const row of rows) {
      const owner = row?.user_id || row?.userId || row?.owner_id || row?.ownerId;
      if (owner) assert.equal(owner, user.id, `${surface}: response contains another owner`);
    }
    surfaces[surface] = { count: rows.length, ids: new Set(ids), serialized: JSON.stringify(payloads[index]) };
  }
  actors.push({ role: user.role, userId: user.id, surfaces });
}

for (let left = 0; left < actors.length; left += 1) {
  for (let right = left + 1; right < actors.length; right += 1) {
    for (const [surface] of endpoints) {
      const overlap = [...actors[left].surfaces[surface].ids].filter((id) => actors[right].surfaces[surface].ids.has(id));
      assert.deepEqual(overlap, [], `${surface}: actors ${left + 1} and ${right + 1} share history row ids`);
      assert.equal(actors[left].surfaces[surface].serialized.includes(actors[right].userId), false, `${surface}: actor ${left + 1} response exposes actor ${right + 1}`);
      assert.equal(actors[right].surfaces[surface].serialized.includes(actors[left].userId), false, `${surface}: actor ${right + 1} response exposes actor ${left + 1}`);
    }
  }
}

const report = {
  ok: true,
  generatedAt: new Date().toISOString(),
  origin: ORIGIN,
  database: "local-only",
  actors: actors.map((actor, index) => ({
    actor: index + 1,
    role: actor.role,
    counts: Object.fromEntries(Object.entries(actor.surfaces).map(([surface, value]) => [surface, value.count])),
  })),
  surfaces: endpoints.map(([surface]) => surface),
  pairwiseComparisons: actors.length * (actors.length - 1) / 2,
  mutations: 0,
  providerCalls: 0,
};
await mkdir(evidenceDir, { recursive: false });
await writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...report, evidenceDir }, null, 2));
