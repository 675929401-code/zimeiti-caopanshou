import { config } from "dotenv";
import { SignJWT } from "jose";

config({ path: ".env.local", quiet: true });

const baseUrl = (process.env.BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const requireAuth = process.argv.includes("--auth");
const results = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function listFrom(payload, keys) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function assertRealtime(payload, label) {
  const serialized = JSON.stringify(payload);
  assert(!/"source":"(?:backup|local_backup)"/.test(serialized), `${label} returned snapshot data`);
}

async function request(path, options = {}, expected = [200]) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, options);
  const durationMs = Math.round(performance.now() - startedAt);
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  assert(expected.includes(response.status), `${path} returned HTTP ${response.status}`);
  return { response, body, durationMs };
}

function pass(name, detail) {
  results.push({ name, detail });
  console.log(`PASS ${name}: ${detail}`);
}

async function publicChecks() {
  const home = await request("/");
  assert(String(home.body).includes('data-theme="lattice"'), "HTML theme is not lattice");
  assert(String(home.body).includes('data-mode="dark"'), "HTML mode is not dark");
  pass("theme", `lattice/dark (${home.durationMs}ms)`);

  const checks = [
    ["agents", "/api/bots", ["bots", "agents"], 1],
    ["categories", "/api/categories", ["categories"], 1],
    ["navigation", "/api/nav-items", ["items", "navItems"], 1],
    ["shortcuts", "/api/shortcuts", ["items", "shortcuts"], 1],
    ["chat models", "/api/chat-models", ["models"], 1],
    ["video models", "/api/video/models", ["models"], 1],
  ];

  for (const [name, path, keys, minimum] of checks) {
    const result = await request(path);
    assertRealtime(result.body, name);
    const rows = listFrom(result.body, keys);
    assert(rows.length >= minimum, `${name} list is empty`);
    pass(name, `${rows.length} rows (${result.durationMs}ms)`);
  }

  const methods = await request("/api/payment/methods");
  assertRealtime(methods.body, "payment methods");
  const methodRows = listFrom(methods.body, ["methods"]);
  assert(methodRows.length > 0, "No active payment method");
  pass("payment methods", `${methodRows.length} active`);
}

async function getAuthToken() {
  if (process.env.VERIFY_PUBLIC_ONLY === "1") return "";
  if (process.env.VERIFY_AUTH_TOKEN) return process.env.VERIFY_AUTH_TOKEN;
  if (process.env.NODE_ENV === "production") return "";
  const hostname = new URL(baseUrl).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) return "";
  try {
    const session = await request("/api/auth/dev-session", {
      headers: { "x-local-workbench": "ai-creation-studio-local" },
    });
    return session.body?.token || "";
  } catch (error) {
    if (requireAuth) throw error;
    return "";
  }
}

async function makeUserToken(user) {
  const secret = process.env.JWT_SECRET;
  assert(secret, "JWT_SECRET is required for local permission verification");
  return new SignJWT({
    userId: user.id,
    username: `verify-${user.id}`,
    role: "student",
    displayName: "Runtime Verify",
    sessionId: `verify-${Date.now()}`,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}

async function authenticatedChecks(token) {
  const auth = { Authorization: `Bearer ${token}` };
  const me = await request("/api/auth/me", { headers: auth });
  assertRealtime(me.body, "current user");
  const currentUserId = me.body?.user?.id;
  assert(currentUserId, "Authenticated user id is missing");

  const [credits, conversations, videos, activeTasks, consistency, users] = await Promise.all([
    request(`/api/credits?user_id=${encodeURIComponent(currentUserId)}`, { headers: auth }),
    request("/api/conversations/history", { headers: auth }),
    request("/api/video/history?limit=100", { headers: auth }),
    request("/api/video/active-tasks", { headers: auth }),
    request("/api/admin/consistency-check", { headers: auth }),
    request("/api/admin/users?page=1&page_size=500", { headers: auth }),
  ]);

  for (const [label, result] of [
    ["credits", credits],
    ["conversations", conversations],
    ["video history", videos],
    ["active video tasks", activeTasks],
    ["billing consistency", consistency],
    ["users", users],
  ]) assertRealtime(result.body, label);

  const conversationRows = listFrom(conversations.body, ["conversations", "history", "items"]);
  const videoRows = listFrom(videos.body, ["tasks", "history", "items"]);
  pass("authenticated history", `${conversationRows.length} conversations, ${videoRows.length} videos`);
  pass("billing consistency", `${consistency.body?.critical ?? "?"} critical, ${consistency.body?.warning ?? "?"} warnings`);

  const invalidPayment = await request("/api/payment/create", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "credits", amount: 1, paymentMethod: "Alipay" }),
  }, [400]);
  pass("payment validation", `invalid recharge rejected (${invalidPayment.response.status})`);

  const usersList = listFrom(users.body, ["users"]);
  const inactiveUser = usersList.find((user) =>
    user.role !== "admin" &&
    Number(user.credits ?? 0) <= 0 &&
    ["inactive", "expired"].includes(String(user.memberStatus || "inactive"))
  );

  if (inactiveUser && new URL(baseUrl).hostname === "127.0.0.1") {
    const userToken = await makeUserToken(inactiveUser);
    const userAuth = { Authorization: `Bearer ${userToken}` };
    const visibleAgents = await request("/api/bots", { headers: userAuth });
    const agentRows = listFrom(visibleAgents.body, ["bots", "agents"]);
    assert(agentRows.length > 0, "Inactive member cannot see agents");

    const userCredits = await request(`/api/credits?user_id=${encodeURIComponent(inactiveUser.id)}`, { headers: userAuth });
    assert(Number(userCredits.body?.credits) === 0, "Zero balance was not preserved");

    const agentId = agentRows[0]?.id;
    const denied = await request("/api/llm", {
      method: "POST",
      headers: { ...userAuth, "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId,
        messages: [{ role: "user", content: "permission check" }],
        stream: false,
      }),
    }, [403]);
    assert(denied.body?.code === "MEMBERSHIP_REQUIRED", "Inactive member denial code is incorrect");
    pass("new member permissions", `${agentRows.length} agents visible, model use denied, credits remain 0`);
  } else {
    pass("new member permissions", "no inactive zero-credit account available for read-only check");
  }

  const persistentVideo = videoRows.find((task) => {
    const storageUrl = task.storageUrl || task.storage_url || "";
    return task.status === "completed" && task.id && String(storageUrl).startsWith("object://");
  });
  if (persistentVideo) {
    const first = await request(`/api/video/proxy?id=${encodeURIComponent(persistentVideo.id)}`, {
      headers: { ...auth, Range: "bytes=0-1023" },
      redirect: "manual",
    }, [200, 206, 302]);
    const second = await request(`/api/video/proxy?id=${encodeURIComponent(persistentVideo.id)}`, {
      headers: { ...auth, Range: "bytes=0-1023" },
      redirect: "manual",
    }, [200, 206, 302]);
    pass("video range", `HTTP ${second.response.status}, warm metadata ${second.durationMs}ms (cold ${first.durationMs}ms)`);
  } else {
    pass("video range", "no post-migration persistent video available; legacy temporary URLs ignored");
  }
}

try {
  await publicChecks();
  const token = await getAuthToken();
  if (token) {
    await authenticatedChecks(token);
  } else if (requireAuth) {
    throw new Error("Authenticated checks requested but VERIFY_AUTH_TOKEN is missing");
  } else {
    pass("authenticated checks", "skipped (set VERIFY_AUTH_TOKEN to enable)");
  }
  console.log(`\nRuntime contract passed: ${results.length} checks against ${baseUrl}`);
} catch (error) {
  console.error(`\nRuntime contract failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
